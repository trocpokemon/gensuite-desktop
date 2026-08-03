import { spawn as realSpawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';

const requireNode = createRequire(import.meta.url);
const sourcePath = path.resolve('electron/ipc/capcuttts.ts');
const source = await readFile(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
  fileName: sourcePath,
}).outputText;

class MockAppFailure extends Error {
  constructor(code, context, internalDiagnostics = {}) {
    super(code);
    this.name = 'AppFailure';
    this.code = code;
    this.context = context;
    this.internalDiagnostics = internalDiagnostics;
  }
}

const handlers = new Map();
const testRoot = await mkdtemp(path.join(os.tmpdir(), 'gensuite-voice-check-'));
const mediaBinary = path.resolve('resources/ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const probeBinary = path.resolve('resources/ffmpeg', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
let probeMode = 'real';
let probeEntered = null;

function controlledSpawn(command, args, options) {
  if (probeMode !== 'hang' || path.resolve(String(command)) !== probeBinary) {
    return realSpawn(command, args, options);
  }
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {
    setImmediate(() => child.emit('close', null));
    return true;
  };
  setImmediate(() => probeEntered?.());
  return child;
}

const module = { exports: {} };
const execute = new Function('require', 'module', 'exports', compiled);
execute((name) => {
  if (name === 'electron') return { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } };
  if (name === './project') return { projectDir: (id) => path.join(testRoot, id) };
  if (name === './ffmpeg') return { ffmpegBinary: () => mediaBinary, ffprobeBinary: () => probeBinary };
  if (name === 'node:child_process') return { ...requireNode(name), spawn: controlledSpawn };
  if (name === './appErrors') {
    return {
      AppFailure: MockAppFailure,
      appFailure: (code, context, diagnostics) => new MockAppFailure(code, context, diagnostics),
      appFailureResult: (error) => ({ ok: false, error }),
      appSuccess: (value) => ({ ok: true, value }),
    };
  }
  return requireNode(name);
}, module, module.exports);

const {
  registerCapCutTtsIpc,
  splitCapCutTtsText,
  synthesizeCapCutTts,
} = module.exports;
registerCapCutTtsIpc();

const longNaturalText = Array.from(
  { length: 72 },
  (_, index) => `Đây là câu kiểm tra số ${index + 1}, dùng để xác nhận nội dung dài được chia đúng nhịp.`,
).join(' ');
const denseText = 'ộ'.repeat(10_000);
const naturalChunks = splitCapCutTtsText(longNaturalText);
const denseChunks = splitCapCutTtsText(denseText);
const normalize = (value) => value.replace(/\s+/g, ' ').trim();
const violations = [];

for (const [label, chunks, original, dense] of [
  ['văn bản tự nhiên', naturalChunks, longNaturalText, false],
  ['văn bản không có khoảng trắng', denseChunks, denseText, true],
]) {
  if (chunks.length < 2) violations.push(`${label} dài chưa được chia thành nhiều phần.`);
  if (chunks.some((chunk) => !chunk || chunk.length > 900)) violations.push(`${label} tạo phần rỗng hoặc vượt 900 ký tự.`);
  const reconstructed = dense ? chunks.join('') : normalize(chunks.join(' '));
  const expected = dense ? original : normalize(original);
  if (reconstructed !== expected) violations.push(`${label} bị mất hoặc lặp nội dung sau khi chia.`);
}

const baseArgs = {
  projectId: 'voice-check',
  jobId: 'job-valid',
  segmentId: 'segment-valid',
  text: 'Nội dung kiểm tra.',
  voiceId: 'voice-check',
  resourceId: '123456789012',
  speed: 1,
};

async function capturedCode(work) {
  try {
    await work();
    return null;
  } catch (error) {
    return error instanceof MockAppFailure ? error.code : `unexpected:${error?.constructor?.name ?? typeof error}`;
  }
}

async function capturedFailure(work) {
  try {
    await work();
    return null;
  } catch (error) {
    return error instanceof MockAppFailure ? error : null;
  }
}

const invalidCode = await capturedCode(() => synthesizeCapCutTts({}));
const tooLongCode = await capturedCode(() => synthesizeCapCutTts({ ...baseArgs, jobId: 'job-long', text: 'a'.repeat(10_001) }));
if (invalidCode !== 'VOICE_INPUT_INVALID') violations.push(`Input sai trả ${invalidCode} thay vì VOICE_INPUT_INVALID.`);
if (tooLongCode !== 'VOICE_TEXT_TOO_LONG') violations.push(`Nội dung quá dài trả ${tooLongCode} thay vì VOICE_TEXT_TOO_LONG.`);

const generatedAudioPath = path.join(testRoot, 'fixture.mp3');
const generated = spawnSync(mediaBinary, [
  '-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.25',
  '-c:a', 'libmp3lame', '-b:a', '64k', generatedAudioPath,
], { encoding: 'utf8' });
if (generated.status !== 0) {
  violations.push('Không thể tạo fixture âm thanh cho kiểm tra hợp đồng tạo giọng.');
}
const validAudio = generated.status === 0 ? await readFile(generatedAudioPath) : Buffer.alloc(0);
let downloadMode = 'valid';
let bodyEntered = null;
let audioDownloadCount = 0;

function pendingUntilAbort(signal) {
  bodyEntered?.();
  return new Promise((_resolve, reject) => {
    const rejectAbort = () => reject(new Error('aborted'));
    if (signal?.aborted) rejectAbort();
    else signal?.addEventListener('abort', rejectAbort, { once: true });
  });
}

function response({ status = 200, url, json, bytes, contentType = 'application/octet-stream', jsonReader, arrayBufferReader }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: (name) => name.toLowerCase() === 'content-length' ? String(bytes?.length ?? 0) : name.toLowerCase() === 'content-type' ? contentType : null },
    json: jsonReader ?? (async () => json),
    arrayBuffer: arrayBufferReader ?? (async () => {
      const value = bytes ?? Buffer.alloc(0);
      return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    }),
  };
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const value = String(url);
  if (downloadMode === 'hang') {
    return await new Promise((_resolve, reject) => {
      const rejectAbort = () => reject(new Error('aborted'));
      if (init.signal?.aborted) rejectAbort();
      else init.signal?.addEventListener('abort', rejectAbort, { once: true });
    });
  }
  if (value.includes('/common_task/new')) {
    const status = downloadMode === 'request-401' ? 401
      : downloadMode === 'request-429' ? 429
        : downloadMode === 'request-400' ? 400
          : downloadMode === 'request-500' ? 500
            : 200;
    return response({
      status,
      url: value,
      json: { ret: 0, data: { tasks: [{ id: 'task', token: 'token' }] } },
      jsonReader: downloadMode === 'json-body-hang'
        ? () => pendingUntilAbort(init.signal)
        : downloadMode === 'invalid-json'
          ? async () => { throw new Error('invalid json'); }
          : undefined,
    });
  }
  if (value.includes('/common_task/query')) {
    return response({
      url: value,
      json: { ret: 0, data: { tasks: [{ status: 'success', payload: JSON.stringify({ audio_subtitles: [{ speech_url: 'https://audio.example/result.mp3' }] }) }] } },
    });
  }
  if (value === 'https://audio.example/result.mp3') {
    audioDownloadCount += 1;
    const status = downloadMode === 'download-404' ? 404
      : downloadMode === 'download-408' ? 408
        : downloadMode === 'download-429' ? 429
          : 200;
    const bytes = downloadMode === 'html'
      ? Buffer.from('<html>not audio</html>')
      : downloadMode === 'corrupt-after-first' && audioDownloadCount > 1
        ? Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, ...Array(16).fill(0)])
        : validAudio;
    return response({
      status,
      url: value,
      bytes,
      contentType: downloadMode === 'html' ? 'text/html' : 'audio/mpeg',
      arrayBufferReader: downloadMode === 'audio-body-hang' ? () => pendingUntilAbort(init.signal) : undefined,
    });
  }
  throw new Error('unexpected test URL');
};

try {
  if (validAudio.length) {
    const success = await synthesizeCapCutTts(baseArgs);
    if (!(success.durationSec > 0) || !success.audioPath) violations.push('Kết quả hợp lệ không có duration/path đã được xác minh.');

    downloadMode = 'html';
    const htmlCode = await capturedCode(() => synthesizeCapCutTts({ ...baseArgs, jobId: 'job-html', segmentId: 'segment-html' }));
    if (htmlCode !== 'VOICE_AUDIO_INVALID') {
      violations.push(`HTTP 200 không phải audio trả ${htmlCode} thay vì VOICE_AUDIO_INVALID.`);
    }
    const invalidOutput = path.join(testRoot, 'voice-check', 'audio', 'segment-html.mp3');
    if (await access(invalidOutput).then(() => true).catch(() => false)) violations.push('Dữ liệu không phải audio đã bị commit thành tệp kết quả.');

    for (const [mode, expectedCode] of [
      ['request-401', 'VOICE_SERVICE_ACCESS_DENIED'],
      ['request-429', 'VOICE_RATE_LIMITED'],
      ['request-400', 'VOICE_REQUEST_REJECTED'],
      ['request-500', 'VOICE_SERVICE_UNAVAILABLE'],
      ['invalid-json', 'VOICE_RESPONSE_INVALID'],
      ['download-404', 'VOICE_AUDIO_RESULT_UNAVAILABLE'],
      ['download-408', 'VOICE_AUDIO_DOWNLOAD_TIMEOUT'],
      ['download-429', 'VOICE_RATE_LIMITED'],
    ]) {
      downloadMode = mode;
      audioDownloadCount = 0;
      const statusCode = await capturedCode(() => synthesizeCapCutTts({
        ...baseArgs,
        jobId: `job-${mode}`,
        segmentId: `segment-${mode}`,
      }));
      if (statusCode !== expectedCode) violations.push(`${mode} trả ${statusCode} thay vì ${expectedCode}.`);
    }

    downloadMode = 'corrupt-after-first';
    audioDownloadCount = 0;
    const corruptChunkFailure = await capturedFailure(() => synthesizeCapCutTts({
      ...baseArgs,
      jobId: 'job-corrupt-chunk',
      segmentId: 'segment-corrupt-chunk',
      text: 'a'.repeat(1_800),
    }));
    if (corruptChunkFailure?.code !== 'VOICE_AUDIO_INVALID') {
      violations.push(`Phần âm thanh hỏng trả ${corruptChunkFailure?.code ?? 'success'} thay vì VOICE_AUDIO_INVALID.`);
    }
    if (corruptChunkFailure?.context?.chunkNumber !== 2 || corruptChunkFailure?.context?.chunkCount !== 2) {
      violations.push('Lỗi phần âm thanh hỏng không chỉ đúng phần 2/2.');
    }

    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (callback, delay, ...args) => originalSetTimeout(callback, Math.min(Number(delay) || 0, 10), ...args);
    try {
      downloadMode = 'json-body-hang';
      const jsonBodyTimeout = await capturedCode(() => synthesizeCapCutTts({ ...baseArgs, jobId: 'job-json-body-timeout', segmentId: 'segment-json-body-timeout' }));
      if (jsonBodyTimeout !== 'VOICE_REQUEST_TIMEOUT') {
        violations.push(`Nội dung phản hồi treo trả ${jsonBodyTimeout} thay vì VOICE_REQUEST_TIMEOUT.`);
      }

      downloadMode = 'audio-body-hang';
      const audioBodyTimeout = await capturedCode(() => synthesizeCapCutTts({ ...baseArgs, jobId: 'job-audio-body-timeout', segmentId: 'segment-audio-body-timeout' }));
      if (audioBodyTimeout !== 'VOICE_AUDIO_DOWNLOAD_TIMEOUT') {
        violations.push(`Nội dung âm thanh treo trả ${audioBodyTimeout} thay vì VOICE_AUDIO_DOWNLOAD_TIMEOUT.`);
      }
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }

    downloadMode = 'audio-body-hang';
    const bodyReady = new Promise((resolve) => { bodyEntered = resolve; });
    const bodyJob = synthesizeCapCutTts({ ...baseArgs, jobId: 'job-body-cancel', segmentId: 'segment-body-cancel' });
    await Promise.race([
      bodyReady,
      new Promise((_, reject) => originalSetTimeout(() => reject(new Error('body test did not start')), 2_000)),
    ]);
    const killHandler = handlers.get('capcuttts:kill');
    await killHandler?.(null, 'job-body-cancel');
    const bodyCancelledCode = await capturedCode(() => bodyJob);
    if (bodyCancelledCode !== 'VOICE_CANCELLED') violations.push(`Hủy khi đang tải nội dung trả ${bodyCancelledCode} thay vì VOICE_CANCELLED.`);
    const bodyOutput = path.join(testRoot, 'voice-check', 'audio', 'segment-body-cancel.mp3');
    if (await access(bodyOutput).then(() => true).catch(() => false)) violations.push('Job bị hủy khi tải nội dung vẫn commit tệp kết quả.');
    bodyEntered = null;

    downloadMode = 'valid';
    probeMode = 'hang';
    const probeReady = new Promise((resolve) => { probeEntered = resolve; });
    const probeJob = synthesizeCapCutTts({ ...baseArgs, jobId: 'job-probe-cancel', segmentId: 'segment-probe-cancel' });
    await Promise.race([
      probeReady,
      new Promise((_, reject) => originalSetTimeout(() => reject(new Error('probe test did not start')), 2_000)),
    ]);
    await killHandler?.(null, 'job-probe-cancel');
    const probeCancelledCode = await capturedCode(() => probeJob);
    if (probeCancelledCode !== 'VOICE_CANCELLED') violations.push(`Hủy khi đang kiểm tra âm thanh trả ${probeCancelledCode} thay vì VOICE_CANCELLED.`);
    const probeOutput = path.join(testRoot, 'voice-check', 'audio', 'segment-probe-cancel.mp3');
    if (await access(probeOutput).then(() => true).catch(() => false)) violations.push('Job bị hủy khi kiểm tra âm thanh vẫn commit tệp kết quả.');
    probeMode = 'real';
    probeEntered = null;
  }

  downloadMode = 'hang';
  const firstJob = synthesizeCapCutTts({ ...baseArgs, jobId: 'job-duplicate-a', segmentId: 'segment-duplicate' });
  const duplicateCode = await capturedCode(() => synthesizeCapCutTts({ ...baseArgs, jobId: 'job-duplicate-b', segmentId: 'segment-duplicate' }));
  if (duplicateCode !== 'VOICE_JOB_CONFLICT') violations.push(`Job trùng output trả ${duplicateCode} thay vì VOICE_JOB_CONFLICT.`);
  const killHandler = handlers.get('capcuttts:kill');
  await killHandler?.(null, 'job-duplicate-a');
  const cancelledCode = await capturedCode(() => firstJob);
  if (cancelledCode !== 'VOICE_CANCELLED') violations.push(`Hủy job trả ${cancelledCode} thay vì VOICE_CANCELLED.`);

  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => originalSetTimeout(callback, Math.min(Number(delay) || 0, 10), ...args);
  try {
    const timeoutCode = await capturedCode(() => synthesizeCapCutTts({ ...baseArgs, jobId: 'job-timeout', segmentId: 'segment-timeout' }));
    if (timeoutCode !== 'VOICE_REQUEST_TIMEOUT') violations.push(`Request treo trả ${timeoutCode} thay vì VOICE_REQUEST_TIMEOUT.`);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
} finally {
  globalThis.fetch = originalFetch;
  await rm(testRoot, { recursive: true, force: true });
}

if (violations.length) {
  console.error(`Kiểm tra tạo giọng thất bại:\n${violations.map((item) => `- ${item}`).join('\n')}`);
  process.exit(1);
}

console.log(`Kiểm tra tạo giọng: đạt (${naturalChunks.length} phần tự nhiên, ${denseChunks.length} phần dày; validation, timeout, conflict và cleanup đạt).`);
