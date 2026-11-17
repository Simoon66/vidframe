import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { APP_CONFIG } from '../config.ts';
import {
  ProcessingJobRecord,
  JobStatus,
  getMediaItem,
  getMediaVersion,
  updateMediaItem,
  saveIntroSuggestion,
  SubtitleTrackMeta,
} from '../db.ts';
import { getEffectiveBearerToken, clearCachedAdminToken } from '../firestoreRest.ts';
import { JobQueueAdapter, EnqueueJobInput } from './types.ts';
import { FirestoreJobQueueAdapter } from './firestoreQueueAdapter.ts';
import { CloudTasksQueueAdapter, PubSubQueueAdapter } from './cloudQueueAdapters.ts';
import {
  executeHlsPackagingJob,
  resolveLocalSourceVideo,
  detectSilenceAndBlackFrames,
  probeMediaFull,
} from '../workers/mediaPipeline.ts';
import {
  getTranscriptionProvider,
  getTranslationProvider,
  getChapterAnalysisProvider,
} from '../ai/externalProviders.ts';
import { getStorageAdapter } from '../storage/storageRouter.ts';

const WORKER_ID = `worker_${process.pid}_${crypto.randomBytes(3).toString('hex')}`;

class QueueManager {
  private static instance: QueueManager;
  private readonly adapter: JobQueueAdapter;
  private loopTimer: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private activeJobId: string | null = null;

  private constructor() {
    if (APP_CONFIG.queueDriver === 'cloud_tasks') {
      this.adapter = new CloudTasksQueueAdapter();
    } else if (APP_CONFIG.queueDriver === 'pubsub') {
      this.adapter = new PubSubQueueAdapter();
    } else {
      this.adapter = new FirestoreJobQueueAdapter();
    }
  }

  public static getInstance(): QueueManager {
    if (!QueueManager.instance) {
      QueueManager.instance = new QueueManager();
    }
    return QueueManager.instance;
  }

  public getDriverName(): string {
    return this.adapter.driverName;
  }

  public startWorkerLoop(): void {
    if (this.loopTimer) return;
    // Trigger background check every 4 seconds; only hits Firestore when a valid admin token/Service Account exists
    this.loopTimer = setInterval(() => {
      this.tick().catch((err) => {
        console.warn('[QueueWorker] Tick notice:', err?.message || err);
      });
    }, 4000);
    this.loopTimer.unref();
  }

  public async enqueue(input: EnqueueJobInput): Promise<{ job: ProcessingJobRecord; deduplicated: boolean }> {
    const res = await this.adapter.enqueue(input);
    // Wake worker loop immediately
    setTimeout(() => {
      this.tick().catch(() => {});
    }, 50);
    return res;
  }

  public async listJobs(status: JobStatus | 'all' = 'all', limit = 50): Promise<ProcessingJobRecord[]> {
    return this.adapter.listJobs(status, limit);
  }

  public async cancelJob(jobId: string): Promise<ProcessingJobRecord | null> {
    return this.adapter.requestCancel(jobId);
  }

  public async retryJob(jobId: string): Promise<ProcessingJobRecord | null> {
    const retried = await this.adapter.retryJob(jobId);
    setTimeout(() => {
      this.tick().catch(() => {});
    }, 50);
    return retried;
  }

  public async tick(): Promise<void> {
    if (this.isProcessing) return;
    const hasServiceAccount = Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS);
    if (!hasServiceAccount && !getEffectiveBearerToken()) {
      return; // Wait until admin session or service account is present
    }

    this.isProcessing = true;
    try {
      const job = await this.adapter.claimNext(WORKER_ID, 180000);
      if (!job) return;
      await this.executeJob(job);
    } catch (err: any) {
      const msg = String(err?.message || err || '');
      if (err?.status === 401 || msg.includes('(401)') || msg.includes('UNAUTHENTICATED')) {
        // Cached sandbox admin ID token expired; pause background polling silently until next authenticated admin request
        clearCachedAdminToken();
        return;
      }
      throw err;
    } finally {
      this.isProcessing = false;
      this.activeJobId = null;
    }
  }

  public async executeJobById(jobId: string): Promise<void> {
    const jobs = await this.adapter.listJobs('all', 100);
    const job = jobs.find((j) => j.id === jobId);
    if (job) {
      await this.executeJob(job);
    }
  }

  private async executeJob(job: ProcessingJobRecord): Promise<void> {
    this.activeJobId = job.id;
    const heartbeatTimer = setInterval(() => {
      this.adapter.heartbeat(job.id, WORKER_ID, 180000).catch(() => {});
    }, 25000);
    heartbeatTimer.unref();

    try {
      const checkpoint = async (stage: string, pct: number, msg: string) => {
        await this.adapter.checkpoint(job.id, stage, pct, msg);
      };

      if (job.jobType === 'transcode_hls') {
        const version = await executeHlsPackagingJob(
          job.mediaId,
          job.versionId,
          checkpoint,
          job.payload?.localSourcePath
        );
        await this.adapter.complete(job.id, {
          versionId: version.id,
          masterPlaylistKey: version.masterPlaylistKey,
          renditionsCount: version.renditions.length,
        });
      } else if (job.jobType === 'ai_transcribe') {
        await this.runAiTranscribeJob(job, checkpoint);
      } else if (job.jobType === 'ai_translate') {
        await this.runAiTranslateJob(job, checkpoint);
      } else if (job.jobType === 'detect_intro') {
        await this.runDetectIntroJob(job, checkpoint);
      } else {
        throw new Error(`Unsupported jobType: ${job.jobType}`);
      }
    } catch (err: any) {
      console.error(`[QueueWorker] Job ${job.id} (${job.jobType}) failed:`, err?.message || err);
      await this.adapter.fail(job.id, err?.message || 'Job execution failed');
    } finally {
      clearInterval(heartbeatTimer);
    }
  }

  private async runAiTranscribeJob(
    job: ProcessingJobRecord,
    checkpoint: (stage: string, pct: number, msg: string) => Promise<void>
  ): Promise<void> {
    const media = await getMediaItem(job.mediaId);
    if (!media) throw new Error(`Media ${job.mediaId} not found.`);

    const providerId = String(job.payload?.provider || 'gemini');
    const provider = getTranscriptionProvider(providerId);
    if (!provider.isConfigured()) {
      throw new Error(`Transcription provider '${provider.displayName}' is not configured.`);
    }

    await checkpoint('fetching_source', 15, 'Fetching source video for audio extraction...');
    const version = media.activeVersionId ? await getMediaVersion(media.activeVersionId) : null;
    const localVideo = await resolveLocalSourceVideo(media, version);

    await checkpoint('extracting_audio', 35, 'Extracting speech audio track with FFmpeg...');
    const audioOut = path.resolve(process.cwd(), 'temp_uploads', `ai_audio_${job.id}.mp3`);
    const extRes = spawnSync('ffmpeg', [
      '-y',
      '-i', localVideo,
      '-vn',
      '-ac', '1',
      '-ar', '16000',
      '-b:a', '48k',
      audioOut,
    ]);
    if (extRes.status !== 0 || !fs.existsSync(audioOut)) {
      throw new Error('Failed to extract audio track from video for transcription.');
    }

    try {
      await checkpoint('transcribing', 60, `Transcribing speech to WebVTT via ${provider.displayName}...`);
      const result = await provider.transcribeToVtt({
        audioFilePath: audioOut,
        languageHint: job.payload?.language || undefined,
        mediaTitle: media.title,
      });

      await checkpoint('saving_subtitles', 90, 'Persisting generated WebVTT subtitle track...');
      const lang = (job.payload?.language || result.language || 'en').toLowerCase().slice(0, 12);
      const subFileName = `ai_${lang}_${Date.now()}.vtt`;
      const existingSubs = media.subtitleTracks || [];
      const nextIndex = existingSubs.length;

      let publicUrl = `/api/media/${media.id}/subtitles/file/${subFileName}`;
      let objectKey: string | undefined;

      if (version && (version.storageBackend === 's3_r2' || version.storageBackend === 'local_dev')) {
        const adapter = await getStorageAdapter(version.storageBackend);
        objectKey = `${version.objectPrefix}/${subFileName}`;
        await adapter.putObject(objectKey, result.vttContent, 'text/vtt');
        publicUrl = `/api/cdn/v1/hls/${media.id}/${version.id}/${subFileName}`;
      } else {
        const subDir = path.resolve(process.cwd(), 'public_subtitles');
        if (!fs.existsSync(subDir)) fs.mkdirSync(subDir, { recursive: true });
        fs.writeFileSync(path.join(subDir, `${media.id}_${subFileName}`), result.vttContent, 'utf8');
      }

      const newTrack: SubtitleTrackMeta = {
        index: nextIndex,
        language: lang,
        title: `${lang.toUpperCase()} (AI Transcribed - ${result.provider})`,
        format: 'vtt',
        url: publicUrl,
        objectKey,
        isDefault: existingSubs.length === 0,
        source: 'ai_transcribed',
      };

      await updateMediaItem(media.id, {
        subtitleTracks: [...existingSubs, newTrack],
      });

      await this.adapter.complete(job.id, { subtitleTrack: newTrack });
    } finally {
      try {
        if (fs.existsSync(audioOut)) fs.unlinkSync(audioOut);
      } catch {}
    }
  }

  private async runAiTranslateJob(
    job: ProcessingJobRecord,
    checkpoint: (stage: string, pct: number, msg: string) => Promise<void>
  ): Promise<void> {
    const media = await getMediaItem(job.mediaId);
    if (!media) throw new Error(`Media ${job.mediaId} not found.`);

    const targetLanguage = String(job.payload?.targetLanguage || 'Spanish');
    const targetCode = String(job.payload?.targetCode || targetLanguage.slice(0, 2).toLowerCase());
    const sourceTrackIndex = Number(job.payload?.sourceTrackIndex ?? 0);

    const provider = getTranslationProvider();
    if (!provider.isConfigured()) {
      throw new Error(`Translation provider '${provider.displayName}' requires GEMINI_API_KEY.`);
    }

    await checkpoint('loading_source_vtt', 25, 'Loading source WebVTT track...');
    const sourceTrack = (media.subtitleTracks || []).find((s) => s.index === sourceTrackIndex) || media.subtitleTracks?.[0];
    if (!sourceTrack) {
      throw new Error('No existing subtitle track available to translate.');
    }

    let sourceVtt = '';
    if (sourceTrack.objectKey && media.storageBackend) {
      const adapter = await getStorageAdapter(media.storageBackend);
      sourceVtt = await adapter.getObjectText(sourceTrack.objectKey);
    } else {
      const fileCandidate = path.resolve(
        process.cwd(),
        'public_subtitles',
        `sub_${media.id}_${sourceTrack.index}.vtt`
      );
      if (fs.existsSync(fileCandidate)) {
        sourceVtt = fs.readFileSync(fileCandidate, 'utf8');
      }
    }

    if (!sourceVtt.trim()) {
      throw new Error('Source subtitle file content could not be loaded for translation.');
    }

    await checkpoint('translating', 60, `Translating captions into ${targetLanguage} via Gemini...`);
    const translated = await provider.translateVtt({
      vttContent: sourceVtt,
      targetLanguage,
    });

    const subFileName = `ai_tr_${targetCode}_${Date.now()}.vtt`;
    const subDir = path.resolve(process.cwd(), 'public_subtitles');
    if (!fs.existsSync(subDir)) fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, `${media.id}_${subFileName}`), translated.vttContent, 'utf8');

    const nextIndex = (media.subtitleTracks || []).length;
    const newTrack: SubtitleTrackMeta = {
      index: nextIndex,
      language: targetCode,
      title: `${targetLanguage} (AI Translated)`,
      format: 'vtt',
      url: `/api/media/${media.id}/subtitles/file/${subFileName}`,
      source: 'ai_translated',
    };

    await updateMediaItem(media.id, {
      subtitleTracks: [...(media.subtitleTracks || []), newTrack],
    });

    await this.adapter.complete(job.id, { subtitleTrack: newTrack });
  }

  private async runDetectIntroJob(
    job: ProcessingJobRecord,
    checkpoint: (stage: string, pct: number, msg: string) => Promise<void>
  ): Promise<void> {
    const media = await getMediaItem(job.mediaId);
    if (!media) throw new Error(`Media ${job.mediaId} not found.`);

    const provider = getChapterAnalysisProvider();
    if (!provider.isConfigured()) {
      throw new Error(`Chapter analysis provider '${provider.displayName}' requires GEMINI_API_KEY.`);
    }

    await checkpoint('fetching_source', 20, 'Resolving source video for FFmpeg black-frame & silence scan...');
    const version = media.activeVersionId ? await getMediaVersion(media.activeVersionId) : null;
    const localVideo = await resolveLocalSourceVideo(media, version);
    const probe = probeMediaFull(localVideo);

    await checkpoint('ffmpeg_cue_scan', 50, 'Running FFmpeg blackdetect and silencedetect structural scan...');
    const cues = detectSilenceAndBlackFrames(localVideo);

    await checkpoint('gemini_analysis', 75, 'Analyzing structural cues & boundaries with Gemini...');
    const analysis = await provider.analyzeStructure({
      mediaTitle: media.title,
      durationSeconds: probe.duration || media.duration || 0,
      blackSegments: cues.blackSegments,
      silenceSegments: cues.silenceSegments,
    });

    const suggestionId = `sug_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    await saveIntroSuggestion({
      id: suggestionId,
      mediaId: media.id,
      introStart: analysis.introStart,
      introEnd: analysis.introEnd,
      outroStart: analysis.outroStart,
      outroEnd: analysis.outroEnd,
      chapters: analysis.chapters,
      confidenceNote: analysis.confidenceNote,
      provider: analysis.provider,
      status: 'pending',
      createdBy: job.createdBy,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await this.adapter.complete(job.id, { suggestionId, chaptersCount: analysis.chapters.length });
  }
}

export const queueManager = QueueManager.getInstance();
