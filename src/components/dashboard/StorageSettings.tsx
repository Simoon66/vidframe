import React, { useState } from 'react';
import { StorageConfig, TelegramState } from '../../types/media';
import { testStorageChat } from '../../services/api';

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
  const [chatIdInput, setChatIdInput] = useState(storageConfig?.chatId || '');
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<StorageConfig | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const isTelegramConnected = telegramState?.state === 'Connected';

  const handleTestAndSave = async (e: React.FormEvent) => {
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
      setIsTesting(false);
      setTestResult(res.storage);
      setSuccessMessage(`Successfully connected to Telegram channel: "${res.storage.chatTitle}". Storage configuration updated in Firestore.`);
      onRefresh();
    } catch (err: any) {
      setIsTesting(false);
      setErrorMessage(err.message || 'Verification failed. Make sure your Telegram account is an Admin with Post permission.');
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="p-5 bg-zinc-900/80 border border-zinc-800 rounded-2xl flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-red-600/10 border border-red-500/20 flex items-center justify-center text-red-500">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>
          </div>
          <div>
            <h2 className="text-base font-bold text-white">Telegram Storage Destination</h2>
            <p className="text-xs text-zinc-400">
              Private Telegram channel used to store and stream high-capacity video files
            </p>
          </div>
        </div>
      </div>

      {/* Telegram Connection Alert if not connected */}
      {!isTelegramConnected && (
        <div className="p-4 bg-amber-950/40 border border-amber-500/30 rounded-2xl flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
          <div>
            <span className="font-semibold text-amber-200 block">Telegram Account Required</span>
            <span className="text-amber-300/80 text-[11px]">
              You must log in to Telegram before validating access to private storage channels.
            </span>
          </div>
          <button
            onClick={onGoToTelegram}
            className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white font-semibold rounded-xl transition cursor-pointer self-start sm:self-auto"
          >
            Connect Telegram
          </button>
        </div>
      )}

      {/* Main Form */}
      <div className="p-6 bg-zinc-900/60 border border-zinc-800 rounded-2xl space-y-5">
        <form onSubmit={handleTestAndSave} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-zinc-300 mb-1.5">
              Storage Channel or Group ID
            </label>
            <input
              type="text"
              placeholder="e.g. -1002345678901 or @my_storage_channel"
              value={chatIdInput}
              onChange={(e) => setChatIdInput(e.target.value)}
              className="w-full px-4 py-2.5 bg-zinc-950 border border-zinc-800 rounded-xl text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-red-500 font-mono transition"
              required
            />
            <p className="text-[11px] text-zinc-500 mt-1 leading-relaxed">
              Accepts numeric chat IDs with the <code className="text-zinc-400">-100</code> prefix or public channel usernames. The authorized Telegram account must have Administrator rights or permission to post media.
            </p>
          </div>

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="submit"
              disabled={isTesting || !chatIdInput.trim() || !isTelegramConnected}
              className="px-5 py-2.5 bg-red-600 hover:bg-red-500 text-white rounded-xl text-xs font-semibold shadow-lg shadow-red-950/60 transition active:scale-95 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {isTesting ? (
                <>
                  <div className="w-3.5 h-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  <span>Verifying Permissions...</span>
                </>
              ) : (
                <span>Test & Save Destination</span>
              )}
            </button>
          </div>
        </form>

        {/* Notifications */}
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

        {/* Current / Verified Channel Card */}
        {(testResult || storageConfig?.chatId) && (
          <div className="mt-4 p-4 bg-zinc-950/80 border border-zinc-800 rounded-xl space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-white">Active Channel Access Verification</span>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-mono">
                Verified
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
              <div>
                <span className="text-zinc-500 block text-[10px] uppercase font-mono">Channel Title</span>
                <span className="text-white font-medium">{testResult?.chatTitle || storageConfig?.chatTitle}</span>
              </div>
              <div>
                <span className="text-zinc-500 block text-[10px] uppercase font-mono">Chat ID</span>
                <span className="text-zinc-300 font-mono">{testResult?.chatId || storageConfig?.chatId}</span>
              </div>
              <div>
                <span className="text-zinc-500 block text-[10px] uppercase font-mono">Upload Permission</span>
                <span className="text-emerald-400 font-semibold">Granted ✓</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Helpful Instructions Card */}
      <div className="p-5 bg-zinc-900/40 border border-zinc-800 rounded-2xl text-xs text-zinc-400 space-y-2.5">
        <h4 className="text-zinc-200 font-semibold text-sm">How to set up your Telegram Storage Channel</h4>
        <ol className="list-decimal list-inside space-y-1.5 text-zinc-400 leading-relaxed text-[11px]">
          <li>Open your Telegram app on mobile or desktop and create a new <strong>Private Channel</strong> (e.g. "My Video Storage").</li>
          <li>Make sure your authorized Telegram account is the <strong>Owner</strong> or has <strong>Administrator permissions</strong> with "Post Messages" enabled.</li>
          <li>Forward any message from that channel to a bot such as <code className="text-zinc-300 font-mono">@userinfobot</code> or check channel info to copy the Channel ID (usually starts with <code className="text-zinc-300 font-mono">-100</code>).</li>
          <li>Paste the ID into the field above and click <strong>Test & Save Destination</strong>.</li>
        </ol>
      </div>
    </div>
  );
};
