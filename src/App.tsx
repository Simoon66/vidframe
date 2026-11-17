import React, { useState, useEffect, useCallback } from 'react';
import { MediaItem, SystemStatus } from './types/media';
import {
  fetchSystemStatus,
  fetchMediaPaginated,
  deleteMediaItem,
  fetchIssueReports,
} from './services/api';
import { auth, googleProvider, signInWithPopup, signOut, onAuthStateChanged, User } from './services/firebase';
import { Navbar, DashboardTab } from './components/navigation/Navbar';
import { MediaLibrary } from './components/dashboard/MediaLibrary';
import { SeriesManager } from './components/dashboard/SeriesManager';
import { QueueMonitor } from './components/dashboard/QueueMonitor';
import { ReportsManager } from './components/dashboard/ReportsManager';
import { SecurityAndHealth } from './components/dashboard/SecurityAndHealth';
import { SettingsHub } from './components/dashboard/SettingsHub';
import { UploadModal } from './components/dashboard/UploadModal';
import { EditMediaModal } from './components/dashboard/EditMediaModal';
import { PreviewModal } from './components/dashboard/PreviewModal';
import { WatchPage } from './components/watch/WatchPage';
import { EmbedPage } from './components/embed/EmbedPage';
import { AnalyticsDashboard } from './components/dashboard/AnalyticsDashboard';
import { ToastProvider } from './components/common/Toast';
import { ErrorBoundary } from './components/common/ErrorBoundary';

export default function App() {
  const [currentPath, setCurrentPath] = useState<string>(window.location.pathname);
  const [currentTab, setCurrentTab] = useState<DashboardTab>('library');
  const [reportsCount, setReportsCount] = useState<number>(0);

  // Google Auth User State
  const [user, setUser] = useState<User | null>(null);
  const [isAuthChecking, setIsAuthChecking] = useState<boolean>(true);
  const [authError, setAuthError] = useState<string | null>(null);

  // Data states
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [mediaItems, setMediaItems] = useState<MediaItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMoreMedia, setHasMoreMedia] = useState<boolean>(false);
  const [isLoadingMedia, setIsLoadingMedia] = useState<boolean>(true);
  const [isLoadingMoreMedia, setIsLoadingMoreMedia] = useState<boolean>(false);

  // Modals state
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [editingMedia, setEditingMedia] = useState<MediaItem | null>(null);
  const [previewMedia, setPreviewMedia] = useState<MediaItem | null>(null);
  const [isPreviewDemo, setIsPreviewDemo] = useState(false);

  useEffect(() => {
    const handlePopState = () => setCurrentPath(window.location.pathname);
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // Firebase Auth listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      setUser(firebaseUser);
      setIsAuthChecking(false);
    });
    return () => unsubscribe();
  }, []);

  const navigateTo = (path: string) => {
    window.history.pushState({}, '', path);
    setCurrentPath(path);
  };

  // Public / Player Routes
  const embedMatch = currentPath.match(/^\/embed\/([a-zA-Z0-9_\-]+)$/);
  if (embedMatch) {
    return (
      <ErrorBoundary>
        <EmbedPage mediaId={embedMatch[1]} />
      </ErrorBoundary>
    );
  }

  const embedSourceMatch = currentPath.match(/^\/e\/([a-z]+)\/([a-zA-Z0-9_\-]+)$/);
  if (embedSourceMatch) {
    return (
      <ErrorBoundary>
        <EmbedPage source={embedSourceMatch[1]} sourceId={embedSourceMatch[2]} />
      </ErrorBoundary>
    );
  }

  const embedDirectMatch = currentPath.match(/^\/e\/([a-zA-Z0-9_\-]+)$/);
  if (embedDirectMatch) {
    return (
      <ErrorBoundary>
        <EmbedPage mediaId={embedDirectMatch[1]} />
      </ErrorBoundary>
    );
  }

  const watchMatch = currentPath.match(/^\/watch\/([a-zA-Z0-9_\-]+)$/);
  if (watchMatch) {
    return (
      <ErrorBoundary>
        <WatchPage mediaId={watchMatch[1]} onNavigateHome={() => navigateTo('/')} />
      </ErrorBoundary>
    );
  }

  const loadStatus = useCallback(async () => {
    try {
      const status = await fetchSystemStatus();
      setSystemStatus(status);
      setAuthError(null);
    } catch (e: any) {
      if (e?.message?.includes('401') || e?.message?.includes('status')) {
        setAuthError(null);
      }
      console.error('Failed to load system status:', e);
    }
  }, []);

  const loadMedia = useCallback(async () => {
    setIsLoadingMedia(true);
    try {
      const page = await fetchMediaPaginated({ limit: 24 });
      setMediaItems(page.items);
      setNextCursor(page.nextCursor);
      setHasMoreMedia(page.hasMore);
    } catch (e) {
      console.error('Failed to load media items:', e);
    } finally {
      setIsLoadingMedia(false);
    }
  }, []);

  const loadMoreMedia = useCallback(async () => {
    if (!nextCursor || isLoadingMoreMedia) return;
    setIsLoadingMoreMedia(true);
    try {
      const page = await fetchMediaPaginated({ limit: 24, cursor: nextCursor });
      setMediaItems((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        return [...prev, ...page.items.filter((m) => !seen.has(m.id))];
      });
      setNextCursor(page.nextCursor);
      setHasMoreMedia(page.hasMore);
    } catch (e) {
      console.error('Failed to load more media:', e);
    } finally {
      setIsLoadingMoreMedia(false);
    }
  }, [nextCursor, isLoadingMoreMedia]);

  const loadReports = useCallback(async () => {
    try {
      const reports = await fetchIssueReports();
      setReportsCount(reports.filter((r) => r.status === 'open').length);
    } catch {}
  }, []);

  useEffect(() => {
    if (user) {
      loadStatus();
      loadMedia();
      loadReports();

      const refreshTimer = setInterval(async () => {
        if (document.visibilityState === 'visible') {
          try {
            await user.getIdToken(true);
            await loadStatus();
          } catch {}
        }
      }, 35 * 60 * 1000);
      return () => clearInterval(refreshTimer);
    }
  }, [user, loadStatus, loadMedia, loadReports]);

  const handleDeleteMedia = async (id: string) => {
    try {
      await deleteMediaItem(id);
      setMediaItems((prev) => prev.filter((m) => m.id !== id));
    } catch (e: any) {
      console.error('Failed to delete media:', e);
    }
  };

  if (isAuthChecking) {
    return (
      <div className="w-screen h-screen bg-[#0a0a0c] flex items-center justify-center">
        <div className="w-10 h-10 rounded-full border-3 border-zinc-800 border-t-red-600 animate-spin" />
      </div>
    );
  }

  // Zero-Leak Google Login Gate (never exposes admin email pre-auth)
  if (!user) {
    return (
      <div className="w-screen h-screen bg-[#0a0a0c] text-white flex flex-col items-center justify-center p-4">
        <div className="max-w-md w-full bg-zinc-950 border border-zinc-800/80 rounded-3xl p-8 shadow-2xl text-center space-y-6">
          <div className="w-16 h-16 bg-red-600/15 border border-red-500/30 rounded-2xl flex items-center justify-center mx-auto text-red-500 shadow-lg shadow-red-950">
            <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          </div>
          <div className="space-y-2">
            <h1 className="text-2xl font-bold tracking-tight">VidFrame Admin Portal</h1>
            <p className="text-xs text-zinc-400">
              Sign in with your authorized administrator or editor Google account to access VidFrame.
            </p>
          </div>

          {authError && (
            <div className="p-3 bg-red-950/40 border border-red-500/30 rounded-xl text-red-300 text-xs">
              {authError}
            </div>
          )}

          <button
            onClick={async () => {
              setAuthError(null);
              try {
                await signInWithPopup(auth, googleProvider);
              } catch (err: any) {
                setAuthError(err?.message || 'Google sign-in failed.');
              }
            }}
            className="w-full py-3 bg-red-600 hover:bg-red-500 text-white rounded-xl text-xs font-semibold shadow-xl shadow-red-950/50 transition cursor-pointer flex items-center justify-center gap-2.5"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"><path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="currentColor" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/><path fill="currentColor" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/></svg>
            <span>Sign in with Google</span>
          </button>
        </div>
      </div>
    );
  }

  const folders = Array.from(new Set(mediaItems.map((m) => m.folder).filter(Boolean))) as string[];

  return (
    <ErrorBoundary>
      <ToastProvider>
        <div className="min-h-screen bg-[#0a0a0c] text-zinc-100 flex flex-col font-sans selection:bg-red-600/30 selection:text-red-200">
          <Navbar
            currentTab={currentTab}
            onSelectTab={setCurrentTab}
            telegramState={systemStatus?.telegram || null}
            storageConfig={systemStatus?.storage || null}
            onOpenUpload={() => setIsUploadOpen(true)}
            reportsCount={reportsCount}
          />

          <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-6 sm:py-8">
            {currentTab === 'library' && (
              <MediaLibrary
                mediaItems={mediaItems}
                isLoading={isLoadingMedia}
                isLoadingMore={isLoadingMoreMedia}
                hasMore={hasMoreMedia}
                onLoadMore={loadMoreMedia}
                onRefresh={loadMedia}
                onOpenUpload={() => setIsUploadOpen(true)}
                onOpenEdit={(item) => setEditingMedia(item)}
                onOpenPreview={(item) => {
                  setPreviewMedia(item);
                  setIsPreviewDemo(false);
                }}
                onDeleteMedia={handleDeleteMedia}
                folders={folders}
                onBatchUpdated={loadMedia}
              />
            )}

            {currentTab === 'series' && <SeriesManager mediaItems={mediaItems} onRefresh={loadMedia} />}

            {currentTab === 'queue' && <QueueMonitor />}

            {currentTab === 'analytics' && <AnalyticsDashboard mediaItems={mediaItems} />}

            {currentTab === 'reports' && <ReportsManager />}

            {currentTab === 'health' && <SecurityAndHealth />}

            {currentTab === 'settings' && (
              <SettingsHub
                status={systemStatus}
                onRefresh={loadStatus}
                onOpenPreviewDemo={() => {
                  setPreviewMedia(null);
                  setIsPreviewDemo(true);
                }}
              />
            )}
          </main>

          <UploadModal
            isOpen={isUploadOpen}
            onClose={() => setIsUploadOpen(false)}
            onSuccess={(newMedia) => {
              if (Array.isArray(newMedia)) {
                setMediaItems((prev) => [...newMedia, ...prev]);
              } else {
                setMediaItems((prev) => [newMedia, ...prev]);
              }
            }}
            telegramState={systemStatus?.telegram || null}
            storageConfig={systemStatus?.storage || null}
            onGoToTelegram={() => setCurrentTab('settings')}
            onGoToStorage={() => setCurrentTab('settings')}
          />

          <EditMediaModal
            media={editingMedia}
            isOpen={Boolean(editingMedia)}
            onClose={() => setEditingMedia(null)}
            onSaved={(updated) => {
              setMediaItems((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
              setEditingMedia((prev) => (prev && prev.id === updated.id ? updated : prev));
            }}
          />

          <PreviewModal
            media={previewMedia}
            isOpen={Boolean(previewMedia) || isPreviewDemo}
            isDemo={isPreviewDemo}
            onClose={() => {
              setPreviewMedia(null);
              setIsPreviewDemo(false);
            }}
          />

          <footer className="border-t border-zinc-900 py-6 px-4 text-center text-xs text-zinc-600">
            <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className="font-bold text-zinc-400">VidFrame</span>
                <span>• Scalable Video CDN & Media Infrastructure</span>
              </div>
              <div className="flex items-center gap-3">
                <span>{user.email}</span>
                <button
                  onClick={() => signOut(auth)}
                  className="text-zinc-400 hover:text-white underline cursor-pointer"
                >
                  Sign Out
                </button>
              </div>
            </div>
          </footer>
        </div>
      </ToastProvider>
    </ErrorBoundary>
  );
}
