import { readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

async function compile(file) {
  const source = await readFile(file, 'utf8');
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: file,
  }).outputText;
}

function evaluate(source) {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', source)((name) => {
    throw new Error(`Unexpected runtime dependency: ${name}`);
  }, module, module.exports);
  return module.exports;
}

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};

const voicePath = path.resolve('src/providers/voice/voiceReliability.ts');
const subtitlePath = path.resolve('src/shared/subtitleAlignment.ts');
const voice = evaluate(await compile(voicePath));
const subtitle = evaluate(await compile(subtitlePath));
const violations = [];

const naturalText = Array.from({ length: 100 }, (_, index) => `Câu kiểm tra ${index + 1}, cần được giữ nguyên nội dung.`).join(' ');
const denseText = '你'.repeat(4_000);
for (const [label, input, dense] of [['tự nhiên', naturalText, false], ['không khoảng trắng', denseText, true]]) {
  const parts = voice.splitVoiceText(input, 900);
  if (parts.length < 2 || parts.some((part) => !part || part.length > 900)) {
    violations.push(`Chia giọng ${label} tạo phần rỗng hoặc vượt giới hạn.`);
  }
  const rebuilt = dense ? parts.join('') : parts.join(' ').replace(/\s+/g, ' ').trim();
  const expected = dense ? input : input.replace(/\s+/g, ' ').trim();
  if (rebuilt !== expected) violations.push(`Chia giọng ${label} làm mất hoặc lặp nội dung.`);
}

const request = {
  projectId: 'p', segmentId: 's', text: naturalText, voiceId: 'v', modelId: 'm', language: 'vi',
  speed: 1, temperature: 0.5, stability: 0.5, similarityBoost: 0.5, style: 0,
  useSpeakerBoost: true, pitch: 0, volume: 100, deliveryMode: 'default',
};
const key = voice.voiceRequestKey(request, 'engine');
if (key !== voice.voiceRequestKey({ ...request }, 'engine')) violations.push('Khóa yêu cầu giọng không ổn định.');
if (key === voice.voiceRequestKey({ ...request, text: `${request.text}!` }, 'engine')) violations.push('Khóa yêu cầu giọng không đổi khi nội dung đổi.');
if (key === voice.voiceRequestKey({ ...request, speed: 1.1 }, 'engine')) violations.push('Khóa yêu cầu giọng không đổi khi thiết lập đổi.');

const checkpoint = voice.createVoiceCheckpoint(key, 3);
checkpoint.parts[0] = { index: 0, status: 'done', audioPath: 'safe-part.mp3', durationSec: 1 };
voice.saveVoiceCheckpoint('p', 's', checkpoint);
const restored = voice.loadVoiceCheckpoint('p', 's', key);
if (restored?.parts[0]?.status !== 'done' || restored.parts.length !== 3) violations.push('Checkpoint giọng không khôi phục đúng phần đã hoàn thành.');

const cancelled = new AbortController();
cancelled.abort();
try {
  await voice.retryDelay(1, cancelled.signal);
  violations.push('Khoảng chờ thử lại không dừng khi người dùng hủy.');
} catch (error) {
  if (error?.name !== 'AbortError') violations.push('Hủy khoảng chờ trả sai loại lỗi.');
}

const estimated = subtitle.estimateSubtitleTiming('Xin chào, đây là một câu kiểm tra.', 6);
if (!estimated.length || estimated[0].start !== 0 || Math.abs(estimated.at(-1).end - 6) > 0.001) {
  violations.push('Thời gian phụ đề ước lượng không phủ đủ tệp giọng.');
}
if (estimated.some((word, index) => word.end <= word.start || (index && word.start < estimated[index - 1].end - 0.001))) {
  violations.push('Thời gian phụ đề ước lượng bị chồng hoặc đi lùi.');
}
const cjk = subtitle.estimateSubtitleTiming('你好，世界！', 3);
if (cjk.length < 4 || Math.abs(cjk.at(-1).end - 3) > 0.001) violations.push('Fallback phụ đề không xử lý đúng nội dung không có khoảng trắng.');

globalThis.window = {
  gensuite: {
    whisper: { align: async () => ({ ok: false, error: { kind: 'app-error-v1' } }) },
  },
};
const fallback = await subtitle.alignSceneSubtitle({ id: 's', narration: 'Một câu cần fallback.', audioPath: 'a.mp3', audioDuration: 2 }, 'p');
if (fallback.quality !== 'estimated' || !fallback.words.length) violations.push('Căn phụ đề lỗi chưa tự chuyển sang thời gian ước lượng.');
window.gensuite.whisper.align = async () => ({ ok: true, value: [{ word: 'Khớp', start: 0, end: 1 }] });
const aligned = await subtitle.alignSceneSubtitle({ id: 's', narration: 'Khớp', audioPath: 'a.mp3', audioDuration: 1 }, 'p');
if (aligned.quality !== 'aligned' || aligned.words[0]?.word !== 'Khớp') violations.push('Kết quả căn phụ đề hợp lệ không được giữ lại.');

const sources = {
  audio: await readFile(path.resolve('electron/ipc/audio.ts'), 'utf8'),
  edge: await readFile(path.resolve('electron/ipc/edgetts.ts'), 'utf8'),
  whisper: await readFile(path.resolve('electron/ipc/whisper.ts'), 'utf8'),
  cloudVoice: await readFile(path.resolve('src/providers/voice/GenSuiteVoiceAdapter.ts'), 'utf8'),
  cloudStt: await readFile(path.resolve('src/providers/transcription/GenSuiteSttAdapter.ts'), 'utf8'),
};
if (!/appSuccess\(/u.test(sources.audio) || !/appFailureResult\(/u.test(sources.audio)) violations.push('IPC âm thanh chưa dùng hợp đồng kết quả có cấu trúc.');
if (!/appSuccess\(/u.test(sources.edge) || !/appFailureResult\(/u.test(sources.edge)) violations.push('IPC tạo giọng miễn phí chưa dùng hợp đồng lỗi có cấu trúc.');
if (!/checkpoint-/u.test(sources.whisper) || !/whisper:cancel/u.test(sources.whisper)) violations.push('Nhận dạng cục bộ thiếu checkpoint hoặc thao tác dừng.');
if (!/Idempotency-Key/u.test(sources.cloudVoice) || !/requestJson/u.test(sources.cloudVoice)) violations.push('Tạo giọng trực tuyến thiếu khóa chống lặp hoặc watchdog nội dung phản hồi.');
if (!/Idempotency-Key/u.test(sources.cloudStt) || !/TRANSCRIPTION_JOB_EXPIRED/u.test(sources.cloudStt)) violations.push('Nhận dạng trực tuyến thiếu khóa chống lặp hoặc phục hồi job hết hạn.');

if (violations.length) {
  console.error(`Kiểm tra độ bền media thất bại:\n${violations.map((item) => `- ${item}`).join('\n')}`);
  process.exit(1);
}

console.log('Kiểm tra độ bền media: đạt (chia nhỏ, checkpoint, hủy, fallback, lỗi có cấu trúc).');
