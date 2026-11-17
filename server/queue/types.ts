import { JobStatus, JobType, ProcessingJobRecord } from '../db.ts';

export interface EnqueueJobInput {
  idempotencyKey: string;
  mediaId: string;
  versionId?: string;
  jobType: JobType;
  priority?: number;
  maxAttempts?: number;
  payload?: Record<string, any>;
  createdBy: string;
}

export interface JobQueueAdapter {
  readonly driverName: string;
  enqueue(input: EnqueueJobInput): Promise<{ job: ProcessingJobRecord; deduplicated: boolean }>;
  claimNext(workerId: string, leaseDurationMs?: number): Promise<ProcessingJobRecord | null>;
  heartbeat(jobId: string, workerId: string, leaseDurationMs?: number): Promise<boolean>;
  checkpoint(jobId: string, checkpoint: string, progressPercent: number, statusMessage?: string): Promise<void>;
  complete(jobId: string, result?: Record<string, any>): Promise<void>;
  fail(jobId: string, errorMessage: string): Promise<ProcessingJobRecord | null>;
  requestCancel(jobId: string): Promise<ProcessingJobRecord | null>;
  retryJob(jobId: string): Promise<ProcessingJobRecord | null>;
  listJobs(status?: JobStatus | 'all', limit?: number): Promise<ProcessingJobRecord[]>;
}
