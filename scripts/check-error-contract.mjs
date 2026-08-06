import { readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

async function compile(file) {
  const source = await readFile(file, 'utf8');
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: file,
  }).outputText;
}

function evaluateCommonJs(source, requireModule) {
  const module = { exports: {} };
  const execute = new Function('require', 'module', 'exports', source);
  execute(requireModule, module, module.exports);
  return module.exports;
}

const sharedPath = path.resolve('src/shared/appErrors.ts');
const errorsPath = path.resolve('src/providers/errors.ts');
const creditPromptPath = path.resolve('src/store/creditPromptStore.ts');
const shared = evaluateCommonJs(await compile(sharedPath), (name) => {
  throw new Error(`Unexpected dependency in shared error contract: ${name}`);
});
const createStore = (factory) => {
  let state;
  const set = (next) => { state = { ...state, ...(typeof next === 'function' ? next(state) : next) }; };
  const get = () => state;
  state = factory(set, get);
  const hook = () => state;
  hook.getState = get;
  return hook;
};
const creditPrompt = evaluateCommonJs(await compile(creditPromptPath), (name) => {
  if (name === 'zustand') return { create: createStore };
  throw new Error(`Unexpected dependency in credit prompt: ${name}`);
});
const errors = evaluateCommonJs(await compile(errorsPath), (name) => {
  if (name === '../shared/appErrors') return shared;
  if (name === '../store/creditPromptStore') return creditPrompt;
  if (name === '../shared/diagnosticSummary') return { rememberDiagnostic: () => undefined };
  throw new Error(`Unexpected dependency in error presentation: ${name}`);
});

const structured = errors.errorMessage({
  kind: 'app-error-v1',
  code: 'VIDEO_SEGMENT_AUDIO_UNAVAILABLE',
  stage: 'voice',
  cause: 'file-not-found',
  retryable: true,
  diagnosticId: 'GS-TEST1234',
  context: { segmentNumber: 7, segmentCount: 20 },
});
const chunkStructured = errors.errorMessage({
  kind: 'app-error-v1',
  code: 'VOICE_AUDIO_INVALID',
  ...shared.APP_ERROR_DEFINITIONS.VOICE_AUDIO_INVALID,
  diagnosticId: 'GS-CHUNK123',
  context: { chunkNumber: 2, chunkCount: 7 },
});
const wrappedSafe = errors.errorMessage(
  new Error("Error invoking remote method 'ffmpeg:redub': Error: Video nguồn không còn khả dụng. Hãy chọn lại video."),
);
const wrappedRaw = errors.errorMessage(
  new Error("Error invoking remote method 'ffmpeg:redub': Error: C:\\private\\project\\input.mp4 codec failed"),
);
const unknown = errors.errorMessage(new Error('socket exploded at internal endpoint'));
const unsafePayloadAccepted = shared.isPublicAppError({
  kind: 'app-error-v1',
  code: 'VIDEO_PROCESS_FAILED',
  stage: 'video-completion',
  cause: 'processing-failed',
  retryable: true,
  diagnosticId: 'GS-TEST1234',
  context: { path: 'C:\\private\\project.mp4' },
});
const extraRootFieldAccepted = shared.isPublicAppError({
  kind: 'app-error-v1',
  code: 'VIDEO_PROCESS_FAILED',
  stage: 'video-completion',
  cause: 'processing-failed',
  retryable: true,
  diagnosticId: 'GS-TEST1234',
  rawPath: 'C:\\private\\project.mp4',
});
const mismatchedDefinitionAccepted = shared.isPublicAppError({
  kind: 'app-error-v1',
  code: 'OUTPUT_STORAGE_FULL',
  stage: 'voice',
  cause: 'invalid-media',
  retryable: false,
  diagnosticId: 'GS-TEST1234',
});
const invalidSuccessValueAccepted = shared.isIpcResult(
  { ok: true, value: { rawPath: 'C:\\private\\project.mp4' } },
  (value) => value === null || typeof value === 'string',
);
const extraIpcFieldAccepted = shared.isIpcResult(
  { ok: true, value: 'ok.mp4', rawPath: 'C:\\private\\project.mp4' },
  (value) => value === null || typeof value === 'string',
);

const secretBearingMessages = [
  'Không mở được C:\\Temp\\a.mp4',
  'Không mở được \\\\server\\share\\a.mp4',
  'Không mở được file:///private/project.mp4',
  'Không mở được /private/project/input.mp4',
  'Không thể gọi api.private.local bằng khóa sk-live-SECRET123',
  'Chưa chọn giọng edge-tts.',
];
const leakedSecretMessages = secretBearingMessages.filter((message) => errors.errorMessage(new Error(message)) === message);
const cancellationRecognized = errors.isCancellationError(new Error('voice:cancelled'))
  && errors.isCancellationError(new Error('edgetts:killed'))
  && errors.isCancellationError(new Error('gensuite:cancelled'))
  && errors.isCancellationError({
    kind: 'app-error-v1',
    code: 'VOICE_CANCELLED',
    ...shared.APP_ERROR_DEFINITIONS.VOICE_CANCELLED,
    diagnosticId: 'GS-TEST1234',
  });
const cancellationDisplayed = errors.errorMessage(new Error('voice:cancelled'));
const unknownMissingKeyAccepted = errors.missingKeyService(new Error('MISSING_KEY:C:\\private\\secret'));
const unknownServiceLabel = errors.serviceLabel('C:\\private\\secret');
const creditsMessage = errors.errorMessage(new Error('INSUFFICIENT_CREDITS'));
const creditsPromptOpened = creditPrompt.useCreditPromptStore.getState().open;
creditPrompt.useCreditPromptStore.getState().close();
const unrelatedOpenedCreditsPrompt = creditPrompt.notifyIfInsufficientCredits(new Error('network unavailable'));

const missingStructuredPresenters = Object.entries(shared.APP_ERROR_DEFINITIONS).filter(([code, definition]) => {
  const message = errors.errorMessage({
    kind: 'app-error-v1',
    code,
    ...definition,
    diagnosticId: 'GS-TEST1234',
  });
  return !message.includes('GS-TEST1234') || message === 'Đã xảy ra lỗi khi xử lý. Vui lòng thử lại.';
});

const violations = [];
if (!structured.includes('câu 7/20') || !structured.includes('GS-TEST1234')) {
  violations.push('Lỗi có cấu trúc không giữ đúng câu và mã chẩn đoán.');
}
if (!chunkStructured.includes('phần 2/7') || !chunkStructured.includes('GS-CHUNK123')) {
  violations.push('Lỗi tạo giọng dài không giữ đúng phần và mã chẩn đoán.');
}
if (wrappedSafe.includes('ffmpeg') || !wrappedSafe.includes('Video nguồn không còn khả dụng')) {
  violations.push('Lỗi Việt hóa an toàn bị tên IPC ghi đè.');
}
if (/ffmpeg|codec|C:\\private/i.test(wrappedRaw)) {
  violations.push('Thông tin công nghệ hoặc đường dẫn lọt ra thông báo lỗi.');
}
if (/socket|endpoint/i.test(unknown)) {
  violations.push('Lỗi không biết chưa fail-closed.');
}
if (unsafePayloadAccepted) {
  violations.push('Payload lỗi chứa context ngoài whitelist vẫn được chấp nhận.');
}
if (extraRootFieldAccepted) {
  violations.push('Payload lỗi chứa field gốc ngoài whitelist vẫn được chấp nhận.');
}
if (mismatchedDefinitionAccepted) {
  violations.push('Payload có code/stage/cause/retryable mâu thuẫn vẫn được chấp nhận.');
}
if (invalidSuccessValueAccepted) {
  violations.push('IPC success chứa kiểu value không hợp lệ vẫn được chấp nhận.');
}
if (extraIpcFieldAccepted) {
  violations.push('IPC result chứa field ngoài hợp đồng vẫn được chấp nhận.');
}
if (leakedSecretMessages.length) {
  violations.push(`Thông tin nhạy cảm lọt qua lỗi legacy: ${leakedSecretMessages.length} trường hợp.`);
}
if (!cancellationRecognized || /voice:cancelled|edgetts:killed|gensuite:cancelled/.test(cancellationDisplayed)) {
  violations.push('Tín hiệu hủy chưa được nhận biết riêng hoặc bị hiển thị ra giao diện.');
}
if (unknownMissingKeyAccepted || /C:\\private/i.test(unknownServiceLabel)) {
  violations.push('Tên dịch vụ ngoài allowlist có thể làm lộ dữ liệu qua thông báo thiếu khóa.');
}
if (!creditsPromptOpened || !creditsMessage.includes('không đủ credits') || unrelatedOpenedCreditsPrompt) {
  violations.push('Lỗi thiếu credits chưa mở đúng thông báo bổ sung credits hoặc nhận nhầm lỗi khác.');
}
if (missingStructuredPresenters.length) {
  violations.push(`Thiếu nội dung hiển thị cho ${missingStructuredPresenters.length} mã lỗi có cấu trúc.`);
}

if (violations.length) {
  console.error(`Kiểm tra hợp đồng lỗi thất bại:\n${violations.map((item) => `- ${item}`).join('\n')}`);
  process.exit(1);
}

console.log('Kiểm tra hợp đồng lỗi: đạt.');
