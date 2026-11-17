import React, { useState } from 'react';
import { TelegramState } from '../../types/media';
import {
  sendTelegramCode,
  verifyTelegramCode,
  verifyTelegram2FA,
  disconnectTelegram,
  reconnectTelegram,
  saveTelegramCredentials,
} from '../../services/api';

interface TelegramConnectProps {
  state: TelegramState | null;
  onRefresh: () => void;
  onGoToStorage: () => void;
}

export const TelegramConnect: React.FC<TelegramConnectProps> = ({
  state,
  onRefresh,
  onGoToStorage,
}) => {
  // Input fields
  const [phoneNumber, setPhoneNumber] = useState('');
  const [code, setCode] = useState('');
  const [twoFAPassword, setTwoFAPassword] = useState('');

  // Credentials config fields
  const [showCredsModal, setShowCredsModal] = useState(false);
  const [apiIdInput, setApiIdInput] = useState('');
  const [apiHashInput, setApiHashInput] = useState('');

  // Loading & error states
  const [isLoading, setIsLoading] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successNotice, setSuccessNotice] = useState<string | null>(null);

  const isConnected = state?.state === 'Connected';
  const isWaitingForCode = state?.state === 'Waiting for Code';
  const isWaitingFor2FA = state?.state === 'Waiting for Two-Step Verification';

  // Step 1: Send Code
  const handleSendCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!phoneNumber.trim()) {
      setErrorMessage('Please enter your international phone number, e.g. +14155552671');
      return;
    }

    setIsLoading(true);
    setErrorMessage(null);
    setSuccessNotice(null);

    try {
      await sendTelegramCode(phoneNumber.trim());
      setIsLoading(false);
      setSuccessNotice('Login code sent! Please check your official Telegram app messages.');
      onRefresh();
    } catch (err: any) {
      setIsLoading(false);
      setErrorMessage(err.message || 'Failed to request login code from Telegram MTProto.');
    }
  };

  // Step 2: Verify Code
  const handleVerifyCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim()) {
      setErrorMessage('Please enter the verification code received on Telegram.');
      return;
    }

    setIsLoading(true);
    setErrorMessage(null);

    try {
      const res = await verifyTelegramCode(code.trim());
      setIsLoading(false);
      if (res.requires2FA) {
        setSuccessNotice('Two-Step Verification (2FA) is enabled on your account. Please enter your cloud password.');
      } else {
        setSuccessNotice('Successfully authenticated with Telegram MTProto! Session encrypted and saved to Firestore.');
      }
      onRefresh();
    } catch (err: any) {
      setIsLoading(false);
      setErrorMessage(err.message || 'Invalid or expired Telegram code.');
    }
  };

  // Step 3: Verify 2FA
  const handleVerify2FA = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!twoFAPassword) {
      setErrorMessage('Please enter your Two-Step Verification password.');
      return;
    }

    setIsLoading(true);
    setErrorMessage(null);

    try {
      await verifyTelegram2FA(twoFAPassword);
      setIsLoading(false);
      setSuccessNotice('Two-Step Verification successful! Session encrypted and saved to Firestore.');
      onRefresh();
    } catch (err: any) {
      setIsLoading(false);
      setErrorMessage(err.message || 'Incorrect 2FA password.');
    }
  };

  // Disconnect
  const handleDisconnect = async () => {
    setIsLoading(true);
    setConfirmDisconnect(false);
    setErrorMessage(null);
    try {
      await disconnectTelegram();
      setIsLoading(false);
      setSuccessNotice('Telegram session disconnected.');
      setPhoneNumber('');
      setCode('');
      setTwoFAPassword('');
      onRefresh();
    } catch (err: any) {
      setIsLoading(false);
      setErrorMessage(err.message || 'Failed to disconnect.');
    }
  };

  // Actively reconnect / health-check MTProto session
  const handleReconnect = async () => {
    setIsLoading(true);
    setErrorMessage(null);
    setSuccessNotice(null);
    try {
      await reconnectTelegram();
      setIsLoading(false);
      setSuccessNotice('Telegram MTProto client is connected and healthy!');
      onRefresh();
    } catch (err: any) {
      setIsLoading(false);
      setErrorMessage(err.message || 'Failed to reconnect Telegram client.');
    }
  };

  // Save Credentials
  const handleSaveCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiIdInput || !apiHashInput) {
      setErrorMessage('Please enter both API ID and API Hash.');
      return;
    }

    setIsLoading(true);
    setErrorMessage(null);
    try {
      await saveTelegramCredentials(Number(apiIdInput), apiHashInput.trim());
      setIsLoading(false);
      setShowCredsModal(false);
      setSuccessNotice('Telegram API credentials saved successfully.');
      onRefresh();
    } catch (err: any) {
      setIsLoading(false);
      setErrorMessage(err.message || 'Failed to save credentials.');
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Title & Connection Status Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-5 bg-zinc-900/80 border border-zinc-800/90 rounded-2xl">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-blue-500/10 border border-blue-500/30 flex items-center justify-center text-blue-400">
            <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>
          </div>
          <div>
            <h2 className="text-base font-bold text-white">Telegram MTProto Authorization</h2>
            <p className="text-xs text-zinc-400">
              GramJS client session with AES-256-GCM persistent single-login
            </p>
          </div>
        </div>

        {/* Status Badge */}
        <div className="flex items-center gap-2">
          <span
            className={`text-xs px-3 py-1 rounded-full font-semibold border flex items-center gap-2 ${
              isConnected
                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                : state?.state === 'Login Required' || state?.state === 'Connection Error'
                ? 'bg-red-500/10 text-red-400 border-red-500/30'
                : state?.state === 'Connecting' || state?.state === 'Reconnecting'
                ? 'bg-blue-500/10 text-blue-400 border-blue-500/30'
                : isWaitingForCode || isWaitingFor2FA
                ? 'bg-amber-500/10 text-amber-400 border-amber-500/30'
                : 'bg-zinc-800 text-zinc-400 border-zinc-700'
            }`}
          >
            <span
              className={`w-2 h-2 rounded-full ${
                isConnected
                  ? 'bg-emerald-500 animate-pulse'
                  : state?.state === 'Login Required' || state?.state === 'Connection Error'
                  ? 'bg-red-500'
                  : isWaitingForCode || isWaitingFor2FA
                  ? 'bg-amber-400 animate-pulse'
                  : 'bg-zinc-500'
              }`}
            />
            <span>{state?.state || 'Not Connected'}</span>
          </span>
        </div>
      </div>

      {/* Diagnostic Banner for Login Required / AUTH_KEY_UNREGISTERED / Destination Resolution */}
      {(state?.state === 'Login Required' || state?.lastDiagnostic) && !isConnected && (
        <div className="p-4 bg-red-950/35 border border-red-500/40 rounded-2xl text-xs space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="font-bold text-red-300">
              {state?.state === 'Login Required'
                ? 'Telegram Session Requires Re-Authorization (401 / AUTH_KEY_UNREGISTERED)'
                : `MTProto Diagnostic (${state?.lastDiagnostic?.code})`}
            </span>
            {state?.lastDiagnostic?.failedAt && (
              <span className="text-[10px] font-mono text-zinc-400">
                {new Date(state.lastDiagnostic.failedAt).toLocaleString()}
              </span>
            )}
          </div>
          <p className="text-zinc-300 leading-relaxed">
            {state?.lastDiagnostic?.message ||
              state?.errorMessage ||
              'The stored Telegram MTProto auth key was invalidated by Telegram or unregistered.'}
          </p>
          {state?.lastDiagnostic?.chatIdTried && (
            <p className="text-[11px] font-mono text-zinc-400">
              Channel/Peer Target Attempted: <span className="text-zinc-200">{state.lastDiagnostic.chatIdTried}</span>
            </p>
          )}
          <p className="text-[11px] text-amber-300/90">
            Your encrypted Firestore session backup has been preserved rather than wiped automatically. Sign in below with your phone number to issue a fresh MTProto session key, or click Retry Reconnect if transient.
          </p>
          <div>
            <button
              type="button"
              onClick={handleReconnect}
              disabled={isLoading}
              className="px-3 py-1.5 bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-200 rounded-lg font-medium transition cursor-pointer"
            >
              Retry Socket Reconnect
            </button>
          </div>
        </div>
      )}

      {/* Notifications */}
      {successNotice && (
        <div className="p-3.5 bg-emerald-950/40 border border-emerald-500/30 rounded-xl text-emerald-300 text-xs flex items-center justify-between">
          <span>{successNotice}</span>
          <button onClick={() => setSuccessNotice(null)} className="text-emerald-400 hover:text-emerald-200 cursor-pointer">✕</button>
        </div>
      )}

      {errorMessage && (
        <div className="p-3.5 bg-red-950/40 border border-red-500/30 rounded-xl text-red-300 text-xs flex items-center justify-between">
          <span>{errorMessage}</span>
          <button onClick={() => setErrorMessage(null)} className="text-red-400 hover:text-red-200 cursor-pointer">✕</button>
        </div>
      )}

      {/* Connected Account Card */}
      {isConnected && state?.user && (
        <div className="p-6 bg-zinc-900/60 border border-zinc-800 rounded-2xl space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white">Authorized Telegram User</h3>
            <span className="text-[11px] text-emerald-400 font-mono bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-0.5 rounded-full">
              Session Active & Restored
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 p-4 bg-zinc-950/80 border border-zinc-800/80 rounded-xl text-xs">
            <div>
              <span className="text-zinc-500 block text-[10px] uppercase font-mono">Full Name</span>
              <span className="text-white font-medium">
                {state.user.firstName} {state.user.lastName}
              </span>
            </div>
            <div>
              <span className="text-zinc-500 block text-[10px] uppercase font-mono">Username</span>
              <span className="text-zinc-300 font-mono">
                {state.user.username ? `@${state.user.username}` : 'No username set'}
              </span>
            </div>
            <div>
              <span className="text-zinc-500 block text-[10px] uppercase font-mono">User ID</span>
              <span className="text-zinc-300 font-mono">{state.user.id}</span>
            </div>
          </div>

          <div className="p-3.5 bg-zinc-950/50 border border-zinc-800/60 rounded-xl text-xs text-zinc-400 space-y-1">
            <div className="flex items-center gap-1.5 text-zinc-300 font-medium">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
              <span>Cross-Domain Single-Login Persistence</span>
            </div>
            <p className="text-[11px] text-zinc-500 leading-relaxed">
              Both your Telegram API credentials and MTProto session are AES-256-GCM encrypted in Firestore and auto-restore across every domain (dev, preview, custom domains, and container restarts). Idle sockets automatically close after 3 minutes so logging in once never triggers duplicate-session bans.
            </p>
          </div>

          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-2">
            <button
              onClick={onGoToStorage}
              className="w-full sm:w-auto px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded-xl text-xs font-semibold shadow-md transition active:scale-95 cursor-pointer flex items-center justify-center gap-2"
            >
              <span>Proceed to Storage Settings</span>
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
            </button>

            <div className="flex items-center gap-2 w-full sm:w-auto">
              <button
                onClick={handleReconnect}
                disabled={isLoading}
                className="w-full sm:w-auto px-3.5 py-2 bg-blue-950/40 hover:bg-blue-900/60 text-blue-300 border border-blue-500/30 rounded-xl text-xs font-medium transition cursor-pointer flex items-center justify-center gap-1.5"
                title="Verify socket health or re-establish MTProto connection"
              >
                <span>🔄</span>
                <span>Check / Reconnect Socket</span>
              </button>

              {!confirmDisconnect ? (
                <button
                  onClick={() => setConfirmDisconnect(true)}
                  disabled={isLoading}
                  className="w-full sm:w-auto px-3.5 py-2 bg-zinc-800 hover:bg-red-950/40 text-zinc-400 hover:text-red-400 border border-zinc-700/80 hover:border-red-800/60 rounded-xl text-xs font-medium transition cursor-pointer"
                >
                  Disconnect
                </button>
              ) : (
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={handleDisconnect}
                    disabled={isLoading}
                    className="px-3 py-2 bg-red-600 hover:bg-red-500 text-white rounded-xl text-xs font-semibold cursor-pointer"
                  >
                    Confirm Disconnect
                  </button>
                  <button
                    onClick={() => setConfirmDisconnect(false)}
                    className="px-2.5 py-2 bg-zinc-800 text-zinc-300 rounded-xl text-xs cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Login Flow (If not connected) */}
      {!isConnected && (
        <div className="p-6 bg-zinc-900/60 border border-zinc-800 rounded-2xl space-y-5">
          <div>
            <h3 className="text-sm font-semibold text-white mb-1">Log in to your Telegram Account</h3>
            <p className="text-xs text-zinc-400">
              FRAME uses personal Telegram accounts via official MTProto to store and stream video files without bot size restrictions.
            </p>
          </div>

          {/* Credentials Status Check */}
          {!state?.hasCredentials && (
            <div className="p-4 bg-amber-950/30 border border-amber-500/30 rounded-xl text-xs space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-amber-200">Telegram API ID & API Hash Not Set</span>
                <button
                  onClick={() => setShowCredsModal(true)}
                  className="px-3 py-1 bg-amber-600 hover:bg-amber-500 text-white font-semibold rounded-lg transition cursor-pointer"
                >
                  Configure API Keys
                </button>
              </div>
              <p className="text-zinc-400 text-[11px] leading-relaxed">
                Before logging in, provide your Telegram API ID and API Hash from <a href="https://my.telegram.org" target="_blank" rel="noreferrer" className="text-amber-400 underline">my.telegram.org</a>.
              </p>
            </div>
          )}

          {/* Step 1: Phone Number */}
          {!isWaitingForCode && !isWaitingFor2FA && (
            <form onSubmit={handleSendCode} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                  Telegram Phone Number (International Format)
                </label>
                <input
                  type="tel"
                  placeholder="+14155552671"
                  value={phoneNumber}
                  onChange={(e) => setPhoneNumber(e.target.value)}
                  disabled={isLoading}
                  className="w-full px-4 py-2.5 bg-zinc-950 border border-zinc-800 rounded-xl text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-red-500 transition font-mono"
                  required
                />
                <p className="text-[11px] text-zinc-500 mt-1">
                  Must include country code (e.g. +1 for US/Canada, +44 for UK, +62 for Indonesia, +91 for India).
                </p>
              </div>

              <div className="flex items-center justify-between pt-2">
                <button
                  type="button"
                  onClick={() => setShowCredsModal(true)}
                  className="text-xs text-zinc-400 hover:text-white underline cursor-pointer"
                >
                  Configure API ID & Hash
                </button>

                <button
                  type="submit"
                  disabled={isLoading}
                  className="px-5 py-2.5 bg-red-600 hover:bg-red-500 text-white rounded-xl text-xs font-semibold shadow-lg shadow-red-950/60 transition active:scale-95 cursor-pointer disabled:opacity-50 flex items-center gap-2"
                >
                  {isLoading ? (
                    <>
                      <div className="w-3.5 h-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                      <span>Requesting Code...</span>
                    </>
                  ) : (
                    <span>Send Login Code</span>
                  )}
                </button>
              </div>
            </form>
          )}

          {/* Step 2: Verification Code */}
          {isWaitingForCode && (
            <form onSubmit={handleVerifyCode} className="space-y-4 animate-in fade-in duration-200">
              <div className="p-3 bg-zinc-950 border border-zinc-800 rounded-xl text-xs text-zinc-400">
                <span>Code sent to Telegram app on </span>
                <span className="font-mono text-white font-semibold">{phoneNumber || state?.pendingPhone}</span>
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                  Telegram Verification Code
                </label>
                <input
                  type="text"
                  placeholder="12345"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  disabled={isLoading}
                  autoFocus
                  className="w-full px-4 py-2.5 bg-zinc-950 border border-zinc-800 rounded-xl text-base text-white tracking-widest text-center placeholder-zinc-600 focus:outline-none focus:border-red-500 transition font-mono font-bold"
                  required
                />
              </div>

              <div className="flex items-center justify-between pt-2">
                <button
                  type="button"
                  onClick={() => {
                    handleDisconnect();
                  }}
                  className="text-xs text-zinc-500 hover:text-zinc-300 cursor-pointer"
                >
                  Back to Phone Entry
                </button>

                <button
                  type="submit"
                  disabled={isLoading}
                  className="px-5 py-2.5 bg-red-600 hover:bg-red-500 text-white rounded-xl text-xs font-semibold shadow-lg shadow-red-950/60 transition active:scale-95 cursor-pointer disabled:opacity-50 flex items-center gap-2"
                >
                  {isLoading ? (
                    <>
                      <div className="w-3.5 h-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                      <span>Verifying...</span>
                    </>
                  ) : (
                    <span>Verify Code</span>
                  )}
                </button>
              </div>
            </form>
          )}

          {/* Step 3: Two-Step Verification Password */}
          {isWaitingFor2FA && (
            <form onSubmit={handleVerify2FA} className="space-y-4 animate-in fade-in duration-200">
              <div className="p-3 bg-blue-950/30 border border-blue-500/30 rounded-xl text-xs text-blue-300">
                Two-Step Verification is active on this account. Enter your cloud password to complete authorization.
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                  Telegram 2FA Password
                </label>
                <input
                  type="password"
                  placeholder="Enter 2FA password"
                  value={twoFAPassword}
                  onChange={(e) => setTwoFAPassword(e.target.value)}
                  disabled={isLoading}
                  autoFocus
                  className="w-full px-4 py-2.5 bg-zinc-950 border border-zinc-800 rounded-xl text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-red-500 transition"
                  required
                />
              </div>

              <div className="flex items-center justify-between pt-2">
                <button
                  type="button"
                  onClick={() => handleDisconnect()}
                  className="text-xs text-zinc-500 hover:text-zinc-300 cursor-pointer"
                >
                  Cancel
                </button>

                <button
                  type="submit"
                  disabled={isLoading}
                  className="px-5 py-2.5 bg-red-600 hover:bg-red-500 text-white rounded-xl text-xs font-semibold shadow-lg shadow-red-950/60 transition active:scale-95 cursor-pointer disabled:opacity-50 flex items-center gap-2"
                >
                  {isLoading ? (
                    <>
                      <div className="w-3.5 h-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                      <span>Authenticating...</span>
                    </>
                  ) : (
                    <span>Complete Login</span>
                  )}
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {/* Telegram Credentials Modal */}
      {showCredsModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
          <div
            className="w-full max-w-md bg-zinc-950 border border-zinc-800 rounded-2xl p-6 text-zinc-300 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-3 border-b border-zinc-800 mb-4">
              <h4 className="text-sm font-bold text-white">Telegram MTProto API Credentials</h4>
              <button
                onClick={() => setShowCredsModal(false)}
                className="text-zinc-400 hover:text-white"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSaveCredentials} className="space-y-3.5 text-xs">
              <p className="text-[11px] text-zinc-400 leading-relaxed">
                Obtain free developer credentials from{' '}
                <a
                  href="https://my.telegram.org"
                  target="_blank"
                  rel="noreferrer"
                  className="text-red-400 underline font-semibold"
                >
                  https://my.telegram.org
                </a>{' '}
                under "API development tools".
              </p>

              <div>
                <label className="block text-zinc-300 font-medium mb-1">API ID (Numeric)</label>
                <input
                  type="number"
                  placeholder="e.g. 12345678"
                  value={apiIdInput}
                  onChange={(e) => setApiIdInput(e.target.value)}
                  className="w-full px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-xl text-white font-mono focus:outline-none focus:border-red-500"
                  required
                />
              </div>

              <div>
                <label className="block text-zinc-300 font-medium mb-1">API Hash (32-character string)</label>
                <input
                  type="text"
                  placeholder="e.g. 0123456789abcdef0123456789abcdef"
                  value={apiHashInput}
                  onChange={(e) => setApiHashInput(e.target.value)}
                  className="w-full px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-xl text-white font-mono focus:outline-none focus:border-red-500"
                  required
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-zinc-800">
                <button
                  type="button"
                  onClick={() => setShowCredsModal(false)}
                  className="px-3.5 py-1.5 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 rounded-xl"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isLoading}
                  className="px-4 py-1.5 bg-red-600 hover:bg-red-500 text-white rounded-xl font-semibold shadow-md cursor-pointer"
                >
                  Save Credentials
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
