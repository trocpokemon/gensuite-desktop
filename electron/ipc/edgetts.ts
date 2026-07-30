import { ipcMain } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { projectDir } from './project';
import type { EdgeTtsSynthesizeArgs, EdgeTtsSynthesizeResult, EdgeTtsVoice, SubtitleWordTiming } from '../../src/shared/types';

// edge-tts calls Microsoft Edge's online Read-Aloud service over a WebSocket —
// free, no API key, but requires network. Node-only (the service now demands an
// Edge user-agent), so it runs here in the main process, not the renderer. Each
// job is tracked by id so the renderer can cancel a slow synthesis mid-run.

type Job = { tts: MsEdgeTTS };
const running = new Map<string, Job>();

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
  ipcMain.handle('edgetts:voices', async (): Promise<EdgeTtsVoice[]> => {
    const tts = new MsEdgeTTS();
    const voices = await tts.getVoices();
    return voices.map((voice) => ({
      shortName: voice.ShortName,
      friendlyName: voice.FriendlyName,
      locale: voice.Locale,
      gender: voice.Gender,
    }));
  });

  ipcMain.handle('edgetts:synthesize', async (_e, args: EdgeTtsSynthesizeArgs): Promise<EdgeTtsSynthesizeResult> => {
    const { projectId, jobId, segmentId, text, voiceId } = args;
    if (!projectId || !jobId || !text?.trim()) throw new Error('edgetts:synthesize missing args');
    if (!voiceId) throw new Error('Chưa chọn giọng edge-tts.');

    const audioDir = path.join(projectDir(projectId), 'audio');
    await fs.mkdir(audioDir, { recursive: true });
    const outPath = path.join(audioDir, `${segmentId}.mp3`);

    const tts = new MsEdgeTTS();
    running.set(jobId, { tts });

    try {
      await tts.setMetadata(voiceId, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, { wordBoundaryEnabled: true });
      const pitchHz = Math.round(Number(args.pitch) || 0);
      const volume = Math.max(0, Math.min(100, Number.isFinite(args.volume as number) ? Number(args.volume) : 100));
      const { audioStream, metadataStream } = tts.toStream(escapeXml(text), {
        rate: ratePercent(args.speed),
        pitch: `${pitchHz >= 0 ? '+' : ''}${pitchHz}Hz`,
        volume,
      });

      const chunks: Buffer[] = [];
      const metadataChunks: Buffer[] = [];
      const audioDone = new Promise<void>((resolve, reject) => {
        audioStream.on('data', (chunk: Buffer) => chunks.push(chunk));
        audioStream.on('close', resolve);
        audioStream.on('error', (err: Error) => {
          if (/turn\.end|Stream closed before the synthesis/i.test(err?.message ?? '')) {
            reject(new Error('Máy chủ Edge TTS ngắt kết nối giữa chừng nên audio bị cắt. Thường do bị giới hạn khi tạo nhiều đoạn liên tiếp — hãy chờ vài giây rồi bấm "Đọc" lại cho phân cảnh này.'));
            return;
          }
          reject(err);
        });
      });
      const metadataDone = metadataStream ? new Promise<void>((resolve, reject) => {
        metadataStream.on('data', (chunk: Buffer) => metadataChunks.push(chunk));
        metadataStream.on('close', resolve);
        metadataStream.on('error', reject);
      }) : Promise.resolve();
      await Promise.all([audioDone, metadataDone]);

      if (!running.has(jobId)) throw new Error('edgetts:killed');
      if (!chunks.length) throw new Error('edge-tts không trả về audio. Kiểm tra kết nối mạng và tên giọng.');

      await fs.writeFile(outPath, Buffer.concat(chunks));
      const wordTimings = boundaryTimings(text, metadataChunks);
      return { audioPath: outPath, wordTimings: wordTimings.length ? wordTimings : undefined };
    } finally {
      tts.close();
      running.delete(jobId);
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
