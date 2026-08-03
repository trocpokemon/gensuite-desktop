import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

const requireNode = createRequire(import.meta.url);
const sourcePath = path.resolve('electron/ipc/ffmpeg.ts');
const source = await readFile(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
  fileName: sourcePath,
}).outputText + `
module.exports.__watchdogTest = {
  runMediaProcess,
  runMediaProbe,
  processFailure,
  probeInfrastructureFailure,
};`;

class MockAppFailure extends Error {
  constructor(code, context, internalDiagnostics = {}) {
    super(code);
    this.name = 'AppFailure';
    this.code = code;
    this.context = context;
    this.internalDiagnostics = internalDiagnostics;
  }
}

const nativeSetTimeout = globalThis.setTimeout;
let spawnMode = 'silent';
let killCount = 0;

function fakeSpawn() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  let closed = false;
  let heartbeat;
  const close = (code) => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    child.emit('close', code);
  };
  child.kill = () => {
    killCount += 1;
    nativeSetTimeout(() => close(null), 0);
    return true;
  };
  if (spawnMode === 'heartbeat') {
    heartbeat = setInterval(() => child.stderr.emit('data', 'progress=continue\n'), 2);
    nativeSetTimeout(() => close(0), 45);
  } else if (spawnMode === 'success') {
    nativeSetTimeout(() => close(0), 0);
  }
  return child;
}

const module = { exports: {} };
const execute = new Function('require', 'module', 'exports', compiled);
execute((name) => {
  if (name === 'electron') {
    return {
      ipcMain: { handle: () => {} },
      BrowserWindow: { fromWebContents: () => null },
      dialog: {},
      shell: { showItemInFolder: () => {} },
      app: { isPackaged: false, getAppPath: () => process.cwd() },
    };
  }
  if (name === 'node:child_process') return { ...requireNode(name), spawn: fakeSpawn };
  if (name === '../../src/shared/subtitlePresets') return { DEFAULT_SUBTITLE_CONFIG: {} };
  if (name === './project') return { projectDir: (id) => path.join(process.cwd(), String(id)) };
  if (name === './appErrors') {
    return {
      appFailure: (code, context, diagnostics) => new MockAppFailure(code, context, diagnostics),
      appFailureResult: (error) => ({ ok: false, error }),
      appSuccess: (value) => ({ ok: true, value }),
    };
  }
  return requireNode(name);
}, module, module.exports);

const {
  runMediaProcess,
  runMediaProbe,
  processFailure,
  probeInfrastructureFailure,
} = module.exports.__watchdogTest;
const violations = [];

globalThis.setTimeout = (callback, delay, ...args) => nativeSetTimeout(callback, Math.min(Number(delay) || 0, 10), ...args);
try {
  spawnMode = 'silent';
  let silentFailure;
  try {
    await runMediaProcess({ binary: path.resolve('processor.exe'), args: [] });
  } catch (error) {
    silentFailure = error;
  }
  if (silentFailure?.kind !== 'timeout') violations.push('Tiến trình im lặng không dừng bằng watchdog timeout.');

  const batchFailure = processFailure(
    silentFailure,
    new MockAppFailure('VIDEO_AUDIO_PREPARATION_FAILED', { groupNumber: 2, groupCount: 5 }),
    { groupNumber: 2, groupCount: 5 },
    'temporary',
  );
  if (batchFailure.code !== 'VIDEO_AUDIO_PREPARATION_TIMEOUT' || batchFailure.context?.groupNumber !== 2) {
    violations.push('Timeout chuẩn bị nhóm giọng không trả đúng code/context.');
  }

  const finalFailure = processFailure(
    silentFailure,
    new MockAppFailure('VIDEO_PROCESS_FAILED'),
    undefined,
    'output',
  );
  if (finalFailure.code !== 'VIDEO_COMPLETION_TIMEOUT') {
    violations.push('Timeout hoàn thiện video không trả đúng code.');
  }

  spawnMode = 'heartbeat';
  try {
    await runMediaProcess({ binary: path.resolve('processor.exe'), args: [] });
  } catch {
    violations.push('Tiến trình có heartbeat đều vẫn bị watchdog dừng nhầm.');
  }

  spawnMode = 'silent';
  let probeFailure;
  try {
    await runMediaProbe([], () => undefined);
  } catch (error) {
    probeFailure = error;
  }
  if (probeFailure?.kind !== 'timeout') violations.push('Probe im lặng không dừng bằng deadline.');

  for (const [code, context] of [
    ['VIDEO_SOURCE_VALIDATION_TIMEOUT', undefined],
    ['VIDEO_SEGMENT_AUDIO_VALIDATION_TIMEOUT', { segmentNumber: 3, segmentCount: 9 }],
    ['BACKGROUND_AUDIO_VALIDATION_TIMEOUT', undefined],
    ['VIDEO_OUTPUT_VALIDATION_TIMEOUT', undefined],
  ]) {
    const classified = probeInfrastructureFailure(probeFailure, code, context);
    if (classified?.code !== code) violations.push(`Probe timeout trả sai code ${code}.`);
    if (context && classified?.context?.segmentNumber !== context.segmentNumber) {
      violations.push('Probe timeout âm thanh không giữ đúng context câu.');
    }
  }
} finally {
  globalThis.setTimeout = nativeSetTimeout;
}

if (killCount < 2) violations.push('Watchdog không dừng đủ các tiến trình bị treo.');

if (violations.length) {
  console.error(`Kiểm tra watchdog video thất bại:\n${violations.map((item) => `- ${item}`).join('\n')}`);
  process.exit(1);
}

console.log('Kiểm tra watchdog video: đạt (inactivity, heartbeat, probe timeout và phân loại lỗi đạt).');
