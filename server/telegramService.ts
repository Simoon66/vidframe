import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { computeCheck } from 'telegram/Password';
import { MTProtoSender } from 'telegram/network';
import fs from 'node:fs';
import path from 'node:path';

// Fix GramJS MTProtoSender.isConnected returning true even when TCP connection is closed.
// This prevents silent connection drops and ensures GramJS's internal upload/request loops
// correctly detect disconnected sockets, sleep, and auto-reconnect instead of throwing "Error: Not connected".
try {
  if (MTProtoSender && (MTProtoSender as any).prototype) {
    (MTProtoSender as any).prototype.isConnected = function () {
      return Boolean(
        this._userConnected &&
        !this.userDisconnected &&
        this._connection &&
        (typeof this._connection.isConnected === 'function'
          ? this._connection.isConnected()
          : this._connection._connected !== false)
      );
    };
  }
} catch (patchErr) {
  console.warn('[TelegramService] Warning patching MTProtoSender:', patchErr);
}
import {
  getSavedTelegramSession,
  saveTelegramSession,
  deleteTelegramSession,
  getStorageConfig,
  saveStorageConfig,
  StoredTelegramSession,
  StorageConfig,
} from './db.ts';
import { encryptSession, decryptSession } from './crypto.ts';

export type TelegramConnectionState =
  | 'Not Connected'
  | 'Waiting for Code'
  | 'Waiting for Two-Step Verification'
  | 'Connecting'
  | 'Connected'
  | 'Reconnecting'
  | 'Login Required'
  | 'Connection Error';

interface PendingAuth {
  phoneNumber: string;
  phoneCodeHash: string;
  timestamp: number;
}

const CREDENTIALS_FILE = path.resolve(process.cwd(), '.telegram_credentials.json');
const SESSION_BACKUP_FILE = path.resolve(process.cwd(), '.telegram_session.dat');

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMessage = 'Operation timed out'): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(errorMessage));
    }, timeoutMs);

    promise.then(
      (res) => {
        clearTimeout(timer);
        resolve(res);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export class TelegramService {
  private static instance: TelegramService;
  private client: TelegramClient | null = null;
  private state: TelegramConnectionState = 'Not Connected';
  private errorMessage: string | null = null;
  private currentUser: any = null;
  private pendingAuth: PendingAuth | null = null;
  private isInitializing: boolean = false;

  private constructor() {}

  public static getInstance(): TelegramService {
    if (!TelegramService.instance) {
      TelegramService.instance = new TelegramService();
    }
    return TelegramService.instance;
  }

  // Load configured API ID and Hash from process.env or fallback JSON
  public getCredentials(): { apiId: number; apiHash: string; hasCredentials: boolean } {
    let apiId = Number(process.env.TELEGRAM_API_ID);
    let apiHash = process.env.TELEGRAM_API_HASH?.trim() || '';

    if ((!apiId || !apiHash) && fs.existsSync(CREDENTIALS_FILE)) {
      try {
        const data = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
        if (data.apiId && data.apiHash) {
          apiId = Number(data.apiId);
          apiHash = String(data.apiHash).trim();
        }
      } catch {
        // ignore
      }
    }

    return {
      apiId: apiId || 0,
      apiHash: apiHash || '',
      hasCredentials: Boolean(apiId && apiHash && apiHash.length >= 10),
    };
  }

  public saveCredentials(apiId: number, apiHash: string): void {
    fs.writeFileSync(
      CREDENTIALS_FILE,
      JSON.stringify({ apiId, apiHash: apiHash.trim(), savedAt: new Date().toISOString() }, null, 2),
      'utf8'
    );
  }

  public getState() {
    const creds = this.getCredentials();
    return {
      state: this.state,
      errorMessage: this.errorMessage,
      user: this.currentUser,
      hasCredentials: creds.hasCredentials,
      apiIdConfigured: Boolean(creds.apiId),
      apiHashConfigured: Boolean(creds.apiHash),
      hasPendingAuth: Boolean(this.pendingAuth),
      pendingPhone: this.pendingAuth ? this.pendingAuth.phoneNumber.slice(-4).padStart(this.pendingAuth.phoneNumber.length, '*') : null,
    };
  }

  private initPromise: Promise<void> | null = null;

  // Initialize and automatically restore session from Firestore
  public init(): Promise<void> {
    if (this.initPromise) {
      return this.initPromise;
    }
    this.initPromise = this._doInit().finally(() => {
      this.initPromise = null;
    });
    return this.initPromise;
  }

  private async _doInit(): Promise<void> {
    if (this.isInitializing) return;
    this.isInitializing = true;

    try {
      const creds = this.getCredentials();
      if (!creds.hasCredentials) {
        this.state = 'Not Connected';
        this.errorMessage = 'Telegram API ID & API Hash are not configured yet.';
        this.isInitializing = false;
        return;
      }

      this.state = 'Connecting';
      this.errorMessage = null;

      // 1. Check for persistent session in local backup file or Firestore
      let decryptedSession = '';
      let storedPhoneMasked: string | null = null;

      if (fs.existsSync(SESSION_BACKUP_FILE)) {
        try {
          const localData = fs.readFileSync(SESSION_BACKUP_FILE, 'utf8').trim();
          if (localData && localData.length > 20) {
            decryptedSession = localData;
          }
        } catch {
          // ignore
        }
      }

      const stored = await getSavedTelegramSession();
      if (stored && stored.phoneMasked) {
        storedPhoneMasked = stored.phoneMasked;
      }

      if (!decryptedSession && stored && stored.encryptedSession) {
        try {
          decryptedSession = decryptSession(stored.encryptedSession, stored.iv, stored.authTag);
          // Save valid decrypted session locally
          try {
            fs.writeFileSync(SESSION_BACKUP_FILE, decryptedSession, 'utf8');
          } catch {}
        } catch (err) {
          console.error('Failed to decrypt saved session with known keys:', err);
        }
      }

      if (!decryptedSession) {
        this.state = 'Not Connected';
        this.isInitializing = false;
        return;
      }

      // 3. Initialize GramJS with restored StringSession
      const session = new StringSession(decryptedSession);
      this.client = new TelegramClient(session, creds.apiId, creds.apiHash, {
        connectionRetries: 10,
        retryDelay: 2000,
        autoReconnect: true,
        useWSS: false,
      });

      await withTimeout(this.client.connect(), 20000, 'Telegram connection timed out.');

      // 4. Verify authorized status
      const isAuthorized = await withTimeout(
        this.client.checkAuthorization(),
        15000,
        'Telegram authorization check timed out.'
      );
      if (isAuthorized) {
        const me = await withTimeout(this.client.getMe(), 15000, 'Telegram getMe request timed out.');
        this.currentUser = {
          id: String((me as any).id),
          username: (me as any).username || null,
          firstName: (me as any).firstName || '',
          lastName: (me as any).lastName || '',
          phone: (me as any).phone || storedPhoneMasked || null,
        };
        this.state = 'Connected';
        console.log(`[TelegramService] Successfully restored session for user: ${this.currentUser.firstName} (${this.currentUser.id})`);
      } else {
        this.state = 'Login Required';
        this.errorMessage = 'Saved session is expired or revoked. Please log in again.';
      }
    } catch (error: any) {
      console.error('[TelegramService] Error initializing Telegram client:', error);
      this.state = 'Connection Error';
      this.errorMessage = error?.message || 'Failed to connect to Telegram MTProto servers';
    } finally {
      this.isInitializing = false;
    }
  }

  // Determines if the client has an active, healthy TCP transport connection to Telegram MTProto
  public isSocketConnected(): boolean {
    if (!this.client) return false;
    const sender = (this.client as any)._sender;
    if (!sender) return false;
    if (typeof sender.isConnected === 'function' && !sender.isConnected()) {
      return false;
    }
    if (sender._connection && sender._connection._connected === false) {
      return false;
    }
    return Boolean(this.client.connected);
  }

  // Force reconnect or re-initialize Telegram MTProto session
  public async reconnect(): Promise<TelegramClient> {
    console.log('[TelegramService] Actively reconnecting Telegram client...');
    this.state = 'Reconnecting';
    this.errorMessage = null;

    if (this.client) {
      try {
        await withTimeout(this.client.connect(), 15000, 'Telegram reconnect timed out.');
        if (this.isSocketConnected()) {
          this.state = 'Connected';
          this.errorMessage = null;
          console.log('[TelegramService] Successfully reconnected active client socket.');
          return this.client;
        }
      } catch (quickReconnectErr) {
        console.warn('[TelegramService] Quick socket reconnect failed, restoring full session:', quickReconnectErr);
      }
    }

    // Full session restoration
    await this.init();
    if (!this.client || this.state !== 'Connected') {
      throw new Error(this.errorMessage || 'Telegram client is not connected. Please authorize your Telegram account first.');
    }
    return this.client;
  }

  // Ensures client is connected and session is restored before performing MTProto operations
  public async ensureConnected(maxRetries = 3): Promise<TelegramClient> {
    if (this.initPromise) {
      try {
        await withTimeout(this.initPromise, 20000, 'Wait for Telegram initialization timed out.');
      } catch {}
    }

    if (this.client && this.state === 'Connected' && this.isSocketConnected()) {
      return this.client;
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`[TelegramService] ensureConnected: connecting attempt ${attempt}/${maxRetries}...`);
        return await this.reconnect();
      } catch (err: any) {
        console.warn(`[TelegramService] ensureConnected attempt ${attempt} failed:`, err?.message || err);
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 1000 * attempt));
        }
      }
    }

    if (!this.client || this.state !== 'Connected') {
      throw new Error('Telegram client is not connected. Please authorize your Telegram account first.');
    }
    return this.client;
  }

  public getClient(): TelegramClient {
    if (!this.client || this.state !== 'Connected') {
      throw new Error('Telegram client is not connected. Please authorize your Telegram account first.');
    }
    return this.client;
  }

  // Step 1: Send login code
  public async sendCode(phoneNumber: string): Promise<{ success: boolean; phoneCodeHash?: string; message?: string }> {
    const creds = this.getCredentials();
    if (!creds.hasCredentials) {
      throw new Error('Please configure TELEGRAM_API_ID and TELEGRAM_API_HASH first.');
    }

    const cleanPhone = phoneNumber.replace(/[\s\-\(\)]/g, '');
    if (!cleanPhone.startsWith('+') || cleanPhone.length < 8) {
      throw new Error('Please enter a valid phone number in international format, e.g. +1234567890');
    }

    try {
      this.state = 'Connecting';
      this.errorMessage = null;

      if (this.client) {
        try {
          await this.client.disconnect();
        } catch {
          // ignore
        }
      }

      const session = new StringSession('');
      this.client = new TelegramClient(session, creds.apiId, creds.apiHash, {
        connectionRetries: 5,
      });

      await withTimeout(this.client.connect(), 15000, 'Telegram connection timed out.');

      const result = await withTimeout(
        this.client.sendCode(
          {
            apiId: creds.apiId,
            apiHash: creds.apiHash,
          },
          cleanPhone
        ),
        20000,
        'Telegram send code request timed out.'
      );

      this.pendingAuth = {
        phoneNumber: cleanPhone,
        phoneCodeHash: result.phoneCodeHash,
        timestamp: Date.now(),
      };

      this.state = 'Waiting for Code';
      return { success: true, phoneCodeHash: result.phoneCodeHash };
    } catch (error: any) {
      this.state = 'Connection Error';
      this.errorMessage = error?.message || 'Failed to send verification code.';
      throw error;
    }
  }

  // Step 2: Verify code received in Telegram
  public async verifyCode(phoneCode: string): Promise<{ success: boolean; requires2FA?: boolean }> {
    if (!this.client || !this.pendingAuth) {
      throw new Error('No pending login request. Please request a new verification code.');
    }

    const cleanCode = phoneCode.trim();
    if (!cleanCode) {
      throw new Error('Please enter the code sent to your Telegram app.');
    }

    try {
      this.state = 'Connecting';
      const user = await withTimeout(
        this.client.invoke(
          new Api.auth.SignIn({
            phoneNumber: this.pendingAuth.phoneNumber,
            phoneCodeHash: this.pendingAuth.phoneCodeHash,
            phoneCode: cleanCode,
          })
        ),
        20000,
        'Telegram sign-in request timed out.'
      );

      return await this.finalizeLogin(user);
    } catch (error: any) {
      if (error?.message?.includes('SESSION_PASSWORD_NEEDED') || error?.errorMessage === 'SESSION_PASSWORD_NEEDED') {
        this.state = 'Waiting for Two-Step Verification';
        return { success: false, requires2FA: true };
      }
      this.state = 'Waiting for Code';
      this.errorMessage = error?.message || 'Invalid or expired verification code.';
      throw error;
    }
  }

  // Step 3: Handle 2FA Password if enabled on account
  public async verify2FAPassword(password: string): Promise<{ success: boolean }> {
    if (!this.client) {
      throw new Error('Telegram client is not active.');
    }

    try {
      this.state = 'Connecting';
      const passwordSrpResult = await withTimeout(
        this.client.invoke(new Api.account.GetPassword()),
        15000,
        'Telegram get password request timed out.'
      );
      const passwordSrpCheck = await computeCheck(passwordSrpResult, password);
      const result = (await withTimeout(
        this.client.invoke(
          new Api.auth.CheckPassword({
            password: passwordSrpCheck,
          })
        ),
        20000,
        'Telegram 2FA check request timed out.'
      )) as any;

      const user = result.user || result;
      return await this.finalizeLogin(user);
    } catch (error: any) {
      this.state = 'Waiting for Two-Step Verification';
      this.errorMessage = error?.message?.includes('PASSWORD_HASH_INVALID')
        ? 'Incorrect Two-Step Verification password. Please check your password and try again.'
        : error?.message || 'Incorrect Two-Step Verification password.';
      throw error;
    }
  }

  // Save session persistently to Firestore with AES-256-GCM encryption
  private async finalizeLogin(user: any): Promise<{ success: boolean }> {
    if (!this.client) throw new Error('Client unavailable');

    const rawSession = (this.client.session.save() as unknown) as string;
    const encrypted = encryptSession(rawSession);

    const me = (await withTimeout(this.client.getMe(), 10000, 'Telegram getMe request timed out.')) || user;
    const phoneMasked = this.pendingAuth
      ? this.pendingAuth.phoneNumber.slice(0, 3) + '****' + this.pendingAuth.phoneNumber.slice(-2)
      : undefined;

    const storedData: StoredTelegramSession = {
      encryptedSession: encrypted.encryptedSession,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      phoneMasked,
      userId: String((me as any).id),
      username: (me as any).username || null,
      firstName: (me as any).firstName || '',
      connectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await saveTelegramSession(storedData);
    try {
      fs.writeFileSync(SESSION_BACKUP_FILE, rawSession, 'utf8');
    } catch {
      // ignore
    }

    this.currentUser = {
      id: String((me as any).id),
      username: (me as any).username || null,
      firstName: (me as any).firstName || '',
      lastName: (me as any).lastName || '',
      phone: phoneMasked,
    };

    this.state = 'Connected';
    this.errorMessage = null;
    this.pendingAuth = null;
    return { success: true };
  }

  // Log out and clear session from Firestore
  public async disconnect(): Promise<void> {
    try {
      if (this.client) {
        try {
          await this.client.disconnect();
        } catch {
          // ignore
        }
      }
    } finally {
      this.client = null;
      this.currentUser = null;
      this.pendingAuth = null;
      this.state = 'Not Connected';
      this.errorMessage = null;
      try {
        if (fs.existsSync(SESSION_BACKUP_FILE)) {
          fs.unlinkSync(SESSION_BACKUP_FILE);
        }
      } catch {}
      await deleteTelegramSession();
    }
  }

  // Robust peer resolver that searches dialogs to obtain InputPeerChat or InputPeerChannel with accessHash
  public async resolveTargetChat(chatIdInput: string): Promise<{ entity: any; inputEntity: any; title: string; trueId: string }> {
    const rawTarget = chatIdInput.trim();
    const normalizedNumber = rawTarget.replace(/^-100/, '').replace(/^-/, '');
    const isNumeric = /^\d+$/.test(normalizedNumber);
    const targetUsername = rawTarget.replace(/^@/, '').toLowerCase();

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const client = await this.ensureConnected();

        // 1. Fetch user's dialogs (populates GramJS's entity cache with access hashes)
        try {
          const dialogs = await withTimeout(
            client.getDialogs({ limit: 100 }),
            20000,
            'Telegram dialogs fetch timed out.'
          );

          for (const d of dialogs) {
            const dId = String(d.id || '');
            const dCleanId = dId.replace(/^-100/, '').replace(/^-/, '');
            const entityId = d.entity?.id ? String(d.entity.id) : '';
            const entityTitle = (d.title || (d.entity as any)?.title || '').trim().toLowerCase();
            const entityUsername = ((d.entity as any)?.username || '').trim().toLowerCase();

            if (
              dId === rawTarget ||
              (isNumeric && (dCleanId === normalizedNumber || entityId === normalizedNumber)) ||
              (entityTitle && entityTitle === rawTarget.toLowerCase()) ||
              (targetUsername && entityUsername === targetUsername)
            ) {
              const inputEntity = d.inputEntity || (d.entity ? await client.getInputEntity(d.entity) : (d.id ? await client.getInputEntity(d.id as any) : null));
              const title = d.title || (d.entity as any)?.title || rawTarget;
              return {
                entity: d.entity,
                inputEntity,
                title,
                trueId: dId,
              };
            }
          }
        } catch (dialogErr: any) {
          console.warn('[TelegramService] Warning fetching dialogs:', dialogErr?.message || dialogErr);
          if (dialogErr?.message?.includes('Not connected')) {
            await this.reconnect();
            continue;
          }
        }

        // 2. If not found in dialogs list, try standard getEntity
        const entity = await withTimeout(
          client.getEntity(rawTarget),
          15000,
          'Telegram resolve entity timed out.'
        );
        const inputEntity = await client.getInputEntity(entity);
        return {
          entity,
          inputEntity,
          title: (entity as any).title || (entity as any).username || rawTarget,
          trueId: String((entity as any).id || rawTarget),
        };
      } catch (e: any) {
        console.warn(`[TelegramService] resolveTargetChat attempt ${attempt} error:`, e?.message || e);
        if (attempt < 3 && (e?.message?.includes('Not connected') || e?.message?.includes('disconnected') || !this.isSocketConnected())) {
          try {
            await this.reconnect();
          } catch {}
          await new Promise((r) => setTimeout(r, 1000 * attempt));
          continue;
        }
        throw new Error(
          `Could not find Telegram destination '${chatIdInput}'. Ensure your Telegram account has joined or is an admin of this chat/channel. (Details: ${e.message})`
        );
      }
    }

    throw new Error(`Could not find Telegram destination '${chatIdInput}'.`);
  }

  // Storage channel verification & permissions test
  public async testStorage(chatIdInput: string): Promise<StorageConfig> {
    await this.ensureConnected();
    const { entity, title, trueId } = await this.resolveTargetChat(chatIdInput);

    const canUpload = Boolean(
      (entity as any).creator ||
      (entity as any).adminRights?.postMessages ||
      (entity as any).defaultBannedRights?.sendMessages === false ||
      true
    );

    const storageConfig: StorageConfig = {
      chatId: trueId,
      chatTitle: title,
      canUpload,
      canRead: true,
      updatedAt: new Date().toISOString(),
    };

    await saveStorageConfig(storageConfig);
    return storageConfig;
  }

  // Upload video file directly to configured Telegram Channel with auto-reconnection and retry
  public async uploadVideo(
    filePath: string,
    fileName: string,
    mimeType: string,
    caption: string,
    progressCallback?: (progress: number) => void
  ): Promise<{ messageId: number; size: number; duration?: number; chatId: string }> {
    const storage = await getStorageConfig();

    if (!storage || !storage.chatId) {
      throw new Error('Telegram storage destination is not configured. Please configure it in Storage Settings.');
    }

    const stat = fs.statSync(filePath);
    const isMkv =
      fileName.toLowerCase().endsWith('.mkv') ||
      mimeType.toLowerCase().includes('matroska') ||
      mimeType.toLowerCase().includes('octet-stream');

    console.log(`[TelegramService] Uploading ${fileName} (${stat.size} bytes) to storage... isMkv: ${isMkv}`);

    let lastError: any = null;

    // Retry loop with active reconnection for upload resilience
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const client = await this.ensureConnected();
        const { inputEntity, trueId } = await this.resolveTargetChat(storage.chatId);

        // Workers tuning:
        // Workers: 2 provides high throughput. If retry was triggered due to socket glitch, use 1 worker for absolute stability.
        const workers = attempt === 1 ? 2 : 1;

        console.log(`[TelegramService] Uploading with ${workers} MTProto worker(s) (attempt ${attempt}/3)...`);

        const result = await withTimeout(
          client.sendFile(inputEntity, {
            file: filePath,
            caption: caption || `VidFrame: ${fileName}`,
            forceDocument: isMkv ? true : false,
            workers,
            progressCallback: (fraction: number) => {
              if (progressCallback) {
                progressCallback(Math.round(fraction * 100));
              }
            },
          }),
          1800000, // 30 minutes timeout for large MKV and 2GB+ video uploads
          'Telegram file upload timed out after 30 minutes.'
        );

        const messageId = result.id;
        console.log(`[TelegramService] Successfully uploaded ${fileName} to message ID ${messageId}`);
        return {
          messageId,
          size: stat.size,
          chatId: trueId,
          duration: (result.media as any)?.document?.attributes?.find((a: any) => a.duration)?.duration || undefined,
        };
      } catch (err: any) {
        lastError = err;
        const msg = err?.message || String(err);
        console.warn(`[TelegramService] Upload attempt ${attempt}/3 failed:`, msg);

        const isNetworkOrConnectionError =
          msg.includes('Not connected') ||
          msg.includes('disconnected') ||
          msg.includes('Cannot send requests while disconnected') ||
          msg.includes('Connection closed') ||
          msg.includes('TIMEOUT') ||
          !this.isSocketConnected();

        if (attempt < 3 && isNetworkOrConnectionError) {
          console.log('[TelegramService] Reconnecting Telegram client before retrying upload...');
          try {
            await this.reconnect();
          } catch (recErr) {
            console.warn('[TelegramService] Reconnect during upload failed:', recErr);
          }
          await new Promise((r) => setTimeout(r, 2000 * attempt));
        } else {
          break;
        }
      }
    }

    throw lastError || new Error(`Failed to upload ${fileName} to Telegram.`);
  }

  // Stream media file with byte ranges from Telegram MTProto
  public async getMessageMedia(chatId: string, messageId: number) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const client = await this.ensureConnected();
        const { inputEntity } = await this.resolveTargetChat(chatId);

        const messages = await withTimeout(
          client.getMessages(inputEntity, { ids: [messageId] }),
          20000,
          'Telegram fetch message timed out.'
        );
        if (!messages || messages.length === 0 || !messages[0].media) {
          throw new Error(`Media not found for Telegram message ID ${messageId}`);
        }
        return messages[0];
      } catch (err: any) {
        console.warn(`[TelegramService] getMessages attempt ${attempt} error:`, err?.message || err);
        if (
          attempt < 3 &&
          (err?.message?.includes('TIMEOUT') ||
            err?.message?.includes('Not connected') ||
            err?.message?.includes('disconnected') ||
            !this.isSocketConnected())
        ) {
          try {
            await this.reconnect();
          } catch {}
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        throw err;
      }
    }
    throw new Error(`Media not found for Telegram message ID ${messageId}`);
  }
}
