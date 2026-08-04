import { BrowserWindow, ipcMain } from 'electron';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  NarrationAnalyzeArgs,
  NarrationAnalyzeResult,
  NarrationCue,
  NarrationProgress,
  NarrationProgressPhase,
  NarrationRewriteArgs,
  NarrationRewriteResult,
  NarrationAudience,
  NarrationLanguage,
  NarrationDensity,
  SemanticBeat,
  ShotBoundary,
  ShotManifest,
} from '../../src/shared/types';
import { ffmpegBinary, ffprobeBinary } from './ffmpeg';
import { projectDir } from './project';
import { readSettings } from './settings';

const MODEL = 'gemini-3.1-flash-lite';
const MAX_SHOTS = 240;
const MAX_GAPS_PER_REQUEST = 16;

const DENSITY_RULES: Record<NarrationDensity, { maxShotMs: number; maxGapMs: number; targetCoverage: number }> = {
  sparse: { maxShotMs: 14_000, maxGapMs: 10_000, targetCoverage: 0.45 },
  balanced: { maxShotMs: 9_000, maxGapMs: 6_000, targetCoverage: 0.62 },
  dense: { maxShotMs: 6_000, maxGapMs: 3_000, targetCoverage: 0.74 },
};

interface FileRecord {
  name?: string;
  uri?: string;
  state?: string;
  error?: unknown;
}

interface AnalysisBeat {
  shotNumbers?: unknown;
  description?: unknown;
  importance?: unknown;
  confidence?: unknown;
  narration?: unknown;
}

interface AnalysisPayload {
  summary?: unknown;
  beats?: unknown;
}

const LANGUAGE_LABELS: Record<NarrationLanguage, string> = {
  'vi-VN': 'Vietnamese (Tiếng Việt)',
  'en-US': 'English (United States)',
  'zh-CN': 'Simplified Chinese (简体中文)',
  'ja-JP': 'Japanese (日本語)',
  'ko-KR': 'Korean (한국어)',
  'th-TH': 'Thai (ภาษาไทย)',
  'id-ID': 'Indonesian (Bahasa Indonesia)',
};

const AUDIENCE_LABELS: Record<NarrationAudience, string> = {
  VN: 'Vietnam', US: 'United States', CN: 'China', JP: 'Japan', KR: 'South Korea', TH: 'Thailand', ID: 'Indonesia',
};

function safeLanguage(value: unknown): NarrationLanguage {
  return typeof value === 'string' && value in LANGUAGE_LABELS ? value as NarrationLanguage : 'vi-VN';
}

function safeAudience(value: unknown): NarrationAudience {
  return typeof value === 'string' && value in AUDIENCE_LABELS ? value as NarrationAudience : 'VN';
}

function safeDensity(value: unknown): NarrationDensity {
  return value === 'sparse' || value === 'balanced' || value === 'dense' ? value : 'dense';
}

function emit(win: BrowserWindow | null, projectId: string, phase: NarrationProgressPhase, percent: number): void {
  const progress: NarrationProgress = { projectId, phase, percent };
  win?.webContents.send('narration:progress', progress);
}

function ensureProjectSource(projectId: string, sourceVideoPath: string): string {
  if (!/^[a-z0-9_-]+$/i.test(projectId)) throw new Error('NARRATION_SOURCE_INVALID');
  const root = path.resolve(projectDir(projectId));
  const source = path.resolve(sourceVideoPath);
  if (source !== root && !source.startsWith(`${root}${path.sep}`)) throw new Error('NARRATION_SOURCE_INVALID');
  return source;
}

function mediaType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.webm') return 'video/webm';
  if (ext === '.avi') return 'video/x-msvideo';
  if (ext === '.mpeg' || ext === '.mpg') return 'video/mpeg';
  return 'video/mp4';
}

async function probeDurationMs(source: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const binary = ffprobeBinary();
    const child = spawn(binary, [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', source,
    ], { cwd: path.dirname(binary), stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.on('error', () => reject(new Error('NARRATION_SOURCE_INVALID')));
    child.on('close', (code) => {
      const seconds = Number.parseFloat(stdout.trim());
      if (code === 0 && Number.isFinite(seconds) && seconds > 0) resolve(Math.round(seconds * 1000));
      else reject(new Error('NARRATION_SOURCE_INVALID'));
    });
  });
}

async function fingerprint(source: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(source);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function normalizeBoundaries(raw: number[], durationMs: number): number[] {
  const sorted = [0, ...raw, durationMs]
    .map((value) => Math.max(0, Math.min(durationMs, Math.round(value))))
    .sort((a, b) => a - b);
  const spaced: number[] = [];
  for (const value of sorted) {
    if (!spaced.length || value - spaced[spaced.length - 1] >= 650 || value === durationMs) {
      if (value === durationMs && spaced.at(-1) === durationMs) continue;
      spaced.push(value);
    }
  }
  if (spaced.at(-1) !== durationMs) spaced.push(durationMs);
  if (spaced.length <= MAX_SHOTS + 1) return spaced;
  const stride = Math.ceil((spaced.length - 1) / MAX_SHOTS);
  return spaced.filter((_value, index) => index === 0 || index === spaced.length - 1 || index % stride === 0);
}

async function detectShots(source: string, durationMs: number, density: NarrationDensity): Promise<ShotBoundary[]> {
  const rawTimes = await new Promise<number[]>((resolve) => {
    const binary = ffmpegBinary();
    const child = spawn(binary, [
      '-hide_banner', '-nostdin', '-i', source,
      '-vf', 'select=gt(scene\\,0.28),showinfo',
      '-an', '-f', 'null', '-',
    ], { cwd: path.dirname(binary), stdio: ['ignore', 'ignore', 'pipe'] });
    let buffer = '';
    const times: number[] = [];
    child.stderr?.on('data', (chunk) => {
      buffer += String(chunk);
      const matches = [...buffer.matchAll(/pts_time:([0-9]+(?:\.[0-9]+)?)/g)];
      for (const match of matches) times.push(Number.parseFloat(match[1]) * 1000);
      buffer = buffer.slice(-512);
    });
    child.on('error', () => resolve([]));
    child.on('close', () => resolve(times.filter(Number.isFinite)));
  });
  const boundaries = normalizeBoundaries(rawTimes, durationMs);
  const technicalShots: ShotBoundary[] = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const startMs = boundaries[index];
    const endMs = boundaries[index + 1];
    if (endMs > startMs) technicalShots.push({ id: '', startMs, endMs });
  }
  const base = technicalShots.length ? technicalShots : [{ id: '', startMs: 0, endMs: durationMs }];
  const maxShotMs = DENSITY_RULES[density].maxShotMs;
  const split = base.flatMap((shot) => {
    const count = Math.max(1, Math.ceil((shot.endMs - shot.startMs) / maxShotMs));
    return Array.from({ length: count }, (_unused, index) => ({
      id: '',
      startMs: Math.round(shot.startMs + ((shot.endMs - shot.startMs) * index) / count),
      endMs: Math.round(shot.startMs + ((shot.endMs - shot.startMs) * (index + 1)) / count),
    }));
  });
  const stride = Math.max(1, Math.ceil(split.length / MAX_SHOTS));
  const capped = stride === 1 ? split : Array.from({ length: Math.ceil(split.length / stride) }, (_unused, index) => {
    const group = split.slice(index * stride, (index + 1) * stride);
    return { id: '', startMs: group[0].startMs, endMs: group[group.length - 1].endMs };
  });
  return capped.map((shot, index) => ({ ...shot, id: `shot_${String(index + 1).padStart(3, '0')}` }));
}

async function startUpload(apiKey: string, source: string): Promise<string> {
  const stat = await fs.stat(source);
  const mime = mediaType(source);
  const response = await fetch('https://generativelanguage.googleapis.com/upload/v1beta/files', {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(stat.size),
      'X-Goog-Upload-Header-Content-Type': mime,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: path.basename(source) } }),
  });
  if (response.status === 400 || response.status === 403) throw new Error('MISSING_KEY:google');
  if (!response.ok) throw new Error('NARRATION_ANALYSIS_FAILED');
  const uploadUrl = response.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('NARRATION_ANALYSIS_FAILED');
  return uploadUrl;
}

async function uploadVideo(apiKey: string, source: string): Promise<FileRecord> {
  const stat = await fs.stat(source);
  const uploadUrl = await startUpload(apiKey, source);
  const body = createReadStream(source);
  const init = {
    method: 'POST',
    headers: {
      'Content-Length': String(stat.size),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    body,
    duplex: 'half',
  } as Parameters<typeof fetch>[1] & { duplex: 'half' };
  const response = await fetch(uploadUrl, init);
  if (response.status === 400 || response.status === 403) throw new Error('MISSING_KEY:google');
  if (!response.ok) throw new Error('NARRATION_ANALYSIS_FAILED');
  const payload = await response.json() as FileRecord | { file?: FileRecord };
  const record = (payload as { file?: FileRecord }).file ?? payload as FileRecord;
  if (!record.name) throw new Error('NARRATION_ANALYSIS_FAILED');
  return record;
}

async function waitUntilReady(apiKey: string, initial: FileRecord): Promise<FileRecord> {
  let record = initial;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    if (record.state === 'ACTIVE') return record;
    if (record.state === 'FAILED' || record.error) throw new Error('NARRATION_ANALYSIS_FAILED');
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/${record.name}`, {
      headers: { 'x-goog-api-key': apiKey },
    });
    if (!response.ok) throw new Error('NARRATION_ANALYSIS_FAILED');
    record = await response.json() as FileRecord;
  }
  throw new Error('NARRATION_ANALYSIS_FAILED');
}

function analysisPrompt(shots: ShotBoundary[], durationMs: number, language: NarrationLanguage, audience: NarrationAudience, density: NarrationDensity): string {
  const rows = shots.map((shot, index) => ({
    number: index + 1,
    startMs: shot.startMs,
    endMs: shot.endMs,
  }));
  return [
    `Bạn là biên tập viên thuyết minh video. Ngôn ngữ đầu ra bắt buộc: ${LANGUAGE_LABELS[language]}. Khán giả mục tiêu: ${AUDIENCE_LABELS[audience]}.`,
    'Ngôn ngữ xuất hiện trong video không phải ngôn ngữ đầu ra. Tuyệt đối không bắt chước ngôn ngữ nguồn.',
    'Mốc cảnh dưới đây được đo từ tệp nguồn và là nguồn thời gian duy nhất. Không tự tạo timestamp mới.',
    density === 'dense'
      ? 'Viết nhịp bình luận liên tục như video review: ưu tiên mỗi cửa sổ cảnh có lời, không gộp thành đoạn quá dài và không để khoảng im lặng quá 3 giây.'
      : density === 'balanced'
        ? 'Gộp cảnh khi thật sự cùng một hành động, giữ nhịp bình luận đều và chỉ để khoảng nghỉ ngắn có chủ đích.'
        : 'Gộp các cảnh kỹ thuật liên tiếp thành những nhịp nội dung có ý nghĩa; có thể để narration rỗng khi hình ảnh tự kể được câu chuyện.',
    `Mục tiêu lời đọc phủ khoảng ${Math.round(DENSITY_RULES[density].targetCoverage * 100)}% thời lượng. Mô tả hành động, thay đổi, chi tiết đáng chú ý và thêm câu nối tự nhiên nhưng không lặp ý.`,
    `Lời đọc phải tự nhiên với người xem tại ${AUDIENCE_LABELS[audience]}, không bịa tên riêng hay sự kiện không nhìn thấy. Mỗi giây chỉ nên có tối đa khoảng 2.7 từ để còn khoảng nghỉ.`,
    `Tổng thời lượng: ${durationMs} ms. Danh sách cảnh: ${JSON.stringify(rows)}`,
    'Trả về summary ngắn và beats theo đúng cấu trúc đã yêu cầu.',
  ].join('\n');
}

async function analyzeRemote(apiKey: string, file: FileRecord, mime: string, shots: ShotBoundary[], durationMs: number, language: NarrationLanguage, audience: NarrationAudience, density: NarrationDensity): Promise<AnalysisPayload> {
  if (!file.uri) throw new Error('NARRATION_ANALYSIS_FAILED');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [
        { file_data: { mime_type: mime, file_uri: file.uri } },
        { text: analysisPrompt(shots, durationMs, language, audience, density) },
      ] }],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.45,
        responseSchema: {
          type: 'OBJECT',
          required: ['summary', 'beats'],
          properties: {
            summary: { type: 'STRING' },
            beats: {
              type: 'ARRAY',
              items: {
                type: 'OBJECT',
                required: ['shotNumbers', 'description', 'importance', 'confidence', 'narration'],
                properties: {
                  shotNumbers: { type: 'ARRAY', items: { type: 'INTEGER' } },
                  description: { type: 'STRING' },
                  importance: { type: 'NUMBER' },
                  confidence: { type: 'NUMBER' },
                  narration: { type: 'STRING' },
                },
              },
            },
          },
        },
      },
    }),
  });
  if (response.status === 400 || response.status === 403) throw new Error('MISSING_KEY:google');
  if (!response.ok) throw new Error('NARRATION_ANALYSIS_FAILED');
  const data = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('').trim();
  if (!text) throw new Error('NARRATION_ANALYSIS_FAILED');
  try { return JSON.parse(text) as AnalysisPayload; } catch { throw new Error('NARRATION_ANALYSIS_FAILED'); }
}

async function normalizeAnalysisLanguage(apiKey: string, payload: AnalysisPayload, language: NarrationLanguage, audience: NarrationAudience): Promise<AnalysisPayload> {
  const prompt = [
    `Chuẩn hóa toàn bộ nội dung hướng tới người xem sang ${LANGUAGE_LABELS[language]} cho khán giả tại ${AUDIENCE_LABELS[audience]}.`,
    'Đây là yêu cầu bắt buộc, bất kể ngôn ngữ của dữ liệu đầu vào.',
    'Chỉ viết lại summary, description và narration. Giữ nguyên tuyệt đối shotNumbers, importance, confidence, thứ tự và số lượng beats.',
    'Văn phong tự nhiên như người bản địa đang review video; không dịch cứng, không thêm dữ kiện.',
    `Dữ liệu cần chuẩn hóa: ${JSON.stringify(payload)}`,
  ].join('\n');
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.2,
        responseSchema: {
          type: 'OBJECT',
          required: ['summary', 'beats'],
          properties: {
            summary: { type: 'STRING' },
            beats: { type: 'ARRAY', items: { type: 'OBJECT', required: ['shotNumbers', 'description', 'importance', 'confidence', 'narration'], properties: {
              shotNumbers: { type: 'ARRAY', items: { type: 'INTEGER' } }, description: { type: 'STRING' },
              importance: { type: 'NUMBER' }, confidence: { type: 'NUMBER' }, narration: { type: 'STRING' },
            } } },
          },
        },
      },
    }),
  });
  if (response.status === 400 || response.status === 403) throw new Error('MISSING_KEY:google');
  if (!response.ok) throw new Error('NARRATION_ANALYSIS_FAILED');
  const data = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const raw = data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('').trim();
  if (!raw) throw new Error('NARRATION_ANALYSIS_FAILED');
  try { return JSON.parse(raw) as AnalysisPayload; } catch { throw new Error('NARRATION_ANALYSIS_FAILED'); }
}

function clamp01(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback;
}

function buildResults(payload: AnalysisPayload, shots: ShotBoundary[]): { summary: string; beats: SemanticBeat[]; cues: NarrationCue[] } {
  const rows = Array.isArray(payload.beats) ? payload.beats as AnalysisBeat[] : [];
  const beats: SemanticBeat[] = [];
  const cues: NarrationCue[] = [];
  for (const row of rows) {
    const numbers = Array.isArray(row.shotNumbers)
      ? [...new Set(row.shotNumbers.map(Number).filter((value) => Number.isInteger(value) && value >= 1 && value <= shots.length))].sort((a, b) => a - b)
      : [];
    if (!numbers.length) continue;
    const selected = numbers.map((number) => shots[number - 1]);
    const startMs = Math.min(...selected.map((shot) => shot.startMs));
    const endMs = Math.max(...selected.map((shot) => shot.endMs));
    const beat: SemanticBeat = {
      id: `beat_${String(beats.length + 1).padStart(3, '0')}`,
      shotIds: selected.map((shot) => shot.id),
      startMs,
      endMs,
      description: String(row.description ?? '').trim() || 'Diễn biến trong video',
      importance: clamp01(row.importance, 0.5),
      confidence: clamp01(row.confidence, 0.5),
    };
    beats.push(beat);
    const narration = String(row.narration ?? '').replace(/\s+/g, ' ').trim();
    if (!narration) continue;
    const availableMs = Math.max(1000, endMs - startMs);
    cues.push({
      id: `cue_${String(cues.length + 1).padStart(3, '0')}`,
      beatIds: [beat.id],
      windowStartMs: startMs,
      windowEndMs: endMs,
      preferredStartMs: startMs + Math.min(350, Math.round(availableMs * 0.08)),
      text: narration,
      maxDurationMs: Math.max(800, availableMs - Math.min(700, Math.round(availableMs * 0.12))),
      priority: Math.round(beat.importance * 100),
      revision: 1,
      fitStatus: 'pending',
    });
  }
  if (!beats.length) throw new Error('NARRATION_ANALYSIS_FAILED');
  const summary = String(payload.summary ?? '').trim() || 'Video đã được phân tích và chia thành các diễn biến chính.';
  if (!cues.length) {
    const beat = [...beats].sort((a, b) => b.importance - a.importance)[0];
    const availableMs = Math.max(1000, beat.endMs - beat.startMs);
    cues.push({
      id: 'cue_001',
      beatIds: [beat.id],
      windowStartMs: beat.startMs,
      windowEndMs: beat.endMs,
      preferredStartMs: beat.startMs + Math.min(350, Math.round(availableMs * 0.08)),
      text: summary,
      maxDurationMs: Math.max(800, availableMs - Math.min(700, Math.round(availableMs * 0.12))),
      priority: Math.round(beat.importance * 100),
      revision: 1,
      fitStatus: 'pending',
    });
  }
  return {
    summary,
    beats,
    cues,
  };
}

interface NarrationGap { startMs: number; endMs: number; shotNumbers: number[] }

function estimatedSpeechEnd(cue: NarrationCue): number {
  const words = cue.text.trim().split(/\s+/).filter(Boolean).length;
  return Math.min(cue.windowEndMs, cue.preferredStartMs + Math.max(700, Math.round((words / 2.7) * 1000)));
}

function findNarrationGaps(cues: NarrationCue[], shots: ShotBoundary[], durationMs: number, density: NarrationDensity): NarrationGap[] {
  const maxGapMs = DENSITY_RULES[density].maxGapMs;
  const intervals = cues
    .map((cue) => ({ startMs: cue.preferredStartMs, endMs: estimatedSpeechEnd(cue) }))
    .filter((item) => item.endMs > item.startMs)
    .sort((a, b) => a.startMs - b.startMs);
  const merged: Array<{ startMs: number; endMs: number }> = [];
  for (const interval of intervals) {
    const previous = merged.at(-1);
    if (previous && interval.startMs <= previous.endMs + 250) previous.endMs = Math.max(previous.endMs, interval.endMs);
    else merged.push({ ...interval });
  }
  const raw: Array<{ startMs: number; endMs: number }> = [];
  let cursor = 0;
  for (const interval of merged) {
    if (interval.startMs - cursor > maxGapMs) raw.push({ startMs: cursor, endMs: interval.startMs });
    cursor = Math.max(cursor, interval.endMs);
  }
  if (durationMs - cursor > maxGapMs) raw.push({ startMs: cursor, endMs: durationMs });
  const maximumWindowMs = Math.max(2_000, maxGapMs * 2);
  const windows = raw.flatMap((gap) => {
    const count = Math.max(1, Math.ceil((gap.endMs - gap.startMs) / maximumWindowMs));
    return Array.from({ length: count }, (_unused, index) => ({
      startMs: Math.round(gap.startMs + ((gap.endMs - gap.startMs) * index) / count),
      endMs: Math.round(gap.startMs + ((gap.endMs - gap.startMs) * (index + 1)) / count),
    }));
  });
  return windows.map((gap) => ({
    ...gap,
    shotNumbers: shots.flatMap((shot, index) => shot.endMs > gap.startMs && shot.startMs < gap.endMs ? [index + 1] : []),
  })).filter((gap) => gap.shotNumbers.length > 0);
}

interface NarrationGapFill {
  gapIndex: number;
  description: string;
  narration: string;
}

interface IndexedNarrationGap extends NarrationGap {
  gapIndex: number;
}

async function requestNarrationGapFills(
  apiKey: string,
  file: FileRecord,
  mime: string,
  gaps: IndexedNarrationGap[],
  existingCues: NarrationCue[],
  language: NarrationLanguage,
  audience: NarrationAudience,
): Promise<NarrationGapFill[]> {
  if (!file.uri || !gaps.length) return [];
  const rangeStart = Math.min(...gaps.map((gap) => gap.startMs));
  const rangeEnd = Math.max(...gaps.map((gap) => gap.endMs));
  const nearbyContext = existingCues
    .filter((cue) => cue.windowEndMs >= rangeStart - 15_000 && cue.preferredStartMs <= rangeEnd + 15_000)
    .slice(0, 40)
    .map((cue) => ({ startMs: cue.preferredStartMs, endMs: cue.windowEndMs, text: cue.text }));
  const prompt = [
    `Bổ sung lời bình bằng ${LANGUAGE_LABELS[language]} tự nhiên cho khán giả tại ${AUDIENCE_LABELS[audience]}.`,
    'Hãy xem chính xác từng khoảng thời gian được liệt kê, tìm hành động hoặc chi tiết hình ảnh đang bị bỏ lỡ và viết một câu nối tiếp mạch review.',
    'Mỗi khoảng phải có đúng một kết quả với nguyên gapIndex. Không lặp lại lời đã có, không bịa thông tin ngoài hình ảnh, không dùng ngôn ngữ xuất hiện trong video.',
    'Câu phải vừa khoảng thời gian với tốc độ tối đa 2.7 từ mỗi giây và chừa khoảng nghỉ ngắn.',
    `Các khoảng cần bổ sung: ${JSON.stringify(gaps.map((gap) => ({ ...gap, availableMs: gap.endMs - gap.startMs })))}`,
    `Lời lân cận để tránh lặp: ${JSON.stringify(nearbyContext)}`,
  ].join('\n');
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [
        { file_data: { mime_type: mime, file_uri: file.uri } },
        { text: prompt },
      ] }],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.4,
        responseSchema: {
          type: 'OBJECT', required: ['fills'], properties: {
            fills: { type: 'ARRAY', items: { type: 'OBJECT', required: ['gapIndex', 'description', 'narration'], properties: {
              gapIndex: { type: 'INTEGER' }, description: { type: 'STRING' }, narration: { type: 'STRING' },
            } } },
          },
        },
      },
    }),
  });
  if (response.status === 400 || response.status === 403) throw new Error('MISSING_KEY:google');
  if (!response.ok) throw new Error('NARRATION_ANALYSIS_FAILED');
  const data = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const raw = data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('').trim();
  if (!raw) return [];
  try {
    const fills = (JSON.parse(raw) as { fills?: unknown }).fills;
    if (!Array.isArray(fills)) return [];
    const expectedIndexes = new Set(gaps.map((gap) => gap.gapIndex));
    return fills.flatMap((item) => {
      const row = item as { gapIndex?: unknown; description?: unknown; narration?: unknown };
      const gapIndex = Number(row.gapIndex);
      const narration = String(row.narration ?? '').replace(/\s+/g, ' ').trim();
      if (!Number.isInteger(gapIndex) || !expectedIndexes.has(gapIndex) || !narration) return [];
      return [{ gapIndex, description: String(row.description ?? '').trim() || 'Chi tiết bổ sung', narration }];
    });
  } catch {
    return [];
  }
}

async function fillNarrationGaps(
  apiKey: string,
  file: FileRecord,
  mime: string,
  gaps: NarrationGap[],
  existingCues: NarrationCue[],
  language: NarrationLanguage,
  audience: NarrationAudience,
): Promise<NarrationGapFill[]> {
  if (!file.uri || !gaps.length) return [];
  const completed = new Map<number, NarrationGapFill>();
  for (let offset = 0; offset < gaps.length; offset += MAX_GAPS_PER_REQUEST) {
    const batch = gaps.slice(offset, offset + MAX_GAPS_PER_REQUEST)
      .map((gap, index) => ({ ...gap, gapIndex: offset + index }));
    const firstAttempt = await requestNarrationGapFills(apiKey, file, mime, batch, existingCues, language, audience);
    firstAttempt.forEach((fill) => completed.set(fill.gapIndex, fill));

    const missing = batch.filter((gap) => !completed.has(gap.gapIndex));
    if (missing.length) {
      const retry = await requestNarrationGapFills(apiKey, file, mime, missing, existingCues, language, audience);
      retry.forEach((fill) => completed.set(fill.gapIndex, fill));
    }
    if (batch.some((gap) => !completed.has(gap.gapIndex))) {
      throw new Error('NARRATION_ANALYSIS_FAILED');
    }
  }
  return [...completed.values()].sort((left, right) => left.gapIndex - right.gapIndex);
}

function appendGapFills(
  beats: SemanticBeat[], cues: NarrationCue[], gaps: NarrationGap[], fills: Array<{ gapIndex: number; description: string; narration: string }>, shots: ShotBoundary[],
): { beats: SemanticBeat[]; cues: NarrationCue[] } {
  const nextBeats = [...beats];
  const nextCues = [...cues];
  for (const fill of fills) {
    const gap = gaps[fill.gapIndex];
    if (!gap) continue;
    const beatId = `beat_${String(nextBeats.length + 1).padStart(3, '0')}`;
    const selected = gap.shotNumbers.map((number) => shots[number - 1]).filter(Boolean);
    nextBeats.push({ id: beatId, shotIds: selected.map((shot) => shot.id), startMs: gap.startMs, endMs: gap.endMs, description: fill.description, importance: 0.6, confidence: 0.75 });
    const padding = Math.min(300, Math.round((gap.endMs - gap.startMs) * 0.05));
    nextCues.push({
      id: `cue_${String(nextCues.length + 1).padStart(3, '0')}`,
      beatIds: [beatId], windowStartMs: gap.startMs, windowEndMs: gap.endMs,
      preferredStartMs: gap.startMs + padding, text: fill.narration,
      maxDurationMs: Math.max(800, gap.endMs - gap.startMs - padding * 2), priority: 60, revision: 1, fitStatus: 'pending',
    });
  }
  nextBeats.sort((a, b) => a.startMs - b.startMs);
  nextCues.sort((a, b) => a.preferredStartMs - b.preferredStartMs);
  return { beats: nextBeats, cues: nextCues };
}

function scheduleNarrationCues(cues: NarrationCue[], durationMs: number, density: NarrationDensity): NarrationCue[] {
  const pauseMs = density === 'dense' ? 350 : density === 'balanced' ? 550 : 800;
  const minWindowMs = 1_400;
  let scheduled = [...cues].sort((a, b) => a.preferredStartMs - b.preferredStartMs || b.priority - a.priority);
  for (let pass = 0; pass < 3; pass += 1) {
    const next = scheduled.flatMap((cue, index) => {
      const followingStart = scheduled[index + 1]?.preferredStartMs ?? durationMs;
      const windowEndMs = Math.min(cue.windowEndMs, followingStart - pauseMs, durationMs);
      if (windowEndMs - cue.preferredStartMs < minWindowMs) return [];
      return [{ ...cue, windowStartMs: cue.preferredStartMs, windowEndMs, maxDurationMs: windowEndMs - cue.preferredStartMs }];
    });
    if (next.length === scheduled.length) { scheduled = next; break; }
    scheduled = next;
  }
  if (!scheduled.length && cues[0] && durationMs >= 800) {
    const cue = [...cues].sort((a, b) => b.priority - a.priority)[0];
    scheduled = [{ ...cue, windowStartMs: 0, preferredStartMs: 0, windowEndMs: durationMs, maxDurationMs: durationMs }];
  }
  return scheduled.map((cue, index) => ({ ...cue, id: `cue_${String(index + 1).padStart(3, '0')}` }));
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(temp, filePath);
}

async function removeRemoteFile(apiKey: string, file?: FileRecord): Promise<void> {
  if (!file?.name) return;
  await fetch(`https://generativelanguage.googleapis.com/v1beta/${file.name}`, {
    method: 'DELETE',
    headers: { 'x-goog-api-key': apiKey },
  }).catch(() => undefined);
}

async function rewriteToFit(apiKey: string, args: NarrationRewriteArgs): Promise<NarrationRewriteResult> {
  const text = String(args?.text ?? '').replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('NARRATION_ANALYSIS_FAILED');
  const actualMs = Math.max(1, Number(args.actualDurationMs) || 1);
  const targetMs = Math.max(800, Number(args.targetDurationMs) || 800);
  const words = text.split(/\s+/).length;
  const mode = args.mode === 'expand' ? 'expand' : 'shorten';
  const targetWords = mode === 'expand'
    ? Math.max(words + 2, Math.round(words * (targetMs / actualMs) * 0.9))
    : Math.max(3, Math.floor(words * (targetMs / actualMs) * 0.9));
  const language = safeLanguage(args.targetLanguage);
  const audience = safeAudience(args.targetAudience);
  const prompt = [
    `${mode === 'expand' ? 'Mở rộng' : 'Rút gọn'} lời thuyết minh dưới đây bằng ${LANGUAGE_LABELS[language]} cho khán giả tại ${AUDIENCE_LABELS[audience]}.`,
    'Không được đổi sang ngôn ngữ của video nguồn.',
    mode === 'expand'
      ? `Viết khoảng ${targetWords} từ. Bổ sung diễn biến hoặc câu nối chỉ từ ngữ cảnh đã cho; không bịa dữ kiện hay tên riêng.`
      : `Chỉ dùng tối đa ${targetWords} từ. Giữ đúng ý và dữ kiện nhìn thấy, không thêm tên riêng, không giải thích.`,
    'Ưu tiên câu gọn, có nhịp kể chuyện. Trả về duy nhất một trường text.',
    `Ngữ cảnh hình ảnh: ${String(args.context ?? '').slice(0, 1200)}`,
    `Lời hiện tại: ${text}`,
  ].join('\n');
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.25,
        responseSchema: {
          type: 'OBJECT',
          required: ['text'],
          properties: { text: { type: 'STRING' } },
        },
      },
    }),
  });
  if (response.status === 400 || response.status === 403) throw new Error('MISSING_KEY:google');
  if (!response.ok) throw new Error('NARRATION_ANALYSIS_FAILED');
  const data = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const raw = data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('').trim();
  if (!raw) throw new Error('NARRATION_ANALYSIS_FAILED');
  try {
    const rewritten = String((JSON.parse(raw) as { text?: unknown }).text ?? '').replace(/\s+/g, ' ').trim();
    if (!rewritten) throw new Error('NARRATION_ANALYSIS_FAILED');
    return { text: rewritten };
  } catch (error) {
    if (error instanceof Error && error.message === 'NARRATION_ANALYSIS_FAILED') throw error;
    throw new Error('NARRATION_ANALYSIS_FAILED');
  }
}

export function registerNarrationIpc(): void {
  ipcMain.handle('narration:analyze', async (event, args: NarrationAnalyzeArgs): Promise<NarrationAnalyzeResult> => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const projectId = String(args?.projectId ?? '');
    const source = ensureProjectSource(projectId, String(args?.sourceVideoPath ?? ''));
    const settings = await readSettings();
    const apiKey = settings.googleApiKey?.trim();
    if (!apiKey) throw new Error('MISSING_KEY:google');
    await fs.access(source).catch(() => { throw new Error('NARRATION_SOURCE_INVALID'); });

    let remoteFile: FileRecord | undefined;
    const targetLanguage = safeLanguage(args?.targetLanguage);
    const targetAudience = safeAudience(args?.targetAudience);
    const density = safeDensity(args?.density);
    try {
      emit(win, projectId, 'preparing', 5);
      const [durationMs, sourceFingerprint] = await Promise.all([probeDurationMs(source), fingerprint(source)]);
      emit(win, projectId, 'detecting-scenes', 18);
      const shots = await detectShots(source, durationMs, density);
      emit(win, projectId, 'understanding', 32);
      remoteFile = await uploadVideo(apiKey, source);
      remoteFile = await waitUntilReady(apiKey, remoteFile);
      emit(win, projectId, 'writing', 72);
      const analyzed = await analyzeRemote(apiKey, remoteFile, mediaType(source), shots, durationMs, targetLanguage, targetAudience, density);
      const payload = await normalizeAnalysisLanguage(apiKey, analyzed, targetLanguage, targetAudience);
      const initial = buildResults(payload, shots);
      const gaps = findNarrationGaps(initial.cues, shots, durationMs, density);
      const fills = density === 'sparse' ? [] : await fillNarrationGaps(apiKey, remoteFile, mediaType(source), gaps, initial.cues, targetLanguage, targetAudience);
      const enhanced = appendGapFills(initial.beats, initial.cues, gaps, fills, shots);
      const { summary } = initial;
      const { beats } = enhanced;
      const cues = scheduleNarrationCues(enhanced.cues, durationMs, density);

      const analysisDir = path.join(projectDir(projectId), 'analysis');
      const shotManifestPath = path.join(analysisDir, 'shots.v1.json');
      const semanticManifestPath = path.join(analysisDir, 'semantics.v1.json');
      const narrationPlanPath = path.join(analysisDir, 'narration-plan.v1.json');
      const manifest: ShotManifest = { schemaVersion: 1, sourceFingerprint, durationMs, shots };
      await Promise.all([
        writeJsonAtomic(shotManifestPath, manifest),
        writeJsonAtomic(semanticManifestPath, { schemaVersion: 1, sourceFingerprint, summary, density, beats }),
        writeJsonAtomic(narrationPlanPath, { schemaVersion: 1, sourceFingerprint, density, cues }),
      ]);
      emit(win, projectId, 'complete', 100);
      return { durationMs, sourceFingerprint, summary, shots, beats, cues, shotManifestPath, semanticManifestPath, narrationPlanPath };
    } catch (error) {
      if (error instanceof Error && (error.message.startsWith('MISSING_KEY:') || error.message.startsWith('NARRATION_'))) throw error;
      throw new Error('NARRATION_ANALYSIS_FAILED');
    } finally {
      await removeRemoteFile(apiKey, remoteFile);
    }
  });

  ipcMain.handle('narration:rewrite', async (_event, args: NarrationRewriteArgs): Promise<NarrationRewriteResult> => {
    const settings = await readSettings();
    const apiKey = settings.googleApiKey?.trim();
    if (!apiKey) throw new Error('MISSING_KEY:google');
    return rewriteToFit(apiKey, args);
  });
}
