import { ipcMain, BrowserWindow, app } from 'electron';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import log from 'electron-log';
import { projectDir } from './project';
import { ffmpegBinary } from './ffmpeg';
import type {
  WhisperExtractArgs,
  WhisperTranscribeArgs,
  WhisperModelStatusArgs,
  WhisperModelStatus,
  WhisperModelDownloadArgs,
  WhisperProgress,
  WhisperModelName,
  TranscriptSegment,
  WhisperAlignArgs,
  SubtitleWordTiming,
} from '../../src/shared/types';

// Local speech recognition via the bundled whisper.cpp binary. GGML models are
// NOT bundled (they are large); they are downloaded on demand into userData and
// reused. Audio is extracted to 16kHz mono WAV with the bundled ffmpeg, which is
// exactly what whisper.cpp expects.

function whisperBinary(): string {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'resources', 'whisper')
    : path.join(app.getAppPath(), 'resources', 'whisper');
  return path.join(base, process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli');
}

function modelsDir(): string {
  return path.join(app.getPath('userData'), 'GenSuite', 'models');
}

function modelPath(model: WhisperModelName): string {
  return path.join(modelsDir(), `ggml-${model}.bin`);
}

// Reject clearly incomplete cached downloads left by an interrupted older app
// version. These are deliberately conservative lower bounds so upstream model
// revisions do not cause a needless re-download.
const MIN_MODEL_BYTES: Record<WhisperModelName, number> = {
  tiny: 70_000_000,
  base: 130_000_000,
  small: 430_000_000,
  medium: 1_300_000_000,
};

// HuggingFace mirror of the official ggml whisper models.
function modelUrl(model: WhisperModelName): string {
  return `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${model}.bin`;
}

function emit(win: BrowserWindow | null, p: WhisperProgress): void {
  win?.webContents.send('whisper:progress', p);
}

async function fileExists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(() => true).catch(() => false);
}

async function modelIsUsable(filePath: string, model: WhisperModelName): Promise<boolean> {
  const stat = await fs.stat(filePath).catch(() => null);
  return Boolean(stat?.isFile() && stat.size >= MIN_MODEL_BYTES[model]);
}

async function ensureModel(model: WhisperModelName, win: BrowserWindow | null): Promise<string> {
  const dest = modelPath(model);
  if (await modelIsUsable(dest, model)) return dest;

  await fs.mkdir(modelsDir(), { recursive: true });
  // A short file can otherwise remain cached forever and make every later run
  // fail at the recognition step.
  await fs.unlink(dest).catch(() => undefined);
  emit(win, { phase: 'downloading-model', percent: 0, model });

  const resp = await fetch(modelUrl(model));
  if (!resp.ok || !resp.body) throw new Error('Không thể chuẩn bị dữ liệu nhận dạng. Hãy kiểm tra kết nối và thử lại.');
  const total = Number(resp.headers.get('content-length')) || 0;

  // Write to a temp file first so an interrupted download never leaves a
  // truncated model that later looks "present".
  const tmp = `${dest}.part`;
  await fs.unlink(tmp).catch(() => undefined);
  const out = createWriteStream(tmp);
  let received = 0;
  const reader = resp.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      await new Promise<void>((resolve, reject) =>
        out.write(value, (err) => (err ? reject(err) : resolve())));
      if (total > 0) emit(win, { phase: 'downloading-model', percent: Math.round((received / total) * 100), model });
    }
    await new Promise<void>((resolve, reject) => {
      out.once('finish', resolve);
      out.once('error', reject);
      out.end();
    });
    if ((total > 0 && received !== total) || received < MIN_MODEL_BYTES[model]) {
      throw new Error('Dữ liệu nhận dạng tải xuống chưa đầy đủ. Vui lòng thử lại.');
    }
    await fs.rename(tmp, dest);
  } catch (error) {
    out.destroy();
    await fs.unlink(tmp).catch(() => undefined);
    throw error;
  }
  return dest;
}

// whisper.cpp -oj emits { transcription: [{ offsets:{from,to}(ms), text }] }.
function parseWhisperJson(raw: string): TranscriptSegment[] {
  const data = JSON.parse(raw) as { transcription?: Array<{ offsets?: { from: number; to: number }; text?: string }> };
  const rows = data.transcription ?? [];
  const segments: TranscriptSegment[] = [];
  rows.forEach((row, index) => {
    const text = (row.text ?? '').trim();
    if (!text) return;
    segments.push({
      id: `seg_${index}`,
      start: (row.offsets?.from ?? 0) / 1000,
      end: (row.offsets?.to ?? 0) / 1000,
      text,
    });
  });
  return segments;
}

const ALIGN_CJK_RE = /[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯가-힯]/;
const ALIGN_PUNCT_RE = /^[，。！？、；：,.!?;:）)】」』…]+$/;

export function expectedWords(text: string): string[] {
  const clean = text.replace(/\r\n|\r|\n/g, ' ').trim().replace(/\s+/g, ' ');
  if (!clean) return [];
  if (/\s/.test(clean)) return clean.split(/\s+/).filter(Boolean);
  if (!ALIGN_CJK_RE.test(clean)) return [clean];
  const words: string[] = [];
  for (const char of [...clean]) {
    if (ALIGN_PUNCT_RE.test(char) && words.length) words[words.length - 1] += char;
    else words.push(char);
  }
  return words;
}

function normalizedWeight(text: string): number {
  const normalized = text.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  return Math.max(1, [...normalized].length);
}

export function parseAlignedWords(raw: string, expected: string[], duration: number): SubtitleWordTiming[] {
  const data = JSON.parse(raw) as {
    transcription?: Array<{
      offsets?: { from?: number; to?: number };
      text?: string;
      tokens?: Array<{ text?: string; offsets?: { from?: number; to?: number } }>;
    }>;
  };
  const detailedTokens = (data.transcription ?? []).flatMap((row) => row.tokens ?? [])
    .map((token) => ({
      rawText: String(token.text ?? ''),
      text: String(token.text ?? '').trim(),
      start: Math.max(0, Number(token.offsets?.from ?? 0) / 1000),
      end: Math.max(0, Number(token.offsets?.to ?? 0) / 1000),
    }))
    .filter((token) => token.text && !/^\[_.*_\]$/.test(token.text));
  const fallbackRows = (data.transcription ?? []).map((row) => ({
    text: String(row.text ?? '').trim(),
    start: Math.max(0, Number(row.offsets?.from ?? 0) / 1000),
    end: Math.max(0, Number(row.offsets?.to ?? 0) / 1000),
  })).filter((row) => row.text);
  const sourceTokens = detailedTokens.length ? detailedTokens : fallbackRows;
  const speechEnd = Math.min(duration, Math.max(...sourceTokens.map((token) => token.end), 0));
  const hasWordBoundaries = detailedTokens.some((token) => /^\s/u.test(token.rawText));
  const recognized = hasWordBoundaries ? detailedTokens.reduce<Array<{ text: string; start: number; end: number }>>((words, token) => {
    if (!token.text) return words;
    const beginsWord = /^\s/u.test(token.rawText) && /[\p{L}\p{N}]/u.test(token.text);
    if (beginsWord || !words.length) words.push({ text: token.text, start: token.start, end: token.end });
    else {
      words[words.length - 1].text += token.text;
      words[words.length - 1].end = Math.max(words[words.length - 1].end, token.end);
    }
    return words;
  }, []).filter((word) => /[\p{L}\p{N}]/u.test(word.text))
    : sourceTokens.filter((token) => /[\p{L}\p{N}]/u.test(token.text));
  if (!recognized.length || !expected.length) return [];

  if (recognized.length === expected.length) {
    return expected.map((word, index) => ({
      word,
      start: Math.max(0, Math.min(speechEnd, recognized[index].start)),
      end: Math.max(0, Math.min(speechEnd, recognized[index + 1]?.start ?? speechEnd)),
    }));
  }

  const recognizedWeights = recognized.map((word) => normalizedWeight(word.text));
  const recognizedTotal = recognizedWeights.reduce((sum, weight) => sum + weight, 0);
  let recognizedCursor = 0;
  const anchors = recognized.map((word, index) => {
    const position = recognizedCursor / recognizedTotal;
    recognizedCursor += recognizedWeights[index];
    return { position, time: Math.min(duration, word.start) };
  });
  const timelineEnd = speechEnd > anchors[0].time ? speechEnd : duration;
  anchors.push({ position: 1, time: timelineEnd });

  const expectedWeights = expected.map(normalizedWeight);
  const expectedTotal = expectedWeights.reduce((sum, weight) => sum + weight, 0);
  let expectedCursor = 0;
  const starts = expected.map((_, index) => {
    const position = expectedCursor / expectedTotal;
    expectedCursor += expectedWeights[index];
    let right = anchors.findIndex((anchor) => anchor.position >= position);
    if (right <= 0) return anchors[0].time;
    if (right < 0) right = anchors.length - 1;
    const left = anchors[right - 1];
    const next = anchors[right];
    const span = next.position - left.position;
    const progress = span > 0 ? (position - left.position) / span : 0;
    return left.time + (next.time - left.time) * progress;
  });

  // Some short phrases produce identical tail timestamps. Preserve the measured
  // onset, then spread only the collapsed tail across the remaining audio.
  const minGap = Math.min(0.06, timelineEnd / Math.max(4, expected.length * 3));
  for (let i = starts.length - 1; i >= 0; i -= 1) {
    starts[i] = Math.min(starts[i], timelineEnd - minGap * (starts.length - i));
  }
  for (let i = 1; i < starts.length; i += 1) starts[i] = Math.max(starts[i], starts[i - 1] + minGap);

  return expected.map((word, index) => ({
    word,
    start: Math.max(0, Math.min(timelineEnd, starts[index])),
    end: Math.max(0, Math.min(timelineEnd, starts[index + 1] ?? timelineEnd)),
  }));
}

function languageCode(language?: string): string | undefined {
  const value = String(language ?? '').trim().toLowerCase().replace('_', '-');
  if (!value || value === 'auto') return undefined;
  const names: Record<string, string> = {
    vietnamese: 'vi', english: 'en', chinese: 'zh', 'chinese (mandarin)': 'zh', japanese: 'ja',
    korean: 'ko', french: 'fr', german: 'de', spanish: 'es', portuguese: 'pt', italian: 'it',
    russian: 'ru', thai: 'th', indonesian: 'id', hindi: 'hi', arabic: 'ar',
  };
  return names[value] ?? value.split('-')[0];
}

async function mediaDuration(sourcePath: string): Promise<number> {
  const probe = path.join(path.dirname(ffmpegBinary()), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  return await new Promise<number>((resolve) => {
    const child = spawn(probe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', sourcePath], {
      cwd: path.dirname(probe), stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    child.stdout?.on('data', (data) => { stdout += String(data); });
    child.on('error', () => resolve(0));
    child.on('close', () => resolve(Math.max(0, Number.parseFloat(stdout.trim()) || 0)));
  });
}

export function registerWhisperIpc(): void {
  ipcMain.handle('whisper:extract', async (e, args: WhisperExtractArgs): Promise<string> => {
    const { projectId, sourcePath } = args;
    if (!projectId || !sourcePath) throw new Error('Thiếu thông tin tệp nguồn để nhận dạng.');
    if (!(await fileExists(sourcePath))) throw new Error('Không tìm thấy file nguồn để trích audio.');

    const win = BrowserWindow.fromWebContents(e.sender);
    const workDir = path.join(projectDir(projectId), 'work');
    await fs.mkdir(workDir, { recursive: true });
    const wavPath = path.join(workDir, 'source-16k.wav');

    const binary = ffmpegBinary();
    emit(win, { phase: 'extracting' });
    await new Promise<void>((resolve, reject) => {
      const child = spawn(binary, [
        '-y', '-i', sourcePath,
        '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
        wavPath,
      ], { cwd: path.dirname(binary), stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr?.on('data', (d) => { stderr += String(d); });
      child.on('error', () => reject(new Error('Không thể chuẩn bị âm thanh từ tệp nguồn.')));
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error('Không thể chuẩn bị âm thanh từ tệp nguồn.')));
    });
    return wavPath;
  });

  ipcMain.handle('whisper:modelStatus', async (_e, args: WhisperModelStatusArgs): Promise<WhisperModelStatus> => {
    const dest = modelPath(args.model);
    return { model: args.model, present: await fileExists(dest), path: dest };
  });

  ipcMain.handle('whisper:downloadModel', async (e, args: WhisperModelDownloadArgs): Promise<string> => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const dest = await ensureModel(args.model, win);
    emit(win, { phase: 'complete', model: args.model });
    return dest;
  });

  ipcMain.handle('whisper:transcribe', async (e, args: WhisperTranscribeArgs): Promise<TranscriptSegment[]> => {
    const { projectId, wavPath, model, language } = args;
    if (!projectId || !wavPath) throw new Error('Thiếu thông tin âm thanh để nhận dạng.');
    if (!(await fileExists(wavPath))) throw new Error('Không tìm thấy file WAV đã trích.');

    const win = BrowserWindow.fromWebContents(e.sender);
    const binary = whisperBinary();
    if (!(await fileExists(binary))) throw new Error('Không thể khởi tạo bộ nhận dạng. Vui lòng cài lại ứng dụng.');

    const modelFile = await ensureModel(model, win);
    emit(win, { phase: 'transcribing', model });

    const workDir = path.join(projectDir(projectId), 'work');
    const outBase = path.join(workDir, 'transcript');
    const whisperArgs = [
      '-m', modelFile,
      '-f', wavPath,
      '-t', String(Math.max(1, Math.min(4, os.availableParallelism()))),
      '-oj',
      '-of', outBase,
    ];
    // Omitting this option does not mean automatic detection; the recognizer
    // falls back to English. Always pass the user's actual choice explicitly.
    whisperArgs.push('-l', language && language !== 'auto' ? language : 'auto');

    await new Promise<void>((resolve, reject) => {
      const child = spawn(binary, whisperArgs, { cwd: path.dirname(binary), stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr?.on('data', (d) => { stderr += String(d); });
      child.on('error', (error) => {
        log.error('speech recognition spawn failed', { code: (error as NodeJS.ErrnoException).code });
        reject(new Error('Không thể khởi động bộ nhận dạng. Vui lòng thử lại.'));
      });
      child.on('close', (code) => {
        if (code === 0) resolve();
        else {
          log.error('speech recognition failed', { code, model, detail: stderr.slice(-1200) });
          reject(new Error('Không thể nhận dạng lời thoại từ tệp này. Hãy thử mức độ chính xác thấp hơn.'));
        }
      });
    });

    const jsonPath = `${outBase}.json`;
    const raw = await fs.readFile(jsonPath, 'utf-8').catch(() => '');
    if (!raw) throw new Error('Không thể đọc kết quả nhận dạng. Vui lòng thử lại.');
    const segments = parseWhisperJson(raw);
    if (!segments.length) throw new Error('Không nhận dạng được lời thoại nào trong tệp nguồn.');
    emit(win, { phase: 'complete', model });
    return segments;
  });

  ipcMain.handle('whisper:align', async (e, args: WhisperAlignArgs): Promise<SubtitleWordTiming[]> => {
    const { projectId, audioPath, text, model } = args;
    if (!projectId || !audioPath || !text?.trim()) throw new Error('Thiếu dữ liệu để căn phụ đề với lời đọc.');
    if (!(await fileExists(audioPath))) throw new Error('Không tìm thấy giọng đọc để căn phụ đề.');
    const expected = expectedWords(text);
    if (!expected.length) return [];

    const win = BrowserWindow.fromWebContents(e.sender);
    const modelFile = await ensureModel(model, win);
    const workDir = path.join(projectDir(projectId), 'work', 'caption-timing');
    await fs.mkdir(workDir, { recursive: true });
    const identity = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const wavPath = path.join(workDir, `${identity}.wav`);
    const outBase = path.join(workDir, identity);
    const jsonPath = `${outBase}.json`;

    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(ffmpegBinary(), ['-y', '-i', audioPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath], {
          cwd: path.dirname(ffmpegBinary()), stdio: ['ignore', 'ignore', 'pipe'],
        });
        child.on('error', () => reject(new Error('Không thể chuẩn bị giọng đọc để căn phụ đề.')));
        child.on('close', (code) => code === 0 ? resolve() : reject(new Error('Không thể chuẩn bị giọng đọc để căn phụ đề.')));
      });

      // The exact script is known and the input is clean generated speech, so a
      // single decoding candidate plus a prompt is both faster and more stable
      // than the exploratory settings used for source-video transcription.
      const whisperArgs = [
        '-m', modelFile,
        '-f', wavPath,
        '-ojf',
        '-np',
        '-bo', '1',
        '-bs', '1',
        '-nf',
        '--prompt', text.slice(0, 1200),
        '-of', outBase,
      ];
      const language = languageCode(args.language);
      whisperArgs.push('-l', language ?? 'auto');
      await new Promise<void>((resolve, reject) => {
        const child = spawn(whisperBinary(), whisperArgs, { cwd: path.dirname(whisperBinary()), stdio: ['ignore', 'ignore', 'pipe'] });
        child.on('error', () => reject(new Error('Không thể căn phụ đề với lời đọc. Vui lòng thử lại.')));
        child.on('close', (code) => code === 0 ? resolve() : reject(new Error('Không thể căn phụ đề với lời đọc. Vui lòng thử lại.')));
      });

      const [raw, duration] = await Promise.all([fs.readFile(jsonPath, 'utf8'), mediaDuration(audioPath)]);
      const aligned = parseAlignedWords(raw, expected, duration);
      if (!aligned.length) throw new Error('Không xác định được nhịp lời đọc cho phụ đề. Vui lòng thử lại.');
      return aligned;
    } finally {
      fs.unlink(wavPath).catch(() => {});
      fs.unlink(jsonPath).catch(() => {});
    }
  });
}
