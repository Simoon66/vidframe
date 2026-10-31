import React, { useState, useEffect } from 'react';
import { fetchIssueReports, updateIssueReportStatus, deleteIssueReport } from '../../services/api';
import { ReportRecord } from '../../types/media';

export const ReportsManager: React.FC = () => {
  const [reports, setReports] = useState<ReportRecord[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [statusFilter, setStatusFilter] = useState<'all' | 'open' | 'investigating' | 'resolved'>('all');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState<boolean>(false);
  const [actionSuccessMsg, setActionSuccessMsg] = useState<string | null>(null);

  const loadReports = async () => {
    setIsLoading(true);
    try {
      const data = await fetchIssueReports();
      setReports(data);
    } catch (err) {
      console.error('Failed to load issue reports:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadReports();
  }, []);

  const handleStatusChange = async (id: string, newStatus: 'open' | 'investigating' | 'resolved') => {
    try {
      await updateIssueReportStatus(id, newStatus);
      setReports((prev) =>
        prev.map((r) => (r.id === id ? { ...r, status: newStatus } : r))
      );
      setActionSuccessMsg(`Report marked as ${newStatus}`);
      setTimeout(() => setActionSuccessMsg(null), 2500);
    } catch (err: any) {
      alert(err.message || 'Failed to update report status');
    }
  };

  const handleDelete = async (id: string) => {
    setIsDeleting(true);
    try {
      await deleteIssueReport(id);
      setReports((prev) => prev.filter((r) => r.id !== id));
      setConfirmDeleteId(null);
      setActionSuccessMsg('Report deleted');
      setTimeout(() => setActionSuccessMsg(null), 2500);
    } catch (err: any) {
      alert(err.message || 'Failed to delete report');
    } finally {
      setIsDeleting(false);
    }
  };

  const filteredReports = reports.filter((r) => {
    if (statusFilter === 'all') return true;
    return r.status === statusFilter;
  });

  const openCount = reports.filter((r) => r.status === 'open').length;

  const getIssueBadgeColor = (issue: string) => {
    switch (issue) {
      case 'Video not playing':
        return 'bg-red-500/15 text-red-400 border-red-500/30';
      case 'Audio issue':
        return 'bg-amber-500/15 text-amber-400 border-amber-500/30';
      case 'Subtitle issue':
        return 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30';
      case 'Buffering or slow playback':
        return 'bg-orange-500/15 text-orange-400 border-orange-500/30';
      default:
        return 'bg-purple-500/15 text-purple-400 border-purple-500/30';
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in">
      {/* Header Bar */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h2 className="text-lg font-bold text-white tracking-tight">Issue Reports</h2>
            {openCount > 0 && (
              <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-red-600/20 text-red-400 border border-red-500/30">
                {openCount} Open
              </span>
            )}
          </div>
          <p className="text-xs text-zinc-400 mt-0.5">
            User-submitted video playback issues, buffering reports, and audio/subtitle tickets.
          </p>
        </div>

        <button
          onClick={loadReports}
          disabled={isLoading}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 rounded-xl text-xs font-medium border border-zinc-700/60 transition cursor-pointer"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className={isLoading ? 'animate-spin' : ''}
          >
            <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
            <path d="M3 3v5h5" />
            <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
            <path d="M16 21h5v-5" />
          </svg>
          <span>Refresh</span>
        </button>
      </div>

      {actionSuccessMsg && (
        <div className="p-3 bg-emerald-950/40 border border-emerald-500/30 rounded-xl text-xs text-emerald-300 flex items-center justify-between">
          <span>✓ {actionSuccessMsg}</span>
        </div>
      )}

      {/* Filter Tabs */}
      <div className="flex items-center gap-2 border-b border-zinc-800 pb-2">
        {(['all', 'open', 'investigating', 'resolved'] as const).map((filter) => {
          const count =
            filter === 'all'
              ? reports.length
              : reports.filter((r) => r.status === filter).length;
          return (
            <button
              key={filter}
              onClick={() => setStatusFilter(filter)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer capitalize flex items-center gap-1.5 ${
                statusFilter === filter
                  ? 'bg-zinc-800 text-white border border-zinc-700/80 shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900/60'
              }`}
            >
              <span>{filter}</span>
              <span className="text-[10px] font-mono opacity-60">({count})</span>
            </button>
          );
        })}
      </div>

      {/* Reports List */}
      {isLoading ? (
        <div className="py-20 text-center">
          <div className="w-8 h-8 rounded-full border-2 border-zinc-800 border-t-red-600 animate-spin mx-auto" />
        </div>
      ) : filteredReports.length === 0 ? (
        <div className="p-12 bg-zinc-900/40 border border-zinc-800/80 rounded-2xl text-center space-y-3">
          <div className="w-12 h-12 rounded-full bg-zinc-800 flex items-center justify-center text-emerald-400 mx-auto">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>
          </div>
          <h3 className="text-white font-semibold text-sm">No {statusFilter !== 'all' ? statusFilter : ''} reports found</h3>
          <p className="text-zinc-500 text-xs max-w-sm mx-auto">
            All video playback reports from the player embed flag button will appear here in real-time.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredReports.map((report) => (
            <div
              key={report.id}
              className="p-4 sm:p-5 bg-zinc-900/40 border border-zinc-800/80 rounded-2xl hover:border-zinc-700 transition space-y-3"
            >
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                <div className="flex items-center gap-2.5 flex-wrap">
                  <span className={`px-2.5 py-1 rounded-lg text-xs font-semibold border ${getIssueBadgeColor(report.issueType)}`}>
                    {report.issueType}
                  </span>
                  <span className="text-xs font-bold text-white tracking-tight">
                    {report.mediaTitle || 'Unknown Video'}
                  </span>
                  {report.mediaId && (
                    <span className="text-[11px] font-mono text-zinc-500">
                      ID: {report.mediaId}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <select
                    value={report.status}
                    onChange={(e) => handleStatusChange(report.id, e.target.value as any)}
                    className="px-2.5 py-1 bg-zinc-900 border border-zinc-700 rounded-lg text-xs font-medium text-zinc-300 focus:outline-none cursor-pointer"
                  >
                    <option value="open">Open</option>
                    <option value="investigating">Investigating</option>
                    <option value="resolved">Resolved</option>
                  </select>

                  <button
                    onClick={() => setConfirmDeleteId(report.id)}
                    className="p-1.5 text-zinc-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition cursor-pointer"
                    title="Delete report"
                    aria-label="Delete report"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                  </button>
                </div>
              </div>

              {report.description ? (
                <div className="p-3 bg-zinc-950/60 rounded-xl border border-zinc-800/80 text-xs text-zinc-300 leading-relaxed font-sans">
                  "{report.description}"
                </div>
              ) : (
                <p className="text-[11px] text-zinc-600 italic">No additional description provided.</p>
              )}

              <div className="flex items-center justify-between text-[11px] text-zinc-500 pt-1 border-t border-zinc-800/40">
                <span>Report ID: {report.id}</span>
                <span>
                  {new Date(report.createdAt).toLocaleString(undefined, {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {confirmDeleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in">
          <div className="bg-zinc-950 border border-zinc-800 rounded-2xl max-w-sm w-full p-6 space-y-4 shadow-2xl">
            <h3 className="text-base font-bold text-white text-center">Delete Report</h3>
            <p className="text-xs text-zinc-400 text-center">
              Are you sure you want to remove this report? This action cannot be undone.
            </p>
            <div className="flex items-center gap-3 pt-2">
              <button
                onClick={() => setConfirmDeleteId(null)}
                disabled={isDeleting}
                className="flex-1 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-zinc-300 text-xs font-semibold border border-zinc-700/60 transition cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDelete(confirmDeleteId)}
                disabled={isDeleting}
                className="flex-1 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-semibold shadow-lg shadow-red-950/40 transition cursor-pointer"
              >
                {isDeleting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
