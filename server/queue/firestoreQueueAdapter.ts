import crypto from 'node:crypto';
import {
  ProcessingJobRecord,
  JobStatus,
  computeShard,
  saveProcessingJob,
  getProcessingJob,
  findJobByIdempotencyKey,
  listProcessingJobs,
} from '../db.ts';
import { EnqueueJobInput, JobQueueAdapter } from './types.ts';

export class FirestoreJobQueueAdapter implements JobQueueAdapter {
  public readonly driverName: string = 'firestore';

  public async enqueue(input: EnqueueJobInput): Promise<{ job: ProcessingJobRecord; deduplicated: boolean }> {
    const existing = await findJobByIdempotencyKey(input.idempotencyKey);
    if (existing && (existing.status === 'queued' || existing.status === 'running')) {
      return { job: existing, deduplicated: true };
    }

    const now = new Date().toISOString();
    const id = `job_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const job: ProcessingJobRecord = {
      id,
      idempotencyKey: input.idempotencyKey,
      queueShard: `q_${computeShard(input.mediaId, 8)}`,
      mediaId: input.mediaId,
      versionId: input.versionId,
      jobType: input.jobType,
      status: 'queued',
      priority: input.priority ?? 5,
      attempts: 0,
      maxAttempts: input.maxAttempts ?? 3,
      checkpoint: 'queued',
      progressPercent: 0,
      statusMessage: 'Queued for worker execution',
      cancelRequested: false,
      payload: input.payload || {},
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };

    await saveProcessingJob(job);
    return { job, deduplicated: false };
  }

  public async claimNext(workerId: string, leaseDurationMs = 120000): Promise<ProcessingJobRecord | null> {
    const nowMs = Date.now();
    // Claim queued jobs first, or expired leased running jobs (stale worker recovery)
    const [queued, running] = await Promise.all([
      listProcessingJobs({ status: 'queued', limit: 25 }),
      listProcessingJobs({ status: 'running', limit: 15 }),
    ]);

    const candidates = [
      ...queued,
      ...running.filter((j) => j.leaseExpiresAt && new Date(j.leaseExpiresAt).getTime() < nowMs),
    ].sort((a, b) => (b.priority - a.priority) || a.createdAt.localeCompare(b.createdAt));

    for (const candidate of candidates) {
      if (candidate.cancelRequested) {
        await saveProcessingJob({
          ...candidate,
          status: 'cancelled',
          statusMessage: 'Cancelled before worker execution',
          updatedAt: new Date().toISOString(),
        });
        continue;
      }

      const nowIso = new Date().toISOString();
      const leaseExpiresAt = new Date(nowMs + leaseDurationMs).toISOString();
      const claimed: ProcessingJobRecord = {
        ...candidate,
        status: 'running',
        attempts: candidate.attempts + 1,
        leaseOwner: workerId,
        leaseExpiresAt,
        heartbeatAt: nowIso,
        statusMessage: candidate.statusMessage || 'Claimed by media worker',
        updatedAt: nowIso,
      };
      await saveProcessingJob(claimed);
      return claimed;
    }

    return null;
  }

  public async heartbeat(jobId: string, workerId: string, leaseDurationMs = 120000): Promise<boolean> {
    const job = await getProcessingJob(jobId);
    if (!job || job.status !== 'running' || job.leaseOwner !== workerId) {
      return false;
    }
    if (job.cancelRequested) {
      return false;
    }
    const nowMs = Date.now();
    await saveProcessingJob({
      ...job,
      heartbeatAt: new Date(nowMs).toISOString(),
      leaseExpiresAt: new Date(nowMs + leaseDurationMs).toISOString(),
      updatedAt: new Date(nowMs).toISOString(),
    });
    return true;
  }

  public async checkpoint(
    jobId: string,
    checkpoint: string,
    progressPercent: number,
    statusMessage?: string
  ): Promise<void> {
    const job = await getProcessingJob(jobId);
    if (!job) return;
    await saveProcessingJob({
      ...job,
      checkpoint,
      progressPercent: Math.max(0, Math.min(100, Math.round(progressPercent))),
      statusMessage: statusMessage ?? job.statusMessage,
      heartbeatAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  public async complete(jobId: string, result?: Record<string, any>): Promise<void> {
    const job = await getProcessingJob(jobId);
    if (!job) return;
    await saveProcessingJob({
      ...job,
      status: 'completed',
      checkpoint: 'completed',
      progressPercent: 100,
      statusMessage: 'Completed successfully',
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      result,
      updatedAt: new Date().toISOString(),
    });
  }

  public async fail(jobId: string, errorMessage: string): Promise<ProcessingJobRecord | null> {
    const job = await getProcessingJob(jobId);
    if (!job) return null;

    if (job.cancelRequested) {
      const cancelled: ProcessingJobRecord = {
        ...job,
        status: 'cancelled',
        statusMessage: 'Cancelled by operator',
        error: errorMessage,
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        updatedAt: new Date().toISOString(),
      };
      await saveProcessingJob(cancelled);
      return cancelled;
    }

    const exhausted = job.attempts >= job.maxAttempts;
    const nextStatus: JobStatus = exhausted ? 'dead_letter' : 'queued';
    const next: ProcessingJobRecord = {
      ...job,
      status: nextStatus,
      statusMessage: exhausted
        ? `Moved to Dead Letter Queue after ${job.attempts} attempts`
        : `Scheduled retry (attempt ${job.attempts}/${job.maxAttempts})`,
      error: errorMessage.slice(0, 800),
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      updatedAt: new Date().toISOString(),
    };
    await saveProcessingJob(next);
    return next;
  }

  public async requestCancel(jobId: string): Promise<ProcessingJobRecord | null> {
    const job = await getProcessingJob(jobId);
    if (!job) return null;
    const next: ProcessingJobRecord = {
      ...job,
      cancelRequested: true,
      status: job.status === 'queued' ? 'cancelled' : job.status,
      statusMessage: job.status === 'queued' ? 'Cancelled by operator' : 'Cancellation requested...',
      updatedAt: new Date().toISOString(),
    };
    await saveProcessingJob(next);
    return next;
  }

  public async retryJob(jobId: string): Promise<ProcessingJobRecord | null> {
    const job = await getProcessingJob(jobId);
    if (!job) return null;
    const next: ProcessingJobRecord = {
      ...job,
      status: 'queued',
      attempts: 0,
      cancelRequested: false,
      error: undefined,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      statusMessage: 'Re-queued manually from DLQ/Failed state',
      updatedAt: new Date().toISOString(),
    };
    await saveProcessingJob(next);
    return next;
  }

  public async listJobs(status: JobStatus | 'all' = 'all', limit = 50): Promise<ProcessingJobRecord[]> {
    return listProcessingJobs({ status, limit });
  }
}
