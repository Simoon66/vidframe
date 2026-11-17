import React, { useState } from 'react';
import { StorageConfig, StorageBackendMode, TelegramState } from '../../types/media';
import { testStorageChat, saveAndTestS3Storage, switchStorageBackend } from '../../services/api';

interface StorageSettingsProps {
  storageConfig: StorageConfig | null;
  telegramState: TelegramState | null;
  onRefresh: () => void;
  onGoToTelegram: () => void;
}

export const StorageSettings: React.FC<StorageSettingsProps> = ({
  storageConfig,
  telegramState,
  onRefresh,
  onGoToTelegram,
}) => {
  const activeBackend: StorageBackendMode = storageConfig?.backend || 'telegram';

  const [chatIdInput, setChatIdInput] = useState(storageConfig?.chatId || '');
  const [s3Endpoint, setS3Endpoint] = useState(storageConfig?.s3Endpoint || '');
  const [s3Region, setS3Region] = useState(storageConfig?.s3Region || 'auto');
  const [s3Bucket, setS3Bucket] = useState(storageConfig?.s3Bucket || '');
  const [s3AccessKeyId, setS3AccessKeyId] = useState(storageConfig?.s3AccessKeyId || '');
  const [s3SecretAccessKey, setS3SecretAccessKey] = useState('');
  const [s3CdnBaseUrl, setS3CdnBaseUrl] = useState(storageConfig?.s3CdnBaseUrl || '');
  const [s3ForcePathStyle, setS3ForcePathStyle] = useState(Boolean(storageConfig?.s3ForcePathStyle));
  const [activateS3AsDefault, setActivateS3AsDefault] = useState(activeBackend === 's3_r2');

  const [isTesting, setIsTesting] = useState(false);
  const [isSwitching, setIsSwitching] = useState(false);
  const [testResult, setTestResult] = useState<StorageConfig | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const isTelegramConnected = telegramState?.state === 'Connected';

  const handleSwitchBackend = async (backend: StorageBackendMode) => {
    setIsSwitching(true);
    setErrorMessage(null);
    setSuccessMessage(null);
    try {
      await switchStorageBackend(backend);
      setSuccessMessage(`Active default storage backend switched to '${backend}'.`);
      onRefresh();
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to switch storage backend.');
    } finally {
      setIsSwitching(false);
    }
  };

  const handleTestAndSaveTelegram = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatIdInput.trim()) {
      setErrorMessage('Please enter a Telegram Channel or Group ID or username.');
      return;
    }
    if (!isTelegramConnected) {
      setErrorMessage('Telegram account is not connected. Please connect your Telegram account first.');
      return;
    }

    setIsTesting(true);
    setErrorMessage(null);
    setSuccessMessage(null);
    setTestResult(null);

    try {
      const res = await testStorageChat(chatIdInput.trim());
      setTestResult(res.storage);
      setSuccessMessage(
        `Successfully connected to Telegram channel: "${res.storage.chatTitle}". Normalized Chat ID: ${res.storage.chatId}.`
      );
      onRefresh();
    } catch (err: any) {
      setErrorMessage(err.message || 'Verification failed. Make sure your Telegram account is an Admin.');
    } finally {
      setIsTesting(false);
    }
  };

  const handleSaveS3 = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!s3Endpoint.trim() || !s3Bucket.trim() || !s3AccessKeyId.trim()) {
      setErrorMessage('S3 endpoint URL, bucket name, and access key ID are required.');
      return;
    }

    setIsTesting(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const res = await saveAndTestS3Storage({
        endpoint: s3Endpoint.trim(),
        region: s3Region.trim() || 'auto',
        bucket: s3Bucket.trim(),
        accessKeyId: s3AccessKeyId.trim(),
        secretAccessKey: s3SecretAccessKey.trim() || undefined,
        cdnBaseUrl: s3CdnBaseUrl.trim() || undefined,
        forcePathStyle: s3ForcePathStyle,
        activateAsDefault: activateS3AsDefault,
      });
      setS3SecretAccessKey('');
      setSuccessMessage(`Verified & encrypted S3/R2 bucket '${s3Bucket.trim()}': ${res.detail}`);
      onRefresh();
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to verify S3/R2 bucket permissions.');
    } finally {
      setIsTesting(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header & Active Storage Adapter Selector */}
      <div className="p-5 bg-zinc-900/80 border border-zinc-800 rounded-2xl space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-bold text-white">Pluggable Object Storage Adapters</h2>
            <p className="text-xs text-zinc-400">
              Switch between S3 / Cloudflare R2 / GCS Interop, Telegram MTProto, or Dev-Only Local Store.
            </p>
          </div>
          <span className="text-[11px] font-mono px-3 py-1 rounded-full bg-zinc-950 border border-zinc-800 text-zinc-300 self-start">
            Active: <strong className="text-red-400">{activeBackend}</strong>
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
          {[
            {
              id: 's3_r2' as StorageBackendMode,
              title: 'S3 / Cloudflare R2',
              desc: 'Recommended for billion-scale HLS manifests, TS segments, thumbnails & VTT.',
            },
            {
              id: 'telegram' as StorageBackendMode,
              title: 'Telegram MTProto',
              desc: 'Uses your Telegram channel for zero-cost source & artifact archival.',
            },
            {
              id: 'local_dev' as StorageBackendMode,
              title: 'Local Object Store',
              desc: 'Single-instance disk storage under local_object_store/ for local testing.',
            },
          ].map((opt) => (
            <button
              key={opt.id}
              type="button"
              disabled={isSwitching}
              onClick={() => handleSwitchBackend(opt.id)}
              className={`p-3.5 rounded-xl border text-left transition cursor-pointer ${
                activeBackend === opt.id
                  ? 'bg-red-600/15 border-red-500/60 text-white'
                  : 'bg-zinc-950/70 border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200'
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="font-semibold text-xs">{opt.title}</span>
                {activeBackend === opt.id && (
                  <span className="text-[10px] font-mono text-red-400">ACTIVE</span>
                )}
              </div>
              <p className="text-[11px] text-zinc-400 leading-relaxed">{opt.desc}</p>
            </button>
          ))}
        </div>

        {storageConfig?.multiNodeMode && activeBackend === 'local_dev' && (
          <div className="p-3 bg-amber-950/40 border border-amber-500/30 rounded-xl text-[11px] text-amber-200">
            Warning: Multi-node runtime detected while using <code className="font-mono">local_dev</code>. Ephemeral local disk files will not replicate across stateless containers—configure S3 / R2 for production scale.
          </div>
        )}
      </div>

      {/* Feedback Banners */}
      {successMessage && (
        <div className="p-3.5 bg-emerald-950/40 border border-emerald-500/30 rounded-xl text-emerald-300 text-xs">
          {successMessage}
        </div>
      )}
      {errorMessage && (
        <div className="p-3.5 bg-red-950/40 border border-red-500/30 rounded-xl text-red-300 text-xs">
          {errorMessage}
        </div>
      )}

      {/* S3 / R2 / GCS Interop Form */}
      <div className="p-6 bg-zinc-900/60 border border-zinc-800 rounded-2xl space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-bold text-white">S3 / Cloudflare R2 / GCS Interop Credentials</h3>
            <p className="text-[11px] text-zinc-400">
              Secret keys are encrypted with AES-256-GCM on the server and never returned to the browser.
            </p>
          </div>
          {storageConfig?.s3Configured && (
            <span className="text-[10px] px-2.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-mono">
              Configured (encrypted)
            </span>
          )}
        </div>

        <form onSubmit={handleSaveS3} className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 text-xs">
          <div className="sm:col-span-2">
            <label className="block text-zinc-300 font-medium mb-1">S3 Endpoint URL</label>
            <input
              type="url"
              placeholder="https://<accountid>.r2.cloudflarestorage.com or https://s3.us-east-1.amazonaws.com"
              value={s3Endpoint}
              onChange={(e) => setS3Endpoint(e.target.value)}
              className="w-full px-3.5 py-2 bg-zinc-950 border border-zinc-800 rounded-xl text-white font-mono focus:outline-none focus:border-red-500"
              required
            />
          </div>

          <div>
            <label className="block text-zinc-300 font-medium mb-1">Bucket Name</label>
            <input
              type="text"
              placeholder="vidframe-media-prod"
              value={s3Bucket}
              onChange={(e) => setS3Bucket(e.target.value)}
              className="w-full px-3.5 py-2 bg-zinc-950 border border-zinc-800 rounded-xl text-white font-mono focus:outline-none focus:border-red-500"
              required
            />
          </div>

          <div>
            <label className="block text-zinc-300 font-medium mb-1">Region</label>
            <input
              type="text"
              placeholder="auto or us-east-1"
              value={s3Region}
              onChange={(e) => setS3Region(e.target.value)}
              className="w-full px-3.5 py-2 bg-zinc-950 border border-zinc-800 rounded-xl text-white font-mono focus:outline-none focus:border-red-500"
            />
          </div>

          <div>
            <label className="block text-zinc-300 font-medium mb-1">Access Key ID</label>
            <input
              type="text"
              placeholder="AKIA..."
              value={s3AccessKeyId}
              onChange={(e) => setS3AccessKeyId(e.target.value)}
              className="w-full px-3.5 py-2 bg-zinc-950 border border-zinc-800 rounded-xl text-white font-mono focus:outline-none focus:border-red-500"
              required
            />
          </div>

          <div>
            <label className="block text-zinc-300 font-medium mb-1">
              Secret Access Key {storageConfig?.s3Configured ? '(leave blank to keep existing)' : ''}
            </label>
            <input
              type="password"
              placeholder={storageConfig?.s3Configured ? '••••••••••••••••' : 'Enter Secret Access Key'}
              value={s3SecretAccessKey}
              onChange={(e) => setS3SecretAccessKey(e.target.value)}
              className="w-full px-3.5 py-2 bg-zinc-950 border border-zinc-800 rounded-xl text-white font-mono focus:outline-none focus:border-red-500"
            />
          </div>

          <div className="sm:col-span-2">
            <label className="block text-zinc-300 font-medium mb-1">Optional Public Edge CDN Base URL</label>
            <input
              type="url"
              placeholder="https://cdn.yourdomain.com (leave empty to serve via /api/cdn/v1/hls)"
              value={s3CdnBaseUrl}
              onChange={(e) => setS3CdnBaseUrl(e.target.value)}
              className="w-full px-3.5 py-2 bg-zinc-950 border border-zinc-800 rounded-xl text-white font-mono focus:outline-none focus:border-red-500"
            />
          </div>

          <div className="sm:col-span-2 flex flex-wrap items-center justify-between gap-3 pt-1">
            <div className="flex flex-wrap items-center gap-4">
              <label className="inline-flex items-center gap-2 text-zinc-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={s3ForcePathStyle}
                  onChange={(e) => setS3ForcePathStyle(e.target.checked)}
                  className="rounded border-zinc-700 bg-zinc-900 text-red-600"
                />
                <span>Force Path-Style URLs (MinIO / Custom S3)</span>
              </label>

              <label className="inline-flex items-center gap-2 text-zinc-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={activateS3AsDefault}
                  onChange={(e) => setActivateS3AsDefault(e.target.checked)}
                  className="rounded border-zinc-700 bg-zinc-900 text-red-600"
                />
                <span>Activate as default backend after test</span>
              </label>
            </div>

            <button
              type="submit"
              disabled={isTesting}
              className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded-xl font-semibold transition cursor-pointer disabled:opacity-50"
            >
              {isTesting ? 'Verifying S3 Bucket...' : 'Test & Save S3 / R2'}
            </button>
          </div>
        </form>
      </div>

      {/* Telegram Channel Destination Section */}
      <div className="p-6 bg-zinc-900/60 border border-zinc-800 rounded-2xl space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-bold text-white">Telegram Storage Channel</h3>
            <p className="text-[11px] text-zinc-400">
              Channel or group used by the Telegram MTProto adapter (auto-normalized with <code className="font-mono">-100</code>).
            </p>
          </div>
          {!isTelegramConnected && (
            <button
              type="button"
              onClick={onGoToTelegram}
              className="px-3 py-1 bg-amber-600/20 border border-amber-500/40 text-amber-300 rounded-lg text-xs font-semibold cursor-pointer"
            >
              Connect Telegram
            </button>
          )}
        </div>

        <form onSubmit={handleTestAndSaveTelegram} className="space-y-3 text-xs">
          <div>
            <label className="block font-medium text-zinc-300 mb-1">Channel ID or @username</label>
            <input
              type="text"
              placeholder="e.g. -1002345678901 or @my_storage_channel"
              value={chatIdInput}
              onChange={(e) => setChatIdInput(e.target.value)}
              className="w-full px-4 py-2.5 bg-zinc-950 border border-zinc-800 rounded-xl text-white placeholder-zinc-600 focus:outline-none focus:border-red-500 font-mono transition"
              required
            />
          </div>

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={isTesting || !chatIdInput.trim() || !isTelegramConnected}
              className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-white rounded-xl font-semibold border border-zinc-700 transition cursor-pointer disabled:opacity-50"
            >
              {isTesting ? 'Verifying Channel...' : 'Verify & Save Telegram Channel'}
            </button>
          </div>
        </form>

        {(testResult || storageConfig?.chatId) && (
          <div className="p-3.5 bg-zinc-950/80 border border-zinc-800 rounded-xl grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
            <div>
              <span className="text-zinc-500 block text-[10px] uppercase font-mono">Channel Title</span>
              <span className="text-white font-medium">{testResult?.chatTitle || storageConfig?.chatTitle || 'Configured'}</span>
            </div>
            <div>
              <span className="text-zinc-500 block text-[10px] uppercase font-mono">Normalized ID</span>
              <span className="text-zinc-300 font-mono">{testResult?.chatId || storageConfig?.chatId}</span>
            </div>
            <div>
              <span className="text-zinc-500 block text-[10px] uppercase font-mono">Permission</span>
              <span className="text-emerald-400 font-semibold">Verified ✓</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
