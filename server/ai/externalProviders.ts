import fs from 'node:fs';
import path from 'node:path';
import {
  TranscriptionProvider,
  TranscriptionRequest,
  TranscriptionResult,
  TranslationProvider,
  ChapterAnalysisProvider,
} from './types.ts';
import {
  GeminiTranscriptionProvider,
  GeminiTranslationProvider,
  GeminiChapterAnalysisProvider,
} from './geminiProvider.ts';

// External Whisper API adapter (activated if OPENAI_API_KEY is configured)
export class WhisperApiTranscriptionProvider implements TranscriptionProvider {
  public readonly id = 'whisper';
  public readonly displayName = 'OpenAI Whisper (External Hook)';

  public isConfigured(): boolean {
    return Boolean((process.env.OPENAI_API_KEY || '').trim());
  }

  public async transcribeToVtt(req: TranscriptionRequest): Promise<TranscriptionResult> {
    const apiKey = (process.env.OPENAI_API_KEY || '').trim();
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is not configured in environment.');
    }

    const fileBuf = await fs.promises.readFile(req.audioFilePath);
    const form = new FormData();
    form.append('file', new Blob([fileBuf], { type: 'audio/mp3' }), path.basename(req.audioFilePath));
    form.append('model', 'whisper-1');
    form.append('response_format', 'vtt');
    if (req.languageHint) form.append('language', req.languageHint);

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Whisper transcription failed (${res.status}): ${errText.slice(0, 240)}`);
    }

    const vttContent = await res.text();
    return {
      vttContent,
      language: req.languageHint || 'auto',
      provider: this.id,
    };
  }
}

// External Deepgram API adapter (activated if DEEPGRAM_API_KEY is configured)
export class DeepgramTranscriptionProvider implements TranscriptionProvider {
  public readonly id = 'deepgram';
  public readonly displayName = 'Deepgram Nova-2 (External Hook)';

  public isConfigured(): boolean {
    return Boolean((process.env.DEEPGRAM_API_KEY || '').trim());
  }

  public async transcribeToVtt(req: TranscriptionRequest): Promise<TranscriptionResult> {
    const apiKey = (process.env.DEEPGRAM_API_KEY || '').trim();
    if (!apiKey) {
      throw new Error('DEEPGRAM_API_KEY is not configured in environment.');
    }

    const buf = await fs.promises.readFile(req.audioFilePath);
    const langParam = req.languageHint ? `&language=${encodeURIComponent(req.languageHint)}` : '&detect_language=true';
    const res = await fetch(`https://api.deepgram.com/v1/listen?model=nova-2&utterances=true&smart_format=true${langParam}`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': 'audio/mp3',
      },
      body: new Uint8Array(buf),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Deepgram API failed (${res.status}): ${errText.slice(0, 240)}`);
    }

    const data: any = await res.json();
    const utterances = data?.results?.utterances || [];
    const lines = ['WEBVTT', ''];

    const fmt = (sec: number) => {
      const msTotal = Math.round(sec * 1000);
      const h = Math.floor(msTotal / 3600000);
      const m = Math.floor((msTotal % 3600000) / 60000);
      const s = Math.floor((msTotal % 60000) / 1000);
      const ms = msTotal % 1000;
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
    };

    for (const u of utterances) {
      lines.push(`${fmt(u.start)} --> ${fmt(u.end)}`);
      lines.push(String(u.transcript || '').trim());
      lines.push('');
    }

    return {
      vttContent: lines.join('\n'),
      language: req.languageHint || 'auto',
      provider: this.id,
    };
  }
}

export function getTranscriptionProvider(providerId = 'gemini'): TranscriptionProvider {
  if (providerId === 'whisper') return new WhisperApiTranscriptionProvider();
  if (providerId === 'deepgram') return new DeepgramTranscriptionProvider();
  return new GeminiTranscriptionProvider();
}

export function getTranslationProvider(): TranslationProvider {
  return new GeminiTranslationProvider();
}

export function getChapterAnalysisProvider(): ChapterAnalysisProvider {
  return new GeminiChapterAnalysisProvider();
}

export function listAvailableAiProviders() {
  const geminiTranscribe = new GeminiTranscriptionProvider();
  const whisper = new WhisperApiTranscriptionProvider();
  const deepgram = new DeepgramTranscriptionProvider();
  return [
    { id: geminiTranscribe.id, displayName: geminiTranscribe.displayName, configured: geminiTranscribe.isConfigured() },
    { id: whisper.id, displayName: whisper.displayName, configured: whisper.isConfigured() },
    { id: deepgram.id, displayName: deepgram.displayName, configured: deepgram.isConfigured() },
  ];
}
