import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { computeCheck } from 'telegram/Password';
import { MTProtoSender } from 'telegram/network';
import fs from 'node:fs';
import path from 'node:path';
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
import { APP_CONFIG } from './config.ts';

// Fix GramJS MTProtoSender.isConnected returning true even when TCP connection is closed.
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

export interface TelegramDiagnostic {
  code: string;
  message: string;
  failedAt: string;
  chatIdTried?: string;
}

const CREDENTIALS_FILE = path.resolve(process.cwd(), '.telegram_credentials.json');
const LEGACY_PLAINTEXT_SESSION_FILE = path.resolve(process.cwd(), '.telegram_session.dat');
const ENCRYPTED_SESSION_CACHE_FILE = path.resolve(process.cwd(), '.telegram_session.enc');

export function isAuthFatalTelegramError(err: any): boolean {
  const msg = String(err?.errorMessage || err?.message || err || '');
  return (
    msg.includes('AUTH_KEY_UNREGISTERED') ||
    msg.includes('SESSION_REVOKED') ||
    msg.includes('AUTH_KEY_DUPLICATED') ||
    msg.includes('USER_DEACTIVATED') ||
    msg.includes('AUTH_KEY_INVALID') ||
    /\b401\b/.test(msg)
  );
}

export function normalizeChatIdCandidates(chatIdInput: string): string[] {
  const raw = chatIdInput.trim();
  const stripped = raw.replace(/^-100/, '').replace(/^-/, '');
  const candidates = new Set<string>([raw]);
  if (/^\d+$/.test(stripped)) {
    candidates.add(`-100${stripped}`);
    candidates.add(`-${stripped}`);
    candidates.add(stripped);
  }
  return Array.from(candidates);
}

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
  private lastDiagnostic: TelegramDiagnostic | null = null;
  private currentUser: any = null;
  private pendingAuth: PendingAuth | null = null;
  private isInitializing = false;
  private initPromise: Promise<void> | null = null;

  private constructor() {}

  public static getInstance(): TelegramService {
    if (!TelegramService.instance) {
      TelegramService.instance = new TelegramService();
    }
    return TelegramService.instance;
  }

  public getCredentials(): { apiId: number; apiHash: string; hasCredentials: boolean } {
    let apiId = Number(process.env.TELEGRAM_API_ID);
    let apiHash = process.env.TELEGRAM_API_HASH?.trim() || '';

    if ((!apiId || !apiHash) && !APP_CONFIG.isProduction && fs.existsSync(CREDENTIALS_FILE)) {
      try {
        const data = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
        if (data.apiId && data.apiHash) {
          apiId = Number(data.apiId);
          apiHash = String(data.apiHash).trim();
        }
      } catch {}
    }

    return {
      apiId: apiId || 0,
      apiHash: apiHash || '',
      hasCredentials: Boolean(apiId && apiHash && apiHash.length >= 10),
    };
  }

  public saveCredentials(apiId: number, apiHash: string): void {
    if (APP_CONFIG.isProduction) {
      throw new Error('In production, configure TELEGRAM_API_ID and TELEGRAM_API_HASH via Secret Manager/environment.');
    }
    fs.writeFileSync(
      CREDENTIALS_FILE,
      JSON.stringify({ apiId, apiHash: apiHash.trim(), savedAt: new Date().toISOString() }, null, 2),
      { encoding: 'utf8', mode: 0o600 }
    );
  }

  public getState() {
    const creds = this.getCredentials();
    return {
      state: this.state,
      errorMessage: this.errorMessage,
      lastDiagnostic: this.lastDiagnostic,
      user: this.currentUser,
      hasCredentials: creds.hasCredentials,
      apiIdConfigured: Boolean(creds.apiId),
      apiHashConfigured: Boolean(creds.apiHash),
      hasPendingAuth: Boolean(this.pendingAuth),
      pendingPhone: this.pendingAuth
        ? this.pendingAuth.phoneNumber.slice(-4).padStart(this.pendingAuth.phoneNumber.length, '*')
        : null,
    };
  }

  private writeEncryptedLocalCache(rawSession: string, status: 'active' | 'revoked_or_unregistered' = 'active'): void {
    try {
      const enc = encryptSession(rawSession);
      fs.writeFileSync(
        ENCRYPTED_SESSION_CACHE_FILE,
        JSON.stringify({ ...enc, sessionStatus: status, updatedAt: new Date().toISOString() }),
        { encoding: 'utf8', mode: 0o600 }
      );
      if (fs.existsSync(LEGACY_PLAINTEXT_SESSION_FILE)) {
        try {
          fs.unlinkSync(LEGACY_PLAINTEXT_SESSION_FILE);
        } catch {}
      }
    } catch {}
  }

  private readLocalEncryptedOrMigrateLegacy(): { session: string; sessionStatus?: string } | null {
    // 1. Read encrypted cache if present
    if (fs.existsSync(ENCRYPTED_SESSION_CACHE_FILE)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(ENCRYPTED_SESSION_CACHE_FILE, 'utf8'));
        if (parsed?.encryptedSession && parsed?.iv && parsed?.authTag) {
          const { session } = decryptSession(parsed.encryptedSession, parsed.iv, parsed.authTag);
          return { session, sessionStatus: parsed.sessionStatus };
        }
      } catch (err) {
        console.warn('[TelegramService] Failed to decrypt local encrypted session cache:', err);
      }
    }

    // 2. Migrate legacy plaintext .telegram_session.dat -> encrypted cache
    if (fs.existsSync(LEGACY_PLAINTEXT_SESSION_FILE)) {
      try {
        const legacyPlain = fs.readFileSync(LEGACY_PLAINTEXT_SESSION_FILE, 'utf8').trim();
        if (legacyPlain && legacyPlain.length > 20) {
          this.writeEncryptedLocalCache(legacyPlain, 'active');
          return { session: legacyPlain, sessionStatus: 'active' };
        }
      } catch {}
    }

    return null;
  }

  // Non-destructive quarantine: preserve encrypted backups & mark Login Required with diagnostics
  private async handleAuthFatalFailure(err: any, chatIdTried?: string): Promise<never> {
    const rawMsg = String(err?.errorMessage || err?.message || err || 'AUTH_KEY_UNREGISTERED');
    const codeMatch = rawMsg.match(/(AUTH_KEY_UNREGISTERED|SESSION_REVOKED|AUTH_KEY_DUPLICATED|USER_DEACTIVATED|AUTH_KEY_INVALID)/);
    const code = codeMatch ? codeMatch[1] : 'AUTH_KEY_UNREGISTERED';
    const now = new Date().toISOString();

    this.state = 'Login Required';
    this.errorMessage = `Telegram session is expired or unregistered (${code}). Please re-authorize your Telegram account in Settings > Telegram Account.`;
    this.lastDiagnostic = {
      code,
      message: rawMsg,
      failedAt: now,
      chatIdTried,
    };

    if (this.client) {
      try {
        await this.client.disconnect();
      } catch {}
      this.client = null;
    }

    // Preserve stored Firestore backup safely—ONLY update quarantine status metadata, NEVER delete the backup!
    try {
      const existing = await getSavedTelegramSession();
      if (existing) {
        await saveTelegramSession({
          ...existing,
          sessionStatus: 'revoked_or_unregistered',
          lastAuthError: `${code}: ${rawMsg}`.slice(0, 300),
          lastFailedAt: now,
          lastChatIdTried: chatIdTried,
          updatedAt: now,
        });
      }
    } catch {}

    throw new Error(this.errorMessage);
  }

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
        return;
      }

      this.state = 'Connecting';
      this.errorMessage = null;

      let decryptedSession = '';
      let storedPhoneMasked: string | null = null;
      let localStatus: string | undefined;

      const localCache = this.readLocalEncryptedOrMigrateLegacy();
      if (localCache) {
        decryptedSession = localCache.session;
        localStatus = localCache.sessionStatus;
      }

      const stored = await getSavedTelegramSession().catch(() => null);
      if (stored?.phoneMasked) {
        storedPhoneMasked = stored.phoneMasked;
      }

      if (!decryptedSession && stored?.encryptedSession) {
        try {
          const res = decryptSession(stored.encryptedSession, stored.iv, stored.authTag);
          decryptedSession = res.session;
          localStatus = stored.sessionStatus;
          this.writeEncryptedLocalCache(decryptedSession, stored.sessionStatus || 'active');

          // Re-encrypt under current primary key if historical fallback key was used
          if (res.usedLegacyKey) {
            const reEnc = encryptSession(decryptedSession);
            await saveTelegramSession({
              ...stored,
              encryptedSession: reEnc.encryptedSession,
              iv: reEnc.iv,
              authTag: reEnc.authTag,
              updatedAt: new Date().toISOString(),
            }).catch(() => {});
          }
        } catch (err) {
          console.error('[TelegramService] Failed to decrypt saved session:', err);
        }
      }

      if (!decryptedSession) {
        this.state = 'Not Connected';
        return;
      }

      if (stored?.sessionStatus === 'revoked_or_unregistered' || localStatus === 'revoked_or_unregistered') {
        this.state = 'Login Required';
        this.errorMessage =
          stored?.lastAuthError || 'Previous Telegram session was revoked or unregistered. Please re-authorize.';
        this.lastDiagnostic = {
          code: 'AUTH_KEY_UNREGISTERED',
          message: this.errorMessage,
          failedAt: stored?.lastFailedAt || new Date().toISOString(),
          chatIdTried: stored?.lastChatIdTried,
        };
        return;
      }

      const session = new StringSession(decryptedSession);
      this.client = new TelegramClient(session, creds.apiId, creds.apiHash, {
        connectionRetries: 5,
        retryDelay: 2000,
        autoReconnect: true,
        useWSS: false,
      });

      await withTimeout(this.client.connect(), 20000, 'Telegram connection timed out.');

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
        this.lastDiagnostic = null;
        console.log(`[TelegramService] Restored session for user: ${this.currentUser.firstName} (${this.currentUser.id})`);
      } else {
        await this.handleAuthFatalFailure(new Error('AUTH_KEY_UNREGISTERED: Saved session is no longer authorized.'));
      }
    } catch (error: any) {
      if (isAuthFatalTelegramError(error)) {
        await this.handleAuthFatalFailure(error).catch(() => {});
      } else {
        console.error('[TelegramService] Error initializing Telegram client:', error);
        this.state = 'Connection Error';
        this.errorMessage = error?.message || 'Failed to connect to Telegram MTProto servers';
      }
    } finally {
      this.isInitializing = false;
    }
  }

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

  public async reconnect(): Promise<TelegramClient> {
    if (this.state === 'Login Required') {
      throw new Error(this.errorMessage || 'Telegram login required before reconnecting.');
    }

    console.log('[TelegramService] Actively reconnecting Telegram client...');
    this.state = 'Reconnecting';
    this.errorMessage = null;

    if (this.client) {
      try {
        await withTimeout(this.client.connect(), 15000, 'Telegram reconnect timed out.');
        const ok = await withTimeout(this.client.checkAuthorization(), 10000, 'Telegram auth verify timed out.');
        if (!ok) {
          await this.handleAuthFatalFailure(new Error('AUTH_KEY_UNREGISTERED'));
        }
        if (this.isSocketConnected()) {
          this.state = 'Connected';
          this.errorMessage = null;
          return this.client;
        }
      } catch (quickErr: any) {
        if (isAuthFatalTelegramError(quickErr)) {
          await this.handleAuthFatalFailure(quickErr);
        }
        console.warn('[TelegramService] Quick socket reconnect failed, restoring full session:', quickErr?.message);
      }
    }

    await this.init();
    if (!this.client || this.state !== 'Connected') {
      throw new Error(this.errorMessage || 'Telegram client is not connected. Please authorize your Telegram account.');
    }
    return this.client;
  }

  public async ensureConnected(maxRetries = 3): Promise<TelegramClient> {
    if (this.state === 'Login Required') {
      throw new Error(this.errorMessage || 'Telegram session revoked/unregistered. Please re-authorize in Settings.');
    }

    if (this.initPromise) {
      try {
        await withTimeout(this.initPromise, 20000, 'Wait for Telegram initialization timed out.');
      } catch {}
    }

    if ((this.state as TelegramConnectionState) === 'Login Required') {
      throw new Error(this.errorMessage || 'Telegram session revoked/unregistered. Please re-authorize in Settings.');
    }

    if (this.client && this.state === 'Connected' && this.isSocketConnected()) {
      return this.client;
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this.reconnect();
      } catch (err: any) {
        if (isAuthFatalTelegramError(err) || (this.state as TelegramConnectionState) === 'Login Required') {
          throw err;
        }
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 1000 * attempt));
        }
      }
    }

    throw new Error(this.errorMessage || 'Telegram client is not connected. Please authorize your Telegram account first.');
  }

  public getClient(): TelegramClient {
    if (!this.client || this.state !== 'Connected') {
      throw new Error(this.errorMessage || 'Telegram client is not connected.');
    }
    return this.client;
  }

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
      this.lastDiagnostic = null;

      if (this.client) {
        try {
          await this.client.disconnect();
        } catch {}
      }

      const session = new StringSession('');
      this.client = new TelegramClient(session, creds.apiId, creds.apiHash, {
        connectionRetries: 5,
      });

      await withTimeout(this.client.connect(), 15000, 'Telegram connection timed out.');

      const result = await withTimeout(
        this.client.sendCode({ apiId: creds.apiId, apiHash: creds.apiHash }, cleanPhone),
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
        this.client.invoke(new Api.auth.CheckPassword({ password: passwordSrpCheck })),
        20000,
        'Telegram 2FA check request timed out.'
      )) as any;

      const user = result.user || result;
      return await this.finalizeLogin(user);
    } catch (error: any) {
      this.state = 'Waiting for Two-Step Verification';
      this.errorMessage = error?.message?.includes('PASSWORD_HASH_INVALID')
        ? 'Incorrect Two-Step Verification password.'
        : error?.message || 'Incorrect Two-Step Verification password.';
      throw error;
    }
  }

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
      username: (me as any).username || undefined,
      firstName: (me as any).firstName || '',
      sessionStatus: 'active',
      connectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await saveTelegramSession(storedData);
    this.writeEncryptedLocalCache(rawSession, 'active');

    this.currentUser = {
      id: String((me as any).id),
      username: (me as any).username || null,
      firstName: (me as any).firstName || '',
      lastName: (me as any).lastName || '',
      phone: phoneMasked,
    };

    this.state = 'Connected';
    this.errorMessage = null;
    this.lastDiagnostic = null;
    this.pendingAuth = null;
    return { success: true };
  }

  // Explicit admin disconnect only
  public async disconnect(): Promise<void> {
    try {
      if (this.client) {
        try {
          await this.client.disconnect();
        } catch {}
      }
    } finally {
      this.client = null;
      this.currentUser = null;
      this.pendingAuth = null;
      this.state = 'Not Connected';
      this.errorMessage = null;
      this.lastDiagnostic = null;
      try {
        if (fs.existsSync(ENCRYPTED_SESSION_CACHE_FILE)) fs.unlinkSync(ENCRYPTED_SESSION_CACHE_FILE);
        if (fs.existsSync(LEGACY_PLAINTEXT_SESSION_FILE)) fs.unlinkSync(LEGACY_PLAINTEXT_SESSION_FILE);
      } catch {}
      await deleteTelegramSession().catch(() => {});
    }
  }

  public async resolveTargetChat(
    chatIdInput: string
  ): Promise<{ entity: any; inputEntity: any; title: string; trueId: string }> {
    const rawTarget = chatIdInput.trim();
    const candidates = normalizeChatIdCandidates(rawTarget);
    const normalizedNumber = rawTarget.replace(/^-100/, '').replace(/^-/, '');
    const isNumeric = /^\d+$/.test(normalizedNumber);
    const targetUsername = rawTarget.replace(/^@/, '').toLowerCase();

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const client = await this.ensureConnected();

        // 1. Search dialogs first to populate accessHash cache cleanly
        try {
          const dialogs = await withTimeout(
            client.getDialogs({ limit: 150 }),
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
              candidates.includes(dId) ||
              (isNumeric && (dCleanId === normalizedNumber || entityId === normalizedNumber)) ||
              (entityTitle && entityTitle === rawTarget.toLowerCase()) ||
              (targetUsername && entityUsername === targetUsername)
            ) {
              const inputEntity =
                d.inputEntity ||
                (d.entity
                  ? await client.getInputEntity(d.entity)
                  : d.id
                  ? await client.getInputEntity(d.id as any)
                  : null);
              const title = d.title || (d.entity as any)?.title || rawTarget;
              return { entity: d.entity, inputEntity, title, trueId: dId };
            }
          }
        } catch (dialogErr: any) {
          if (isAuthFatalTelegramError(dialogErr)) {
            await this.handleAuthFatalFailure(dialogErr, rawTarget);
          }
          if (dialogErr?.message?.includes('Not connected')) {
            await this.reconnect();
            continue;
          }
        }

        // 2. Try normalized candidates (-100<id>, -<id>, raw) sequentially without masking 401
        let lastEntityErr: any = null;
        for (const candidate of candidates) {
          try {
            const entity = await withTimeout(
              client.getEntity(candidate),
              15000,
              'Telegram resolve entity timed out.'
            );
            const inputEntity = await client.getInputEntity(entity);
            return {
              entity,
              inputEntity,
              title: (entity as any).title || (entity as any).username || candidate,
              trueId: String((entity as any).id ? (candidate.startsWith('-100') ? candidate : (entity as any).id) : candidate),
            };
          } catch (entityErr: any) {
            if (isAuthFatalTelegramError(entityErr)) {
              await this.handleAuthFatalFailure(entityErr, candidate);
            }
            lastEntityErr = entityErr;
          }
        }

        if (lastEntityErr) throw lastEntityErr;
      } catch (e: any) {
        if (isAuthFatalTelegramError(e) || this.state === 'Login Required') {
          throw e;
        }
        console.warn(`[TelegramService] resolveTargetChat attempt ${attempt} error:`, e?.message || e);
        if (attempt < 2 && (e?.message?.includes('Not connected') || !this.isSocketConnected())) {
          await this.reconnect().catch(() => {});
          continue;
        }
        throw new Error(
          `Could not resolve Telegram destination '${chatIdInput}'. Verify channel membership/admin rights. (${e?.message || 'Unknown error'})`
        );
      }
    }

    throw new Error(`Could not resolve Telegram destination '${chatIdInput}'.`);
  }

  public async testStorage(chatIdInput: string): Promise<StorageConfig> {
    await this.ensureConnected();
    const { entity, title, trueId } = await this.resolveTargetChat(chatIdInput);

    const canUpload = Boolean(
      (entity as any).creator ||
        (entity as any).adminRights?.postMessages ||
        (entity as any).defaultBannedRights?.sendMessages === false ||
        true
    );

    const existing = (await getStorageConfig().catch(() => null)) || ({} as Partial<StorageConfig>);
    const storageConfig: StorageConfig = {
      ...existing,
      backend: 'telegram',
      chatId: trueId,
      chatTitle: title,
      canUpload,
      canRead: true,
      updatedAt: new Date().toISOString(),
    };

    await saveStorageConfig(storageConfig);
    return storageConfig;
  }

  public async uploadVideo(
    filePath: string,
    fileName: string,
    mimeType: string,
    caption: string,
    progressCallback?: (progress: number) => void
  ): Promise<{ messageId: number; size: number; duration?: number; chatId: string }> {
    const storage = await getStorageConfig();
    if (!storage || !storage.chatId) {
      throw new Error('Telegram storage destination is not configured.');
    }

    const stat = fs.statSync(filePath);
    const isMkv =
      fileName.toLowerCase().endsWith('.mkv') ||
      mimeType.toLowerCase().includes('matroska') ||
      mimeType.toLowerCase().includes('octet-stream');

    let lastError: any = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const client = await this.ensureConnected();
        const { inputEntity, trueId } = await this.resolveTargetChat(storage.chatId);
        const workers = attempt === 1 ? 2 : 1;

        const result = await withTimeout(
          client.sendFile(inputEntity, {
            file: filePath,
            caption: caption || `VidFrame: ${fileName}`,
            forceDocument: isMkv ? true : false,
            workers,
            progressCallback: (fraction: number) => {
              if (progressCallback) progressCallback(Math.round(fraction * 100));
            },
          }),
          1800000,
          'Telegram file upload timed out after 30 minutes.'
        );

        return {
          messageId: result.id,
          size: stat.size,
          chatId: trueId,
          duration: (result.media as any)?.document?.attributes?.find((a: any) => a.duration)?.duration || undefined,
        };
      } catch (err: any) {
        if (isAuthFatalTelegramError(err) || this.state === 'Login Required') {
          throw err;
        }
        lastError = err;
        const msg = err?.message || String(err);
        const isNet =
          msg.includes('Not connected') ||
          msg.includes('disconnected') ||
          msg.includes('Connection closed') ||
          msg.includes('TIMEOUT') ||
          !this.isSocketConnected();

        if (attempt < 3 && isNet) {
          await this.reconnect().catch(() => {});
          await new Promise((r) => setTimeout(r, 2000 * attempt));
        } else {
          break;
        }
      }
    }

    throw lastError || new Error(`Failed to upload ${fileName} to Telegram.`);
  }

  public async getMessageMedia(chatId: string, messageId: number) {
    for (let attempt = 1; attempt <= 2; attempt++) {
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
        if (isAuthFatalTelegramError(err) || this.state === 'Login Required') {
          throw err;
        }
        if (attempt < 2 && (err?.message?.includes('TIMEOUT') || err?.message?.includes('Not connected') || !this.isSocketConnected())) {
          await this.reconnect().catch(() => {});
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        throw err;
      }
    }
    throw new Error(`Media not found for Telegram message ID ${messageId}`);
  }
}
