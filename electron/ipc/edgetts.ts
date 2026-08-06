import { ipcMain } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { projectDir } from './project';
import type { EdgeTtsSynthesizeArgs, EdgeTtsSynthesizeResult, EdgeTtsVoice, SubtitleWordTiming } from '../../src/shared/types';
import type { IpcResult } from '../../src/shared/appErrors';
import { AppFailure, appFailure, appFailureResult, appSuccess } from './appErrors';
import { audioOutputFailure, replaceAudioFile, validateAudioFile } from './audio';

// edge-tts calls Microsoft Edge's online Read-Aloud service over a WebSocket —
// free, no API key, but requires network. Node-only (the service now demands an
// Edge user-agent), so it runs here in the main process, not the renderer. Each
// job is tracked by id so the renderer can cancel a slow synthesis mid-run.

type Job = { tts: MsEdgeTTS };
const running = new Map<string, Job>();
const EDGE_SYNTHESIS_INACTIVITY_MS = 90_000;
const EDGE_REQUEST_START_TIMEOUT_MS = 35_000;

async function withStartTimeout<T>(work: Promise<T>, tts: MsEdgeTTS, context?: { chunkNumber?: number; chunkCount?: number }): Promise<T> {
  let timer: NodeJS.Timeout;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          tts.close();
          reject(appFailure('VOICE_REQUEST_TIMEOUT', context));
        }, EDGE_REQUEST_START_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

function freeVoiceFailure(error: unknown, context?: { chunkNumber?: number; chunkCount?: number }): AppFailure {
  if (error instanceof AppFailure) return error;
  const code = error && typeof error === 'object' ? String((error as NodeJS.ErrnoException).code || '').toUpperCase() : '';
  if (['EACCES', 'EPERM', 'ENOSPC'].includes(code)) return audioOutputFailure(error);
  return appFailure('VOICE_SERVICE_UNAVAILABLE', context);
}

// The SSML template inserts text verbatim, so user input must be XML-escaped to
// avoid breaking the document (or injecting extra SSML tags).
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// speed multiplier (1 = natural) → signed percentage string the service expects.
function ratePercent(speed?: number): string {
  const clamped = Math.max(0.5, Math.min(2, Number(speed) || 1));
  const pct = Math.round((clamped - 1) * 100);
  return `${pct >= 0 ? '+' : ''}${pct}%`;
}

type BoundaryItem = {
  Type?: string;
  Data?: {
    Offset?: number;
    Duration?: number;
    text?: { Text?: string };
  };
};

const BOUNDARY_TICKS_PER_SECOND = 10_000_000;
const CJK_RE = /[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯가-힯]/;
const PUNCT_RE = /^[，。！？、；：,.!?;:）)】」』…]+$/;

function scriptWords(text: string): string[] {
  const clean = text.replace(/\r\n|\r|\n/g, ' ').trim().replace(/\s+/g, ' ');
  if (!clean) return [];
  if (/\s/.test(clean)) return clean.split(/\s+/).filter(Boolean);
  if (!CJK_RE.test(clean)) return [clean];
  const words: string[] = [];
  for (const char of [...clean]) {
    if (PUNCT_RE.test(char) && words.length) words[words.length - 1] += char;
    else words.push(char);
  }
  return words;
}

function normalizedLength(text: string): number {
  return Math.max(1, [...text.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')].length);
}

function boundaryTimings(text: string, chunks: Buffer[]): SubtitleWordTiming[] {
  const expected = scriptWords(text);
  if (!expected.length || !chunks.length) return [];
  const boundaries: BoundaryItem[] = [];
  for (const chunk of chunks) {
    try {
      const parsed = JSON.parse(chunk.toString('utf8')) as { Metadata?: BoundaryItem[] };
      boundaries.push(...(parsed.Metadata ?? []).filter((item) => item.Type === 'WordBoundary'));
    } catch {
      // Ignore a malformed metadata packet and fall back to audio alignment.
    }
  }
  const measured = boundaries.map((item) => ({
    start: Math.max(0, Number(item.Data?.Offset ?? 0) / BOUNDARY_TICKS_PER_SECOND),
    end: Math.max(0, Number(item.Data?.Offset ?? 0) + Number(item.Data?.Duration ?? 0)) / BOUNDARY_TICKS_PER_SECOND,
    text: String(item.Data?.text?.Text ?? ''),
  })).filter((item) => item.text && item.end > item.start);
  if (!measured.length) return [];
  if (measured.length === expected.length) {
    return expected.map((word, index) => ({ word, start: measured[index].start, end: measured[index].end }));
  }

  // Some languages return one boundary for a multi-character word. Consume the
  // matching script characters and divide that measured boundary between them.
  const result: SubtitleWordTiming[] = [];
  let cursor = 0;
  for (const boundary of measured) {
    if (cursor >= expected.length) break;
    const targetUnits = normalizedLength(boundary.text);
    const group: string[] = [];
    let units = 0;
    while (cursor < expected.length && (units < targetUnits || !group.length)) {
      group.push(expected[cursor]);
      units += normalizedLength(expected[cursor]);
      cursor += 1;
    }
    let elapsedUnits = 0;
    for (const word of group) {
      const wordUnits = normalizedLength(word);
      const start = boundary.start + ((boundary.end - boundary.start) * elapsedUnits) / units;
      elapsedUnits += wordUnits;
      const end = boundary.start + ((boundary.end - boundary.start) * elapsedUnits) / units;
      result.push({ word, start, end });
    }
  }
  return cursor === expected.length ? result : [];
}

export function registerEdgeTtsIpc(): void {
  ipcMain.handle('edgetts:voices', async (): Promise<IpcResult<EdgeTtsVoice[]>> => {
    try {
      const tts = new MsEdgeTTS();
      const voices = await withStartTimeout(tts.getVoices(), tts);
      return appSuccess(voices.map((voice) => ({
        shortName: voice.ShortName,
        friendlyName: voice.FriendlyName,
        locale: voice.Locale,
        gender: voice.Gender,
      })));
    } catch (error) {
      return appFailureResult(error, 'VOICE_SERVICE_UNAVAILABLE', { operation: 'voice-catalog' });
    }
  });

  ipcMain.handle('edgetts:synthesize', async (_e, args: EdgeTtsSynthesizeArgs): Promise<IpcResult<EdgeTtsSynthesizeResult>> => {
    const context = args?.chunkNumber && args?.chunkCount
      ? { chunkNumber: args.chunkNumber, chunkCount: args.chunkCount }
      : undefined;
    let partialPath = '';
    try {
      const { projectId, jobId, segmentId, text, voiceId } = args ?? {};
      if (!projectId || !jobId || !segmentId || !text?.trim() || !voiceId) throw appFailure('VOICE_INPUT_INVALID', context);
      if (running.has(jobId)) throw appFailure('VOICE_JOB_CONFLICT', context);

      const audioDir = path.join(projectDir(projectId), 'audio');
      await fs.mkdir(audioDir, { recursive: true }).catch((error) => { throw audioOutputFailure(error); });
      const outPath = path.join(audioDir, `${segmentId.replace(/[^a-z0-9_-]/gi, '_')}.mp3`);
      partialPath = `${outPath}.partial.mp3`;
      await fs.rm(partialPath, { force: true }).catch(() => undefined);

      const tts = new MsEdgeTTS();
      running.set(jobId, { tts });

      try {
        await withStartTimeout(
          tts.setMetadata(voiceId, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, { wordBoundaryEnabled: true }),
          tts,
          context,
        );
        const pitchHz = Math.round(Number(args.pitch) || 0);
        const volume = Math.max(0, Math.min(100, Number.isFinite(args.volume as number) ? Number(args.volume) : 100));
        const { audioStream, metadataStream } = tts.toStream(escapeXml(text), {
          rate: ratePercent(args.speed),
          pitch: `${pitchHz >= 0 ? '+' : ''}${pitchHz}Hz`,
          volume,
        });

        const chunks: Buffer[] = [];
        const metadataChunks: Buffer[] = [];
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          let audioClosed = false;
          let timer: NodeJS.Timeout;
          const finish = (error?: unknown) => {
            if (settled) return;
            if (!error && !audioClosed) return;
            settled = true;
            clearTimeout(timer);
            error ? reject(error) : resolve();
          };
          const arm = () => {
            clearTimeout(timer);
            timer = setTimeout(() => {
              tts.close();
              finish(appFailure('VOICE_REQUEST_TIMEOUT', context));
            }, EDGE_SYNTHESIS_INACTIVITY_MS);
          };
          arm();
          audioStream.on('data', (chunk: Buffer) => { arm(); chunks.push(chunk); });
          const audioDone = () => { audioClosed = true; finish(); };
          audioStream.on('end', audioDone);
          audioStream.on('close', audioDone);
          audioStream.on('error', () => finish(appFailure('VOICE_SERVICE_UNAVAILABLE', context)));
          metadataStream?.on('data', (chunk: Buffer) => { arm(); metadataChunks.push(chunk); });
          // Metadata is an enhancement. If it fails, keep valid audio and let
          // the caption pipeline use its alignment/fallback tiers.
          metadataStream?.on('error', () => undefined);
        });

        if (!running.has(jobId)) throw appFailure('VOICE_CANCELLED', context);
        if (!chunks.length) throw appFailure('VOICE_AUDIO_RESULT_UNAVAILABLE', context);

        await fs.writeFile(partialPath, Buffer.concat(chunks)).catch((error) => { throw audioOutputFailure(error); });
        const validated = await validateAudioFile(partialPath);
        await replaceAudioFile(partialPath, outPath);
        const wordTimings = boundaryTimings(text, metadataChunks);
        return appSuccess({
          audioPath: outPath,
          durationSec: validated.durationSec,
          wordTimings: wordTimings.length ? wordTimings : undefined,
        });
      } finally {
        tts.close();
        running.delete(jobId);
      }
    } catch (error) {
      return appFailureResult(freeVoiceFailure(error, context), 'VOICE_UNEXPECTED', {
        operation: 'free-voice',
        chunkNumber: args?.chunkNumber,
        chunkCount: args?.chunkCount,
      });
    } finally {
      if (partialPath) await fs.rm(partialPath, { force: true }).catch(() => undefined);
    }
  });

  ipcMain.handle('edgetts:kill', async (_e, jobId: string): Promise<boolean> => {
    const job = running.get(jobId);
    if (!job) return false;
    running.delete(jobId);
    job.tts.close();
    return true;
  });
}
