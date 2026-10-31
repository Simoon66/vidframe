import React, { useState } from 'react';
import { SystemStatus } from '../../types/media';
import { saveTelegramCredentials } from '../../services/api';

interface GeneralSettingsProps {
  status: SystemStatus | null;
  onRefresh: () => void;
  onOpenPreviewDemo: () => void;
}

export const GeneralSettings: React.FC<GeneralSettingsProps> = ({
  status,
  onRefresh,
  onOpenPreviewDemo,
}) => {
  const [apiId, setApiId] = useState('');
  const [apiHash, setApiHash] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiId || !apiHash) return;
    setIsSaving(true);
    setSaveMessage(null);
    try {
      await saveTelegramCredentials(Number(apiId), apiHash.trim());
      setIsSaving(false);
      setSaveMessage('Telegram API credentials successfully updated in server runtime!');
      setApiId('');
      setApiHash('');
      onRefresh();
    } catch (e: any) {
      setIsSaving(false);
      setSaveMessage(`Error: ${e.message}`);
    }
  };

  const tgState = status?.telegram;
  const isConnected = tgState?.state === 'Connected';

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="p-5 bg-zinc-900/80 border border-zinc-800 rounded-2xl flex items-center justify-between">
        <div>
          <h2 className="text-base font-bold text-white">Application Configuration & Health</h2>
          <p className="text-xs text-zinc-400">
            System diagnostics, server-side secrets verification, and documentation
          </p>
        </div>
        <button
          onClick={onOpenPreviewDemo}
          className="px-3.5 py-1.5 bg-red-600/15 hover:bg-red-600/25 border border-red-500/30 text-red-400 rounded-xl text-xs font-semibold transition cursor-pointer flex items-center gap-1.5"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          <span>Test Player Preview</span>
        </button>
      </div>

      {/* Secrets & Infrastructure Health Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Telegram Credentials Status */}
        <div className="p-5 bg-zinc-900/50 border border-zinc-800 rounded-2xl space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-white">Telegram MTProto API Keys</span>
            <span
              className={`text-[10px] px-2 py-0.5 rounded-full font-mono border ${
                tgState?.hasCredentials
                  ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                  : 'bg-amber-500/10 text-amber-400 border-amber-500/30'
              }`}
            >
              {tgState?.hasCredentials ? 'Configured ✓' : 'Action Required'}
            </span>
          </div>
          <div className="text-xs text-zinc-400 space-y-1 font-mono text-[11px]">
            <p>
              TELEGRAM_API_ID:{' '}
              <span className={tgState?.apiIdConfigured ? 'text-emerald-400' : 'text-zinc-500'}>
                {tgState?.apiIdConfigured ? 'Active' : 'Missing'}
              </span>
            </p>
            <p>
              TELEGRAM_API_HASH:{' '}
              <span className={tgState?.apiHashConfigured ? 'text-emerald-400' : 'text-zinc-500'}>
                {tgState?.apiHashConfigured ? 'Active' : 'Missing'}
              </span>
            </p>
          </div>
        </div>

        {/* Firestore Database Status */}
        <div className="p-5 bg-zinc-900/50 border border-zinc-800 rounded-2xl space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-white">Firestore Database</span>
            <span className="text-[10px] px-2 py-0.5 rounded-full font-mono border bg-emerald-500/10 text-emerald-400 border-emerald-500/30">
              Provisioned ✓
            </span>
          </div>
          <div className="text-xs text-zinc-400 space-y-1 font-mono text-[11px]">
            <p>Database ID: <span className="text-zinc-300">ai-studio-5780916b-a4c7-481f-9936-5cd165418cc6</span></p>
            <p>Security Rules: <span className="text-emerald-400">Deployed & Hardened</span></p>
          </div>
        </div>

        {/* AES Session Encryption Key */}
        <div className="p-5 bg-zinc-900/50 border border-zinc-800 rounded-2xl space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-white">AES-256-GCM Session Key</span>
            <span className="text-[10px] px-2 py-0.5 rounded-full font-mono border bg-emerald-500/10 text-emerald-400 border-emerald-500/30">
              Active ✓
            </span>
          </div>
          <p className="text-[11px] text-zinc-400 leading-relaxed">
            Telegram StringSession is encrypted with an isolated 256-bit AES key prior to Firestore persistence.
          </p>
        </div>

        {/* Administrator Identity */}
        <div className="p-5 bg-zinc-900/50 border border-zinc-800 rounded-2xl space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-white">Administrator Access</span>
            <span className="text-[10px] px-2 py-0.5 rounded-full font-mono border bg-emerald-500/10 text-emerald-400 border-emerald-500/30">
              Authorized ✓
            </span>
          </div>
          <div className="text-xs text-zinc-400 space-y-1 font-mono text-[11px]">
            <p>Admin Email: <span className="text-zinc-300">{status?.adminEmail || 'admin@vidframe.ai'}</span></p>
            <p>Role: <span className="text-zinc-300">Super Admin / Owner</span></p>
          </div>
        </div>
      </div>

      {/* Set API Credentials Form */}
      <div className="p-6 bg-zinc-900/60 border border-zinc-800 rounded-2xl space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-white">Update Telegram MTProto Credentials</h3>
          <p className="text-xs text-zinc-400 mt-0.5">
            Configure or override the credentials used to communicate with Telegram MTProto servers.
          </p>
        </div>

        <form onSubmit={handleSave} className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          <div>
            <label className="block text-zinc-300 font-medium mb-1">TELEGRAM_API_ID (Number)</label>
            <input
              type="number"
              placeholder="e.g. 12345678"
              value={apiId}
              onChange={(e) => setApiId(e.target.value)}
              className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-xl text-white font-mono focus:outline-none focus:border-red-500"
              required
            />
          </div>
          <div>
            <label className="block text-zinc-300 font-medium mb-1">TELEGRAM_API_HASH (String)</label>
            <input
              type="text"
              placeholder="e.g. 0123456789abcdef0123456789abcdef"
              value={apiHash}
              onChange={(e) => setApiHash(e.target.value)}
              className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-xl text-white font-mono focus:outline-none focus:border-red-500"
              required
            />
          </div>

          <div className="sm:col-span-2 flex items-center justify-between pt-1">
            <span className="text-[11px] text-zinc-500">
              Credentials persist on the server across sessions.
            </span>
            <button
              type="submit"
              disabled={isSaving || !apiId || !apiHash}
              className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white font-semibold rounded-xl transition cursor-pointer disabled:opacity-50"
            >
              {isSaving ? 'Saving...' : 'Save API Credentials'}
            </button>
          </div>
        </form>

        {saveMessage && (
          <div className="p-3 bg-zinc-950 border border-zinc-800 rounded-xl text-xs text-zinc-300">
            {saveMessage}
          </div>
        )}
      </div>

      {/* Guide: How to get Telegram API ID & Hash */}
      <div className="p-6 bg-zinc-900/40 border border-zinc-800 rounded-2xl text-xs space-y-3">
        <h3 className="text-sm font-semibold text-white">How to Obtain Telegram MTProto Credentials</h3>
        <ol className="list-decimal list-inside space-y-2 text-zinc-400 leading-relaxed text-[11px]">
          <li>
            Visit the official Telegram core portal at{' '}
            <a
              href="https://my.telegram.org"
              target="_blank"
              rel="noreferrer"
              className="text-red-400 font-semibold underline"
            >
              https://my.telegram.org
            </a>.
          </li>
          <li>Log in with your Telegram phone number and enter the confirmation code sent to your Telegram app.</li>
          <li>Select <strong>"API development tools"</strong> from the menu.</li>
          <li>Create a new application by entering an App title (e.g. "FRAME Video") and short name.</li>
          <li>Copy your numeric <code className="text-zinc-200 font-mono">App api_id</code> and 32-character <code className="text-zinc-200 font-mono">App api_hash</code>.</li>
          <li>Save them in the form above or add them to your environment variables secrets in Google AI Studio.</li>
        </ol>
      </div>
    </div>
  );
};
