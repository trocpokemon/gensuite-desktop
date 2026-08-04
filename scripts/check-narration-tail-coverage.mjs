import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

const requireNode = createRequire(import.meta.url);
const narrationPath = path.resolve('electron/ipc/narration.ts');
const narrationSource = await readFile(narrationPath, 'utf8');
const sharedTypesSource = await readFile(path.resolve('src/shared/types.ts'), 'utf8');
const studioSource = await readFile(path.resolve('src/steps/NarrationStudio.tsx'), 'utf8');
const compiled = ts.transpileModule(narrationSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
  fileName: narrationPath,
}).outputText + `
module.exports.__narrationTailCoverageTest = {
  findNarrationGaps,
  fillNarrationGaps,
  appendGapFills,
  scheduleNarrationCues,
};`;

const module = { exports: {} };
const execute = new Function('require', 'module', 'exports', compiled);
execute((name) => {
  if (name === 'electron') {
    return {
      ipcMain: { handle: () => undefined },
      BrowserWindow: { fromWebContents: () => null },
    };
  }
  if (name === './ffmpeg') {
    return {
      ffmpegBinary: () => path.resolve('resources/ffmpeg/ffmpeg.exe'),
      ffprobeBinary: () => path.resolve('resources/ffmpeg/ffprobe.exe'),
    };
  }
  if (name === './project') return { projectDir: () => process.cwd() };
  if (name === './settings') return { readSettings: async () => ({}) };
  return requireNode(name);
}, module, module.exports);

const {
  findNarrationGaps,
  fillNarrationGaps,
  appendGapFills,
  scheduleNarrationCues,
} = module.exports.__narrationTailCoverageTest;

const violations = [];

if (/raw\.slice\(0,\s*24\)/u.test(narrationSource)) {
  violations.push('Luồng tìm khoảng trống vẫn cắt cứng danh sách ở 24 mục.');
}

const analyzeResultType = sharedTypesSource.match(/export interface NarrationAnalyzeResult\s*\{([\s\S]*?)\n\}/u)?.[1] ?? '';
if (!/\bdurationMs\s*:\s*number\s*;/u.test(analyzeResultType)) {
  violations.push('Kết quả phân tích chưa trả thời lượng thật của video qua durationMs.');
}
const workflowType = sharedTypesSource.match(/export interface NarrationWorkflowState\s*\{([\s\S]*?)\n\}/u)?.[1] ?? '';
if (!/\bsourceDurationMs\s*\?\s*:\s*number\s*;/u.test(workflowType)) {
  violations.push('Dự án chưa lưu sourceDurationMs để kiểm tra độ phủ sau khi mở lại.');
}
if (!/return\s*\{[^}]*\bdurationMs\s*,[^}]*\}/su.test(narrationSource)) {
  violations.push('IPC phân tích chưa đưa durationMs vào payload trả về.');
}

const coverageBlock = studioSource.match(/function narrationCoverage\s*\(([\s\S]*?)\r?\n\}\r?\n\r?\ninterface NarrationStudioProps/u);
const coverageParameters = coverageBlock?.[1]?.split(')')[0] ?? '';
const coverageBody = coverageBlock?.[1] ?? '';
if (!/sourceDurationSec\s*:\s*number/u.test(coverageParameters)) {
  violations.push('narrationCoverage chưa nhận sourceDurationSec làm mốc timeline.');
}
if (!/timelineEnd\s*=\s*Math\.max\([^\n]*sourceDurationSec/u.test(coverageBody)) {
  violations.push('Độ phủ UI chưa dùng thời lượng video thật để tính phần đuôi.');
}
if (!/sourceDurationMs\s*:\s*result\.durationMs/u.test(studioSource)) {
  violations.push('Màn hình thuyết minh chưa lưu result.durationMs vào dự án.');
}
const derivesSourceDuration = /sourceDurationSec\s*=\s*[^;\n]*sourceDurationMs[^;\n]*\/\s*1000/u.test(studioSource);
const passesSourceDuration = /narrationCoverage\(project\.scenes,\s*narrationDensity,\s*sourceDurationSec\)/u.test(studioSource)
  || /narrationCoverage\(project\.scenes,\s*narrationDensity,\s*[^)]*sourceDurationMs/su.test(studioSource);
if (!derivesSourceDuration || !passesSourceDuration) {
  violations.push('Màn hình thuyết minh chưa truyền sourceDurationMs vào phép tính độ phủ.');
}

const durationMs = 180_000;
const shots = Array.from({ length: 60 }, (_, index) => ({
  id: `shot_${String(index + 1).padStart(3, '0')}`,
  startMs: index * 3_000,
  endMs: (index + 1) * 3_000,
}));
const existingCues = Array.from({ length: 30 }, (_, index) => {
  const startMs = 1_000 + index * 6_000;
  return {
    id: `cue_${String(index + 1).padStart(3, '0')}`,
    beatIds: [],
    windowStartMs: startMs,
    windowEndMs: Math.min(durationMs, startMs + 1_000),
    preferredStartMs: startMs,
    text: `Nhịp ${index + 1}`,
    maxDurationMs: 1_000,
    priority: 50,
    revision: 1,
    fitStatus: 'pending',
  };
});

const gaps = findNarrationGaps(existingCues, shots, durationMs, 'dense');
if (gaps.length <= 24) {
  violations.push(`Timeline 180 giây chỉ thu được ${gaps.length} khoảng; phần sau giới hạn 24 khoảng vẫn đang bị bỏ qua.`);
}
if (gaps.at(-1)?.endMs !== durationMs) {
  violations.push(`Khoảng cuối dừng ở ${gaps.at(-1)?.endMs ?? 'không có'} ms thay vì cuối video ${durationMs} ms.`);
}

// Reproduce the customer shape: many short cues in the first half, then no cue
// at all after roughly 90 seconds. The old 24-item cap discarded this tail.
const cutoffCues = Array.from({ length: 24 }, (_, index) => {
  const startMs = 1_000 + index * 3_750;
  return {
    id: `cutoff_${index + 1}`,
    beatIds: [],
    windowStartMs: startMs,
    windowEndMs: startMs + 1_000,
    preferredStartMs: startMs,
    text: `Nhịp ${index + 1}`,
    maxDurationMs: 1_000,
    priority: 50,
    revision: 1,
    fitStatus: 'pending',
  };
});
const cutoffGaps = findNarrationGaps(cutoffCues, shots, durationMs, 'dense');
if (!cutoffGaps.some((gap) => gap.startMs >= 170_000 && gap.endMs === durationMs)) {
  violations.push('Tình huống lời dừng ở khoảng 90 giây vẫn không tạo được khoảng bổ sung đến cuối video.');
}

const requestedBatches = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (_url, init = {}) => {
  const payload = JSON.parse(String(init.body ?? '{}'));
  const prompt = payload.contents?.[0]?.parts?.find((part) => typeof part?.text === 'string')?.text ?? '';
  const serialized = prompt.match(/Các khoảng cần bổ sung: (\[[^\n]*\])/u)?.[1];
  const requested = serialized ? JSON.parse(serialized) : [];
  requestedBatches.push(requested.map((gap) => Number(gap.gapIndex)));

  // The remote response deliberately accepts at most 24 items. A correct client
  // must split a larger timeline and preserve the original gap indexes.
  const accepted = requested.slice(0, 24);
  const fills = accepted.map((gap) => ({
    gapIndex: Number(gap.gapIndex),
    description: `Bổ sung khoảng ${gap.gapIndex}`,
    narration: `Lời bổ sung ${gap.gapIndex}`,
  }));
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ fills }) }] } }],
    }),
  };
};

let fills = [];
try {
  fills = await fillNarrationGaps(
    'test-key',
    { uri: 'mock://video' },
    'video/mp4',
    gaps,
    existingCues,
    'vi-VN',
    'VN',
  );
} finally {
  globalThis.fetch = originalFetch;
}

if (requestedBatches.length < 2) {
  violations.push(`Có ${gaps.length} khoảng nhưng chỉ gửi ${requestedBatches.length} nhóm; cần chia thành nhiều nhóm an toàn.`);
}
if (requestedBatches.some((batch) => batch.length > 24)) {
  violations.push('Có nhóm bổ sung vượt 24 khoảng và có thể bị cắt mất phần cuối.');
}
const filledIndexes = new Set(fills.map((fill) => fill.gapIndex));
if (fills.length !== gaps.length || filledIndexes.size !== gaps.length) {
  violations.push(`Chỉ nhận lại ${filledIndexes.size}/${gaps.length} khoảng bổ sung duy nhất.`);
}
if (!filledIndexes.has(gaps.length - 1)) {
  violations.push(`Không nhận lại lời cho khoảng cuối (chỉ số ${gaps.length - 1}).`);
}

const enhanced = appendGapFills([], existingCues, gaps, fills, shots);
const tailCue = enhanced.cues.find((cue) => cue.windowEndMs === durationMs && cue.text === `Lời bổ sung ${gaps.length - 1}`);
if (!tailCue) {
  violations.push('Lời bổ sung cuối không được gắn lại vào timeline đến hết video.');
}
const scheduled = scheduleNarrationCues(enhanced.cues, durationMs, 'dense');
const scheduledTail = scheduled.find((cue) => cue.windowEndMs >= durationMs - 1_000 && cue.text === `Lời bổ sung ${gaps.length - 1}`);
if (!scheduledTail) {
  violations.push('Bộ sắp lịch đã làm rơi lời bổ sung ở phần cuối video.');
}

if (violations.length) {
  console.error(`Kiểm tra độ phủ thuyết minh thất bại:\n${violations.map((item) => `- ${item}`).join('\n')}`);
  process.exit(1);
}

console.log(`Kiểm tra độ phủ thuyết minh: đạt (${gaps.length} khoảng, ${requestedBatches.length} nhóm, phần đuôi ${durationMs / 1000} giây được giữ).`);
