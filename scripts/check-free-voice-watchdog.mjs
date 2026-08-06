import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { readFile } from 'node:fs/promises';

const requireNode = createRequire(import.meta.url);
const sourcePath = path.resolve('electron/ipc/edgetts.ts');
const source = await readFile(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  fileName: sourcePath,
}).outputText;

class MockAppFailure extends Error {
  constructor(code, context, internalDiagnostics = {}) {
    super(code); this.code = code; this.context = context; this.internalDiagnostics = internalDiagnostics;
  }
}

let mode = 'success';
let currentAudio = null;
class MockTts {
  async getVoices() {
    if (mode === 'catalog-hang') return await new Promise(() => undefined);
    return [{ ShortName: 'vi-Test', FriendlyName: 'Giọng thử', Locale: 'vi-VN', Gender: 'Female' }];
  }
  async setMetadata() {
    if (mode === 'start-hang') return await new Promise(() => undefined);
  }
  toStream() {
    const audioStream = new EventEmitter();
    const metadataStream = new EventEmitter();
    currentAudio = audioStream;
    if (mode === 'success') {
      setImmediate(() => {
        metadataStream.emit('data', Buffer.from('{"Metadata":[]}'));
        audioStream.emit('data', Buffer.alloc(256, 1));
        audioStream.emit('end');
        // Deliberately never close metadata: it must not block valid audio.
      });
    }
    return { audioStream, metadataStream };
  }
  close() {
    if (mode === 'stream-hang' && currentAudio) setImmediate(() => currentAudio.emit('close'));
  }
}

const handlers = new Map();
const root = await mkdtemp(path.join(os.tmpdir(), 'gensuite-free-voice-'));
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled)((name) => {
  if (name === 'electron') return { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } };
  if (name === 'msedge-tts') return { MsEdgeTTS: MockTts, OUTPUT_FORMAT: { AUDIO_24KHZ_48KBITRATE_MONO_MP3: 'format' } };
  if (name === './project') return { projectDir: (id) => path.join(root, id) };
  if (name === './audio') return {
    audioOutputFailure: (error) => error instanceof MockAppFailure ? error : new MockAppFailure('VOICE_OUTPUT_UNAVAILABLE'),
    validateAudioFile: async (audioPath) => ({ audioPath, durationSec: 1.25 }),
    replaceAudioFile: async (partial, dest) => rename(partial, dest),
  };
  if (name === './appErrors') return {
    AppFailure: MockAppFailure,
    appFailure: (code, context, diagnostics) => new MockAppFailure(code, context, diagnostics),
    appSuccess: (value) => ({ ok: true, value }),
    appFailureResult: (error, fallback) => ({ ok: false, error: error instanceof MockAppFailure ? error : new MockAppFailure(fallback) }),
  };
  return requireNode(name);
}, module, module.exports);
module.exports.registerEdgeTtsIpc();

const args = {
  projectId: 'p', jobId: 'job-ok', segmentId: 's', text: 'Nội dung thử', voiceId: 'vi-Test',
  speed: 1, pitch: 0, volume: 100, chunkNumber: 1, chunkCount: 1,
};
const violations = [];
try {
  mode = 'success';
  const success = await Promise.race([
    handlers.get('edgetts:synthesize')?.(null, args),
    new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 2_000)),
  ]);
  if (!success?.ok || !(success.value.durationSec > 0)) violations.push('Âm thanh hợp lệ vẫn bị dữ liệu căn chữ giữ chờ.');

  mode = 'stream-hang';
  currentAudio = null;
  const pending = handlers.get('edgetts:synthesize')?.(null, { ...args, jobId: 'job-cancel', segmentId: 'cancel' });
  for (let attempt = 0; attempt < 100 && !currentAudio; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!currentAudio) violations.push('Kiểm tra hủy không khởi động được luồng giọng.');
  await handlers.get('edgetts:kill')?.(null, 'job-cancel');
  const cancelled = await pending;
  if (cancelled?.ok || cancelled?.error?.code !== 'VOICE_CANCELLED') violations.push('Hủy giọng đang chờ chưa trả VOICE_CANCELLED.');

  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...rest) => originalSetTimeout(callback, Math.min(Number(delay) || 0, 10), ...rest);
  try {
    mode = 'catalog-hang';
    const catalog = await handlers.get('edgetts:voices')?.();
    if (catalog?.ok || catalog?.error?.code !== 'VOICE_REQUEST_TIMEOUT') violations.push('Danh sách giọng treo chưa có timeout.');
    mode = 'start-hang';
    const start = await handlers.get('edgetts:synthesize')?.(null, { ...args, jobId: 'job-start-timeout', segmentId: 'start-timeout' });
    if (start?.ok || start?.error?.code !== 'VOICE_REQUEST_TIMEOUT') violations.push('Khởi tạo giọng treo chưa có timeout.');
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

if (violations.length) {
  console.error(`Kiểm tra giọng miễn phí thất bại:\n${violations.map((item) => `- ${item}`).join('\n')}`);
  process.exit(1);
}
console.log('Kiểm tra giọng miễn phí: đạt (không bị metadata chặn, hủy và timeout hoạt động).');
