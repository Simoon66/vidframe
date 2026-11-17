import { ChapterItem } from '../db.ts';

export interface TranscriptionRequest {
  audioFilePath: string;
  languageHint?: string;
  mediaTitle?: string;
}

export interface TranscriptionResult {
  vttContent: string;
  language: string;
  provider: string;
}

export interface TranscriptionProvider {
  readonly id: string;
  readonly displayName: string;
  isConfigured(): boolean;
  transcribeToVtt(req: TranscriptionRequest): Promise<TranscriptionResult>;
}

export interface TranslationRequest {
  vttContent: string;
  targetLanguage: string;
}

export interface TranslationProvider {
  readonly id: string;
  readonly displayName: string;
  isConfigured(): boolean;
  translateVtt(req: TranslationRequest): Promise<{ vttContent: string; provider: string }>;
}

export interface ChapterAnalysisRequest {
  mediaTitle: string;
  durationSeconds: number;
  blackSegments: Array<{ start: number; end: number; duration: number }>;
  silenceSegments: Array<{ start: number; end: number; duration: number }>;
  transcriptSample?: string;
}

export interface ChapterAnalysisResult {
  introStart: number;
  introEnd: number;
  outroStart: number;
  outroEnd: number;
  chapters: ChapterItem[];
  confidenceNote: string;
  provider: string;
}

export interface ChapterAnalysisProvider {
  readonly id: string;
  readonly displayName: string;
  isConfigured(): boolean;
  analyzeStructure(req: ChapterAnalysisRequest): Promise<ChapterAnalysisResult>;
}
