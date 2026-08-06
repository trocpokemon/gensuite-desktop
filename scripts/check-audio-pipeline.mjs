import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';

const requireNode = createRequire(import.meta.url);
const sourcePath = path.resolve('electron/ipc/audio.ts');
const source = await readFile(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  fileName: sourcePath,
}).outputText;

class MockAppFailure extends Error {
  constructor(code, context, internalDiagnostics = {}) {
    super(code);
    this.code = code;
    this.context = context;
    this.internalDiagnostics = internalDiagnostics;
  }
}

const handlers = new Map();
const testRoot = await mkdtemp(path.join(os.tmpdir(), 'gensuite-audio-pipeline-'));
const mediaBinary = path.resolve('resources/ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const probeBinary = path.resolve('resources/ffmpeg', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled)((name) => {
  if (name === 'electron') return { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } };
  if (name === './project') return { projectDir: (id) => path.join(testRoot, id) };
  if (name === './ffmpeg') return { ffmpegBinary: () => mediaBinary };
  if (name === './appErrors') return {
    AppFailure: MockAppFailure,
    appFailure: (code, context, diagnostics) => new MockAppFailure(code, context, diagnostics),
    appSuccess: (value) => ({ ok: true, value }),
    appFailureResult: (error, fallback) => ({ ok: false, error: error instanceof MockAppFailure ? error : new MockAppFailure(fallback) }),
  };
  return requireNode(name);
}, module, module.exports);
module.exports.registerAudioIpc();

const fixture = path.join(testRoot, 'fixture.mp3');
const generated = spawnSync(mediaBinary, [
  '-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.3',
  '-c:a', 'libmp3lame', '-b:a', '64k', fixture,
], { encoding: 'utf8' });
const violations = [];
if (generated.status !== 0) violations.push('Không thể tạo tệp âm thanh mẫu.');

try {
  const valid = generated.status === 0 ? await readFile(fixture) : Buffer.alloc(0);
  const write = handlers.get('audio:write');
  const assemble = handlers.get('audio:assemble');
  const probe = handlers.get('audio:probe');

  const first = await write?.(null, { projectId: 'p', segmentId: 'stable', base64: valid.toString('base64'), ext: 'mp3' });
  if (!first?.ok || !(first.value.durationSec > 0)) violations.push('Tệp giọng hợp lệ không được xác minh và lưu.');
  const before = first?.ok ? await readFile(first.value.audioPath) : Buffer.alloc(0);

  const invalid = await write?.(null, { projectId: 'p', segmentId: 'stable', base64: Buffer.from('<html>bad</html>').toString('base64'), ext: 'mp3' });
  if (invalid?.ok || invalid?.error?.code !== 'VOICE_AUDIO_INVALID') violations.push('Dữ liệu sai không trả VOICE_AUDIO_INVALID.');
  const after = first?.ok ? await readFile(first.value.audioPath) : Buffer.alloc(0);
  if (!before.equals(after)) violations.push('Lần ghi lỗi đã làm hỏng tệp giọng hợp lệ trước đó.');

  const second = await write?.(null, { projectId: 'p', segmentId: 'second', base64: valid.toString('base64'), ext: 'mp3' });
  const merged = first?.ok && second?.ok
    ? await assemble?.(null, { projectId: 'p', segmentId: 'merged', partPaths: [first.value.audioPath, second.value.audioPath] })
    : null;
  if (!merged?.ok || merged.value.durationSec < 0.5) violations.push('Không ghép và xác minh được nhiều phần giọng.');

  const missing = await probe?.(null, { audioPath: path.join(testRoot, 'missing.mp3') });
  if (missing?.ok || missing?.error?.code !== 'VOICE_AUDIO_RESULT_UNAVAILABLE') violations.push('Tệp giọng bị mất chưa trả đúng nguyên nhân.');

  if (!spawnSync(probeBinary, ['-version'], { encoding: 'utf8' }).stdout) violations.push('Thành phần kiểm tra âm thanh không sẵn sàng trong bộ kiểm thử.');
} finally {
  await rm(testRoot, { recursive: true, force: true });
}

if (violations.length) {
  console.error(`Kiểm tra pipeline âm thanh thất bại:\n${violations.map((item) => `- ${item}`).join('\n')}`);
  process.exit(1);
}
console.log('Kiểm tra pipeline âm thanh: đạt (xác minh, rollback, ghép phần và phân loại tệp mất).');
