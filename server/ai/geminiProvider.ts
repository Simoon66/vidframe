import fs from 'node:fs';
import crypto from 'node:crypto';
import { GoogleGenAI, Type } from '@google/genai';
import { APP_CONFIG } from '../config.ts';
import {
  TranscriptionProvider,
  TranscriptionRequest,
  TranscriptionResult,
  TranslationProvider,
  TranslationRequest,
  ChapterAnalysisProvider,
  ChapterAnalysisRequest,
  ChapterAnalysisResult,
} from './types.ts';

function getGeminiClient(): GoogleGenAI {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY is not configured in the server environment. Configure GEMINI_API_KEY in Settings > Secrets to use Gemini AI transcription, translation, or chapter detection.'
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function normalizeWebVttOutput(rawText: string): string {
  let clean = rawText.trim();
  // Strip optional markdown code fences if present
  clean = clean.replace(/^```(?:vtt|webvtt)?\s*/i, '').replace(/\s*```$/, '').trim();
  if (!clean.startsWith('WEBVTT')) {
    clean = `WEBVTT\n\n${clean}`;
  }
  return clean + '\n';
}

export class GeminiTranscriptionProvider implements TranscriptionProvider {
  public readonly id = 'gemini';
  public readonly displayName = 'Gemini Speech Transcription (gemini-3.5-transcribe)';

  public isConfigured(): boolean {
    return Boolean((process.env.GEMINI_API_KEY || '').trim());
  }

  public async transcribeToVtt(req: TranscriptionRequest): Promise<TranscriptionResult> {
    const ai = getGeminiClient();
    const stat = await fs.promises.stat(req.audioFilePath);
    const prompt = [
      'Transcribe the spoken dialogue in this audio accurately into standard WebVTT subtitle format.',
      'Return ONLY valid WEBVTT starting with "WEBVTT" and timestamps formatted as HH:MM:SS.mmm --> HH:MM:SS.mmm.',
      req.languageHint ? `Language hint: ${req.languageHint}.` : '',
      req.mediaTitle ? `Video context title: ${req.mediaTitle}.` : '',
    ]
      .filter(Boolean)
      .join(' ');

    let responseText = '';
    if (stat.size <= 14 * 1024 * 1024) {
      const b64 = (await fs.promises.readFile(req.audioFilePath)).toString('base64');
      const res = await ai.models.generateContent({
        model: APP_CONFIG.ai.transcriptionModel,
        contents: {
          parts: [
            {
              inlineData: {
                mimeType: 'audio/mp3',
                data: b64,
              },
            },
            { text: prompt },
          ],
        },
      });
      responseText = res.text || '';
    } else {
      // Larger audio files use the @google/genai Files upload API
      const uploaded = await ai.files.upload({
        file: req.audioFilePath,
        config: { mimeType: 'audio/mp3' },
      });
      const res = await ai.models.generateContent({
        model: APP_CONFIG.ai.transcriptionModel,
        contents: [
          {
            role: 'user',
            parts: [
              { fileData: { fileUri: uploaded.uri, mimeType: uploaded.mimeType || 'audio/mp3' } },
              { text: prompt },
            ],
          },
        ],
      });
      responseText = res.text || '';
    }

    if (!responseText.trim()) {
      throw new Error('Gemini returned an empty transcription response.');
    }

    return {
      vttContent: normalizeWebVttOutput(responseText),
      language: req.languageHint || 'auto',
      provider: this.id,
    };
  }
}

export class GeminiTranslationProvider implements TranslationProvider {
  public readonly id = 'gemini';
  public readonly displayName = 'Gemini Subtitle Translation (gemini-4-hydrogen)';

  public isConfigured(): boolean {
    return Boolean((process.env.GEMINI_API_KEY || '').trim());
  }

  public async translateVtt(req: TranslationRequest): Promise<{ vttContent: string; provider: string }> {
    const ai = getGeminiClient();
    const res = await ai.models.generateContent({
      model: APP_CONFIG.ai.translationModel,
      contents: [
        'Translate this WebVTT subtitle file into ' + req.targetLanguage + '.',
        'Strictly preserve all cue timestamps (HH:MM:SS.mmm --> HH:MM:SS.mmm), cue numbering, and WEBVTT header verbatim.',
        'Only translate the spoken subtitle text lines.',
        '',
        req.vttContent,
      ].join('\n'),
    });

    const text = res.text || '';
    if (!text.trim()) {
      throw new Error('Gemini returned an empty translation response.');
    }

    return {
      vttContent: normalizeWebVttOutput(text),
      provider: this.id,
    };
  }
}

export class GeminiChapterAnalysisProvider implements ChapterAnalysisProvider {
  public readonly id = 'gemini';
  public readonly displayName = 'Gemini Chapter & Intro/Outro Analyzer (gemini-4-hydrogen)';

  public isConfigured(): boolean {
    return Boolean((process.env.GEMINI_API_KEY || '').trim());
  }

  public async analyzeStructure(req: ChapterAnalysisRequest): Promise<ChapterAnalysisResult> {
    const ai = getGeminiClient();
    const prompt = JSON.stringify(
      {
        task: 'Analyze video FFmpeg silence/black-frame boundaries and transcript cues to propose intro/outro skip ranges and logical viewer chapters.',
        rules: [
          'Only propose non-zero intro/outro intervals when acoustic/visual cues support an opening or closing credit block.',
          'All timestamps must be within [0, durationSeconds].',
          'Return structured JSON matching the schema.',
        ],
        mediaTitle: req.mediaTitle,
        durationSeconds: Math.round(req.durationSeconds),
        ffmpegBlackFrameCues: req.blackSegments.slice(0, 25),
        ffmpegSilenceCues: req.silenceSegments.slice(0, 30),
        transcriptPreview: req.transcriptSample ? req.transcriptSample.slice(0, 4000) : undefined,
      },
      null,
      2
    );

    const res = await ai.models.generateContent({
      model: APP_CONFIG.ai.analysisModel,
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            introStart: { type: Type.NUMBER, description: 'Proposed intro skip start time in seconds (0 if none)' },
            introEnd: { type: Type.NUMBER, description: 'Proposed intro skip end time in seconds (0 if none)' },
            outroStart: { type: Type.NUMBER, description: 'Proposed outro skip start time in seconds (0 if none)' },
            outroEnd: { type: Type.NUMBER, description: 'Proposed outro skip end time in seconds (0 if none)' },
            confidenceNote: { type: Type.STRING, description: 'Brief explanation citing the FFmpeg cues used' },
            chapters: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING },
                  startTime: { type: Type.NUMBER },
                  endTime: { type: Type.NUMBER },
                },
              },
            },
          },
        },
      },
    });

    const parsed = JSON.parse((res.text || '{}').trim());
    const dur = Math.max(0, req.durationSeconds || 999999);
    const clamp = (n: any) => Math.max(0, Math.min(dur, Number(n) || 0));

    const chapters = Array.isArray(parsed.chapters)
      ? parsed.chapters
          .map((c: any, idx: number) => ({
            id: `ch_${idx + 1}_${crypto.randomBytes(2).toString('hex')}`,
            title: String(c.title || `Chapter ${idx + 1}`).slice(0, 120),
            startTime: clamp(c.startTime),
            endTime: c.endTime !== undefined ? clamp(c.endTime) : undefined,
          }))
          .sort((a: any, b: any) => a.startTime - b.startTime)
      : [];

    return {
      introStart: clamp(parsed.introStart),
      introEnd: clamp(parsed.introEnd),
      outroStart: clamp(parsed.outroStart),
      outroEnd: clamp(parsed.outroEnd),
      chapters,
      confidenceNote: String(parsed.confidenceNote || 'Derived from FFmpeg structural boundaries and Gemini analysis.'),
      provider: this.id,
    };
  }
}
