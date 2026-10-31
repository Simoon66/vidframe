import React, { useState } from 'react';
import { SystemStatus } from '../../types/media';
import { TelegramConnect } from './TelegramConnect';
import { StorageSettings } from './StorageSettings';
import { GeneralSettings } from './GeneralSettings';

interface SettingsHubProps {
  status: SystemStatus | null;
  onRefresh: () => void;
  onOpenPreviewDemo: () => void;
}

export const SettingsHub: React.FC<SettingsHubProps> = ({ status, onRefresh, onOpenPreviewDemo }) => {
  const [subTab, setSubTab] = useState<'telegram' | 'storage' | 'general'>('telegram');

  return (
    <div className="space-y-6 animate-in fade-in">
      {/* Sub-tabs Navigation */}
      <div className="flex items-center gap-2 border-b border-zinc-800 pb-4">
        <button
          onClick={() => setSubTab('telegram')}
          className={`px-4 py-2 rounded-xl text-xs font-semibold transition cursor-pointer ${
            subTab === 'telegram'
              ? 'bg-red-600 text-white shadow'
              : 'bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-white'
          }`}
        >
          Telegram Account
        </button>
        <button
          onClick={() => setSubTab('storage')}
          className={`px-4 py-2 rounded-xl text-xs font-semibold transition cursor-pointer ${
            subTab === 'storage'
              ? 'bg-red-600 text-white shadow'
              : 'bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-white'
          }`}
        >
          Storage Channel
        </button>
        <button
          onClick={() => setSubTab('general')}
          className={`px-4 py-2 rounded-xl text-xs font-semibold transition cursor-pointer ${
            subTab === 'general'
              ? 'bg-red-600 text-white shadow'
              : 'bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-white'
          }`}
        >
          General & Secrets
        </button>
      </div>

      {subTab === 'telegram' && (
        <TelegramConnect
          state={status?.telegram || null}
          onRefresh={onRefresh}
          onGoToStorage={() => setSubTab('storage')}
        />
      )}

      {subTab === 'storage' && (
        <StorageSettings
          storageConfig={status?.storage || null}
          telegramState={status?.telegram || null}
          onRefresh={onRefresh}
          onGoToTelegram={() => setSubTab('telegram')}
        />
      )}

      {subTab === 'general' && (
        <GeneralSettings
          status={status}
          onRefresh={onRefresh}
          onOpenPreviewDemo={onOpenPreviewDemo}
        />
      )}
    </div>
  );
};
