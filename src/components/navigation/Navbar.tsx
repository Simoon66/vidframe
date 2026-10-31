import React, { useState } from 'react';
import { TelegramState } from '../../types/media';

interface NavbarProps {
  currentTab: 'library' | 'series' | 'analytics' | 'reports' | 'settings';
  onSelectTab: (tab: 'library' | 'series' | 'analytics' | 'reports' | 'settings') => void;
  telegramState: TelegramState | null;
  onOpenUpload: () => void;
  reportsCount?: number;
}

interface NavItem {
  id: 'library' | 'series' | 'analytics' | 'reports' | 'settings';
  label: string;
  badge?: string;
  badgeColor?: string;
}

export const Navbar: React.FC<NavbarProps> = ({
  currentTab,
  onSelectTab,
  telegramState,
  onOpenUpload,
  reportsCount = 0,
}) => {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const isConnected = telegramState?.state === 'Connected';
  const isConnecting =
    telegramState?.state === 'Connecting' ||
    telegramState?.state === 'Waiting for Code' ||
    telegramState?.state === 'Waiting for Two-Step Verification';

  const navItems: NavItem[] = [
    { id: 'library', label: 'Media Library' },
    { id: 'series', label: 'Series & Projects' },
    { id: 'analytics', label: 'Analytics' },
    {
      id: 'reports',
      label: 'Reports',
      badge: reportsCount > 0 ? `${reportsCount} Open` : undefined,
      badgeColor: 'bg-red-500/20 text-red-400 border-red-500/30',
    },
    {
      id: 'settings',
      label: 'Settings',
      badge: isConnected ? 'Connected' : isConnecting ? 'Pending' : 'Action Req',
      badgeColor: isConnected ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' : 'bg-amber-500/20 text-amber-400 border-amber-500/30',
    },
  ];

  return (
    <header className="sticky top-0 z-40 w-full border-b border-zinc-800/80 bg-[#0a0a0c]/85 backdrop-blur-xl">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
        {/* Brand Logo & Tag */}
        <div className="flex items-center gap-6">
          <div
            onClick={() => onSelectTab('library')}
            className="flex items-center gap-2.5 cursor-pointer group select-none"
          >
            <div className="w-8 h-8 rounded-lg bg-zinc-900 border border-zinc-700/80 flex items-center justify-center group-hover:border-red-500/50 transition">
              <div className="w-3 h-3 bg-red-600 rounded-xs shadow-sm shadow-red-600/50 group-hover:scale-110 transition-transform" />
            </div>
            <div className="flex flex-col">
              <span className="text-base font-bold tracking-wider text-white">VidFrame</span>
              <span className="text-[10px] text-zinc-500 tracking-wider -mt-1 hidden sm:inline">TG VIDEO CLOUD</span>
            </div>
          </div>

          {/* Desktop Navigation Links */}
          <nav className="hidden md:flex items-center gap-1">
            {navItems.map((item) => (
              <button
                key={item.id}
                onClick={() => onSelectTab(item.id)}
                className={`relative px-3.5 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer flex items-center gap-2 ${
                  currentTab === item.id
                    ? 'text-white bg-zinc-800/80 border border-zinc-700/60 shadow-sm'
                    : 'text-zinc-400 hover:text-white hover:bg-zinc-900/60'
                }`}
              >
                <span>{item.label}</span>
                {item.badge && (
                  <span
                    className={`text-[9px] px-1.5 py-0.5 rounded-full border ${item.badgeColor} font-mono`}
                  >
                    {item.badge}
                  </span>
                )}
              </button>
            ))}
          </nav>
        </div>

        {/* Right Action: Status Pill + Upload Button */}
        <div className="flex items-center gap-3">
          {/* Connection indicator */}
          <div
            onClick={() => onSelectTab('settings')}
            className="hidden sm:flex items-center gap-2 px-2.5 py-1 rounded-full bg-zinc-900/90 border border-zinc-800 text-[11px] text-zinc-400 cursor-pointer hover:border-zinc-700 transition"
            title={`Telegram: ${telegramState?.state || 'Checking...'}`}
          >
            <span
              className={`w-2 h-2 rounded-full ${
                isConnected
                  ? 'bg-emerald-500 shadow-sm shadow-emerald-500/50 animate-pulse'
                  : isConnecting
                  ? 'bg-amber-500 animate-pulse'
                  : 'bg-zinc-600'
              }`}
            />
            <span className="truncate max-w-[120px]">
              {isConnected ? telegramState?.user?.firstName || 'Connected' : 'Telegram: Disconnected'}
            </span>
          </div>

          {/* Upload Button */}
          <button
            onClick={onOpenUpload}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-semibold shadow-lg shadow-red-950/40 hover:shadow-red-900/60 active:scale-95 transition cursor-pointer"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <span className="hidden xs:inline">Upload Video</span>
            <span className="xs:hidden">Upload</span>
          </button>

          {/* Mobile hamburger menu */}
          <button
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            className="md:hidden p-2 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-900 focus:outline-none cursor-pointer"
            aria-label="Toggle navigation menu"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              {mobileMenuOpen ? (
                <path d="M18 6L6 18M6 6l12 12" />
              ) : (
                <path d="M4 6h16M4 12h16M4 18h16" />
              )}
            </svg>
          </button>
        </div>
      </div>

      {/* Mobile Drawer Navigation */}
      {mobileMenuOpen && (
        <div className="md:hidden border-t border-zinc-800 bg-[#0a0a0c]/95 backdrop-blur-xl px-4 py-3 space-y-1 animate-in fade-in slide-in-from-top-2 duration-150">
          {navItems.map((item) => (
            <button
              key={item.id}
              onClick={() => {
                onSelectTab(item.id);
                setMobileMenuOpen(false);
              }}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-xs font-medium cursor-pointer ${
                currentTab === item.id
                  ? 'bg-zinc-800 text-white font-semibold'
                  : 'text-zinc-400 hover:bg-zinc-900 hover:text-white'
              }`}
            >
              <span>{item.label}</span>
              {item.badge && (
                <span
                  className={`text-[9px] px-2 py-0.5 rounded-full border ${item.badgeColor} font-mono`}
                >
                  {item.badge}
                </span>
              )}
            </button>
          ))}
          <div className="pt-2 border-t border-zinc-800/80 mt-2 flex items-center justify-between text-xs text-zinc-400 px-3">
            <span>Status:</span>
            <span
              className={`font-semibold ${
                isConnected ? 'text-emerald-400' : 'text-zinc-500'
              }`}
            >
              {telegramState?.state || 'Not Connected'}
            </span>
          </div>
        </div>
      )}
    </header>
  );
};
