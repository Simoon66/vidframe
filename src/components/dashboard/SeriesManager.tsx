import React, { useState, useEffect } from 'react';
import { SeriesRecord, SeasonItem, EpisodeItem, MediaItem } from '../../types/media';
import { authFetch } from '../../services/api';

interface SeriesManagerProps {
  mediaItems: MediaItem[];
  onRefresh: () => void;
}

export const SeriesManager: React.FC<SeriesManagerProps> = ({ mediaItems, onRefresh: _onRefresh }) => {
  const [seriesList, setSeriesList] = useState<SeriesRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedSeries, setSelectedSeries] = useState<SeriesRecord | null>(null);

  // New series modal state
  const [showAddModal, setShowAddModal] = useState(false);
  const [sourceType, setSourceType] = useState<'iddb' | 'tmdb' | 'anilist' | 'mal' | 'custom'>('iddb');
  const [sourceIdInput, setSourceIdInput] = useState('');
  const [customTitle, setCustomTitle] = useState('');
  const [isFetching, setIsFetching] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Deletion modal state (in-app modal, replaces blocked window.confirm)
  const [confirmDeleteProject, setConfirmDeleteProject] = useState<SeriesRecord | null>(null);
  const [isDeleting, setIsDeleting] = useState<boolean>(false);
  const [copiedUrl, setCopiedUrl] = useState<boolean>(false);

  // Episode editing modal state
  const [editingSeasonNum, setEditingSeasonNum] = useState<number>(1);
  const [editingEpisode, setEditingEpisode] = useState<EpisodeItem | null>(null);
  const [showEpisodeModal, setShowEpisodeModal] = useState(false);

  const fetchSeries = async () => {
    setIsLoading(true);
    try {
      const res = await authFetch('/api/series');
      const data = await res.json();
      setSeriesList(Array.isArray(data) ? data : []);
      if (Array.isArray(data) && data.length > 0 && !selectedSeries) {
        setSelectedSeries(data[0]);
      }
    } catch (e) {
      console.error('Failed to fetch series:', e);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchSeries();
  }, []);

  const handleFetchMetadata = async (e: React.FormEvent) => {
    e.preventDefault();
    if (sourceType === 'custom') {
      if (!customTitle.trim()) {
        setErrorMsg('Please enter a custom title.');
        return;
      }
      const newSeries: SeriesRecord = {
        id: `custom_${Date.now()}`,
        source: 'custom',
        sourceId: `custom_${Date.now()}`,
        title: customTitle.trim(),
        description: 'Custom anime or video series collection',
        coverImage: 'https://images.unsplash.com/photo-1578632767115-351597cf2477?w=800&auto=format&fit=crop&q=60',
        bannerImage: 'https://images.unsplash.com/photo-1578632767115-351597cf2477?w=1600&auto=format&fit=crop&q=80',
        seasons: [
          {
            seasonNumber: 1,
            title: 'Season 1',
            episodes: [
              { episodeNumber: 1, title: 'Episode 1', description: '', thumbnail: '' }
            ]
          }
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      try {
        const res = await authFetch('/api/series', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(newSeries),
        });
        const data = await res.json();
        if (data.success) {
          setSeriesList([data.series, ...seriesList]);
          setSelectedSeries(data.series);
          setShowAddModal(false);
          setCustomTitle('');
        }
      } catch (err: any) {
        setErrorMsg(err.message || 'Failed to create custom series');
      }
      return;
    }

    if (!sourceIdInput.trim()) {
      setErrorMsg('Please enter a valid ID (TMDB ID, AniList ID, or MAL ID).');
      return;
    }

    setIsFetching(true);
    setErrorMsg(null);
    try {
      const res = await authFetch('/api/series/fetch-metadata', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: sourceType, sourceId: sourceIdInput.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to fetch metadata');

      const savedRes = await authFetch('/api/series', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data.series),
      });
      const savedData = await savedRes.json();
      if (savedData.success) {
        setSeriesList([savedData.series, ...seriesList]);
        setSelectedSeries(savedData.series);
        setShowAddModal(false);
        setSourceIdInput('');
      }
    } catch (e: any) {
      setErrorMsg(e.message || 'Failed to fetch and create project');
    } finally {
      setIsFetching(false);
    }
  };

  const executeDeleteSeries = async (project: SeriesRecord) => {
    setIsDeleting(true);
    try {
      const res = await authFetch(`/api/series/${encodeURIComponent(project.id)}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to delete project');
      }
      const next = seriesList.filter((s) => s.id !== project.id);
      setSeriesList(next);
      if (selectedSeries?.id === project.id) {
        setSelectedSeries(next.length > 0 ? next[0] : null);
      }
      setConfirmDeleteProject(null);
    } catch (e: any) {
      setErrorMsg(e.message || 'Failed to delete project');
    } finally {
      setIsDeleting(false);
    }
  };

  const handleAddSeason = async () => {
    if (!selectedSeries) return;
    const nextSeasonNum = selectedSeries.seasons.length + 1;
    const updatedSeasons: SeasonItem[] = [
      ...selectedSeries.seasons,
      {
        seasonNumber: nextSeasonNum,
        title: `Season ${nextSeasonNum}`,
        episodes: [
          { episodeNumber: 1, title: 'Episode 1', description: '', thumbnail: selectedSeries.coverImage || '' }
        ]
      }
    ];

    const updatedSeries: SeriesRecord = {
      ...selectedSeries,
      seasons: updatedSeasons,
      updatedAt: new Date().toISOString(),
    };

    try {
      const res = await authFetch(`/api/series/${selectedSeries.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatedSeries),
      });
      const data = await res.json();
      if (data.success) {
        setSelectedSeries(data.series);
        setSeriesList(seriesList.map((s) => (s.id === data.series.id ? data.series : s)));
      }
    } catch (e: any) {
      setErrorMsg(e.message || 'Failed to add season');
    }
  };

  const handleAddEpisode = (seasonNum: number) => {
    if (!selectedSeries) return;
    const season = selectedSeries.seasons.find((s) => s.seasonNumber === seasonNum);
    const nextEpNum = season ? season.episodes.length + 1 : 1;
    setEditingSeasonNum(seasonNum);
    setEditingEpisode({
      episodeNumber: nextEpNum,
      title: `Episode ${nextEpNum}`,
      description: '',
      thumbnail: selectedSeries.coverImage || '',
      mediaId: '',
    });
    setShowEpisodeModal(true);
  };

  const handleSaveEpisode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSeries || !editingEpisode) return;

    const updatedSeasons = selectedSeries.seasons.map((season) => {
      if (season.seasonNumber === editingSeasonNum) {
        const existingEpIndex = season.episodes.findIndex((ep) => ep.episodeNumber === editingEpisode.episodeNumber);
        let updatedEpisodes = [...season.episodes];
        if (existingEpIndex >= 0) {
          updatedEpisodes[existingEpIndex] = editingEpisode;
        } else {
          updatedEpisodes.push(editingEpisode);
        }
        return { ...season, episodes: updatedEpisodes };
      }
      return season;
    });

    const updatedSeries: SeriesRecord = {
      ...selectedSeries,
      seasons: updatedSeasons,
      updatedAt: new Date().toISOString(),
    };

    try {
      const res = await authFetch(`/api/series/${selectedSeries.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatedSeries),
      });
      const data = await res.json();
      if (data.success) {
        setSelectedSeries(data.series);
        setSeriesList(seriesList.map((s) => (s.id === data.series.id ? data.series : s)));
        setShowEpisodeModal(false);
        setEditingEpisode(null);
      }
    } catch (e: any) {
      setErrorMsg(e.message || 'Failed to save episode');
    }
  };

  const appOrigin = window.location.origin;

  return (
    <div className="space-y-6 animate-in fade-in">
      {/* Top Bar: Title & Launch Project Button */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-white tracking-tight">Series & Anime Projects</h2>
          <p className="text-xs text-zinc-400">Launch series projects using TMDB, AniList, or MAL data with multi-season & episode support.</p>
        </div>
        <button
          onClick={() => {
            setErrorMsg(null);
            setShowAddModal(true);
          }}
          className="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded-xl text-xs font-semibold shadow-lg shadow-red-950/40 transition active:scale-95 cursor-pointer"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          <span>Launch New Project</span>
        </button>
      </div>

      {isLoading ? (
        <div className="py-20 text-center">
          <div className="w-8 h-8 rounded-full border-2 border-zinc-800 border-t-red-600 animate-spin mx-auto" />
        </div>
      ) : seriesList.length === 0 ? (
        <div className="p-12 bg-zinc-900/40 border border-zinc-800/80 rounded-2xl text-center space-y-3">
          <div className="w-12 h-12 rounded-full bg-zinc-800 flex items-center justify-center text-zinc-400 mx-auto">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/></svg>
          </div>
          <h3 className="text-white font-semibold text-sm">No Series Projects Yet</h3>
          <p className="text-zinc-500 text-xs max-w-sm mx-auto">Launch your first anime or video project using TMDB, AniList, or MAL database IDs.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          {/* Series List Sidebar */}
          <div className="lg:col-span-1 space-y-2">
            <div className="text-[10px] uppercase font-bold text-zinc-500 tracking-wider px-1">Your Projects ({seriesList.length})</div>
            <div className="space-y-2 max-h-[600px] overflow-y-auto pr-1">
              {seriesList.map((s) => {
                const isSelected = selectedSeries?.id === s.id;
                return (
                  <div
                    key={s.id}
                    onClick={() => setSelectedSeries(s)}
                    className={`group relative flex items-center gap-3 p-2.5 rounded-xl border transition cursor-pointer ${
                      isSelected ? 'bg-zinc-800/90 border-red-500/50 shadow' : 'bg-zinc-900/40 border-zinc-800 hover:border-zinc-700'
                    }`}
                  >
                    <img src={s.coverImage || 'https://images.unsplash.com/photo-1578632767115-351597cf2477?w=200&auto=format&fit=crop&q=60'} alt="" className="w-10 h-14 rounded-lg object-cover bg-zinc-800 shrink-0" />
                    <div className="flex-1 min-w-0 pr-6">
                      <h4 className="text-white font-semibold text-xs truncate">{s.title}</h4>
                      <p className="text-[10px] text-zinc-400 capitalize">{s.source} • {s.seasons.length} Seasons</p>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmDeleteProject(s);
                      }}
                      className="opacity-0 group-hover:opacity-100 absolute right-2 p-1.5 text-zinc-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition"
                      title="Delete Project"
                      aria-label="Delete Project"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Selected Series Detail View */}
          {selectedSeries ? (
            <div className="lg:col-span-3 space-y-6 bg-zinc-900/40 border border-zinc-800 rounded-2xl p-6">
              {/* Banner / Cover Header */}
              <div className="relative rounded-2xl overflow-hidden bg-zinc-950 border border-zinc-800 h-48 md:h-64 flex items-end p-6">
                <div className="absolute inset-0">
                  <img src={selectedSeries.bannerImage || selectedSeries.coverImage} alt="" className="w-full h-full object-cover opacity-30 blur-xs" />
                  <div className="absolute inset-0 bg-gradient-to-t from-[#0a0a0c] via-[#0a0a0c]/60 to-transparent" />
                </div>
                <div className="relative z-10 flex flex-col sm:flex-row items-start sm:items-end gap-5 w-full justify-between">
                  <div className="flex items-end gap-4">
                    <img src={selectedSeries.coverImage} alt="" className="w-20 h-28 md:w-24 md:h-36 rounded-xl object-cover border-2 border-zinc-700 shadow-2xl bg-zinc-800 hidden sm:block" />
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-red-600/20 text-red-400 border border-red-500/30 uppercase">{selectedSeries.source}</span>
                        {selectedSeries.sourceId && <span className="text-[10px] font-mono text-zinc-400">ID: {selectedSeries.sourceId}</span>}
                      </div>
                      <h2 className="text-xl md:text-2xl font-bold text-white">{selectedSeries.title}</h2>
                      {selectedSeries.japaneseTitle && <p className="text-xs text-zinc-400">{selectedSeries.japaneseTitle}</p>}
                    </div>
                  </div>
                  <button
                    onClick={() => setConfirmDeleteProject(selectedSeries)}
                    className="px-3 py-1.5 bg-red-950/60 hover:bg-red-900/80 text-red-300 border border-red-500/30 rounded-lg text-xs font-medium transition cursor-pointer flex items-center gap-1.5"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                    <span>Delete Project</span>
                  </button>
                </div>
              </div>

              {/* Embed Link Format Box */}
              <div className="p-4 bg-zinc-950/80 border border-zinc-800/80 rounded-xl space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-zinc-300">Embed URL format ({selectedSeries.source}):</span>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(`${appOrigin}/e/${selectedSeries.source}/${selectedSeries.sourceId}`);
                      setCopiedUrl(true);
                      setTimeout(() => setCopiedUrl(false), 2000);
                    }}
                    className="text-xs text-red-400 hover:text-red-300 font-medium cursor-pointer"
                  >
                    {copiedUrl ? <span className="text-emerald-400 font-semibold">✓ Copied!</span> : 'Copy Base Embed URL'}
                  </button>
                </div>
                <div className="p-2.5 bg-zinc-900 rounded-lg font-mono text-xs text-zinc-400 select-all overflow-x-auto">
                  {appOrigin}/e/{selectedSeries.source}/{selectedSeries.sourceId}
                </div>
              </div>

              {/* Seasons & Episodes Section */}
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-bold text-white">Seasons & Episodes</h3>
                  <button
                    onClick={handleAddSeason}
                    className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-white rounded-lg text-xs font-semibold transition cursor-pointer border border-zinc-700"
                  >
                    + Add Season
                  </button>
                </div>

                <div className="space-y-4">
                  {selectedSeries.seasons.map((season) => (
                    <div key={season.seasonNumber} className="p-4 bg-zinc-950/60 border border-zinc-800/80 rounded-xl space-y-3">
                      <div className="flex items-center justify-between border-b border-zinc-800/80 pb-3">
                        <h4 className="text-white font-bold text-xs uppercase tracking-wider">{season.title} ({season.episodes.length} Episodes)</h4>
                        <button
                          onClick={() => handleAddEpisode(season.seasonNumber)}
                          className="px-2.5 py-1 bg-red-600/20 hover:bg-red-600/30 text-red-400 border border-red-500/30 rounded-lg text-xs font-semibold transition cursor-pointer"
                        >
                          + Add Episode
                        </button>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                        {season.episodes.map((ep) => {
                          const linkedMedia = mediaItems.find((m) => m.id === ep.mediaId);
                          const epEmbedUrl = `${appOrigin}/e/${selectedSeries.source}/${selectedSeries.sourceId}?s=${season.seasonNumber}&e=${ep.episodeNumber}`;
                          return (
                            <div key={ep.episodeNumber} className="p-3 bg-zinc-900/60 border border-zinc-800/80 rounded-xl flex items-center justify-between gap-3">
                              <div className="flex items-center gap-3 min-w-0">
                                <div className="w-12 h-8 rounded bg-zinc-800 overflow-hidden flex-shrink-0">
                                  {ep.thumbnail ? (
                                    <img src={ep.thumbnail} alt="" className="w-full h-full object-cover" />
                                  ) : (
                                    <div className="w-full h-full flex items-center justify-center text-[10px] text-zinc-500 font-mono">#{ep.episodeNumber}</div>
                                  )}
                                </div>
                                <div className="min-w-0">
                                  <h5 className="text-white font-semibold text-xs truncate">Ep {ep.episodeNumber}: {ep.title}</h5>
                                  <p className="text-[10px] text-zinc-400 truncate">
                                    {linkedMedia ? <span className="text-emerald-400">Linked: {linkedMedia.title}</span> : <span className="text-amber-400">Unlinked video</span>}
                                  </p>
                                </div>
                              </div>
                              <div className="flex items-center gap-1.5 flex-shrink-0">
                                <button
                                  onClick={() => {
                                    setEditingSeasonNum(season.seasonNumber);
                                    setEditingEpisode(ep);
                                    setShowEpisodeModal(true);
                                  }}
                                  className="px-2.5 py-1 bg-zinc-800 hover:bg-zinc-700 text-white rounded text-[11px] font-medium transition cursor-pointer"
                                >
                                  Edit
                                </button>
                                <button
                                  onClick={() => {
                                    navigator.clipboard.writeText(epEmbedUrl);
                                    setCopiedUrl(true);
                                    setTimeout(() => setCopiedUrl(false), 2000);
                                  }}
                                  className="px-2.5 py-1 bg-red-600/20 hover:bg-red-600/30 text-red-400 rounded text-[11px] font-medium transition cursor-pointer"
                                  title="Copy Episode Embed URL"
                                >
                                  Embed
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      )}

      {/* Launch Project Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4">
          <div className="bg-zinc-950 border border-zinc-800 w-full max-w-md rounded-2xl p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-white font-bold text-base">Launch Series Project</h3>
              <button onClick={() => setShowAddModal(false)} className="text-zinc-400 hover:text-white cursor-pointer">✕</button>
            </div>

            <form onSubmit={handleFetchMetadata} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1.5">Metadata Source</label>
                <select
                  value={sourceType}
                  onChange={(e) => setSourceType(e.target.value as any)}
                  className="w-full px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-xl text-xs text-white focus:outline-none focus:border-red-500"
                >
                  <option value="iddb">IDDB (Universal Media Database - e.g. IDDB-1)</option>
                  <option value="tmdb">TMDB (The Movie Database ID - e.g. 1429)</option>
                  <option value="anilist">AniList ID (e.g. 16498)</option>
                  <option value="mal">MyAnimeList (MAL ID - e.g. 21185)</option>
                  <option value="custom">Custom Title / Manual</option>
                </select>
              </div>

              {sourceType === 'custom' ? (
                <div>
                  <label className="block text-xs font-medium text-zinc-300 mb-1.5">Custom Series Title</label>
                  <input
                    type="text"
                    value={customTitle}
                    onChange={(e) => setCustomTitle(e.target.value)}
                    placeholder="e.g. My Custom Video Series"
                    className="w-full px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-xl text-xs text-white focus:outline-none focus:border-red-500"
                  />
                </div>
              ) : (
                <div>
                  <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                    {sourceType === 'iddb'
                      ? 'IDDB Media ID (e.g. IDDB-1 or 1)'
                      : sourceType === 'tmdb'
                      ? 'TMDB TV Show ID (e.g. 1429)'
                      : sourceType === 'anilist'
                      ? 'AniList Anime ID (e.g. 16498)'
                      : 'MAL Anime ID (e.g. 21185)'}
                  </label>
                  <input
                    type="text"
                    value={sourceIdInput}
                    onChange={(e) => setSourceIdInput(e.target.value)}
                    placeholder={sourceType === 'iddb' ? 'e.g. IDDB-1' : 'Enter ID number'}
                    className="w-full px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-xl text-xs text-white focus:outline-none focus:border-red-500"
                  />
                  <p className="text-[10px] text-zinc-500 mt-1">Metadata, covers, synopsis, and seasons will be auto-imported instantly.</p>
                </div>
              )}

              {errorMsg && <p className="text-xs text-red-400 bg-red-950/40 p-2.5 rounded-lg border border-red-500/20">{errorMsg}</p>}

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-4 py-2 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 rounded-xl text-xs font-medium cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isFetching}
                  className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded-xl text-xs font-semibold shadow-lg shadow-red-950/40 cursor-pointer disabled:opacity-50"
                >
                  {isFetching ? 'Fetching...' : 'Launch Project'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Episode Edit Modal */}
      {showEpisodeModal && editingEpisode && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4">
          <div className="bg-zinc-950 border border-zinc-800 w-full max-w-lg rounded-2xl p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-white font-bold text-base">Edit Episode {editingEpisode.episodeNumber}</h3>
              <button onClick={() => setShowEpisodeModal(false)} className="text-zinc-400 hover:text-white cursor-pointer">✕</button>
            </div>

            <form onSubmit={handleSaveEpisode} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1.5">Episode Title</label>
                <input
                  type="text"
                  value={editingEpisode.title}
                  onChange={(e) => setEditingEpisode({ ...editingEpisode, title: e.target.value })}
                  className="w-full px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-xl text-xs text-white focus:outline-none focus:border-red-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1.5">Link Uploaded Video (Media Library)</label>
                <select
                  value={editingEpisode.mediaId || ''}
                  onChange={(e) => setEditingEpisode({ ...editingEpisode, mediaId: e.target.value })}
                  className="w-full px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-xl text-xs text-white focus:outline-none focus:border-red-500"
                >
                  <option value="">-- Select video from library --</option>
                  {mediaItems.map((m) => (
                    <option key={m.id} value={m.id}>{m.title} ({Math.round(m.size / (1024*1024))} MB)</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1.5">Episode Thumbnail URL (Optional)</label>
                <input
                  type="text"
                  value={editingEpisode.thumbnail || ''}
                  onChange={(e) => setEditingEpisode({ ...editingEpisode, thumbnail: e.target.value })}
                  placeholder="https://image.tmdb.org/t/p/original..."
                  className="w-full px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-xl text-xs text-white focus:outline-none focus:border-red-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1.5">Synopsis / Description</label>
                <textarea
                  rows={3}
                  value={editingEpisode.description || ''}
                  onChange={(e) => setEditingEpisode({ ...editingEpisode, description: e.target.value })}
                  className="w-full px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-xl text-xs text-white focus:outline-none focus:border-red-500 resize-none"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowEpisodeModal(false)}
                  className="px-4 py-2 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 rounded-xl text-xs font-medium cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded-xl text-xs font-semibold shadow-lg shadow-red-950/40 cursor-pointer"
                >
                  Save Episode
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* In-app Confirmation Modal for Deleting Series Project */}
      {confirmDeleteProject && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in">
          <div className="bg-zinc-950 border border-zinc-800 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-2xl">
            <div className="w-12 h-12 rounded-xl bg-red-600/15 border border-red-500/30 flex items-center justify-center text-red-500 mx-auto">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
            </div>
            <div className="text-center space-y-1">
              <h3 className="text-base font-bold text-white">Delete Project</h3>
              <p className="text-xs text-zinc-400">
                Are you sure you want to delete <span className="text-white font-medium">"{confirmDeleteProject.title}"</span>? This will permanently delete this series project and all its season/episode associations.
              </p>
            </div>
            <div className="flex items-center gap-3 pt-2">
              <button
                onClick={() => setConfirmDeleteProject(null)}
                disabled={isDeleting}
                className="flex-1 py-2.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-zinc-300 text-xs font-semibold border border-zinc-700/60 transition cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={() => executeDeleteSeries(confirmDeleteProject)}
                disabled={isDeleting}
                className="flex-1 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-semibold shadow-lg shadow-red-950/50 transition cursor-pointer flex items-center justify-center gap-2"
              >
                {isDeleting ? (
                  <div className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                ) : (
                  'Delete Permanently'
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
