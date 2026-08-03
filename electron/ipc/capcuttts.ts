import { ipcMain } from 'electron';
import { spawn } from 'node:child_process';
import { constants, createHash, publicEncrypt, randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { projectDir } from './project';
import { ffmpegBinary, ffprobeBinary } from './ffmpeg';
import type { CapCutTtsPreviewArgs, CapCutTtsPreviewResult, CapCutTtsSynthesizeArgs, CapCutTtsSynthesizeResult } from '../../src/shared/types';
import type { AppErrorCode, IpcResult } from '../../src/shared/appErrors';
import { AppFailure, appFailure, appFailureResult, appSuccess } from './appErrors';

// This integration intentionally contains only the text-to-speech flow needed by
// GenSuite. Internal protocol details stay in the main process and are never
// forwarded to renderer errors or user-visible logs.
const BASE_URL = 'https://editor-api-sg.capcutapi.com';
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAmTd34Lw4b7IuldSXh/zY
CMla+ITdGG5TeWz6ad+OySd4r+IrY45AoqrYUxhQ2dl+7z+i7r/5vEa8rr39BYfB
8AGMQLmZA8HmgpWBsqrn/V6daUALkKnkLb70Fn32CJigIuGXAYqxUdGuI340aC+0
v5Es3puJsHyzf01/AelE4Cdc6bZhQrASJLBh8R3BQToYClmDVSDUQk28o8sl/guA
Z4n303Vj+6Siv1HayPCdV6kpVVnMBAG4+umUbwGmn132N3fgpzLarFF3XyWmS1zh
D/J07iM/rP8GDO9IskHNHd2phrO0G6KzrcFAnTBHjVv+hCBEfzN/no3FNA9AuC36
mwIDAQAB
-----END PUBLIC KEY-----`;

const deviceId = `7${BigInt(`0x${randomBytes(8).toString('hex')}`).toString().slice(0, 19).padEnd(19, '0')}`;
const DEVICE = {
  aid: '359289', app_name: 'CapCut', appvr: '8.7.0', version_name: '8.7.0', version_code: '8.7.0',
  channel: 'capcutpc_google', device_platform: 'mac', device_type: 'MacBookPro17,4',
  device_brand: 'MacBookPro17,4', os_version: '15.7.4', device_id: deviceId, iid: deviceId,
  region: 'VN', loc: 'VN', lan: 'vi-VN', pf: '3', tdid: deviceId,
};

type TaskEnvelope = { data?: { tasks?: Array<Record<string, unknown>> }; ret?: string | number };
const running = new Map<string, AbortController>();
const runningOutputs = new Map<string, string>();
const MAX_REQUEST_CHARS = 900;
const MIN_PREFERRED_SPLIT = Math.floor(MAX_REQUEST_CHARS * 0.45);
const REMOTE_REQUEST_TIMEOUT_MS = 30_000;
const AUDIO_DOWNLOAD_TIMEOUT_MS = 60_000;
const AUDIO_ASSEMBLY_TIMEOUT_MS = 2 * 60_000;
const AUDIO_PROBE_TIMEOUT_MS = 30_000;

class VoiceMergeFailure extends Error {
  constructor(
    readonly kind: 'spawn' | 'exit',
    readonly systemCode?: string,
    readonly exitCode?: number | null,
    readonly detail = '',
  ) {
    super(kind);
    this.name = 'VoiceMergeFailure';
  }
}

function normalizedSystemCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code.toUpperCase() : undefined;
}

function voiceOutputFailure(error: unknown): AppFailure {
  const systemCode = normalizedSystemCode(error);
  if (systemCode === 'ENOSPC') return appFailure('VOICE_OUTPUT_STORAGE_FULL', undefined, { systemCode, classifier: 'storage-full' });
  if (systemCode === 'EACCES' || systemCode === 'EPERM' || systemCode === 'EROFS') {
    return appFailure('VOICE_OUTPUT_PERMISSION_DENIED', undefined, { systemCode, classifier: 'write-denied' });
  }
  return appFailure('VOICE_OUTPUT_UNAVAILABLE', undefined, { systemCode, classifier: 'write-failed' });
}

async function commitVoiceOutput(
  partialPath: string,
  outputPath: string,
  backupPath: string,
  signal: AbortSignal,
): Promise<boolean> {
  let backupCreated = false;
  let replacementCreated = false;
  try {
    try {
      await fs.rename(outputPath, backupPath);
      backupCreated = true;
    } catch (error) {
      if (normalizedSystemCode(error) !== 'ENOENT') throw voiceOutputFailure(error);
    }
    if (signal.aborted) throw appFailure('VOICE_CANCELLED');
    try {
      await fs.rename(partialPath, outputPath);
      replacementCreated = true;
    } catch (error) {
      throw voiceOutputFailure(error);
    }
    if (signal.aborted) throw appFailure('VOICE_CANCELLED');
    return backupCreated;
  } catch (error) {
    try {
      if (replacementCreated) await fs.rm(outputPath, { force: true });
      if (backupCreated) await fs.rename(backupPath, outputPath);
    } catch (rollbackError) {
      const failure = voiceOutputFailure(rollbackError);
      throw appFailure('VOICE_OUTPUT_RECOVERY_FAILED', undefined, {
        ...failure.internalDiagnostics,
        classifier: 'output-rollback-failed',
      });
    }
    throw error;
  }
}

function voiceMergeFailure(error: unknown): AppFailure {
  if (!(error instanceof VoiceMergeFailure)) return appFailure('VOICE_AUDIO_ASSEMBLY_FAILED');
  const detail = error.detail.toLowerCase();
  const diagnostics = {
    processKind: error.kind,
    systemCode: error.systemCode,
    exitCode: error.exitCode ?? undefined,
  };
  if (error.systemCode === 'ENOENT') return appFailure('VOICE_COMPONENT_UNAVAILABLE', undefined, { ...diagnostics, classifier: 'component-missing' });
  if (error.systemCode === 'EACCES' || error.systemCode === 'EPERM') {
    return appFailure('VOICE_PROCESS_START_DENIED', undefined, { ...diagnostics, classifier: 'start-denied' });
  }
  if (error.systemCode === 'ENOSPC' || /no space left|not enough space|disk(?: is)? full/.test(detail)) {
    return appFailure('VOICE_OUTPUT_STORAGE_FULL', undefined, { ...diagnostics, classifier: 'storage-full' });
  }
  if (/permission denied|access is denied|read-only file system/.test(detail)) {
    return appFailure('VOICE_OUTPUT_PERMISSION_DENIED', undefined, { ...diagnostics, classifier: 'write-denied' });
  }
  if (error.kind === 'spawn') {
    return appFailure('VOICE_PROCESS_START_FAILED', undefined, { ...diagnostics, classifier: 'start-failed' });
  }
  return appFailure('VOICE_AUDIO_ASSEMBLY_FAILED', undefined, { ...diagnostics, classifier: 'process-exit' });
}

function requestStatusFailure(status: number): AppErrorCode {
  if (status === 401 || status === 403) return 'VOICE_SERVICE_ACCESS_DENIED';
  if (status === 408 || status === 504) return 'VOICE_REQUEST_TIMEOUT';
  if (status === 429) return 'VOICE_RATE_LIMITED';
  if (status >= 400 && status < 500) return 'VOICE_REQUEST_REJECTED';
  return 'VOICE_SERVICE_UNAVAILABLE';
}

function downloadStatusFailure(status: number): AppErrorCode {
  if (status === 401 || status === 403) return 'VOICE_SERVICE_ACCESS_DENIED';
  if (status === 404 || status === 410) return 'VOICE_AUDIO_RESULT_UNAVAILABLE';
  if (status === 408 || status === 504) return 'VOICE_AUDIO_DOWNLOAD_TIMEOUT';
  if (status === 429) return 'VOICE_RATE_LIMITED';
  return 'VOICE_AUDIO_DOWNLOAD_FAILED';
}

async function fetchWithTimeout<T>(
  url: string,
  init: RequestInit,
  parentSignal: AbortSignal,
  timeoutMs: number,
  timeoutCode: 'VOICE_REQUEST_TIMEOUT' | 'VOICE_AUDIO_DOWNLOAD_TIMEOUT',
  classifier: string,
  consume: (response: Response) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  if (parentSignal.aborted) abort();
  else parentSignal.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const value = await consume(response);
    if (parentSignal.aborted) throw new Error('cancelled');
    if (timedOut) throw appFailure(timeoutCode, undefined, { classifier });
    return value;
  } catch (error) {
    if (parentSignal.aborted) throw error;
    if (timedOut) throw appFailure(timeoutCode, undefined, { classifier });
    throw error;
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener('abort', abort);
  }
}

function compact(value: unknown): string { return JSON.stringify(value); }
function md5(value: string): string { return createHash('md5').update(value, 'utf8').digest('hex'); }
function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function safeName(value: string): string { return value.replace(/[^a-z0-9_-]/gi, '_').slice(0, 120) || 'voice'; }

function looksLikeMp3(bytes: Buffer): boolean {
  if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return true;
  const scanLength = Math.min(bytes.length - 1, 4096);
  for (let index = 0; index < scanLength; index += 1) {
    if (bytes[index] === 0xff && (bytes[index + 1] & 0xe0) === 0xe0) return true;
  }
  return false;
}

async function probeVoiceAudioDuration(filePath: string, signal: AbortSignal): Promise<number> {
  if (signal.aborted) throw appFailure('VOICE_CANCELLED');
  return await new Promise<number>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      const binary = ffprobeBinary();
      child = spawn(binary, [
        '-v', 'error', '-select_streams', 'a:0',
        '-show_entries', 'stream=index,duration:format=duration',
        '-of', 'json', filePath,
      ], { cwd: path.dirname(binary), stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (error) {
      const code = normalizedSystemCode(error);
      reject(code === 'ENOENT'
        ? appFailure('VOICE_COMPONENT_UNAVAILABLE', undefined, { systemCode: code, classifier: 'component-missing' })
        : code === 'EACCES' || code === 'EPERM'
          ? appFailure('VOICE_PROCESS_START_DENIED', undefined, { systemCode: code, classifier: 'start-denied' })
          : appFailure('VOICE_PROCESS_START_FAILED', undefined, { systemCode: code, classifier: 'probe-start-failed' }));
      return;
    }
    let stdout = '';
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let closeFallback: NodeJS.Timeout | undefined;
    let cancelRequested = false;
    let probeTimedOut = false;
    const finish = (duration?: number, error?: unknown) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (closeFallback) clearTimeout(closeFallback);
      signal.removeEventListener('abort', abort);
      if (typeof duration === 'number' && Number.isFinite(duration) && duration > 0) resolve(duration);
      else reject(error ?? new Error('voice-audio-invalid'));
    };
    const abort = () => {
      if (cancelRequested) return;
      cancelRequested = true;
      if (timer) clearTimeout(timer);
      child.kill();
      closeFallback = setTimeout(() => finish(undefined, new Error('cancelled')), 10_000);
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    timer = setTimeout(() => {
      if (cancelRequested) return;
      probeTimedOut = true;
      child.kill();
      closeFallback = setTimeout(
        () => finish(undefined, appFailure('VOICE_AUDIO_VALIDATION_TIMEOUT', undefined, { classifier: 'audio-validation-timeout' })),
        10_000,
      );
    }, AUDIO_PROBE_TIMEOUT_MS);
    child.stdout?.on('data', (data) => { stdout += String(data); });
    child.on('error', (error) => {
      if (cancelRequested) {
        finish(undefined, new Error('cancelled'));
        return;
      }
      if (probeTimedOut) {
        finish(undefined, appFailure('VOICE_AUDIO_VALIDATION_TIMEOUT', undefined, { classifier: 'audio-validation-timeout' }));
        return;
      }
      const code = normalizedSystemCode(error);
      finish(undefined, code === 'ENOENT'
        ? appFailure('VOICE_COMPONENT_UNAVAILABLE', undefined, { systemCode: code, classifier: 'component-missing' })
        : code === 'EACCES' || code === 'EPERM'
          ? appFailure('VOICE_PROCESS_START_DENIED', undefined, { systemCode: code, classifier: 'start-denied' })
          : appFailure('VOICE_PROCESS_START_FAILED', undefined, { systemCode: code, classifier: 'probe-start-failed' }));
    });
    child.on('close', (code) => {
      if (cancelRequested) {
        finish(undefined, new Error('cancelled'));
        return;
      }
      if (probeTimedOut) {
        finish(undefined, appFailure('VOICE_AUDIO_VALIDATION_TIMEOUT', undefined, { classifier: 'audio-validation-timeout' }));
        return;
      }
      try {
        const payload = JSON.parse(stdout) as { streams?: Array<{ duration?: unknown }>; format?: { duration?: unknown } };
        const duration = [payload.format?.duration, payload.streams?.[0]?.duration]
          .map((value) => Number(value))
          .find((value) => Number.isFinite(value) && value > 0);
        if (code === 0 && payload.streams?.length && typeof duration === 'number') finish(duration);
        else finish();
      } catch {
        finish();
      }
    });
  });
}

/** Split long narration at natural language boundaries before falling back to
 * whitespace. The upstream free voice flow is reliable for short passages but
 * rejects or stalls on long documents. */
export function splitCapCutTtsText(input: string): string[] {
  let remaining = input.replace(/\r\n?/g, '\n').trim();
  const chunks: string[] = [];
  const preferredBoundaries = ['\n\n', '\n', '. ', '! ', '? ', '… ', '; ', ': ', ', '];

  while (remaining.length > MAX_REQUEST_CHARS) {
    const window = remaining.slice(0, MAX_REQUEST_CHARS + 1);
    let cut = -1;
    for (const boundary of preferredBoundaries) {
      const index = window.lastIndexOf(boundary);
      if (index >= MIN_PREFERRED_SPLIT) {
        cut = Math.max(cut, index + boundary.length);
      }
    }
    if (cut < MIN_PREFERRED_SPLIT) {
      const whitespace = Math.max(window.lastIndexOf(' '), window.lastIndexOf('\t'));
      cut = whitespace >= MIN_PREFERRED_SPLIT ? whitespace + 1 : MAX_REQUEST_CHARS;
    }
    const chunk = remaining.slice(0, cut).trim();
    if (chunk) chunks.push(chunk);
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function query(includeRegion: boolean, babi?: object): URLSearchParams {
  const params = new URLSearchParams({
    app_name: DEVICE.app_name, device_type: DEVICE.device_type, os_version: DEVICE.os_version,
    channel: DEVICE.channel, version_name: DEVICE.version_name, device_brand: DEVICE.device_brand,
    device_id: DEVICE.device_id, iid: DEVICE.iid, version_code: DEVICE.version_code,
    device_platform: DEVICE.device_platform, aid: DEVICE.aid,
  });
  if (includeRegion) params.set('region', DEVICE.region);
  if (babi) params.set('babi_param', compact(babi));
  return params;
}

function headers(url: string, body: string): Record<string, string> {
  const now = String(Math.floor(Date.now() / 1000));
  const trace = randomUUID().replace(/-/g, '');
  const pathname = url.split('?', 1)[0];
  return {
    'content-type': 'application/json', appvr: DEVICE.appvr, ch: DEVICE.channel, 'device-time': now,
    lan: DEVICE.lan, loc: DEVICE.loc, pf: DEVICE.pf, 'sign-ver': '1', tdid: DEVICE.tdid,
    'x-ss-stub': md5(body), 'x-ss-dp': DEVICE.aid, 'x-khronos': now,
    'x-tt-trace-id': `00-${trace}-${trace.slice(0, 16)}-01`,
    'user-agent': 'Cronet/TTNetVersion:1d7cc3b1 2025-07-16 QuicVersion:52c2b40d 2025-04-03',
    'store-country-code': 'vn', 'store-country-code-src': 'did', 'is-dispatch-us-ttp': '0',
    'is-app-region-us-ttp': '0', 'app-sdk-version': DEVICE.appvr, appid: DEVICE.aid,
    sign: md5(`9e2c|${pathname.slice(-7)}|3|${DEVICE.appvr}|${now}|${DEVICE.tdid}|11ac`),
  };
}

function payloadSignature(ssml: string, extraInfo: string): string {
  const input = `appid:${DEVICE.aid}&did:${DEVICE.device_id}&creditDisable:false&ssml:${md5(ssml)}&extraInfo:${extraInfo}`;
  return publicEncrypt({ key: PUBLIC_KEY, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(input)).toString('base64');
}

async function postTask(pathname: string, body: object, includeRegion: boolean, signal: AbortSignal, babi?: object): Promise<TaskEnvelope> {
  const bodyText = compact(body);
  const url = `${BASE_URL}${pathname}?${query(includeRegion, babi).toString()}`;
  try {
    return await fetchWithTimeout(
      url,
      { method: 'POST', headers: headers(url, bodyText), body: bodyText },
      signal,
      REMOTE_REQUEST_TIMEOUT_MS,
      'VOICE_REQUEST_TIMEOUT',
      'request-timeout',
      async (response) => {
        if (!response.ok) {
          throw appFailure(requestStatusFailure(response.status), undefined, { statusCode: response.status, classifier: 'request-status' });
        }
        let result: TaskEnvelope;
        try {
          result = await response.json() as TaskEnvelope;
        } catch {
          throw appFailure('VOICE_RESPONSE_INVALID', undefined, { classifier: 'invalid-response' });
        }
        if (String(result.ret ?? '0') !== '0') {
          throw appFailure('VOICE_REQUEST_REJECTED', undefined, { classifier: 'request-rejected' });
        }
        return result;
      },
    );
  } catch (error) {
    if (signal.aborted) throw error;
    if (error instanceof AppFailure) throw error;
    throw appFailure('VOICE_SERVICE_UNAVAILABLE', undefined, { classifier: 'network-failed' });
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new Error('cancelled'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function createTask(args: CapCutTtsSynthesizeArgs, signal: AbortSignal): Promise<{ id: string; token: string }> {
  const speed = Math.max(0.5, Math.min(1.5, Number(args.speed) || 1)).toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  const babi = { feature_entrance: 'editor', feature_entrance_detail: 'editor-feature-text_to_speech', feature_key: 'text_to_speech', scenario: 'video_editor' };
  const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">\n    <voice name="${args.voiceId}" mock_tone_info="" platform="sami" resource_id="${args.resourceId}" emotion="" emotion_scale="0" style="" role="" moyin_emotion="" is_clone_tone="false" need_subtitle_timestamp="false">\n        <prosody rate="${speed}">${escapeXml(args.text.trim())}</prosody>\n    </voice>\n</speak>`;
  const extraInfo = compact({ benefit_info: {} });
  const payload = compact({
    audio_format: 'mp3', babi_param: compact(babi), credit_disable: false, extra_info: extraInfo,
    need_merge_voice: false, need_subtitle_timestamp: false, scene: 'text_to_speech', ssml,
    sign: payloadSignature(ssml, extraInfo),
  });
  const result = await postTask('/lv/v1/common_task/new', {
    bind_id: randomUUID(), can_queue: true, enter_from: 'text_to_speech',
    tasks: [{ context: randomUUID(), payload, req_key: 'sami_text_to_speech', task_version: 'v3' }],
  }, true, signal, babi);
  const task = result.data?.tasks?.[0];
  const id = String(task?.id ?? '');
  const token = String(task?.token ?? '');
  if (!id || !token) throw appFailure('VOICE_RESPONSE_INVALID', undefined, { classifier: 'task-missing' });
  return { id, token };
}

async function waitForAudio(task: { id: string; token: string }, signal: AbortSignal): Promise<string> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const result = await postTask('/lv/v1/common_task/query', {
      tasks: [{ bind_id: '', id: task.id, req_key: 'sami_text_to_speech', task_version: 'v3', token: task.token }],
    }, false, signal);
    const row = result.data?.tasks?.[0];
    const status = String(row?.status ?? '').toLowerCase();
    if (status === 'failed' || status === 'fail') {
      throw appFailure('VOICE_REQUEST_REJECTED', undefined, { classifier: 'task-rejected' });
    }
    if (status === 'succeed' || status === 'success') {
      try {
        const payload = JSON.parse(String(row?.payload ?? '{}')) as { audio_subtitles?: Array<{ speech_url?: string }> };
        const audioUrl = String(payload.audio_subtitles?.[0]?.speech_url ?? '');
        const parsed = new URL(audioUrl);
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
          throw appFailure('VOICE_AUDIO_RESULT_UNAVAILABLE', undefined, { classifier: 'result-url-invalid' });
        }
        return audioUrl;
      } catch (error) {
        if (error instanceof AppFailure) throw error;
        throw appFailure('VOICE_AUDIO_RESULT_UNAVAILABLE', undefined, { classifier: 'result-invalid' });
      }
    }
    await delay(800, signal);
  }
  throw appFailure('VOICE_REQUEST_TIMEOUT', undefined, { classifier: 'task-timeout' });
}

async function fetchAudio(url: string, signal: AbortSignal): Promise<Buffer> {
  try {
    return await fetchWithTimeout(
      url,
      { redirect: 'follow' },
      signal,
      AUDIO_DOWNLOAD_TIMEOUT_MS,
      'VOICE_AUDIO_DOWNLOAD_TIMEOUT',
      'download-timeout',
      async (response) => {
        if (!response.ok) {
          throw appFailure(downloadStatusFailure(response.status), undefined, { statusCode: response.status, classifier: 'download-status' });
        }
        try {
          const finalUrl = new URL(response.url);
          if (finalUrl.protocol !== 'https:' || finalUrl.username || finalUrl.password) {
            throw appFailure('VOICE_AUDIO_RESULT_UNAVAILABLE', undefined, { classifier: 'download-redirect' });
          }
        } catch (error) {
          if (error instanceof AppFailure) throw error;
          throw appFailure('VOICE_AUDIO_RESULT_UNAVAILABLE', undefined, { classifier: 'download-redirect' });
        }
        const length = Number(response.headers.get('content-length') ?? 0);
        if (length > 50 * 1024 * 1024) {
          throw appFailure('VOICE_AUDIO_DOWNLOAD_FAILED', undefined, { classifier: 'download-size' });
        }
        let bytes: Buffer;
        try {
          bytes = Buffer.from(await response.arrayBuffer());
        } catch {
          throw appFailure('VOICE_AUDIO_DOWNLOAD_FAILED', undefined, { classifier: 'download-incomplete' });
        }
        if (!bytes.length || bytes.length > 50 * 1024 * 1024 || !looksLikeMp3(bytes)) {
          throw appFailure('VOICE_AUDIO_INVALID', undefined, { classifier: 'download-invalid' });
        }
        return bytes;
      },
    );
  } catch (error) {
    if (signal.aborted) throw error;
    if (error instanceof AppFailure) throw error;
    throw appFailure('VOICE_AUDIO_DOWNLOAD_FAILED', undefined, { classifier: 'download-network' });
  }
}

async function generateAudio(args: CapCutTtsSynthesizeArgs, signal: AbortSignal): Promise<Buffer> {
  const task = await createTask(args, signal);
  const audioUrl = await waitForAudio(task, signal);
  return fetchAudio(audioUrl, signal);
}

async function generateAudioWithRetry(args: CapCutTtsSynthesizeArgs, signal: AbortSignal): Promise<Buffer> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await generateAudio(args, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      lastError = error;
      if (attempt === 0) await delay(1_200, signal);
    }
  }
  if (lastError instanceof AppFailure) {
    throw appFailure(lastError.code, lastError.context, { ...lastError.internalDiagnostics, attempt: 2 });
  }
  throw lastError;
}

async function mergeAudioParts(files: string[], manifestPath: string, outputPath: string, signal: AbortSignal): Promise<void> {
  const manifest = files.map((file) => `file '${path.basename(file)}'`).join('\n');
  try {
    await fs.writeFile(manifestPath, `${manifest}\n`, 'utf8');
  } catch (error) {
    throw voiceOutputFailure(error);
  }
  await new Promise<void>((resolve, reject) => {
    const binary = ffmpegBinary();
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binary, [
        '-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', manifestPath,
        '-vn', '-c:a', 'libmp3lame', '-b:a', '64k', '-ar', '24000', '-ac', '1', outputPath,
      ], { cwd: path.dirname(manifestPath), stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (error) {
      reject(new VoiceMergeFailure('spawn', normalizedSystemCode(error)));
      return;
    }
    let settled = false;
    let stderr = '';
    let cancelRequested = false;
    let assemblyTimedOut = false;
    let cancelFallback: NodeJS.Timeout | undefined;
    let assemblyTimer: NodeJS.Timeout | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (cancelFallback) clearTimeout(cancelFallback);
      if (assemblyTimer) clearTimeout(assemblyTimer);
      signal.removeEventListener('abort', abort);
      error ? reject(error) : resolve();
    };
    const abort = () => {
      if (cancelRequested) return;
      cancelRequested = true;
      if (assemblyTimer) clearTimeout(assemblyTimer);
      child.kill();
      cancelFallback = setTimeout(() => finish(new Error('cancelled')), 10_000);
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    else {
      assemblyTimer = setTimeout(() => {
        assemblyTimedOut = true;
        child.kill();
        cancelFallback = setTimeout(
          () => finish(appFailure('VOICE_AUDIO_ASSEMBLY_TIMEOUT', undefined, { classifier: 'assembly-timeout' })),
          10_000,
        );
      }, AUDIO_ASSEMBLY_TIMEOUT_MS);
    }
    child.stderr?.on('data', (data) => { stderr = `${stderr}${String(data)}`.slice(-4_000); });
    child.on('error', (error) => finish(cancelRequested
      ? new Error('cancelled')
      : assemblyTimedOut
        ? appFailure('VOICE_AUDIO_ASSEMBLY_TIMEOUT', undefined, { classifier: 'assembly-timeout' })
        : new VoiceMergeFailure('spawn', normalizedSystemCode(error), null, stderr)));
    child.on('close', (code) => finish(cancelRequested
      ? new Error('cancelled')
      : assemblyTimedOut
        ? appFailure('VOICE_AUDIO_ASSEMBLY_TIMEOUT', undefined, { classifier: 'assembly-timeout' })
        : code === 0 ? undefined : new VoiceMergeFailure('exit', undefined, code, stderr)));
  }).catch((error) => {
    if (signal.aborted) throw error;
    if (error instanceof AppFailure) throw error;
    throw voiceMergeFailure(error);
  });
}

export async function synthesizeCapCutTts(args: CapCutTtsSynthesizeArgs): Promise<CapCutTtsSynthesizeResult> {
  if (!args?.projectId || !args.jobId || !args.segmentId || !args.text?.trim() || !args.voiceId || !/^\d{10,24}$/.test(args.resourceId)) {
    throw appFailure('VOICE_INPUT_INVALID');
  }
  if (args.text.length > 10_000) throw appFailure('VOICE_TEXT_TOO_LONG');
  const outputKey = `${safeName(args.projectId)}:${safeName(args.segmentId)}`;
  if (running.has(args.jobId) || runningOutputs.has(outputKey)) throw appFailure('VOICE_JOB_CONFLICT');
  const controller = new AbortController();
  running.set(args.jobId, controller);
  runningOutputs.set(outputKey, args.jobId);
  const audioDir = path.join(projectDir(safeName(args.projectId)), 'audio');
  const output = path.join(audioDir, `${safeName(args.segmentId)}.mp3`);
  const workPrefix = `${output}.${safeName(args.jobId)}`;
  const partial = `${workPrefix}.part.mp3`;
  const manifest = `${workPrefix}.concat.txt`;
  const backup = `${workPrefix}.backup.mp3`;
  const partFiles: string[] = [];
  let backupReadyForCleanup = false;
  try {
    try {
      await fs.mkdir(audioDir, { recursive: true });
    } catch (error) {
      throw voiceOutputFailure(error);
    }
    const chunks = splitCapCutTtsText(args.text);
    for (let index = 0; index < chunks.length; index += 1) {
      let bytes: Buffer;
      try {
        bytes = await generateAudioWithRetry({ ...args, text: chunks[index] }, controller.signal);
      } catch (error) {
        if (error instanceof AppFailure) {
          throw appFailure(error.code, {
            ...error.context,
            chunkNumber: index + 1,
            chunkCount: chunks.length,
          }, {
            ...error.internalDiagnostics,
            chunkNumber: index + 1,
            chunkCount: chunks.length,
          });
        }
        throw error;
      }
      if (chunks.length === 1) {
        try {
          await fs.writeFile(partial, bytes);
        } catch (error) {
          throw voiceOutputFailure(error);
        }
        continue;
      }
      const partPath = `${workPrefix}.chunk-${String(index).padStart(3, '0')}.mp3`;
      partFiles.push(partPath);
      try {
        await fs.writeFile(partPath, bytes);
      } catch (error) {
        throw voiceOutputFailure(error);
      }
      try {
        await probeVoiceAudioDuration(partPath, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) throw error;
        if (error instanceof AppFailure) {
          throw appFailure(error.code, {
            ...error.context,
            chunkNumber: index + 1,
            chunkCount: chunks.length,
          }, error.internalDiagnostics);
        }
        throw appFailure('VOICE_AUDIO_INVALID', {
          chunkNumber: index + 1,
          chunkCount: chunks.length,
        }, { classifier: 'chunk-audio-validation' });
      }
    }
    if (partFiles.length > 1) await mergeAudioParts(partFiles, manifest, partial, controller.signal);
    let durationSec: number;
    try {
      durationSec = await probeVoiceAudioDuration(partial, controller.signal);
    } catch (error) {
      if (error instanceof AppFailure) throw error;
      throw appFailure(
        partFiles.length > 1 ? 'VOICE_AUDIO_ASSEMBLY_FAILED' : 'VOICE_AUDIO_INVALID',
        undefined,
        { classifier: 'audio-validation' },
      );
    }
    if (controller.signal.aborted) throw appFailure('VOICE_CANCELLED');
    backupReadyForCleanup = await commitVoiceOutput(partial, output, backup, controller.signal);
    // From this synchronous commit point onward cancellation is no longer
    // accepted: the new output is complete and any previous output is safe.
    if (running.get(args.jobId) === controller) running.delete(args.jobId);
    if (backupReadyForCleanup) {
      try {
        await fs.rm(backup, { force: true });
        backupReadyForCleanup = false;
      } catch {
        // The final output is already committed. Keep the recovery copy marked
        // for one more best-effort cleanup in finally instead of hiding it.
      }
    }
    return { audioPath: output, durationSec };
  } catch (error) {
    if (error instanceof AppFailure && error.code.startsWith('VOICE_OUTPUT_')) throw error;
    if (controller.signal.aborted) throw appFailure('VOICE_CANCELLED');
    if (error instanceof AppFailure) throw error;
    throw appFailure('VOICE_UNEXPECTED');
  } finally {
    await Promise.all([
      fs.rm(partial, { force: true }).catch(() => {}),
      fs.rm(manifest, { force: true }).catch(() => {}),
      ...(backupReadyForCleanup ? [fs.rm(backup, { force: true }).catch(() => {})] : []),
      ...partFiles.map((file) => fs.rm(file, { force: true }).catch(() => {})),
    ]);
    if (running.get(args.jobId) === controller) running.delete(args.jobId);
    if (runningOutputs.get(outputKey) === args.jobId) runningOutputs.delete(outputKey);
  }
}

export async function previewCapCutTts(args: CapCutTtsPreviewArgs): Promise<CapCutTtsPreviewResult> {
  if (!args?.jobId || !args.text?.trim() || !args.voiceId || !/^\d{10,24}$/.test(args.resourceId)) {
    throw appFailure('VOICE_INPUT_INVALID');
  }
  if (args.text.length > MAX_REQUEST_CHARS) throw appFailure('VOICE_TEXT_TOO_LONG');
  if (running.has(args.jobId)) throw appFailure('VOICE_JOB_CONFLICT');
  const controller = new AbortController();
  running.set(args.jobId, controller);
  try {
    const bytes = await generateAudio({ ...args, projectId: 'preview', segmentId: 'preview' }, controller.signal);
    return { audioBase64: bytes.toString('base64') };
  } catch (error) {
    if (controller.signal.aborted) throw appFailure('VOICE_CANCELLED');
    if (error instanceof AppFailure) throw error;
    throw appFailure('VOICE_UNEXPECTED');
  } finally {
    if (running.get(args.jobId) === controller) running.delete(args.jobId);
  }
}

export function registerCapCutTtsIpc(): void {
  ipcMain.handle('capcuttts:synthesize', async (_event, args: CapCutTtsSynthesizeArgs): Promise<IpcResult<CapCutTtsSynthesizeResult>> => {
    try {
      return appSuccess(await synthesizeCapCutTts(args));
    } catch (error) {
      return appFailureResult(error, 'VOICE_UNEXPECTED', {
        operation: 'voice-synthesis',
        textLength: typeof args?.text === 'string' ? args.text.length : 0,
        chunkCount: typeof args?.text === 'string' ? splitCapCutTtsText(args.text).length : 0,
      });
    }
  });
  ipcMain.handle('capcuttts:preview', async (_event, args: CapCutTtsPreviewArgs): Promise<IpcResult<CapCutTtsPreviewResult>> => {
    try {
      return appSuccess(await previewCapCutTts(args));
    } catch (error) {
      return appFailureResult(error, 'VOICE_UNEXPECTED', {
        operation: 'voice-preview',
        textLength: typeof args?.text === 'string' ? args.text.length : 0,
      });
    }
  });

  ipcMain.handle('capcuttts:kill', async (_event, jobId: string): Promise<boolean> => {
    const controller = running.get(jobId);
    if (!controller) return false;
    controller.abort();
    return true;
  });
}
