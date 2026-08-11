import { ipcMain, BrowserWindow, app } from 'electron';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
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
import type { IpcResult } from '../../src/shared/appErrors';
import { AppFailure, appFailure, appFailureResult, appSuccess } from './appErrors';

// Local speech recognition via the bundled whisper.cpp binary. GGML models are
// NOT bundled (they are large); they are downloaded on demand into userData and
// reused. Audio is extracted to 16kHz mono WAV with the bundled ffmpeg, which is
// exactly what whisper.cpp expects.

function whisperBinary(): string {
  const base = whisperComponentDir();
  return path.join(base, process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli');
}

function whisperComponentDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'resources', 'whisper')
    : path.join(app.getAppPath(), 'resources', 'whisper');
}

const WINDOWS_BUNDLED_RECOGNITION_FILES = [
  'whisper-cli.exe',
  'whisper.dll',
  'ggml.dll',
  'ggml-base.dll',
  'ggml-cpu-x64.dll',
] as const;

const WINDOWS_RECOGNITION_SUPPORT_FILES = [
  'VCOMP140.DLL',
  'MSVCP140.dll',
  'VCRUNTIME140.dll',
  'VCRUNTIME140_1.dll',
] as const;

function recognitionComponentFailure(
  missingBundledCount: number,
  missingSupportCount: number,
  quarantineConfirmed: boolean,
): AppFailure | null {
  if (missingBundledCount > 0 && quarantineConfirmed) {
    return appFailure('TRANSCRIPTION_COMPONENT_QUARANTINED', undefined, {
      classifier: 'security-quarantine-confirmed',
      componentCount: missingBundledCount,
    });
  }
  if (missingBundledCount > 0) {
    return appFailure('TRANSCRIPTION_INSTALLATION_INCOMPLETE', undefined, {
      classifier: 'bundled-component-missing',
      componentCount: missingBundledCount,
    });
  }
  if (missingSupportCount > 0) {
    return appFailure('TRANSCRIPTION_SYSTEM_SUPPORT_MISSING', undefined, {
      classifier: 'system-support-missing',
      componentCount: missingSupportCount,
    });
  }
  return null;
}

async function existingFile(filePath: string): Promise<boolean> {
  const stat = await fs.stat(filePath).catch(() => null);
  return Boolean(stat?.isFile() && stat.size > 0);
}

async function windowsSecurityQuarantineEvidence(missingFileNames: readonly string[]): Promise<boolean> {
  if (process.platform !== 'win32' || missingFileNames.length === 0) return false;
  const windowsDir = process.env.WINDIR || process.env.SystemRoot;
  if (!windowsDir) return false;
  const eventTool = path.join(windowsDir, 'System32', 'wevtutil.exe');
  if (!(await existingFile(eventTool))) return false;

  return await new Promise<boolean>((resolve) => {
    const child = spawn(eventTool, [
      'qe',
      'Microsoft-Windows-Windows Defender/Operational',
      '/q:*[System[(EventID=1116 or EventID=1117) and TimeCreated[timediff(@SystemTime) <= 604800000]]]',
      '/rd:true',
      '/c:64',
      '/f:text',
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    let settled = false;
    const finish = (found: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(found);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(false);
    }, 3_000);
    child.stdout?.on('data', (data) => {
      if (output.length < 512_000) output += String(data);
    });
    child.on('error', () => finish(false));
    child.on('close', () => {
      const normalized = output.toLowerCase();
      finish(missingFileNames.some((name) => normalized.includes(name.toLowerCase())));
    });
  });
}

async function ensureRecognitionComponentAvailable(): Promise<void> {
  const binary = whisperBinary();
  if (process.platform !== 'win32') {
    if (!(await existingFile(binary))) throw appFailure('TRANSCRIPTION_INSTALLATION_INCOMPLETE', undefined, {
      classifier: 'bundled-component-missing', componentCount: 1,
    });
    return;
  }

  const componentDir = whisperComponentDir();
  const bundledChecks = await Promise.all(WINDOWS_BUNDLED_RECOGNITION_FILES.map(async (name) => ({
    name,
    available: await existingFile(path.join(componentDir, name)),
  })));
  const missingBundled = bundledChecks.filter((item) => !item.available).map((item) => item.name);
  if (missingBundled.length > 0) {
    const quarantined = await windowsSecurityQuarantineEvidence(missingBundled);
    throw recognitionComponentFailure(missingBundled.length, 0, quarantined)!;
  }

  const windowsDir = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows';
  const systemDir = path.join(windowsDir, 'System32');
  const supportChecks = await Promise.all(WINDOWS_RECOGNITION_SUPPORT_FILES.map(async (name) => ({
    available: await existingFile(path.join(componentDir, name)) || await existingFile(path.join(systemDir, name)),
  })));
  const missingSupportCount = supportChecks.filter((item) => !item.available).length;
  const failure = recognitionComponentFailure(0, missingSupportCount, false);
  if (failure) throw failure;
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

const MODEL_DOWNLOAD_INACTIVITY_MS = 45_000;
const MODEL_PREFLIGHT_TIMEOUT_MS = 3 * 60 * 1000;
const modelDownloads = new Map<WhisperModelName, Promise<string>>();
const VAD_MODEL_FILE = 'ggml-silero-v6.2.0.bin';
const VAD_MODEL_BYTES = 885_098;
const VAD_MODEL_SHA256 = '2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987';
const VAD_MODEL_URL = `https://huggingface.co/ggml-org/whisper-vad/resolve/main/${VAD_MODEL_FILE}`;
let vadModelDownload: Promise<string> | null = null;
type RecognitionJob = { cancelled: boolean; child?: ReturnType<typeof spawn> };
const runningTranscriptions = new Map<string, RecognitionJob>();

// HuggingFace mirror of the official ggml whisper models.
function modelUrl(model: WhisperModelName): string {
  return `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${model}.bin`;
}

function vadModelPath(): string {
  return path.join(modelsDir(), VAD_MODEL_FILE);
}

function emit(win: BrowserWindow | null, p: WhisperProgress): void {
  win?.webContents.send('whisper:progress', p);
}

async function fileExists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(() => true).catch(() => false);
}

async function vadModelIsUsable(filePath: string): Promise<boolean> {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat?.isFile() || stat.size !== VAD_MODEL_BYTES) return false;
  return await sha256File(filePath).then((hash) => hash === VAD_MODEL_SHA256).catch(() => false);
}

async function downloadVadModel(win: BrowserWindow | null, model: WhisperModelName, dest: string): Promise<void> {
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), MODEL_DOWNLOAD_INACTIVITY_MS);
  let response: Response;
  try {
    response = await fetch(VAD_MODEL_URL, { signal: controller.signal });
  } catch (error) {
    throw appFailure('TRANSCRIPTION_MODEL_DOWNLOAD_FAILED', undefined, {
      systemCode: processErrorCode(error), classifier: 'vad-request-failed',
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok || !response.body) {
    throw appFailure('TRANSCRIPTION_MODEL_DOWNLOAD_FAILED', undefined, {
      statusCode: response.status, classifier: 'vad-response-rejected',
    });
  }

  const partial = `${dest}.part`;
  await fs.unlink(partial).catch(() => undefined);
  const output = createWriteStream(partial);
  const reader = response.body.getReader();
  const hash = createHash('sha256');
  let received = 0;
  try {
    for (;;) {
      const packet = await new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(appFailure('TRANSCRIPTION_MODEL_DOWNLOAD_FAILED', undefined, { classifier: 'vad-body-timeout' }));
        }, MODEL_DOWNLOAD_INACTIVITY_MS);
        reader.read().then(resolve, reject).finally(() => clearTimeout(timer));
      });
      if (packet.done) break;
      hash.update(packet.value);
      received += packet.value.length;
      await new Promise<void>((resolve, reject) => output.write(packet.value, (error) => error ? reject(error) : resolve()));
      emit(win, { phase: 'downloading-model', percent: Math.min(99, Math.round((received / VAD_MODEL_BYTES) * 100)), model });
    }
    await new Promise<void>((resolve, reject) => {
      output.once('finish', resolve); output.once('error', reject); output.end();
    });
    if (received !== VAD_MODEL_BYTES || hash.digest('hex') !== VAD_MODEL_SHA256) {
      throw appFailure('TRANSCRIPTION_MODEL_INVALID', undefined, { classifier: 'vad-integrity' });
    }
    await fs.rm(dest, { force: true }).catch(() => undefined);
    await fs.rename(partial, dest);
  } catch (error) {
    output.destroy();
    await fs.unlink(partial).catch(() => undefined);
    throw modelFailure(error);
  }
}

async function ensureVadModel(win: BrowserWindow | null, model: WhisperModelName): Promise<string> {
  if (vadModelDownload) return vadModelDownload;
  const task = (async () => {
    const dest = vadModelPath();
    await fs.mkdir(modelsDir(), { recursive: true }).catch((error) => { throw modelFailure(error); });
    if (await vadModelIsUsable(dest)) return dest;
    await fs.rm(dest, { force: true }).catch(() => undefined);
    emit(win, { phase: 'downloading-model', percent: 0, model });
    await downloadVadModel(win, model, dest);
    if (!(await vadModelIsUsable(dest))) throw appFailure('TRANSCRIPTION_MODEL_INVALID', undefined, { classifier: 'vad-invalid' });
    return dest;
  })().finally(() => { vadModelDownload = null; });
  vadModelDownload = task;
  return task;
}

async function modelIsUsable(filePath: string, model: WhisperModelName): Promise<boolean> {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat?.isFile() || stat.size < MIN_MODEL_BYTES[model]) return false;
  const handle = await fs.open(filePath, 'r').catch(() => null);
  if (!handle) return false;
  try {
    const header = Buffer.alloc(4);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead !== header.length) return false;
    return ['lmgg', 'ggml', 'GGUF'].includes(header.toString('ascii'));
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function modelFailure(error: unknown): AppFailure {
  if (error instanceof AppFailure) return error;
  const code = processErrorCode(error);
  if (code === 'EACCES' || code === 'EPERM') return appFailure('TRANSCRIPTION_MODEL_PERMISSION_DENIED', undefined, { systemCode: code });
  if (code === 'ENOSPC') return appFailure('TRANSCRIPTION_MODEL_STORAGE_FULL', undefined, { systemCode: code });
  return appFailure('TRANSCRIPTION_MODEL_UNAVAILABLE', undefined, { systemCode: code });
}

function silentWav(durationSeconds = 0.5): Buffer {
  const sampleRate = 16_000;
  const sampleCount = Math.max(1, Math.round(sampleRate * durationSeconds));
  const dataLength = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataLength);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + dataLength, 4); buffer.write('WAVE', 8);
  buffer.write('fmt ', 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(dataLength, 40);
  return buffer;
}

function modelPreflightExitFailure(code: number | null): AppFailure {
  const unsigned = code === null ? null : code >>> 0;
  // Windows loader failures describe the bundled recognition component, not
  // the downloaded model. Keeping these distinct prevents pointless model
  // deletion/redownload loops on affected client machines.
  if (unsigned === 0xC0000135) {
    return appFailure('TRANSCRIPTION_SYSTEM_SUPPORT_MISSING', undefined, {
      exitCode: unsigned,
      classifier: 'system-support-loader-failure',
    });
  }
  if (unsigned === 0xC0000017) {
    return appFailure('TRANSCRIPTION_MEMORY_LIMIT', undefined, {
      exitCode: unsigned,
      classifier: 'memory-unavailable',
    });
  }
  if (unsigned === 0xC000007B) {
    return appFailure('TRANSCRIPTION_COMPONENT_UNAVAILABLE', undefined, {
      exitCode: unsigned,
      classifier: 'runtime-binary-incompatible',
    });
  }
  return appFailure('TRANSCRIPTION_MODEL_INVALID', undefined, {
    exitCode: unsigned ?? undefined,
    classifier: 'preflight-exit',
  });
}

async function validateModelRuntime(model: WhisperModelName, filePath: string): Promise<void> {
  await ensureRecognitionComponentAvailable();
  const stat = await fs.stat(filePath);
  const binaryStat = await fs.stat(whisperBinary());
  const stampPath = `${filePath}.verified.json`;
  const stamp = await fs.readFile(stampPath, 'utf8').then((raw) => JSON.parse(raw) as {
    size?: number; mtimeMs?: number; binaryMtimeMs?: number;
  }).catch(() => null);
  if (stamp?.size === stat.size && stamp.mtimeMs === stat.mtimeMs && stamp.binaryMtimeMs === binaryStat.mtimeMs) return;

  const samplePath = path.join(modelsDir(), `.verify-${model}.wav`);
  await fs.writeFile(samplePath, silentWav());
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(whisperBinary(), [
        '-m', filePath, '-f', samplePath, '-nt', '-np', '-l', 'en',
      ], { cwd: path.dirname(whisperBinary()), stdio: ['ignore', 'ignore', 'pipe'] });
      let settled = false;
      const timer = setTimeout(() => {
        child.kill();
        if (!settled) {
          settled = true;
          reject(appFailure('TRANSCRIPTION_MODEL_INVALID', undefined, { classifier: 'preflight-timeout' }));
        }
      }, MODEL_PREFLIGHT_TIMEOUT_MS);
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(modelFailure(error));
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        code === 0 ? resolve() : reject(modelPreflightExitFailure(code));
      });
    });
    const verified = await fs.stat(filePath);
    const partial = `${stampPath}.partial`;
    await fs.writeFile(partial, JSON.stringify({
      size: verified.size,
      mtimeMs: verified.mtimeMs,
      binaryMtimeMs: binaryStat.mtimeMs,
    }), 'utf8');
    await fs.rm(stampPath, { force: true }).catch(() => undefined);
    await fs.rename(partial, stampPath);
  } finally {
    await fs.unlink(samplePath).catch(() => undefined);
  }
}

async function downloadModel(model: WhisperModelName, win: BrowserWindow | null, dest: string): Promise<void> {
  const controller = new AbortController();
  let responseTimer = setTimeout(() => controller.abort(), MODEL_DOWNLOAD_INACTIVITY_MS);
  let resp: Response;
  try {
    resp = await fetch(modelUrl(model), { signal: controller.signal });
  } catch (error) {
    throw appFailure('TRANSCRIPTION_MODEL_DOWNLOAD_FAILED', undefined, {
      systemCode: processErrorCode(error), classifier: 'request-failed',
    });
  } finally {
    clearTimeout(responseTimer);
  }
  if (!resp.ok || !resp.body) {
    throw appFailure('TRANSCRIPTION_MODEL_DOWNLOAD_FAILED', undefined, { statusCode: resp.status, classifier: 'response-rejected' });
  }
  const total = Number(resp.headers.get('content-length')) || 0;
  const tmp = `${dest}.part`;
  await fs.unlink(tmp).catch(() => undefined);
  const out = createWriteStream(tmp);
  let received = 0;
  const reader = resp.body.getReader();
  try {
    for (;;) {
      const packet = await new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
        responseTimer = setTimeout(() => {
          controller.abort();
          reject(appFailure('TRANSCRIPTION_MODEL_DOWNLOAD_FAILED', undefined, { classifier: 'body-timeout' }));
        }, MODEL_DOWNLOAD_INACTIVITY_MS);
        reader.read().then(resolve, reject).finally(() => clearTimeout(responseTimer));
      });
      if (packet.done) break;
      const value = packet.value;
      received += value.length;
      await new Promise<void>((resolve, reject) => out.write(value, (error) => error ? reject(error) : resolve()));
      if (total > 0) emit(win, { phase: 'downloading-model', percent: Math.round((received / total) * 100), model });
    }
    await new Promise<void>((resolve, reject) => {
      out.once('finish', resolve); out.once('error', reject); out.end();
    });
    if ((total > 0 && received !== total) || received < MIN_MODEL_BYTES[model]) {
      throw appFailure('TRANSCRIPTION_MODEL_INVALID', undefined, { classifier: 'incomplete-download' });
    }
    await fs.rename(tmp, dest);
  } catch (error) {
    out.destroy();
    await fs.unlink(tmp).catch(() => undefined);
    throw modelFailure(error);
  }
}

async function ensureModelUnlocked(model: WhisperModelName, win: BrowserWindow | null): Promise<string> {
  const dest = modelPath(model);
  await fs.mkdir(modelsDir(), { recursive: true }).catch((error) => { throw modelFailure(error); });
  if (await modelIsUsable(dest, model)) {
    try {
      await validateModelRuntime(model, dest);
      return dest;
    } catch (error) {
      if (!(error instanceof AppFailure) || error.code !== 'TRANSCRIPTION_MODEL_INVALID') throw error;
      await fs.unlink(dest).catch(() => undefined);
      await fs.unlink(`${dest}.verified.json`).catch(() => undefined);
    }
  }
  await fs.unlink(dest).catch(() => undefined);
  emit(win, { phase: 'downloading-model', percent: 0, model });
  await downloadModel(model, win, dest);
  if (!(await modelIsUsable(dest, model))) throw appFailure('TRANSCRIPTION_MODEL_INVALID', undefined, { classifier: 'header-invalid' });
  await validateModelRuntime(model, dest);
  return dest;
}

async function ensureModel(model: WhisperModelName, win: BrowserWindow | null): Promise<string> {
  const running = modelDownloads.get(model);
  if (running) return running;
  const task = ensureModelUnlocked(model, win).finally(() => modelDownloads.delete(model));
  modelDownloads.set(model, task);
  return task;
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

const TRANSCRIPTION_CORE_SECONDS = 60;
const TRANSCRIPTION_OVERLAP_SECONDS = 2;
const TRANSCRIPTION_STALL_TIMEOUT_MS = 5 * 60 * 1000;
const EXTRACTION_STALL_TIMEOUT_MS = 5 * 60 * 1000;
const ALIGNMENT_STALL_TIMEOUT_MS = 2 * 60 * 1000;

export interface TranscriptionChunk {
  coreStart: number;
  coreEnd: number;
  windowStart: number;
  windowEnd: number;
}

export function buildTranscriptionChunks(duration: number): TranscriptionChunk[] {
  if (!(duration > 0) || !Number.isFinite(duration)) return [];
  const chunks: TranscriptionChunk[] = [];
  for (let coreStart = 0; coreStart < duration; coreStart += TRANSCRIPTION_CORE_SECONDS) {
    const coreEnd = Math.min(duration, coreStart + TRANSCRIPTION_CORE_SECONDS);
    chunks.push({
      coreStart,
      coreEnd,
      windowStart: Math.max(0, coreStart - TRANSCRIPTION_OVERLAP_SECONDS),
      windowEnd: Math.min(duration, coreEnd + TRANSCRIPTION_OVERLAP_SECONDS),
    });
  }
  return chunks;
}

export function mergeTranscriptionChunks(
  rows: Array<{ chunk: TranscriptionChunk; segments: TranscriptSegment[] }>,
  duration: number,
): TranscriptSegment[] {
  const owned: TranscriptSegment[] = [];
  rows.forEach(({ chunk, segments }, chunkIndex) => {
    // Each short recognition window is converted back to absolute source time
    // before it reaches this merge step.
    segments.forEach((segment) => {
      const start = Math.max(0, Math.min(duration, segment.start));
      const end = Math.max(start, Math.min(duration, segment.end));
      const midpoint = (start + end) / 2;
      const belongsToCore = midpoint >= chunk.coreStart
        && (midpoint < chunk.coreEnd || (chunkIndex === rows.length - 1 && midpoint <= chunk.coreEnd));
      if (belongsToCore && end > start && segment.text.trim()) owned.push({ ...segment, start, end, text: segment.text.trim() });
    });
  });
  owned.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: TranscriptSegment[] = [];
  for (const segment of owned) {
    const previous = merged.at(-1);
    const sameText = previous?.text.replace(/\s+/g, ' ').toLocaleLowerCase()
      === segment.text.replace(/\s+/g, ' ').toLocaleLowerCase();
    if (previous && sameText && Math.abs(previous.start - segment.start) < 1.5) {
      previous.end = Math.max(previous.end, segment.end);
      continue;
    }
    merged.push({ ...segment, id: `seg_${merged.length}` });
  }
  return merged;
}

export function offsetRecognitionWindowSegments(
  segments: TranscriptSegment[],
  windowStart: number,
  windowEnd: number,
): TranscriptSegment[] {
  const windowDuration = Math.max(0, windowEnd - windowStart);
  if (!(windowDuration > 0)) return [];
  return segments.flatMap((segment) => {
    const relativeStart = Math.max(0, segment.start);
    const relativeEnd = Math.min(windowDuration, segment.end);
    if (!segment.text.trim() || relativeStart >= windowDuration || relativeEnd <= relativeStart) return [];
    return [{
      ...segment,
      start: windowStart + relativeStart,
      end: windowStart + relativeEnd,
      text: segment.text.trim(),
    }];
  });
}

interface TranscriptionCheckpoint {
  schemaVersion: 2;
  fingerprint: string;
  duration: number;
  model: WhisperModelName;
  language: string;
  completed: Array<{ index: number; chunk: TranscriptionChunk; segments: TranscriptSegment[] }>;
}

async function sha256File(filePath: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    const input = createReadStream(filePath);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('error', reject);
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

async function transcriptionFingerprint(
  wavPath: string,
  model: WhisperModelName,
  language: string | undefined,
  duration: number,
): Promise<string> {
  const audioHash = await sha256File(wavPath);
  return createHash('sha256')
    .update(JSON.stringify({
      pipelineVersion: 4,
      voiceActivityFilter: 'silero-v6.2.0',
      audioHash,
      model,
      language: language || 'auto',
      duration: Math.round(duration * 1000),
    }))
    .digest('hex');
}

function validCheckpoint(value: unknown, fingerprint: string, chunks: TranscriptionChunk[]): value is TranscriptionCheckpoint {
  if (!value || typeof value !== 'object') return false;
  const checkpoint = value as TranscriptionCheckpoint;
  if (checkpoint.schemaVersion !== 2 || checkpoint.fingerprint !== fingerprint || !Array.isArray(checkpoint.completed)) return false;
  const seen = new Set<number>();
  return checkpoint.completed.every((row) => {
    if (!Number.isInteger(row?.index) || row.index < 0 || row.index >= chunks.length || seen.has(row.index)) return false;
    seen.add(row.index);
    const expected = chunks[row.index];
    if (!row.chunk || row.chunk.coreStart !== expected.coreStart || row.chunk.coreEnd !== expected.coreEnd
      || row.chunk.windowStart !== expected.windowStart || row.chunk.windowEnd !== expected.windowEnd) return false;
    return Array.isArray(row.segments) && row.segments.every((segment) =>
      typeof segment?.id === 'string'
      && Number.isFinite(segment.start) && segment.start >= 0
      && Number.isFinite(segment.end) && segment.end > segment.start
      && typeof segment.text === 'string' && segment.text.trim().length > 0);
  });
}

async function replaceJsonTransaction(dest: string, value: unknown): Promise<void> {
  const partial = `${dest}.partial`;
  const backup = `${dest}.backup`;
  await fs.writeFile(partial, JSON.stringify(value), 'utf8');
  await fs.rm(backup, { force: true }).catch(() => undefined);
  const hadPrevious = await fileExists(dest);
  if (hadPrevious) await fs.rename(dest, backup);
  try {
    await fs.rename(partial, dest);
    await fs.rm(backup, { force: true }).catch(() => undefined);
  } catch (error) {
    await fs.rm(partial, { force: true }).catch(() => undefined);
    if (hadPrevious) await fs.rename(backup, dest).catch(() => undefined);
    throw error;
  }
}

function recognitionThreads(model: WhisperModelName): number {
  const totalGb = os.totalmem() / (1024 ** 3);
  const freeGb = os.freemem() / (1024 ** 3);
  if (model === 'medium' || totalGb < 10 || freeGb < 3) return 1;
  if (model === 'small' || totalGb < 16 || freeGb < 6) return Math.min(2, os.availableParallelism());
  return Math.max(1, Math.min(4, os.availableParallelism()));
}

function processErrorCode(error: unknown): string | undefined {
  const code = error && typeof error === 'object' ? (error as NodeJS.ErrnoException).code : undefined;
  return typeof code === 'string' ? code.toUpperCase() : undefined;
}

function tempFailure(error: unknown): AppFailure {
  const code = processErrorCode(error);
  if (code === 'EACCES' || code === 'EPERM') return appFailure('TRANSCRIPTION_TEMP_PERMISSION_DENIED', undefined, { systemCode: code });
  if (code === 'ENOSPC') return appFailure('TRANSCRIPTION_TEMP_STORAGE_FULL', undefined, { systemCode: code });
  return appFailure('TRANSCRIPTION_TEMP_UNAVAILABLE', undefined, { systemCode: code });
}

function sourceFailure(error: unknown): AppFailure {
  const code = processErrorCode(error);
  if (code === 'ENOENT') return appFailure('TRANSCRIPTION_SOURCE_UNAVAILABLE', undefined, { systemCode: code });
  if (code === 'EACCES' || code === 'EPERM') return appFailure('TRANSCRIPTION_SOURCE_PERMISSION_DENIED', undefined, { systemCode: code });
  return appFailure('TRANSCRIPTION_SOURCE_UNREADABLE', undefined, { systemCode: code });
}

function isMemoryFailure(exitCode: number | null, output: string): boolean {
  const unsignedCode = exitCode === null ? 0 : exitCode >>> 0;
  return unsignedCode === 0xc0000017
    || /failed to allocate|out of memory|bad_alloc|not enough memory|memory allocation/i.test(output);
}

function recognitionTimestampSeconds(value: string): number {
  const match = value.match(/(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) return 0;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

export function recognitionProgressFromLine(line: string, duration: number): number | null {
  if (!(duration > 0)) return null;
  const match = line.match(/-->\s*(\d+:\d+:\d+(?:\.\d+)?)/);
  if (!match) return null;
  const processedSeconds = recognitionTimestampSeconds(match[1]);
  if (!(processedSeconds >= 0)) return null;
  return Math.max(1, Math.min(99, Math.round((processedSeconds / duration) * 100)));
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

async function extractRecognitionWindow(options: {
  sourcePath: string;
  outputPath: string;
  windowStart: number;
  windowEnd: number;
  context: { chunkNumber: number; chunkCount: number };
  job: RecognitionJob;
}): Promise<void> {
  if (options.job.cancelled) throw appFailure('TRANSCRIPTION_CANCELLED', options.context);
  const binary = ffmpegBinary();
  if (!(await fileExists(binary))) throw appFailure('TRANSCRIPTION_COMPONENT_UNAVAILABLE', options.context);
  const partialPath = `${options.outputPath}.partial.wav`;
  await fs.unlink(partialPath).catch(() => undefined);
  await fs.unlink(options.outputPath).catch(() => undefined);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(binary, [
        '-y',
        '-ss', options.windowStart.toFixed(3),
        '-t', Math.max(0, options.windowEnd - options.windowStart).toFixed(3),
        '-i', options.sourcePath,
        '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
        partialPath,
      ], { cwd: path.dirname(binary), stdio: ['ignore', 'ignore', 'pipe'] });
      options.job.child = child;
      let timedOut = false;
      let settled = false;
      let timer: NodeJS.Timeout;
      const finish = (error?: AppFailure) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (options.job.child === child) options.job.child = undefined;
        error ? reject(error) : resolve();
      };
      const armTimer = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          timedOut = true;
          child.kill();
        }, EXTRACTION_STALL_TIMEOUT_MS);
      };
      armTimer();
      child.stderr?.on('data', armTimer);
      child.on('error', (error) => {
        const code = processErrorCode(error);
        finish(appFailure(
          code === 'EACCES' || code === 'EPERM' ? 'TRANSCRIPTION_PROCESS_START_DENIED' : 'TRANSCRIPTION_PROCESS_START_FAILED',
          options.context,
          { systemCode: code },
        ));
      });
      child.on('close', (code) => {
        if (options.job.cancelled) finish(appFailure('TRANSCRIPTION_CANCELLED', options.context));
        else if (timedOut) finish(appFailure('TRANSCRIPTION_AUDIO_PREPARATION_TIMEOUT', options.context));
        else if (code === 0) finish();
        else finish(appFailure('TRANSCRIPTION_AUDIO_PREPARATION_FAILED', options.context, { exitCode: code ?? undefined }));
      });
    });
    const stat = await fs.stat(partialPath);
    if (!stat.isFile() || stat.size <= 44) throw appFailure('TRANSCRIPTION_SOURCE_UNREADABLE', options.context);
    await fs.rename(partialPath, options.outputPath);
  } catch (error) {
    await fs.unlink(partialPath).catch(() => undefined);
    await fs.unlink(options.outputPath).catch(() => undefined);
    if (error instanceof AppFailure) throw error;
    throw tempFailure(error);
  }
}

async function recognizeWindow(options: {
  binary: string;
  modelFile: string;
  vadFile: string;
  wavPath: string;
  workDir: string;
  language?: string;
  windowStart: number;
  windowEnd: number;
  threads: number;
  context: { chunkNumber: number; chunkCount: number };
  identity: string;
  attempt: number;
  job: RecognitionJob;
  onProgress?: (percent: number) => void;
}): Promise<TranscriptSegment[]> {
  if (options.job.cancelled) throw appFailure('TRANSCRIPTION_CANCELLED', options.context);
  const outBase = path.join(options.workDir, `transcript-${options.identity}`);
  const jsonPath = `${outBase}.json`;
  const windowWavPath = path.join(options.workDir, `audio-${options.identity}.wav`);
  await fs.unlink(jsonPath).catch(() => undefined);
  await extractRecognitionWindow({
    sourcePath: options.wavPath,
    outputPath: windowWavPath,
    windowStart: options.windowStart,
    windowEnd: options.windowEnd,
    context: options.context,
    job: options.job,
  });
  const args = [
    '-m', options.modelFile,
    '-f', windowWavPath,
    '-t', String(Math.max(1, options.threads)),
    '-oj',
    '-of', outBase,
    '-l', options.language && options.language !== 'auto' ? options.language : 'auto',
    '--vad', '--vad-model', options.vadFile,
    '--vad-threshold', '0.50',
    '--vad-min-speech-duration-ms', '120',
    '--vad-min-silence-duration-ms', '300',
    '--vad-speech-pad-ms', '80',
    '--vad-max-speech-duration-s', '30',
    '-mc', '0', '-sns', '-sow',
  ];

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(options.binary, args, { cwd: path.dirname(options.binary), stdio: ['ignore', 'pipe', 'pipe'] });
      options.job.child = child;
      let diagnosticOutput = '';
      let stalled = false;
      let settled = false;
      let progressRemainder = '';
      let timer: NodeJS.Timeout;
      const finish = (error?: AppFailure) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (options.job.child === child) options.job.child = undefined;
        error ? reject(error) : resolve();
      };
      const armTimer = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          stalled = true;
          child.kill();
        }, TRANSCRIPTION_STALL_TIMEOUT_MS);
      };
      const consume = (data: unknown) => {
        armTimer();
        const text = String(data);
        diagnosticOutput = `${diagnosticOutput}${text}`.slice(-8192);
        const rows = `${progressRemainder}${text}`.split(/\r\n|\r|\n/);
        progressRemainder = rows.pop()?.slice(-512) ?? '';
        for (const row of rows) {
          const progress = recognitionProgressFromLine(row, options.windowEnd - options.windowStart);
          if (progress !== null) options.onProgress?.(progress);
        }
      };
      armTimer();
      child.stdout?.on('data', consume);
      child.stderr?.on('data', consume);
      child.on('error', (error) => {
        const code = processErrorCode(error);
        finish(appFailure(
          code === 'EACCES' || code === 'EPERM' ? 'TRANSCRIPTION_PROCESS_START_DENIED' : 'TRANSCRIPTION_PROCESS_START_FAILED',
          options.context,
          { systemCode: code, attempt: options.attempt },
        ));
      });
      child.on('close', (code) => {
        if (options.job.cancelled) finish(appFailure('TRANSCRIPTION_CANCELLED', options.context, { attempt: options.attempt }));
        else if (stalled) finish(appFailure('TRANSCRIPTION_CHUNK_TIMEOUT', options.context, { exitCode: code ?? undefined, attempt: options.attempt }));
        else if (code === 0) finish();
        else if (isMemoryFailure(code, diagnosticOutput)) finish(appFailure('TRANSCRIPTION_MEMORY_LIMIT', options.context, { exitCode: code ?? undefined, attempt: options.attempt }));
        else finish(appFailure('TRANSCRIPTION_CHUNK_FAILED', options.context, { exitCode: code ?? undefined, attempt: options.attempt }));
      });
    });

    if (options.job.cancelled) throw appFailure('TRANSCRIPTION_CANCELLED', options.context);
    try {
      return offsetRecognitionWindowSegments(
        parseWhisperJson(await fs.readFile(jsonPath, 'utf8')),
        options.windowStart,
        options.windowEnd,
      );
    } catch (error) {
      throw appFailure('TRANSCRIPTION_RESULT_INVALID', options.context, {
        systemCode: processErrorCode(error), attempt: options.attempt,
      });
    }
  } finally {
    await fs.unlink(jsonPath).catch(() => undefined);
    await fs.unlink(windowWavPath).catch(() => undefined);
    await fs.unlink(`${windowWavPath}.partial.wav`).catch(() => undefined);
  }
}

async function recognizeChunkWithRetry(options: {
  binary: string;
  modelFile: string;
  vadFile: string;
  wavPath: string;
  workDir: string;
  language?: string;
  chunk: TranscriptionChunk;
  chunkIndex: number;
  chunkCount: number;
  duration: number;
  model: WhisperModelName;
  job: RecognitionJob;
  onProgress?: (percent: number) => void;
}): Promise<TranscriptSegment[]> {
  const context = { chunkNumber: options.chunkIndex + 1, chunkCount: options.chunkCount };
  const primaryThreads = recognitionThreads(options.model);
  let lastFailure: AppFailure | null = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await recognizeWindow({
        ...options,
        context,
        windowStart: options.chunk.windowStart,
        windowEnd: options.chunk.windowEnd,
        threads: attempt === 1 ? primaryThreads : 1,
        identity: `${options.chunkIndex + 1}-attempt-${attempt}`,
        attempt,
      });
    } catch (error) {
      const failure = error instanceof AppFailure ? error : appFailure('TRANSCRIPTION_CHUNK_FAILED', context);
      if (failure.code === 'TRANSCRIPTION_CANCELLED'
        || failure.code === 'TRANSCRIPTION_PROCESS_START_DENIED'
        || failure.code === 'TRANSCRIPTION_PROCESS_START_FAILED') throw failure;
      lastFailure = failure;
    }
  }

  // A smaller retry isolates difficult/noisy windows and reduces peak work.
  // The selected recognition quality is preserved; the app never silently
  // switches to a less accurate model.
  const midpoint = options.chunk.coreStart + (options.chunk.coreEnd - options.chunk.coreStart) / 2;
  if (midpoint > options.chunk.coreStart + 1 && midpoint < options.chunk.coreEnd - 1) {
    const subChunks: TranscriptionChunk[] = [
      {
        coreStart: options.chunk.coreStart,
        coreEnd: midpoint,
        windowStart: options.chunk.windowStart,
        windowEnd: Math.min(options.chunk.windowEnd, midpoint + TRANSCRIPTION_OVERLAP_SECONDS),
      },
      {
        coreStart: midpoint,
        coreEnd: options.chunk.coreEnd,
        windowStart: Math.max(options.chunk.windowStart, midpoint - TRANSCRIPTION_OVERLAP_SECONDS),
        windowEnd: options.chunk.windowEnd,
      },
    ];
    try {
      const rows: Array<{ chunk: TranscriptionChunk; segments: TranscriptSegment[] }> = [];
      for (let index = 0; index < subChunks.length; index += 1) {
        const chunk = subChunks[index];
        rows.push({
          chunk,
          segments: await recognizeWindow({
            ...options,
            context,
            windowStart: chunk.windowStart,
            windowEnd: chunk.windowEnd,
            threads: 1,
            identity: `${options.chunkIndex + 1}-attempt-3-${index + 1}`,
            attempt: 3,
          }),
        });
      }
      return mergeTranscriptionChunks(rows, options.duration);
    } catch (error) {
      if (error instanceof AppFailure) throw error;
    }
  }
  throw lastFailure ?? appFailure('TRANSCRIPTION_CHUNK_FAILED', context, { attempt: 3 });
}

export function registerWhisperIpc(): void {
  ipcMain.handle('whisper:extract', async (e, args: WhisperExtractArgs): Promise<IpcResult<string>> => {
    try {
      const { projectId, sourcePath } = args ?? {};
      if (!projectId || !sourcePath) throw appFailure('TRANSCRIPTION_INPUT_REQUIRED');
      try {
        const stat = await fs.stat(sourcePath);
        if (!stat.isFile()) throw appFailure('TRANSCRIPTION_SOURCE_UNREADABLE');
        await fs.access(sourcePath);
      } catch (error) {
        if (error instanceof AppFailure) throw error;
        throw sourceFailure(error);
      }

      const win = BrowserWindow.fromWebContents(e.sender);
      const workDir = path.join(projectDir(projectId), 'work');
      try {
        await fs.mkdir(workDir, { recursive: true });
      } catch (error) {
        throw tempFailure(error);
      }
      const wavPath = path.join(workDir, 'source-16k.wav');
      const partialPath = `${wavPath}.partial.wav`;
      await fs.unlink(partialPath).catch(() => undefined);

      const binary = ffmpegBinary();
      if (!(await fileExists(binary))) throw appFailure('TRANSCRIPTION_COMPONENT_UNAVAILABLE');
      emit(win, { phase: 'extracting', projectId });
      await new Promise<void>((resolve, reject) => {
        const child = spawn(binary, [
          '-y', '-i', sourcePath,
          '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
          partialPath,
        ], { cwd: path.dirname(binary), stdio: ['ignore', 'ignore', 'pipe'] });
        let timedOut = false;
        let settled = false;
        let timer: NodeJS.Timeout;
        const finish = (error?: AppFailure) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          error ? reject(error) : resolve();
        };
        const armTimer = () => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            timedOut = true;
            child.kill();
          }, EXTRACTION_STALL_TIMEOUT_MS);
        };
        armTimer();
        child.stderr?.on('data', armTimer);
        child.on('error', (error) => {
          const code = processErrorCode(error);
          finish(appFailure(
            code === 'EACCES' || code === 'EPERM' ? 'TRANSCRIPTION_PROCESS_START_DENIED' : 'TRANSCRIPTION_PROCESS_START_FAILED',
            undefined,
            { systemCode: code },
          ));
        });
        child.on('close', (code) => {
          if (timedOut) finish(appFailure('TRANSCRIPTION_AUDIO_PREPARATION_TIMEOUT'));
          else if (code === 0) finish();
          else finish(appFailure('TRANSCRIPTION_AUDIO_PREPARATION_FAILED', undefined, { exitCode: code ?? undefined }));
        });
      });
      try {
        const stat = await fs.stat(partialPath);
        if (!stat.isFile() || stat.size <= 44) throw appFailure('TRANSCRIPTION_SOURCE_UNREADABLE');
        const backupPath = `${wavPath}.backup`;
        await fs.unlink(backupPath).catch(() => undefined);
        const hadPrevious = await fileExists(wavPath);
        if (hadPrevious) await fs.rename(wavPath, backupPath);
        try {
          await fs.rename(partialPath, wavPath);
          await fs.unlink(backupPath).catch(() => undefined);
        } catch (replaceError) {
          if (hadPrevious) {
            try {
              await fs.rename(backupPath, wavPath);
            } catch (recoveryError) {
              throw appFailure('TRANSCRIPTION_AUDIO_RECOVERY_FAILED', undefined, {
                systemCode: processErrorCode(recoveryError),
              });
            }
          }
          throw replaceError;
        }
      } catch (error) {
        await fs.unlink(partialPath).catch(() => undefined);
        if (error instanceof AppFailure) throw error;
        throw tempFailure(error);
      }
      return appSuccess(wavPath);
    } catch (error) {
      return appFailureResult(error, 'TRANSCRIPTION_UNEXPECTED', { operation: 'extract' });
    }
  });

  ipcMain.handle('whisper:modelStatus', async (_e, args: WhisperModelStatusArgs): Promise<IpcResult<WhisperModelStatus>> => {
    try {
      if (!args?.model) throw appFailure('TRANSCRIPTION_INPUT_REQUIRED');
      const dest = modelPath(args.model);
      return appSuccess({ model: args.model, present: await modelIsUsable(dest, args.model), path: dest });
    } catch (error) {
      return appFailureResult(error, 'TRANSCRIPTION_MODEL_UNAVAILABLE', { operation: 'model-status' });
    }
  });

  ipcMain.handle('whisper:downloadModel', async (e, args: WhisperModelDownloadArgs): Promise<IpcResult<string>> => {
    try {
      if (!args?.model) throw appFailure('TRANSCRIPTION_INPUT_REQUIRED');
      const win = BrowserWindow.fromWebContents(e.sender);
      const dest = await ensureModel(args.model, win);
      emit(win, { phase: 'complete', model: args.model });
      return appSuccess(dest);
    } catch (error) {
      return appFailureResult(modelFailure(error), 'TRANSCRIPTION_MODEL_UNAVAILABLE', { operation: 'download-model' });
    }
  });

  ipcMain.handle('whisper:transcribe', async (e, args: WhisperTranscribeArgs): Promise<IpcResult<TranscriptSegment[]>> => {
    let activeProjectId = '';
    try {
      const { projectId, wavPath, model, language } = args ?? {};
      if (!projectId || !wavPath || !model) throw appFailure('TRANSCRIPTION_INPUT_REQUIRED');
      if (runningTranscriptions.has(projectId)) throw appFailure('TRANSCRIPTION_JOB_CONFLICT');
      activeProjectId = projectId;
      const recognitionJob: RecognitionJob = { cancelled: false };
      runningTranscriptions.set(projectId, recognitionJob);
      try {
        const stat = await fs.stat(wavPath);
        if (!stat.isFile() || stat.size <= 44) throw appFailure('TRANSCRIPTION_SOURCE_UNREADABLE');
      } catch (error) {
        if (error instanceof AppFailure) throw error;
        throw sourceFailure(error);
      }

      const win = BrowserWindow.fromWebContents(e.sender);
      const binary = whisperBinary();
      await ensureRecognitionComponentAvailable();
      let modelFile: string;
      let vadFile: string;
      try {
        modelFile = await ensureModel(model, win);
        vadFile = await ensureVadModel(win, model);
      } catch (error) {
        throw modelFailure(error);
      }
      const audioDuration = await mediaDuration(wavPath);
      if (!(audioDuration > 0)) throw appFailure('TRANSCRIPTION_SOURCE_UNREADABLE');
      const chunks = buildTranscriptionChunks(audioDuration);
      if (!chunks.length) throw appFailure('TRANSCRIPTION_SOURCE_UNREADABLE');
      emit(win, { phase: 'transcribing', percent: 1, model, projectId, chunkNumber: 1, chunkCount: chunks.length });

      const workDir = path.join(projectDir(projectId), 'work', 'transcription-chunks');
      try {
        await fs.mkdir(workDir, { recursive: true });
      } catch (error) {
        throw tempFailure(error);
      }
      let fingerprint: string;
      try {
        fingerprint = await transcriptionFingerprint(wavPath, model, language, audioDuration);
      } catch (error) {
        throw sourceFailure(error);
      }
      const checkpointPath = path.join(workDir, `checkpoint-${fingerprint}.json`);
      const rawCheckpoint = await fs.readFile(checkpointPath, 'utf8')
        .then((raw) => JSON.parse(raw) as unknown)
        .catch(() => null);
      const checkpoint: TranscriptionCheckpoint = validCheckpoint(rawCheckpoint, fingerprint, chunks)
        ? rawCheckpoint
        : {
          schemaVersion: 2,
          fingerprint,
          duration: audioDuration,
          model,
          language: language || 'auto',
          completed: [],
        };
      const completed = new Map(checkpoint.completed.map((row) => [row.index, row]));
      if (completed.size) {
        const resumedPercent = Math.max(1, Math.min(99, Math.round((completed.size / chunks.length) * 99)));
        emit(win, {
          phase: 'transcribing', percent: resumedPercent, model, projectId,
          chunkNumber: Math.min(chunks.length, completed.size + 1), chunkCount: chunks.length,
        });
      }

      for (let index = 0; index < chunks.length; index += 1) {
        if (recognitionJob.cancelled) throw appFailure('TRANSCRIPTION_CANCELLED', { chunkNumber: index + 1, chunkCount: chunks.length });
        if (completed.has(index)) continue;
        const chunk = chunks[index];
        const segments = await recognizeChunkWithRetry({
          binary,
          modelFile,
          vadFile,
          wavPath,
          workDir,
          language,
          chunk,
          chunkIndex: index,
          chunkCount: chunks.length,
          duration: audioDuration,
          model,
          job: recognitionJob,
          onProgress: (chunkPercent) => {
            const percent = Math.max(1, Math.min(99, Math.round(
              ((index + chunkPercent / 100) / chunks.length) * 99,
            )));
            emit(win, {
              phase: 'transcribing', percent, model, projectId,
              chunkNumber: index + 1, chunkCount: chunks.length,
            });
          },
        });
        const row = { index, chunk, segments };
        completed.set(index, row);
        checkpoint.completed = [...completed.values()].sort((a, b) => a.index - b.index);
        try {
          await replaceJsonTransaction(checkpointPath, checkpoint);
        } catch (error) {
          throw tempFailure(error);
        }
        const percent = Math.max(1, Math.min(99, Math.round((completed.size / chunks.length) * 99)));
        emit(win, { phase: 'transcribing', percent, model, projectId, chunkNumber: index + 1, chunkCount: chunks.length });
      }

      const chunkResults = [...completed.values()]
        .sort((a, b) => a.index - b.index)
        .map(({ chunk, segments }) => ({ chunk, segments }));
      const segments = mergeTranscriptionChunks(chunkResults, audioDuration);
      if (!segments.length) throw appFailure('TRANSCRIPTION_NO_SPEECH');
      emit(win, { phase: 'complete', percent: 100, model, projectId, chunkNumber: chunks.length, chunkCount: chunks.length });
      return appSuccess(segments);
    } catch (error) {
      return appFailureResult(error, 'TRANSCRIPTION_UNEXPECTED', { operation: 'transcribe' });
    } finally {
      if (activeProjectId) runningTranscriptions.delete(activeProjectId);
    }
  });

  ipcMain.handle('whisper:cancel', async (_e, projectId: string): Promise<boolean> => {
    const job = runningTranscriptions.get(String(projectId || ''));
    if (!job) return false;
    job.cancelled = true;
    job.child?.kill();
    return true;
  });

  ipcMain.handle('whisper:align', async (e, args: WhisperAlignArgs): Promise<IpcResult<SubtitleWordTiming[]>> => {
    const segmentContext = args?.segmentNumber && args?.segmentCount
      ? { segmentNumber: args.segmentNumber, segmentCount: args.segmentCount }
      : undefined;
    try {
      const { projectId, audioPath, text, model } = args ?? {};
      if (!projectId || !audioPath || !text?.trim() || !model) throw appFailure('SUBTITLE_ALIGNMENT_INPUT_INVALID', segmentContext);
      if (!(await fileExists(audioPath))) throw appFailure('SUBTITLE_ALIGNMENT_AUDIO_UNAVAILABLE', segmentContext);
      const expected = expectedWords(text);
      if (!expected.length) throw appFailure('SUBTITLE_ALIGNMENT_INPUT_INVALID', segmentContext);

      const win = BrowserWindow.fromWebContents(e.sender);
      let modelFile: string;
      try {
        modelFile = await ensureModel(model, win);
      } catch (error) {
        throw modelFailure(error);
      }
      const workDir = path.join(projectDir(projectId), 'work', 'caption-timing');
      try {
        await fs.mkdir(workDir, { recursive: true });
      } catch (error) {
        throw tempFailure(error);
      }
      const identity = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const wavPath = path.join(workDir, `${identity}.wav`);
      const outBase = path.join(workDir, identity);
      const jsonPath = `${outBase}.json`;

      const runAlignmentProcess = async (binary: string, processArgs: string[], cwd: string): Promise<void> => {
        await new Promise<void>((resolve, reject) => {
          const child = spawn(binary, processArgs, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
          let settled = false;
          let timedOut = false;
          let timer: NodeJS.Timeout;
          const finish = (failure?: AppFailure) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            failure ? reject(failure) : resolve();
          };
          const arm = () => {
            clearTimeout(timer);
            timer = setTimeout(() => {
              timedOut = true;
              child.kill();
            }, ALIGNMENT_STALL_TIMEOUT_MS);
          };
          arm();
          child.stderr?.on('data', arm);
          child.on('error', (error) => finish(appFailure('SUBTITLE_ALIGNMENT_FAILED', segmentContext, {
            systemCode: processErrorCode(error),
            classifier: 'start-failed',
          })));
          child.on('close', (code) => {
            if (timedOut) finish(appFailure('SUBTITLE_ALIGNMENT_TIMEOUT', segmentContext, { exitCode: code ?? undefined }));
            else if (code === 0) finish();
            else finish(appFailure('SUBTITLE_ALIGNMENT_FAILED', segmentContext, { exitCode: code ?? undefined }));
          });
        });
      };

      try {
        await runAlignmentProcess(ffmpegBinary(), [
          '-y', '-i', audioPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath,
        ], path.dirname(ffmpegBinary()));

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
        await runAlignmentProcess(whisperBinary(), whisperArgs, path.dirname(whisperBinary()));

        const [raw, duration] = await Promise.all([fs.readFile(jsonPath, 'utf8'), mediaDuration(audioPath)]);
        const aligned = parseAlignedWords(raw, expected, duration);
        if (!aligned.length) throw appFailure('SUBTITLE_ALIGNMENT_RESULT_INVALID', segmentContext);
        return appSuccess(aligned);
      } finally {
        await fs.unlink(wavPath).catch(() => undefined);
        await fs.unlink(jsonPath).catch(() => undefined);
      }
    } catch (error) {
      return appFailureResult(error, 'SUBTITLE_ALIGNMENT_FAILED', {
        operation: 'align',
        segmentNumber: args?.segmentNumber,
        segmentCount: args?.segmentCount,
      });
    }
  });
}
