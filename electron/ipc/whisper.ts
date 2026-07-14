import { ipcMain, BrowserWindow, app } from 'electron';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
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

async function ensureModel(model: WhisperModelName, win: BrowserWindow | null): Promise<string> {
  const dest = modelPath(model);
  if (await fileExists(dest)) return dest;

  await fs.mkdir(modelsDir(), { recursive: true });
  emit(win, { phase: 'downloading-model', percent: 0, model });

  const resp = await fetch(modelUrl(model));
  if (!resp.ok || !resp.body) throw new Error(`Tải model whisper thất bại: ${resp.status}`);
  const total = Number(resp.headers.get('content-length')) || 0;

  // Write to a temp file first so an interrupted download never leaves a
  // truncated model that later looks "present".
  const tmp = `${dest}.part`;
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
  } finally {
    out.close();
  }
  await fs.rename(tmp, dest);
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

export function registerWhisperIpc(): void {
  ipcMain.handle('whisper:extract', async (e, args: WhisperExtractArgs): Promise<string> => {
    const { projectId, sourcePath } = args;
    if (!projectId || !sourcePath) throw new Error('whisper:extract missing args');
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
      child.on('error', (err) => reject(new Error(`Không thể chạy FFmpeg: ${err.message}`)));
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`FFmpeg trích audio lỗi ${code}: ${stderr.slice(-300)}`)));
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
    if (!projectId || !wavPath) throw new Error('whisper:transcribe missing args');
    if (!(await fileExists(wavPath))) throw new Error('Không tìm thấy file WAV đã trích.');

    const win = BrowserWindow.fromWebContents(e.sender);
    const binary = whisperBinary();
    if (!(await fileExists(binary))) throw new Error('Không tìm thấy whisper.cpp. Kiểm tra resources/whisper/.');

    const modelFile = await ensureModel(model, win);
    emit(win, { phase: 'transcribing', model });

    const workDir = path.join(projectDir(projectId), 'work');
    const outBase = path.join(workDir, 'transcript');
    const whisperArgs = [
      '-m', modelFile,
      '-f', wavPath,
      '-oj',
      '-of', outBase,
    ];
    if (language && language !== 'auto') whisperArgs.push('-l', language);

    await new Promise<void>((resolve, reject) => {
      const child = spawn(binary, whisperArgs, { cwd: path.dirname(binary), stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr?.on('data', (d) => { stderr += String(d); });
      child.on('error', (err) => reject(new Error(`Không thể chạy whisper: ${err.message}`)));
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`whisper lỗi ${code}: ${stderr.slice(-400)}`)));
    });

    const jsonPath = `${outBase}.json`;
    const raw = await fs.readFile(jsonPath, 'utf-8').catch(() => '');
    if (!raw) throw new Error('whisper không tạo ra kết quả JSON.');
    const segments = parseWhisperJson(raw);
    if (!segments.length) throw new Error('whisper không nhận dạng được lời thoại nào.');
    emit(win, { phase: 'complete', model });
    return segments;
  });
}
