import { readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

const sourcePath = path.resolve('src/store/updateStore.ts');
const versionPath = path.resolve('src/shared/version.ts');
const source = await readFile(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  fileName: sourcePath,
}).outputText;
const compiledVersion = ts.transpileModule(await readFile(versionPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  fileName: versionPath,
}).outputText;

const createStore = (factory) => {
  let state;
  const set = (next) => { state = { ...state, ...(typeof next === 'function' ? next(state) : next) }; };
  const get = () => state;
  state = factory(set, get);
  const hook = (selector) => selector ? selector(state) : state;
  hook.getState = get;
  return hook;
};

let statusListener;
let timeoutCallback;
let checkCalls = 0;
let clearedTimers = 0;
globalThis.window = {
  clearTimeout: () => { clearedTimers += 1; },
  setTimeout: (callback) => { timeoutCallback = callback; return 1; },
  gensuite: {
    updater: {
      check: () => { checkCalls += 1; },
      download: () => undefined,
      install: () => undefined,
      getStatus: async () => ({ kind: 'not-available' }),
      onStatus: (callback) => { statusListener = callback; return () => undefined; },
    },
  },
};

const module = { exports: {} };
new Function('require', 'module', 'exports', compiled)(
  (name) => name === 'zustand' ? { create: createStore } : (() => { throw new Error(`Unexpected dependency: ${name}`); })(),
  module,
  module.exports,
);

const store = module.exports.useUpdateStore;
store.getState().initialize();
await Promise.resolve();
store.getState().openChecker();
if (checkCalls !== 1 || store.getState().status.kind !== 'checking' || typeof timeoutCallback !== 'function') {
  throw new Error('Kiểm tra cập nhật không khởi động watchdog đúng cách.');
}

timeoutCallback();
if (store.getState().status.kind !== 'error' || !store.getState().dialogOpen) {
  throw new Error('Watchdog không kết thúc trạng thái kiểm tra bị treo.');
}

store.getState().openChecker();
statusListener({ kind: 'not-available' });
if (store.getState().status.kind !== 'not-available' || clearedTimers < 1) {
  throw new Error('Watchdog không được dọn khi nhận trạng thái hoàn tất.');
}

const versionModule = { exports: {} };
new Function('require', 'module', 'exports', compiledVersion)(() => undefined, versionModule, versionModule.exports);
if (!versionModule.exports.isNewerVersion('0.2.1', '0.2.0')
  || !versionModule.exports.isNewerVersion('v1.0.0', '0.9.9')
  || versionModule.exports.isNewerVersion('0.2.0', '0.2.0')
  || versionModule.exports.isNewerVersion('0.1.9', '0.2.0')) {
  throw new Error('So sánh phiên bản phát hành không chính xác.');
}

console.log('Kiểm tra cập nhật: đạt (timeout, thử lại và dọn watchdog).');
