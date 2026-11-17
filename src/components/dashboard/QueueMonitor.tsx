import React, { useState, useEffect, useCallback } from 'react';
import { ProcessingJobItem } from '../../types/media';
import {
  fetchProcessingJobs,
  cancelProcessingJob,
  retryProcessingJob,
  replayDeadLetterJobs,
} from '../../services/api';
import { useToast } from '../common/Toast';

const STATUS_FILTERS: Array<{ id: string; label: string }> = [
  { id: 'all', label: 'All Jobs' },
  { id: 'queued', label: 'Queued' },
  { id: 'running', label: 'Running' },
  { id: 'completed', label: 'Completed' },
  { id: 'failed', label: 'Failed' },
  { id: 'dead_letter', label: 'Dead Letter' },
];

export const QueueMonitor: React.FC = () => {
  const toast = useToast();
  const [jobs, setJobs] = useState<ProcessingJobItem[]>([]);
  const [driver, setDriver] = useState<string>('firestore');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isReplayingDlq, setIsReplayingDlq] = useState<boolean>(false);

  const loadJobs = useCallback(
    async (silent = false) => {
      if (!silent) setIsLoading(true);
      try {
        const res = await fetchProcessingJobs(statusFilter, 80);
        setJobs(res.jobs || []);
        setDriver(res.driver || 'firestore');
      } catch (err: any) {
        if (!silent) toast.error(err?.message || 'Failed to load queue jobs', 'Queue Error');
      } finally {
        if (!silent) setIsLoading(false);
      }
    },
    [statusFilter, toast]
  );

  useEffect(() => {
    loadJobs();
  }, [loadJobs]);

  const hasActiveJobs = jobs.some((j) => j.status === 'queued' || j.status === 'running');

  useEffect(() => {
    if (!hasActiveJobs) return;
    const timer = setInterval(() => {
      loadJobs(true);
    }, 5000);
    return () => clearInterval(timer);
  }, [hasActiveJobs, loadJobs]);

  const handleCancel = async (jobId: string) => {
    try {
      await cancelProcessingJob(jobId);
      toast.success('Cancellation signal sent to worker.', 'Job Cancelled');
      loadJobs(true);
    } catch (err: any) {
      toast.error(err?.message || 'Failed to cancel job', 'Action Error');
    }
  };

  const handleRetry = async (jobId: string) => {
    try {
      await retryProcessingJob(jobId);
      toast.success('Job re-queued for execution.', 'Job Retried');
      loadJobs(true);
    } catch (err: any) {
      toast.error(err?.message || 'Failed to retry job', 'Action Error');
    }
  };

  const handleReplayDlq = async () => {
    setIsReplayingDlq(true);
    try {
      const res = await replayDeadLetterJobs();
      toast.success(`Re-queued ${res.replayed} dead-letter job(s).`, 'DLQ Replayed');
      loadJobs(true);
    } catch (err: any) {
      toast.error(err?.message || 'Failed to replay dead-letter jobs', 'DLQ Error');
    } finally {
      setIsReplayingDlq(false);
    }
  };

  const statusBadge = (status: ProcessingJobItem['status']) => {
    switch (status) {
      case 'completed':
        return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30';
      case 'running':
        return 'bg-blue-500/10 text-blue-400 border-blue-500/30';
      case 'queued':
        return 'bg-amber-500/10 text-amber-400 border-amber-500/30';
      case 'failed':
      case 'dead_letter':
        return 'bg-red-500/10 text-red-400 border-red-500/30';
      default:
        return 'bg-zinc-800 text-zinc-400 border-zinc-700';
    }
  };

  const dlqCount = jobs.filter((j) => j.status === 'dead_letter').length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="p-5 bg-zinc-900/70 border border-zinc-800 rounded-2xl flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h2 className="text-lg font-bold text-white">Async Processing Queue & Workers</h2>
            <span className="text-[10px] font-mono px-2.5 py-0.5 rounded-full bg-zinc-950 border border-zinc-800 text-zinc-300">
              driver: {driver}
            </span>
            {hasActiveJobs && (
              <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-blue-500/15 border border-blue-500/30 text-blue-300">
                Auto-refresh 5s
              </span>
            )}
          </div>
          <p className="text-xs text-zinc-400 mt-0.5">
            Durable idempotent jobs for HLS ABR packaging, Whisper/Gemini transcription, subtitle translation, and intro detection.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {dlqCount > 0 && (
            <button
              onClick={handleReplayDlq}
              disabled={isReplayingDlq}
              className="px-3.5 py-2 bg-amber-600/20 hover:bg-amber-600/30 text-amber-300 border border-amber-500/30 rounded-xl text-xs font-semibold transition cursor-pointer disabled:opacity-50"
            >
              {isReplayingDlq ? 'Replaying...' : `Replay DLQ (${dlqCount})`}
            </button>
          )}
          <button
            onClick={() => loadJobs()}
            className="px-3.5 py-2 bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-200 rounded-xl text-xs font-semibold transition cursor-pointer"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Status Filter Tabs */}
      <div className="flex flex-wrap items-center gap-1.5">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => setStatusFilter(f.id)}
            className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold transition cursor-pointer ${
              statusFilter === f.id
                ? 'bg-red-600 text-white shadow'
                : 'bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-white'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Jobs List */}
      {isLoading ? (
        <div className="py-16 flex flex-col items-center justify-center text-zinc-500">
          <div className="w-8 h-8 rounded-full border-2 border-red-600/30 border-t-red-500 animate-spin mb-3" />
          <p className="text-xs">Loading processing queue...</p>
        </div>
      ) : jobs.length === 0 ? (
        <div className="py-16 border border-dashed border-zinc-800 rounded-2xl text-center bg-zinc-950/40">
          <p className="text-sm font-semibold text-zinc-300">No jobs in this state</p>
          <p className="text-xs text-zinc-500 mt-1">
            Upload a video, trigger HLS re-packaging, or run AI Studio tasks to enqueue background worker jobs.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {jobs.map((job) => (
            <div
              key={job.id}
              className="p-4 bg-zinc-900/60 border border-zinc-800/90 rounded-2xl space-y-3"
            >
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-mono font-bold text-white px-2 py-0.5 rounded bg-zinc-950 border border-zinc-800">
                    {job.jobType}
                  </span>
                  <span
                    className={`text-[10px] font-mono uppercase px-2 py-0.5 rounded-full border ${statusBadge(
                      job.status
                    )}`}
                  >
                    {job.status}
                  </span>
                  <span className="text-xs font-mono text-zinc-400">Media: {job.mediaId}</span>
                  <span className="text-[11px] font-mono text-zinc-500">
                    Attempt {job.attempts}/{job.maxAttempts} • Checkpoint: {job.checkpoint}
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  {(job.status === 'queued' || job.status === 'running') && (
                    <button
                      onClick={() => handleCancel(job.id)}
                      className="px-2.5 py-1 bg-zinc-800 hover:bg-red-950/60 text-zinc-300 hover:text-red-300 border border-zinc-700 rounded-lg text-[11px] font-medium cursor-pointer"
                    >
                      Cancel
                    </button>
                  )}
                  {(job.status === 'failed' || job.status === 'dead_letter' || job.status === 'cancelled') && (
                    <button
                      onClick={() => handleRetry(job.id)}
                      className="px-2.5 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 rounded-lg text-[11px] font-medium cursor-pointer"
                    >
                      Retry
                    </button>
                  )}
                </div>
              </div>

              {/* Progress bar */}
              <div className="space-y-1">
                <div className="flex items-center justify-between text-[11px] text-zinc-400">
                  <span className="truncate pr-2">{job.statusMessage || job.checkpoint}</span>
                  <span className="font-mono text-zinc-300">{job.progressPercent}%</span>
                </div>
                <div className="w-full h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                  <div
                    className={`h-full transition-all duration-300 ${
                      job.status === 'failed' || job.status === 'dead_letter'
                        ? 'bg-red-500'
                        : job.status === 'completed'
                        ? 'bg-emerald-500'
                        : 'bg-red-600'
                    }`}
                    style={{ width: `${Math.min(100, Math.max(0, job.progressPercent))}%` }}
                  />
                </div>
              </div>

              {job.error && (
                <div className="p-2.5 bg-red-950/35 border border-red-500/25 rounded-xl text-[11px] font-mono text-red-300 break-words">
                  {job.error}
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] font-mono text-zinc-500">
                <span>Job ID: {job.id}</span>
                <span>Updated: {new Date(job.updatedAt).toLocaleString()}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
