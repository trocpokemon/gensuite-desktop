import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

const requireNode = createRequire(import.meta.url);
const compile = async (file) => ts.transpileModule(await readFile(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  fileName: file,
}).outputText;
const evaluate = (source, requireModule) => {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', source)(requireModule, module, module.exports);
  return module.exports;
};

const qualityPath = path.resolve('src/shared/transcriptQuality.ts');
const promptPath = path.resolve('src/providers/script/prompt.ts');
const reliabilityPath = path.resolve('src/providers/script/translationReliability.ts');
const quality = evaluate(await compile(qualityPath), requireNode);
const prompt = evaluate(await compile(promptPath), requireNode);
const memory = new Map();
globalThis.localStorage = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: (key) => memory.delete(key),
};
const reliability = evaluate(await compile(reliabilityPath), (name) => {
  if (name === '../../shared/transcriptQuality') return quality;
  if (name === '../clientAppError') return { clientAppError: (code) => ({ code }) };
  if (name === './prompt') return prompt;
  return requireNode(name);
});

const violations = [];
const longSegments = Array.from({ length: 70 }, (_, index) => ({
  id: `s${index}`, start: index, end: index + 0.8, text: `Câu nguồn ${index} ${'x'.repeat(100)}`,
}));
const batches = reliability.splitTranslationBatches(longSegments);
if (batches.length < 3 || batches.some((batch) => batch.segments.length > reliability.MAX_TRANSLATION_BATCH_SEGMENTS)) {
  violations.push('Video dài chưa được chia thành các lô dịch nhỏ có giới hạn.');
}
if (batches.some((batch) => batch.segments.reduce((sum, segment) => sum + segment.text.trim().length + 16, 0) > reliability.MAX_TRANSLATION_BATCH_CHARS)) {
  violations.push('Có lô dịch vượt giới hạn ký tự an toàn.');
}

const source = Array.from({ length: 8 }, (_, index) => ({
  id: `r${index}`, start: index, end: index + 0.8, text: `Nguồn khác nhau ${index}`,
}));
const collapsed = source.map((segment) => ({ ...segment, text: 'Thả ra' }));
if (!reliability.findTranslationCollapseRuns(source, collapsed).length) {
  violations.push('Không phát hiện chuỗi bản dịch bị sập thành cùng một câu.');
}
if (quality.transcriptHasAbnormalRepetition(collapsed) !== true
  || quality.transcriptHasAbnormalRepetition(source) !== false) {
  violations.push('Bộ phát hiện lặp nhận dạng phân loại sai chuỗi kiểm thử.');
}

let callCount = 0;
const progressEvents = [];
const translated = await reliability.translateSegmentsReliably({
  projectId: 'quality-test', segments: source, sourceLanguage: 'zh', targetLanguage: 'vi',
  onProgress: (progress) => progressEvents.push(progress),
}, 'test', async (translationPrompt) => {
  callCount += 1;
  const lines = translationPrompt.split(/\r?\n/).filter((line) => /^\d+\.\s/u.test(line));
  const table = {};
  lines.forEach((line, index) => {
    const value = line.replace(/^\d+\.\s*/u, '');
    table[String(index)] = lines.length > 1 ? 'Thả ra' : `Dịch ${value}`;
  });
  return JSON.stringify({ translations: table });
});
if (callCount <= 1 || reliability.findTranslationCollapseRuns(source, translated).length
  || new Set(translated.map((segment) => segment.text)).size !== translated.length) {
  violations.push('Bản dịch lặp chưa được tự động dịch lại theo từng câu.');
}
if (memory.size) violations.push('Checkpoint dịch chưa được dọn sau khi hoàn tất.');
if (!progressEvents.some((event) => event.phase === 'requesting')
  || progressEvents.at(-1)?.phase !== 'completed'
  || progressEvents.at(-1)?.completedSegments !== source.length) {
  violations.push('Dịch video không phát heartbeat và tiến độ hoàn tất theo số câu.');
}

let incompleteRejected = false;
try { prompt.parseTranslationJson('{"translations":{"0":"Một"}}', source.slice(0, 2)); }
catch (error) { incompleteRejected = error instanceof Error && error.message === 'TRANSLATION_RESULT_INCOMPLETE'; }
if (!incompleteRejected) violations.push('Bản dịch thiếu câu vẫn được chấp nhận hoặc âm thầm dùng văn bản gốc.');

if (violations.length) {
  console.error(`Kiểm tra độ bền bản dịch thất bại:\n${violations.map((item) => `- ${item}`).join('\n')}`);
  process.exit(1);
}
console.log(`Kiểm tra độ bền bản dịch: đạt (${batches.length} lô; phát hiện và sửa chuỗi lặp).`);
