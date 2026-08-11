import { ipcMain } from 'electron';
import { promises as fs, createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { projectDir } from './project';
import { ffmpegBinary } from './ffmpeg';
import type {
  AudioAssembleArgs,
  AudioDownloadArgs,
  AudioPersistResult,
  AudioProbeArgs,
  AudioTimelineAssembleArgs,
  AudioTimelinePart,
  AudioWriteArgs,
} from '../../src/shared/types';
import type { IpcResult } from '../../src/shared/appErrors';
import { AppFailure, appFailure, appFailureResult, appSuccess } from './appErrors';

const AUDIO_DOWNLOAD_TIMEOUT_MS = 60_000;
const AUDIO_PROBE_TIMEOUT_MS = 30_000;
const AUDIO_ASSEMBLY_TIMEOUT_MS = 2 * 60_000;
const MAX_AUDIO_BYTES = 200 * 1024 * 1024;
const TIMELINE_INPUT_BATCH = 80;
const MAX_TIMELINE_PARTS = 2_000;

function sanitize(name: string): string {
  return name.replace(/[^a-z0-9_-]/gi, '_');
}

function systemCode(error: unknown): string | undefined {
  const code = error && typeof error === 'object' ? (error as NodeJS.ErrnoException).code : undefined;
  return typeof code === 'string' ? code.toUpperCase() : undefined;
}

export function audioOutputFailure(error: unknown): AppFailure {
  if (error instanceof AppFailure) return error;
  const code = systemCode(error);
  if (code === 'EACCES' || code === 'EPERM') return appFailure('VOICE_OUTPUT_PERMISSION_DENIED', undefined, { systemCode: code });
  if (code === 'ENOSPC') return appFailure('VOICE_OUTPUT_STORAGE_FULL', undefined, { systemCode: code });
  return appFailure('VOICE_OUTPUT_UNAVAILABLE', undefined, { systemCode: code });
}

async function fileExists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(() => true).catch(() => false);
}

export async function replaceAudioFile(partial: string, dest: string): Promise<void> {
  const backup = `${dest}.backup`;
  await fs.rm(backup, { force: true }).catch(() => undefined);
  const hadPrevious = await fileExists(dest);
  if (hadPrevious) await fs.rename(dest, backup);
  try {
    await fs.rename(partial, dest);
    await fs.rm(backup, { force: true }).catch(() => undefined);
  } catch (error) {
    if (hadPrevious) {
      try {
        await fs.rename(backup, dest);
      } catch (recoveryError) {
        throw appFailure('VOICE_OUTPUT_RECOVERY_FAILED', undefined, { systemCode: systemCode(recoveryError) });
      }
    }
    throw audioOutputFailure(error);
  }
}

async function probeDuration(audioPath: string): Promise<number> {
  const probe = path.join(path.dirname(ffmpegBinary()), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(probe, [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', audioPath,
    ], { cwd: path.dirname(probe), stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      if (!settled) {
        settled = true;
        reject(appFailure('VOICE_AUDIO_VALIDATION_TIMEOUT'));
      }
    }, AUDIO_PROBE_TIMEOUT_MS);
    child.stdout?.on('data', (data) => { stdout += String(data); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(audioOutputFailure(error));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const duration = Number.parseFloat(stdout.trim());
      if (code === 0 && Number.isFinite(duration) && duration > 0) resolve(duration);
      else reject(appFailure('VOICE_AUDIO_INVALID', undefined, { exitCode: code ?? undefined }));
    });
  });
}

export async function validateAudioFile(audioPath: string): Promise<AudioPersistResult> {
  const stat = await fs.stat(audioPath).catch((error) => {
    const code = systemCode(error);
    if (code === 'ENOENT') throw appFailure('VOICE_AUDIO_RESULT_UNAVAILABLE', undefined, { systemCode: code });
    if (code === 'EACCES' || code === 'EPERM') throw appFailure('VOICE_AUDIO_INVALID', undefined, { systemCode: code });
    throw audioOutputFailure(error);
  });
  if (!stat.isFile() || stat.size < 128 || stat.size > MAX_AUDIO_BYTES) throw appFailure('VOICE_AUDIO_INVALID');
  return { audioPath, durationSec: await probeDuration(audioPath) };
}

async function writeBufferTransaction(dest: string, buffer: Buffer): Promise<AudioPersistResult> {
  if (buffer.length < 128 || buffer.length > MAX_AUDIO_BYTES) throw appFailure('VOICE_AUDIO_INVALID');
  const partial = `${dest}.partial`;
  try {
    await fs.writeFile(partial, buffer);
    const validated = await validateAudioFile(partial);
    await replaceAudioFile(partial, dest);
    return { audioPath: dest, durationSec: validated.durationSec };
  } catch (error) {
    await fs.rm(partial, { force: true }).catch(() => undefined);
    throw error instanceof AppFailure ? error : audioOutputFailure(error);
  }
}

async function downloadTransaction(args: AudioDownloadArgs): Promise<AudioPersistResult> {
  const parsed = new URL(args.url);
  if (parsed.protocol !== 'https:') throw appFailure('VOICE_AUDIO_RESULT_UNAVAILABLE');
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), AUDIO_DOWNLOAD_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(parsed, { redirect: 'follow', signal: controller.signal });
  } catch (error) {
    clearTimeout(timer);
    if (controller.signal.aborted) throw appFailure('VOICE_AUDIO_DOWNLOAD_TIMEOUT');
    throw appFailure('VOICE_AUDIO_DOWNLOAD_FAILED', undefined, { systemCode: systemCode(error) });
  }
  if (!response.ok || !response.body) {
    clearTimeout(timer);
    throw appFailure(
      response.status === 408 ? 'VOICE_AUDIO_DOWNLOAD_TIMEOUT'
        : response.status === 429 ? 'VOICE_RATE_LIMITED'
          : response.status === 404 ? 'VOICE_AUDIO_RESULT_UNAVAILABLE'
            : 'VOICE_AUDIO_DOWNLOAD_FAILED',
      undefined,
      { statusCode: response.status },
    );
  }
  const contentType = String(response.headers.get('content-type') || args.format || '').toLowerCase();
  if (contentType.includes('text/html') || contentType.includes('application/json')) {
    clearTimeout(timer);
    throw appFailure('VOICE_AUDIO_INVALID');
  }
  const ext = contentType.includes('wav') ? 'wav'
    : contentType.includes('ogg') ? 'ogg'
      : contentType.includes('mp4') || contentType.includes('m4a') ? 'm4a' : 'mp3';
  const audioDir = path.join(projectDir(args.projectId), 'audio');
  await fs.mkdir(audioDir, { recursive: true }).catch((error) => { throw audioOutputFailure(error); });
  const dest = path.join(audioDir, `${sanitize(args.segmentId)}.${ext}`);
  const partial = `${dest}.partial`;
  await fs.rm(partial, { force: true }).catch(() => undefined);
  const output = createWriteStream(partial);
  const reader = response.body.getReader();
  let received = 0;
  try {
    for (;;) {
      const packet = await new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          controller.abort();
          reject(appFailure('VOICE_AUDIO_DOWNLOAD_TIMEOUT'));
        }, AUDIO_DOWNLOAD_TIMEOUT_MS);
        reader.read().then(resolve, reject).finally(() => clearTimeout(timer));
      });
      if (packet.done) break;
      received += packet.value.length;
      if (received > MAX_AUDIO_BYTES) throw appFailure('VOICE_AUDIO_INVALID');
      await new Promise<void>((resolve, reject) => output.write(packet.value, (error) => error ? reject(error) : resolve()));
    }
    await new Promise<void>((resolve, reject) => {
      output.once('finish', resolve); output.once('error', reject); output.end();
    });
    const validated = await validateAudioFile(partial);
    await replaceAudioFile(partial, dest);
    return { audioPath: dest, durationSec: validated.durationSec };
  } catch (error) {
    output.destroy();
    await fs.rm(partial, { force: true }).catch(() => undefined);
    if (error instanceof AppFailure) throw error;
    if (controller.signal.aborted) throw appFailure('VOICE_AUDIO_DOWNLOAD_TIMEOUT');
    throw audioOutputFailure(error);
  }
}

async function assembleAudio(args: AudioAssembleArgs): Promise<AudioPersistResult> {
  if (!args.partPaths.length) throw appFailure('VOICE_INPUT_INVALID');
  for (let index = 0; index < args.partPaths.length; index += 1) {
    try {
      await validateAudioFile(args.partPaths[index]);
    } catch (error) {
      if (error instanceof AppFailure) {
        throw appFailure(error.code, { chunkNumber: index + 1, chunkCount: args.partPaths.length }, error.internalDiagnostics);
      }
      throw error;
    }
  }
  if (args.partPaths.length === 1) return validateAudioFile(args.partPaths[0]);
  const audioDir = path.join(projectDir(args.projectId), 'audio');
  await fs.mkdir(audioDir, { recursive: true }).catch((error) => { throw audioOutputFailure(error); });
  const dest = path.join(audioDir, `${sanitize(args.segmentId)}.mp3`);
  const partial = `${dest}.partial.mp3`;
  const listPath = `${dest}.parts.txt`;
  const escape = (value: string) => value.replace(/'/g, "'\\''");
  await fs.writeFile(listPath, args.partPaths.map((part) => `file '${escape(part)}'`).join('\n'), 'utf8');
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(ffmpegBinary(), [
        '-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-vn', '-c:a', 'libmp3lame', '-q:a', '3', partial,
      ], { cwd: path.dirname(ffmpegBinary()), stdio: ['ignore', 'ignore', 'pipe'] });
      let settled = false;
      const timer = setTimeout(() => {
        child.kill();
        if (!settled) { settled = true; reject(appFailure('VOICE_AUDIO_ASSEMBLY_TIMEOUT')); }
      }, AUDIO_ASSEMBLY_TIMEOUT_MS);
      child.on('error', (error) => {
        if (settled) return;
        settled = true; clearTimeout(timer); reject(audioOutputFailure(error));
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        code === 0 ? resolve() : reject(appFailure('VOICE_AUDIO_ASSEMBLY_FAILED', undefined, { exitCode: code ?? undefined }));
      });
    });
    const validated = await validateAudioFile(partial);
    await replaceAudioFile(partial, dest);
    return { audioPath: dest, durationSec: validated.durationSec };
  } finally {
    await fs.rm(listPath, { force: true }).catch(() => undefined);
    await fs.rm(partial, { force: true }).catch(() => undefined);
  }
}

async function renderTimelineMix(
  parts: Array<{ audioPath: string; delayMs: number }>,
  outputPath: string,
  filterPath: string,
): Promise<void> {
  const chains = parts.map((part, index) =>
    `[${index}:a]aresample=async=1:first_pts=0,adelay=${part.delayMs}:all=1[a${index}]`);
  chains.push(`${parts.map((_part, index) => `[a${index}]`).join('')}amix=inputs=${parts.length}:duration=longest:dropout_transition=0:normalize=0[out]`);
  await fs.writeFile(filterPath, chains.join(';\n'), 'utf8').catch((error) => { throw audioOutputFailure(error); });
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegBinary(), [
      '-y', '-v', 'error',
      ...parts.flatMap((part) => ['-i', part.audioPath]),
      '-filter_complex_script', filterPath,
      '-map', '[out]', '-vn', '-c:a', 'libmp3lame', '-q:a', '3', outputPath,
    ], { cwd: path.dirname(ffmpegBinary()), stdio: ['ignore', 'ignore', 'pipe'] });
    let settled = false;
    const timeoutMs = Math.max(AUDIO_ASSEMBLY_TIMEOUT_MS, parts.length * 5_000);
    const timer = setTimeout(() => {
      child.kill();
      if (!settled) { settled = true; reject(appFailure('VOICE_AUDIO_ASSEMBLY_TIMEOUT')); }
    }, timeoutMs);
    child.on('error', (error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); reject(audioOutputFailure(error));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      code === 0 ? resolve() : reject(appFailure('VOICE_AUDIO_ASSEMBLY_FAILED', undefined, { exitCode: code ?? undefined }));
    });
  });
}

async function assembleTimelineAudio(args: AudioTimelineAssembleArgs): Promise<AudioPersistResult> {
  if (!Array.isArray(args.parts) || !args.parts.length) throw appFailure('VOICE_INPUT_INVALID');
  if (args.parts.length > MAX_TIMELINE_PARTS) throw appFailure('VOICE_TEXT_TOO_LONG', { chunkCount: args.parts.length });
  const parts: AudioTimelinePart[] = [...args.parts].sort((left, right) => left.startTime - right.startTime);
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part?.audioPath || !Number.isFinite(part.startTime) || !Number.isFinite(part.endTime)
      || part.startTime < 0 || part.endTime <= part.startTime || part.endTime > 24 * 60 * 60) {
      throw appFailure('VOICE_INPUT_INVALID', { chunkNumber: index + 1, chunkCount: parts.length });
    }
    try {
      await validateAudioFile(part.audioPath);
    } catch (error) {
      if (error instanceof AppFailure) throw appFailure(error.code, { chunkNumber: index + 1, chunkCount: parts.length }, error.internalDiagnostics);
      throw error;
    }
  }

  const audioDir = path.join(projectDir(args.projectId), 'audio');
  await fs.mkdir(audioDir, { recursive: true }).catch((error) => { throw audioOutputFailure(error); });
  const dest = path.join(audioDir, `${sanitize(args.segmentId)}.mp3`);
  const partial = `${dest}.partial.mp3`;
  const temporaryPaths: string[] = [];
  try {
    const groups: string[] = [];
    for (let offset = 0; offset < parts.length; offset += TIMELINE_INPUT_BATCH) {
      const group = parts.slice(offset, offset + TIMELINE_INPUT_BATCH);
      const groupOutput = parts.length <= TIMELINE_INPUT_BATCH ? partial : `${dest}.timeline-${groups.length}.mp3`;
      const filterPath = `${dest}.timeline-${groups.length}.filter.txt`;
      temporaryPaths.push(filterPath);
      if (groupOutput !== partial) temporaryPaths.push(groupOutput);
      await renderTimelineMix(group.map((part) => ({ audioPath: part.audioPath, delayMs: Math.round(part.startTime * 1000) })), groupOutput, filterPath);
      groups.push(groupOutput);
    }
    if (groups.length > 1) {
      const finalFilter = `${dest}.timeline-final.filter.txt`;
      temporaryPaths.push(finalFilter);
      await renderTimelineMix(groups.map((audioPath) => ({ audioPath, delayMs: 0 })), partial, finalFilter);
    }
    const validated = await validateAudioFile(partial);
    await replaceAudioFile(partial, dest);
    return { audioPath: dest, durationSec: validated.durationSec };
  } finally {
    await Promise.all(temporaryPaths.map((filePath) => fs.rm(filePath, { force: true }).catch(() => undefined)));
    await fs.rm(partial, { force: true }).catch(() => undefined);
  }
}

export function registerAudioIpc(): void {
  ipcMain.handle('audio:write', async (_e, args: AudioWriteArgs): Promise<IpcResult<AudioPersistResult>> => {
    try {
      if (!args?.projectId || !args.segmentId || !args.base64) throw appFailure('VOICE_INPUT_INVALID');
      const ext = (args.ext || 'mp3').replace(/[^a-z0-9]/gi, '') || 'mp3';
      const audioDir = path.join(projectDir(args.projectId), 'audio');
      await fs.mkdir(audioDir, { recursive: true }).catch((error) => { throw audioOutputFailure(error); });
      const dest = path.join(audioDir, `${sanitize(args.segmentId)}.${ext}`);
      return appSuccess(await writeBufferTransaction(dest, Buffer.from(args.base64, 'base64')));
    } catch (error) {
      return appFailureResult(error, 'VOICE_UNEXPECTED', { operation: 'write-audio' });
    }
  });

  ipcMain.handle('audio:download', async (_e, args: AudioDownloadArgs): Promise<IpcResult<AudioPersistResult>> => {
    try {
      if (!args?.projectId || !args.segmentId || !args.url) throw appFailure('VOICE_INPUT_INVALID');
      return appSuccess(await downloadTransaction(args));
    } catch (error) {
      return appFailureResult(error, 'VOICE_AUDIO_DOWNLOAD_FAILED', { operation: 'download-audio' });
    }
  });

  ipcMain.handle('audio:assemble', async (_e, args: AudioAssembleArgs): Promise<IpcResult<AudioPersistResult>> => {
    try {
      if (!args?.projectId || !args.segmentId || !Array.isArray(args.partPaths)) throw appFailure('VOICE_INPUT_INVALID');
      return appSuccess(await assembleAudio(args));
    } catch (error) {
      return appFailureResult(error, 'VOICE_AUDIO_ASSEMBLY_FAILED', { operation: 'assemble-audio', chunkCount: args?.partPaths?.length });
    }
  });

  ipcMain.handle('audio:assembleTimeline', async (_e, args: AudioTimelineAssembleArgs): Promise<IpcResult<AudioPersistResult>> => {
    try {
      if (!args?.projectId || !args.segmentId || !Array.isArray(args.parts)) throw appFailure('VOICE_INPUT_INVALID');
      return appSuccess(await assembleTimelineAudio(args));
    } catch (error) {
      return appFailureResult(error, 'VOICE_AUDIO_ASSEMBLY_FAILED', { operation: 'assemble-timeline-audio', chunkCount: args?.parts?.length });
    }
  });

  ipcMain.handle('audio:probe', async (_e, args: AudioProbeArgs): Promise<IpcResult<AudioPersistResult>> => {
    try {
      if (!args?.audioPath) throw appFailure('VOICE_INPUT_INVALID');
      return appSuccess(await validateAudioFile(args.audioPath));
    } catch (error) {
      return appFailureResult(error, 'VOICE_AUDIO_INVALID', { operation: 'probe-audio' });
    }
  });
}
