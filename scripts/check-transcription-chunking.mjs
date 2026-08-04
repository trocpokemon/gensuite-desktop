import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

const requireNode = createRequire(import.meta.url);
const sourcePath = path.resolve('electron/ipc/whisper.ts');
const source = await readFile(sourcePath, 'utf8');
const preloadSource = await readFile(path.resolve('electron/preload.ts'), 'utf8');
const adapterSource = await readFile(path.resolve('src/providers/transcription/LocalWhisperAdapter.ts'), 'utf8');
const studioSource = await readFile(path.resolve('src/steps/LocalizeStudio.tsx'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  fileName: sourcePath,
}).outputText + `
module.exports.__transcriptionChunkingTest = { buildTranscriptionChunks, mergeTranscriptionChunks };
`;

const module = { exports: {} };
new Function('require', 'module', 'exports', compiled)((name) => {
  if (name === 'electron') return {
    ipcMain: { handle: () => undefined },
    BrowserWindow: { fromWebContents: () => null },
    app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => process.cwd() },
  };
  if (name === 'node:child_process') return { spawn: () => { throw new Error('not used by chunk tests'); } };
  if (name === 'electron-log') return { error: () => undefined };
  if (name === './project') return { projectDir: () => process.cwd() };
  if (name === './ffmpeg') return { ffmpegBinary: () => path.resolve('resources/ffmpeg/ffmpeg.exe') };
  if (name === './appErrors') return {
    appFailure: () => new Error('not used by chunk tests'),
    appFailureResult: () => ({ ok: false }),
    appSuccess: (value) => ({ ok: true, value }),
  };
  return requireNode(name);
}, module, module.exports);

const { buildTranscriptionChunks, mergeTranscriptionChunks } = module.exports.__transcriptionChunkingTest;
const violations = [];
const duration = 1_205;
const chunks = buildTranscriptionChunks(duration);

if (chunks.length !== 21) violations.push(`Video 1.205 giây tạo ${chunks.length} phần thay vì 21.`);
if (chunks[0]?.coreStart !== 0 || chunks[0]?.windowStart !== 0) violations.push('Phần đầu không bắt đầu tại 0 giây.');
if (chunks.at(-1)?.coreEnd !== duration || chunks.at(-1)?.windowEnd !== duration) violations.push('Phần cuối không phủ tới hết video.');
if (chunks.some((chunk) => chunk.windowEnd - chunk.windowStart > 64.001)) violations.push('Có cửa sổ nhận dạng dài hơn 64 giây.');
for (let index = 1; index < chunks.length; index += 1) {
  if (chunks[index - 1].coreEnd !== chunks[index].coreStart) violations.push(`Mất độ phủ giữa phần ${index} và ${index + 1}.`);
  if (chunks[index].windowStart !== Math.max(0, chunks[index].coreStart - 2)) violations.push(`Phần ${index + 1} thiếu vùng chồng 2 giây.`);
}

const rows = chunks.map((chunk, index) => ({
  chunk,
  segments: [
    { id: `raw_${index}`, start: chunk.coreStart + 3, end: Math.min(chunk.coreEnd, chunk.coreStart + 5), text: `Câu ${index + 1}` },
  ],
}));
// Simulate a silent middle chunk and a final absolute timestamp near 20:05.
rows[8].segments = [];
rows.at(-1).segments = [{ id: 'tail', start: 1_202, end: 1_204, text: 'Câu cuối' }];
const merged = mergeTranscriptionChunks(rows, duration);
if (!merged.some((segment) => segment.end > 1_200 && segment.text === 'Câu cuối')) violations.push('Câu ở phần cuối video bị làm rơi.');
if (merged.some((segment, index) => segment.id !== `seg_${index}`)) violations.push('ID sau khi ghép không liên tục.');
if (!merged.every((segment, index) => index === 0 || segment.start >= merged[index - 1].start)) violations.push('Timeline sau khi ghép không tăng dần.');

if (!/'-ot'[\s\S]*'-d'/u.test(source)) violations.push('Tiến trình nền chưa giới hạn nhận dạng theo từng cửa sổ thời gian.');
if (!/Promise<IpcResult<TranscriptSegment\[\]>>/u.test(source)) violations.push('IPC nhận dạng chưa trả lỗi có cấu trúc.');
if (!/invokeStructured\('whisper:transcribe'/u.test(preloadSource)) violations.push('Bridge chưa kiểm tra payload nhận dạng.');
if (!/if \(!result\.ok\) throw result\.error/u.test(adapterSource)) violations.push('Adapter chưa chuyển lỗi có cấu trúc lên giao diện.');
if (!/transcriptionVersion === 2/u.test(studioSource)) violations.push('Dự án cũ vẫn có thể tái sử dụng dữ liệu nhận dạng thiếu.');

if (violations.length) {
  console.error(`Kiểm tra nhận dạng video dài thất bại:\n${violations.map((item) => `- ${item}`).join('\n')}`);
  process.exit(1);
}
console.log(`Kiểm tra nhận dạng video dài: đạt (${chunks.length} phần, phủ đủ ${duration} giây, giữ phần cuối).`);
