import { ipcMain, BrowserWindow, dialog, shell, app } from 'electron';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import log from 'electron-log';
import type { LocalizeAspectRatio, SubtitleConfig, SubtitleWordTiming } from '../../src/shared/types';
import { DEFAULT_SUBTITLE_CONFIG } from '../../src/shared/subtitlePresets';
import { projectDir } from './project';

// Video assembly via bundled FFmpeg. Builds a concat of image clips (one per
// scene, duration matched to its audio) muxed with the narration track.

type Scene = {
  id: string;
  imagePath: string;   // absolute path to chosen image or video in project dir
  visualType?: 'stock-image' | 'stock-video' | 'ai-image' | 'ai-video' | 'upload';
  audioPath: string;   // absolute path to segment audio
  durationSec: number; // measured audio duration
  narration?: string;  // caption text burned in when subtitles are enabled
  wordTimings?: SubtitleWordTiming[];
};

type ExportArgs = {
  projectId: string;
  scenes: Scene[];
  ratio: '16:9' | '9:16';
  fps?: number;
  subtitles?: boolean;
  subtitleConfig?: SubtitleConfig;
  musicPath?: string;
  musicVolume?: number;
};

type RedubSegment = {
  audioPath: string;   // absolute path to translated speech audio
  sourceStart: number; // seconds into the source video
  sourceEnd: number;   // seconds into the source video
  text: string;        // translated text, burned as a subtitle when requested
  wordTimings?: SubtitleWordTiming[];
};

type RedubArgs = {
  projectId: string;
  sourceVideoPath: string;
  segments: RedubSegment[];
  subtitles?: boolean;
  subtitleConfig?: SubtitleConfig;
  outputAspectRatio?: LocalizeAspectRatio;
  originalAudioVolume?: number;
  outputDirectory?: string;
  automaticOutputName?: string;
  revealOutput?: boolean;
};

export function ffmpegBinary(): string {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'resources', 'ffmpeg')
    : path.join(app.getAppPath(), 'resources', 'ffmpeg');
  return path.join(base, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
}

export function ffprobeBinary(): string {
  return path.join(path.dirname(ffmpegBinary()), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
}

async function probeDuration(audioPath: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(ffprobeBinary(), [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', audioPath,
    ], { cwd: path.dirname(ffprobeBinary()), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (data) => { stdout += String(data); });
    child.stderr?.on('data', (data) => { stderr += String(data); });
    child.on('error', () => reject(new Error('Không thể đọc thông tin tệp media.')));
    child.on('close', (code) => {
      const duration = Number.parseFloat(stdout.trim());
      if (code === 0 && Number.isFinite(duration) && duration > 0) resolve(duration);
      else reject(new Error('Không đọc được thời lượng audio.'));
    });
  });
}

function resolution(ratio: '16:9' | '9:16'): [number, number] {
  return ratio === '9:16' ? [1080, 1920] : [1920, 1080];
}

const CROSSFADE_SEC = 0.6;

type Motion = 'zoom-in' | 'zoom-out' | 'pan-left' | 'pan-right' | 'pan-up' | 'pan-down';

// Keep the "random" motion stable for a scene so exporting the same project
// again does not unexpectedly produce a different edit.
function motionForScene(sceneId: string): Motion {
  let hash = 2166136261;
  for (const char of sceneId) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  const motions: Motion[] = ['zoom-in', 'zoom-out', 'pan-left', 'pan-right', 'pan-up', 'pan-down'];
  return motions[(hash >>> 0) % motions.length];
}

function zoompanFilter(motion: Motion, frames: number, w: number, h: number, fps: number): string {
  const lastFrame = Math.max(1, frames - 1);
  // Smoothstep prevents an abrupt start/stop. Rendering the motion at 2x and
  // downscaling afterwards also gives zoompan sub-pixel-looking movement instead
  // of visibly holding and jumping between integer pixel coordinates.
  const linearProgress = `on/${lastFrame}`;
  const progress = `(${linearProgress})*(${linearProgress})*(3-2*(${linearProgress}))`;
  const centerX = 'iw/2-(iw/zoom/2)';
  const centerY = 'ih/2-(ih/zoom/2)';
  let z = '1.08';
  let x = centerX;
  let y = centerY;

  switch (motion) {
    case 'zoom-in':
      z = `1+0.10*${progress}`;
      break;
    case 'zoom-out':
      z = `1.10-0.10*${progress}`;
      break;
    case 'pan-left':
      x = `(iw-iw/zoom)*(1-${progress})`;
      break;
    case 'pan-right':
      x = `(iw-iw/zoom)*${progress}`;
      break;
    case 'pan-up':
      y = `(ih-ih/zoom)*(1-${progress})`;
      break;
    case 'pan-down':
      y = `(ih-ih/zoom)*${progress}`;
      break;
  }

  const renderW = w * 2;
  const renderH = h * 2;
  return `zoompan=z='${z}':x='${x}':y='${y}':d=${frames}:s=${renderW}x${renderH}:fps=${fps},` +
    `scale=${w}:${h}:flags=lanczos`;
}

// ASS timestamps are H:MM:SS.cc (centiseconds). libass clamps negatives.
function assTime(seconds: number): string {
  const total = Math.max(0, seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const cs = Math.round((total - Math.floor(total)) * 100);
  const cc = cs === 100 ? 99 : cs; // avoid rolling a full second on rounding
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cc).padStart(2, '0')}`;
}

// `{`/`}` open style-override blocks in ASS and would silently swallow text.
function assEscape(text: string): string {
  return text
    .replace(/[{}]/g, '')
    .replace(/\r\n|\r|\n/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

// ASS colours are &HAABBGGRR — alpha then *reversed* RGB (blue first). Alpha 00
// is fully opaque. Accepts '#RGB', '#RRGGBB' or 'RRGGBB'.
function hexToAssColor(hex: string): string {
  let value = hex.trim().replace(/^#/, '');
  if (value.length === 3) value = value.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(value)) value = 'FFFFFF';
  const r = value.slice(0, 2);
  const g = value.slice(2, 4);
  const b = value.slice(4, 6);
  return `&H00${b}${g}${r}`.toUpperCase();
}

function hexToAssColorWithOpacity(hex: string, opacityPct: number): string {
  const base = hexToAssColor(hex);
  const alpha = Math.round(255 * (1 - Math.max(0, Math.min(100, opacityPct)) / 100));
  return `&H${alpha.toString(16).padStart(2, '0')}${base.slice(4)}`.toUpperCase();
}

// CJK ideographs, kana, Hangul, and full-width forms occupy two display cells.
const CJK_RE = /[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯가-힯]/;
function isWideChar(ch: string): boolean { return CJK_RE.test(ch); }
function containsCJK(text: string): boolean { return CJK_RE.test(text); }
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += isWideChar(ch) ? 2 : 1;
  return width;
}

function cjkFontFamily(): string {
  if (process.platform === 'win32') return 'Microsoft YaHei';
  if (process.platform === 'darwin') return 'PingFang SC';
  return 'Noto Sans CJK SC';
}

interface TimedCaption {
  text: string;
  start: number;
  end: number;
  wordTimings?: SubtitleWordTiming[];
}

interface TimedWord {
  text: string;
  start: number;
  end: number;
}

const PUNCTUATION_RE = /^[，。！？、；：,.!?;:）)】」』…]+$/;

function captionTokens(text: string): { tokens: string[]; joiner: string } {
  const clean = assEscape(text);
  if (!clean) return { tokens: [], joiner: ' ' };
  if (/\s/.test(clean)) return { tokens: clean.split(/\s+/).filter(Boolean), joiner: ' ' };
  if (!containsCJK(clean)) return { tokens: [clean], joiner: ' ' };

  const tokens: string[] = [];
  for (const char of [...clean]) {
    if (PUNCTUATION_RE.test(char) && tokens.length) tokens[tokens.length - 1] += char;
    else tokens.push(char);
  }
  return { tokens, joiner: '' };
}

function timeWords(text: string, start: number, end: number, measured?: SubtitleWordTiming[]): { words: TimedWord[]; joiner: string } {
  const { tokens, joiner } = captionTokens(text);
  if (!tokens.length) return { words: [], joiner };
  const safeEnd = end > start ? end : start + 1;
  if (measured?.length) {
    return {
      joiner,
      words: measured.map((word) => ({
        text: assEscape(word.word),
        start: Math.max(start, Math.min(safeEnd, start + word.start)),
        end: Math.max(start, Math.min(safeEnd, start + word.end)),
      })).filter((word) => word.text && word.end > word.start),
    };
  }
  const weights = tokens.map((token) => Math.max(1, Math.sqrt(displayWidth(token))));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  let cursor = start;
  const words = tokens.map((token, index) => {
    const wordEnd = index === tokens.length - 1
      ? safeEnd
      : cursor + ((safeEnd - start) * weights[index]) / totalWeight;
    const word = { text: token, start: cursor, end: wordEnd };
    cursor = wordEnd;
    return word;
  });
  return { words, joiner };
}

function pageWords(words: TimedWord[], joiner: string, maxWords: number, maxUnits: number): TimedWord[][] {
  const pages: TimedWord[][] = [];
  let current: TimedWord[] = [];
  let units = 0;
  for (const word of words) {
    const added = displayWidth(word.text) + (current.length ? displayWidth(joiner) : 0);
    if (current.length && (current.length >= maxWords || units + added > maxUnits)) {
      pages.push(current);
      current = [];
      units = 0;
    }
    current.push(word);
    units += displayWidth(word.text) + (current.length > 1 ? displayWidth(joiner) : 0);
  }
  if (current.length) pages.push(current);
  return pages;
}

function roundedRectPath(x1: number, y1: number, x2: number, y2: number, radius: number): string {
  const r = Math.min(radius, (x2 - x1) / 2, (y2 - y1) / 2);
  const k = r * 0.5522848;
  return [
    `m ${x1 + r} ${y1}`, `l ${x2 - r} ${y1}`,
    `b ${x2 - r + k} ${y1} ${x2} ${y1 + r - k} ${x2} ${y1 + r}`,
    `l ${x2} ${y2 - r}`,
    `b ${x2} ${y2 - r + k} ${x2 - r + k} ${y2} ${x2 - r} ${y2}`,
    `l ${x1 + r} ${y2}`,
    `b ${x1 + r - k} ${y2} ${x1} ${y2 - r + k} ${x1} ${y2 - r}`,
    `l ${x1} ${y1 + r}`,
    `b ${x1} ${y1 + r - k} ${x1 + r - k} ${y1} ${x1 + r} ${y1}`,
  ].join(' ');
}

function styledPageText(page: TimedWord[], activeIndex: number, joiner: string, config: SubtitleConfig): string {
  return page.map((word, index) => {
    const separator = index < page.length - 1 ? joiner : '';
    const text = config.uppercase ? word.text.toLocaleUpperCase() : word.text;
    if (index === activeIndex) {
      const glowBorder = Math.max(config.outlineWidth, config.outlineWidth + config.highlightGlow / 10);
      const glowBlur = Math.min(0.8, Math.max(0, config.highlightGlow / 20));
      return `{\\1c${hexToAssColor(config.highlightColor)}\\1a&H00&\\bord${glowBorder.toFixed(1)}\\blur${glowBlur.toFixed(1)}\\3c${hexToAssColorWithOpacity(config.highlightColor, 55)}}${text}${separator}`;
    }
    const opacity = index > activeIndex ? config.futureOpacity : 100;
    return `{\\1c${hexToAssColor(config.textColor)}\\1a${hexToAssColorWithOpacity('#FFFFFF', opacity).slice(0, 4)}&\\bord${config.outlineWidth.toFixed(1)}\\blur0\\3c${hexToAssColor(config.outlineColor)}}${text}${separator}`;
  }).join('');
}

export function buildCaptionAss(items: TimedCaption[], w: number, h: number, style?: SubtitleConfig): string {
  const config: SubtitleConfig = { ...DEFAULT_SUBTITLE_CONFIG, ...(style ?? {}) };
  const fontSize = Math.max(1, Math.round(h * (config.fontSizePct / 100)));
  const marginV = Math.round(h * (config.marginPct / 100));
  const fontName = items.some((item) => containsCJK(item.text)) ? cjkFontFamily() : config.fontFamily;
  const alignment = 5;
  const captionX = Math.round(w * (Math.max(0, Math.min(100, config.xPct)) / 100));
  const captionY = Math.round(h * (Math.max(0, Math.min(100, config.yPct)) / 100));
  const captionWidthRatio = Math.max(0.15, Math.min(0.96, config.widthPct / 100));
  const maxUnits = Math.max(8, Math.floor((w * captionWidthRatio) / (fontSize * 0.54)));
  const bold = config.bold ? -1 : 0;
  const italic = config.italic ? -1 : 0;

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${w}`,
    `PlayResY: ${h}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Caption,${fontName},${fontSize},${hexToAssColor(config.textColor)},${hexToAssColor(config.textColor)},${hexToAssColor(config.outlineColor)},&H00000000,${bold},${italic},0,0,100,100,0,0,1,${config.outlineWidth},${config.shadowDepth},${alignment},0,0,${marginV},1`,
    `Style: Backdrop,Arial,20,${hexToAssColorWithOpacity(config.backgroundColor, config.backgroundOpacity)},${hexToAssColorWithOpacity(config.backgroundColor, config.backgroundOpacity)},${hexToAssColorWithOpacity(config.backgroundColor, config.backgroundOpacity)},${hexToAssColorWithOpacity(config.backgroundColor, config.backgroundOpacity)},0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const events: string[] = [];
  for (const item of items) {
    const { words, joiner } = timeWords(item.text, item.start, item.end, item.wordTimings);
    for (const page of pageWords(words, joiner, config.wordsPerPage, maxUnits)) {
      const pageStart = page[0].start;
      const pageEnd = page[page.length - 1].end;
      const pageText = page.map((word) => word.text).join(joiner);
      const estimatedWidth = displayWidth(pageText) * fontSize * 0.54 + fontSize * 1.25;
      const maximumBoxWidth = Math.round(w * captionWidthRatio);
      const boxWidth = config.backgroundStyle === 'bar'
        ? maximumBoxWidth
        : Math.round(Math.min(maximumBoxWidth, Math.max(fontSize * 4, estimatedWidth)));
      const boxHeight = Math.round(fontSize * 1.65);
      const x1 = Math.max(0, Math.min(w - boxWidth, Math.round(captionX - boxWidth / 2)));
      const x2 = x1 + boxWidth;
      const y1 = Math.max(0, Math.min(h - boxHeight, Math.round(captionY - boxHeight / 2)));
      const y2 = y1 + boxHeight;
      const radius = config.backgroundStyle === 'rounded' ? Math.round(config.backgroundRadius * (h / 1080)) : 0;
      const shape = roundedRectPath(x1, y1, x2, y2, radius);
      if (config.backgroundStyle !== 'none' && config.backgroundOpacity > 0) {
        events.push(`Dialogue: 0,${assTime(pageStart)},${assTime(pageEnd)},Backdrop,,0,0,0,,{\\an7\\pos(0,0)\\p1\\fad(90,90)}${shape}`);
      }
      page.forEach((word, activeIndex) => {
        const fade = activeIndex === 0 ? '\\fad(90,0)' : '';
        events.push(`Dialogue: 1,${assTime(word.start)},${assTime(word.end)},Caption,,0,0,0,,{\\an5\\pos(${captionX},${captionY})${fade}}${styledPageText(page, activeIndex, joiner, config)}`);
      });
    }
  }

  return `${header.join('\n')}\n${events.join('\n')}\n`;
}

function sourceSubtitleCoverFilters(config: SubtitleConfig, w: number, h: number, input = '0:v'): { filters: string[]; output: string } | null {
  const cover = config.originalSubtitleCover;
  if (!cover?.enabled) return null;
  const x = Math.max(0, Math.min(w - 2, Math.round(w * cover.xPct / 100))) & ~1;
  const y = Math.max(0, Math.min(h - 2, Math.round(h * cover.yPct / 100))) & ~1;
  const width = Math.max(2, Math.min(w - x, Math.round(w * cover.widthPct / 100))) & ~1;
  const height = Math.max(2, Math.min(h - y, Math.round(h * cover.heightPct / 100))) & ~1;
  const featherPx = Math.max(0, Math.round(Math.min(width, height) * Math.max(0, Math.min(40, cover.featherPct ?? 12)) / 100));
  const featherMask = (opacity = 1) => {
    const peak = Math.round(255 * Math.max(0, Math.min(1, opacity)));
    return `color=c=white:s=${width}x${height},format=gray,geq=lum='${peak}*min(1,min(min(X,W-1-X),min(Y,H-1-Y))/${featherPx})'[vcovermask]`;
  };
  if (cover.mode === 'blur') {
    const strength = Math.max(2, Math.min(30, Math.round(cover.blurStrength)));
    if (featherPx > 0) return {
      filters: [
        `[${input}]split=2[vcoverbase][vcoversource]`,
        `[vcoversource]crop=${width}:${height}:${x}:${y},boxblur=luma_radius=${strength}:luma_power=2:chroma_radius=${Math.max(1, Math.round(strength / 2))}:chroma_power=1[vcoverarea]`,
        featherMask(),
        `[vcoverarea][vcovermask]alphamerge[vcoverblend]`,
        `[vcoverbase][vcoverblend]overlay=${x}:${y}[vcover]`,
      ],
      output: 'vcover',
    };
    return {
      filters: [
        `[${input}]split=2[vcoverbase][vcoversource]`,
        `[vcoversource]crop=${width}:${height}:${x}:${y},boxblur=luma_radius=${strength}:luma_power=2:chroma_radius=${Math.max(1, Math.round(strength / 2))}:chroma_power=1[vcoverarea]`,
        `[vcoverbase][vcoverarea]overlay=${x}:${y}[vcover]`,
      ],
      output: 'vcover',
    };
  }
  if (cover.mode === 'restore') {
    if (featherPx > 0) return {
      filters: [
        `[${input}]split=2[vcoverbase][vcoversource]`,
        `[vcoversource]delogo=x=${x}:y=${y}:w=${width}:h=${height}:show=0,crop=${width}:${height}:${x}:${y}[vcoverarea]`,
        featherMask(),
        `[vcoverarea][vcovermask]alphamerge[vcoverblend]`,
        `[vcoverbase][vcoverblend]overlay=${x}:${y}[vcover]`,
      ],
      output: 'vcover',
    };
    return { filters: [`[${input}]delogo=x=${x}:y=${y}:w=${width}:h=${height}:show=0[vcover]`], output: 'vcover' };
  }
  const color = /^#[0-9a-f]{6}$/i.test(cover.color) ? `0x${cover.color.slice(1)}` : '0x0F172A';
  const opacity = Math.max(0.2, Math.min(1, cover.opacity / 100));
  if (featherPx > 0) return {
    filters: [
      `color=c=${color}:s=${width}x${height},format=rgba[vcoverarea]`,
      featherMask(opacity),
      `[vcoverarea][vcovermask]alphamerge[vcoverblend]`,
      `[${input}][vcoverblend]overlay=${x}:${y}[vcover]`,
    ],
    output: 'vcover',
  };
  return { filters: [`[${input}]drawbox=x=${x}:y=${y}:w=${width}:h=${height}:color=${color}@${opacity.toFixed(3)}:t=fill[vcover]`], output: 'vcover' };
}

// Narration audio is concatenated, so each caption starts at the cumulative scene time.
function buildAssFile(scenes: Scene[], w: number, h: number, config?: SubtitleConfig): string {
  let elapsed = 0;
  const items = scenes.map((scene) => {
    const item = { text: scene.narration ?? '', start: elapsed, end: elapsed + scene.durationSec, wordTimings: scene.wordTimings };
    elapsed = item.end;
    return item;
  });
  return buildCaptionAss(items, w, h, config);
}

// FFmpeg's filtergraph parser needs the Windows drive colon and backslashes
// escaped inside the ass filter argument.
function escapeAssPath(assPath: string): string {
  return assPath.replace(/\\/g, '/').replace(/:/g, '\\:');
}

// Read the pixel dimensions of a video stream via ffprobe. Falls back to 1080p
// landscape if the probe fails so subtitle sizing still has sane numbers.
async function probeVideoDimensions(videoPath: string): Promise<[number, number]> {
  return await new Promise<[number, number]>((resolve) => {
    const child = spawn(ffprobeBinary(), [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'csv=s=x:p=0', videoPath,
    ], { cwd: path.dirname(ffprobeBinary()), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout?.on('data', (data) => { stdout += String(data); });
    child.on('error', () => resolve([1920, 1080]));
    child.on('close', () => {
      const match = stdout.trim().match(/(\d+)x(\d+)/);
      if (match) resolve([Number(match[1]), Number(match[2])]);
      else resolve([1920, 1080]);
    });
  });
}

function localizeFrameDimensions(w: number, h: number, ratio: LocalizeAspectRatio = 'original'): [number, number] {
  // The output encoder requires even dimensions. Some phone/social sources have
  // an odd width or height; pad those by one pixel instead of failing at 100%.
  if (ratio === 'original') return [Math.max(2, (w + 1) & ~1), Math.max(2, (h + 1) & ~1)];
  const longEdge = Math.max(2, Math.max(w, h)) & ~1;
  if (ratio === '9:16') return [Math.max(2, Math.round(longEdge * 9 / 16)) & ~1, longEdge];
  return [longEdge, Math.max(2, Math.round(longEdge * 9 / 16)) & ~1];
}

async function probeHasAudio(videoPath: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const child = spawn(ffprobeBinary(), [
      '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=index', '-of', 'csv=p=0', videoPath,
    ], { cwd: path.dirname(ffprobeBinary()), stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout?.on('data', (data) => { stdout += String(data); });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0 && Boolean(stdout.trim())));
  });
}

// atempo only accepts 0.5–2.0 per instance, so a speed-up beyond 2x is expressed
// as a chain (e.g. 2.5x → atempo=2.0,atempo=1.25). Factors <= 1 return a single
// pass-through so we never slow speech down below its natural pace.
function atempoChain(factor: number): string[] {
  if (!(factor > 1)) return [];
  const stages: number[] = [];
  let remaining = factor;
  while (remaining > 2.0) { stages.push(2.0); remaining /= 2.0; }
  stages.push(remaining);
  return stages.map((f) => `atempo=${f.toFixed(4)}`);
}

// Build a burned-in subtitle track timed to the *source video* windows
// (sourceStart..sourceEnd), so captions stay locked to the original speech
// timing regardless of how the dubbed audio was time-stretched.
function buildRedubAssFile(segments: Array<RedubSegment & { factor: number }>, w: number, h: number, config?: SubtitleConfig): string {
  return buildCaptionAss(segments.map((segment) => ({
    text: segment.text ?? '',
    start: segment.sourceStart,
    end: segment.sourceEnd > segment.sourceStart ? segment.sourceEnd : segment.sourceStart + 1,
    wordTimings: segment.wordTimings?.map((word) => ({
      ...word,
      start: word.start / segment.factor,
      end: word.end / segment.factor,
    })),
  })), w, h, config);
}

export function registerFfmpegIpc(): void {
  ipcMain.handle('ffmpeg:export', async (e, args: ExportArgs): Promise<string | null> => {
    const { projectId, scenes, ratio } = args;
    if (!scenes?.length) throw new Error('Cần ít nhất một phân cảnh để xuất video.');
    const win = BrowserWindow.fromWebContents(e.sender);

    const binary = ffmpegBinary();
    const probe = ffprobeBinary();
    try {
      await Promise.all([
        fs.access(binary),
        fs.access(probe),
        ...scenes.flatMap((scene) => [fs.access(scene.imagePath), fs.access(scene.audioPath)]),
      ]);
    } catch {
      throw new Error('Không thể xuất video vì một số tệp media hoặc audio không khả dụng.');
    }

    win?.webContents.send('ffmpeg:progress', { projectId, timeSec: 0, phase: 'preparing' });
    const preparedScenes = await Promise.all(scenes.map(async (scene) => ({
      ...scene,
      durationSec: scene.durationSec > 0 ? scene.durationSec : await probeDuration(scene.audioPath),
    })));

    const totalDurationSec = preparedScenes.reduce((sum, scene) => sum + scene.durationSec, 0);
    const [w, h] = resolution(ratio);
    const fps = args.fps ?? 30;

    const saveRes = await dialog.showSaveDialog(win!, {
      title: 'Xuất video',
      defaultPath: path.join(app.getPath('videos'), `gensuite-${Date.now()}.mp4`),
      filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
    });
    if (saveRes.canceled || !saveRes.filePath) return null;
    const outPath = saveRes.filePath;
    win?.webContents.send('ffmpeg:progress', {
      projectId,
      timeSec: 0,
      totalSec: totalDurationSec,
      phase: 'encoding',
    });

    // Each still receives a subtle deterministic Ken Burns motion. Every visual
    // except the last is extended by the crossfade duration; the overlap then
    // cancels that extension, keeping the finished video aligned with narration.
    const inputs: string[] = [];
    const filters: string[] = [];
    preparedScenes.forEach((s, i) => {
      const visualDuration = s.durationSec + (i < preparedScenes.length - 1 ? CROSSFADE_SEC : 0);
      const frames = Math.max(2, Math.ceil(visualDuration * fps));
      const isVideo = s.visualType === 'stock-video' || s.visualType === 'ai-video';
      if (isVideo) inputs.push('-stream_loop', '-1', '-t', String(visualDuration), '-i', s.imagePath);
      else inputs.push('-loop', '1', '-t', String(visualDuration), '-i', s.imagePath);
      inputs.push('-i', s.audioPath);
      filters.push(isVideo
        ? `[${i * 2}:v]scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,` +
          `crop=${w}:${h},fps=${fps},setsar=1,trim=duration=${visualDuration},setpts=PTS-STARTPTS,settb=AVTB[v${i}]`
        : `[${i * 2}:v]scale=${w * 2}:${h * 2}:force_original_aspect_ratio=increase:flags=lanczos,` +
          `crop=${w * 2}:${h * 2},setsar=1,${zoompanFilter(motionForScene(s.id), frames, w, h, fps)},` +
          `trim=duration=${visualDuration},setpts=PTS-STARTPTS,settb=AVTB[v${i}]`,
      );
      filters.push(
        `[${i * 2 + 1}:a]aresample=48000,` +
        `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,` +
        `apad,atrim=duration=${s.durationSec},asetpts=PTS-STARTPTS[a${i}]`,
      );
    });

    const audioInputs = preparedScenes.map((_, i) => `[a${i}]`).join('');
    filters.push(`${audioInputs}concat=n=${preparedScenes.length}:v=0:a=1[anar]`);

    // Optional background music: loop the chosen track to cover the whole video,
    // lower it under the narration, fade out over the final seconds, then mix.
    // amix normalize=0 keeps the narration at full level instead of halving it.
    const musicPath = args.musicPath;
    const wantMusic = !!musicPath && (await fs.access(musicPath).then(() => true).catch(() => false));
    let audioLabel = 'anar';
    if (wantMusic) {
      const musicVolume = Math.max(0, Math.min(100, args.musicVolume ?? 18)) / 100;
      const musicInputIndex = preparedScenes.length * 2;
      inputs.push('-stream_loop', '-1', '-i', musicPath!);
      const fade = Math.min(3, totalDurationSec / 2);
      const fadeStart = Math.max(0, totalDurationSec - fade);
      filters.push(
        `[${musicInputIndex}:a]aresample=48000,` +
        `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,` +
        `atrim=duration=${totalDurationSec.toFixed(6)},asetpts=PTS-STARTPTS,` +
        `volume=${musicVolume.toFixed(3)},afade=t=out:st=${fadeStart.toFixed(3)}:d=${fade.toFixed(3)}[amus]`,
      );
      filters.push(`[anar][amus]amix=inputs=2:duration=first:normalize=0[aout]`);
      audioLabel = 'aout';
    }

    if (preparedScenes.length === 1) {
      filters.push('[v0]null[vout]');
    } else {
      let previous = 'v0';
      let elapsed = preparedScenes[0].durationSec;
      for (let i = 1; i < preparedScenes.length; i++) {
        const output = i === preparedScenes.length - 1 ? 'vout' : `vx${i}`;
        filters.push(
          `[${previous}][v${i}]xfade=transition=fade:duration=${CROSSFADE_SEC}:offset=${elapsed.toFixed(6)}[${output}]`,
        );
        previous = output;
        elapsed += preparedScenes[i].durationSec;
      }
    }
    // Burn narration captions if requested and any scene actually has text.
    const wantSubtitles = args.subtitles === true && preparedScenes.some((s) => (s.narration ?? '').trim());
    let assPath: string | null = null;
    let videoLabel = 'vout';
    if (wantSubtitles) {
      assPath = path.join(os.tmpdir(), `gensuite-subs-${projectId}-${Date.now()}.ass`);
      await fs.writeFile(assPath, buildAssFile(preparedScenes, w, h, args.subtitleConfig), 'utf8');
      // On Windows point libass at the system Fonts dir so the chosen family
      // resolves even if fontconfig has no cache.
      const assArgs = [`f='${escapeAssPath(assPath)}'`];
      if (process.platform === 'win32' && process.env.WINDIR) {
        assArgs.push(`fontsdir='${escapeAssPath(path.join(process.env.WINDIR, 'Fonts'))}'`);
      }
      filters.push(`[vout]ass=${assArgs.join(':')}[vsub]`);
      videoLabel = 'vsub';
    }
    const filterComplex = filters.join(';');

    const ffArgs = [
      '-y',
      ...inputs,
      '-filter_complex', filterComplex,
      '-map', `[${videoLabel}]`,
      '-map', `[${audioLabel}]`,
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-movflags', '+faststart',
      '-shortest',
      '-progress', 'pipe:2',
      '-nostats',
      outPath,
    ];

    const child = spawn(binary, ffArgs, { cwd: path.dirname(binary), stdio: ['ignore', 'ignore', 'pipe'] });
    const cleanupSubs = () => { if (assPath) fs.unlink(assPath).catch(() => {}); };

    return await new Promise<string>((resolve, reject) => {
      let stderr = '';
      let progressBuffer = '';
      let lastProgressSec = -1;
      child.stderr?.on('data', (d) => {
        const line = String(d);
        stderr += line;
        progressBuffer += line;
        const matches = [...progressBuffer.matchAll(/out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
        const match = matches.at(-1);
        if (match) {
          const secs = (+match[1]) * 3600 + (+match[2]) * 60 + parseFloat(match[3]);
          if (secs > lastProgressSec) {
            lastProgressSec = secs;
            win?.webContents.send('ffmpeg:progress', {
              projectId,
              timeSec: Math.min(secs, totalDurationSec),
              totalSec: totalDurationSec,
              phase: 'encoding',
            });
          }
        }
        if (progressBuffer.length > 8192) progressBuffer = progressBuffer.slice(-4096);
      });
      child.on('error', (err) => {
        cleanupSubs();
        reject(new Error('Không thể khởi động quá trình xuất video.'));
      });
      child.on('close', (code) => {
        cleanupSubs();
        if (code === 0) {
          win?.webContents.send('ffmpeg:progress', {
            projectId,
            timeSec: totalDurationSec,
            totalSec: totalDurationSec,
            phase: 'complete',
          });
          shell.showItemInFolder(outPath);
          resolve(outPath);
        } else {
          reject(new Error('Quá trình xuất video không hoàn tất. Hãy kiểm tra các tệp đầu vào và thử lại.'));
        }
      });
    });
  });

  // Re-dub: keep the source picture, retain a configurable amount of its audio,
  // and lay translated speech over it. Long lines are compressed into their source window.
  ipcMain.handle('ffmpeg:redub', async (e, args: RedubArgs): Promise<string | null> => {
    const { projectId, sourceVideoPath, segments } = args;
    if (!sourceVideoPath) throw new Error('Cần chọn video nguồn trước khi lồng tiếng.');
    if (!segments?.length) throw new Error('Không có đoạn lời thoại nào để lồng tiếng.');
    const win = BrowserWindow.fromWebContents(e.sender);

    const binary = ffmpegBinary();
    const probe = ffprobeBinary();
    try {
      await Promise.all([
        fs.access(binary),
        fs.access(probe),
        fs.access(sourceVideoPath),
        ...segments.map((seg) => fs.access(seg.audioPath)),
      ]);
    } catch {
      throw new Error('Không thể lồng tiếng vì video nguồn hoặc một số tệp audio không khả dụng.');
    }

    win?.webContents.send('ffmpeg:progress', { projectId, timeSec: 0, phase: 'preparing' });

    const videoDur = await probeDuration(sourceVideoPath).catch(() => 0);
    const [vw, vh] = await probeVideoDimensions(sourceVideoPath);
    const originalAudioVolume = Math.max(0, Math.min(100, Number(args.originalAudioVolume ?? 8)));
    const keepOriginalAudio = originalAudioVolume > 0 && await probeHasAudio(sourceVideoPath);

    // Measure each line's real TTS duration to decide how hard to compress it.
    const prepared = await Promise.all(segments.map(async (seg) => {
      const ttsDur = await probeDuration(seg.audioPath).catch(() => 0);
      const windowLen = Math.max(0, seg.sourceEnd - seg.sourceStart);
      const factor = windowLen > 0 && ttsDur > windowLen ? ttsDur / windowLen : 1;
      return { ...seg, ttsDur, factor };
    }));

    let outPath: string;
    if (args.automaticOutputName || (args.outputDirectory && path.isAbsolute(args.outputDirectory))) {
      const outputDir = args.outputDirectory && path.isAbsolute(args.outputDirectory)
        ? args.outputDirectory
        : path.join(projectDir(projectId), 'output');
      await fs.mkdir(outputDir, { recursive: true });
      const requestedName = args.automaticOutputName || `gensuite-dub-${Date.now()}`;
      const safeBase = path.basename(requestedName, path.extname(requestedName))
        .replace(/[^\p{L}\p{N}._-]+/gu, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 100) || 'video-long-tieng';
      let candidate = path.join(outputDir, `${safeBase}.mp4`);
      let suffix = 2;
      while (await fs.access(candidate).then(() => true).catch(() => false)) {
        candidate = path.join(outputDir, `${safeBase}-${suffix}.mp4`);
        suffix += 1;
      }
      outPath = candidate;
    } else {
      const saveRes = await dialog.showSaveDialog(win!, {
        title: 'Lưu video đã lồng tiếng',
        defaultPath: path.join(app.getPath('videos'), `gensuite-dub-${Date.now()}.mp4`),
        filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
      });
      if (saveRes.canceled || !saveRes.filePath) return null;
      outPath = saveRes.filePath;
    }

    const totalDurationSec = videoDur > 0
      ? videoDur
      : prepared.reduce((max, s) => Math.max(max, s.sourceStart + s.ttsDur), 0);

    win?.webContents.send('ffmpeg:progress', { projectId, timeSec: 0, totalSec: totalDurationSec, phase: 'encoding' });

    // Inputs: [0] = source video, [1..N] = each line's audio.
    const inputs: string[] = ['-i', sourceVideoPath];
    prepared.forEach((s) => inputs.push('-i', s.audioPath));

    // A silent bed spanning the whole video guarantees the dubbed track is as
    // long as the picture even when the last line ends early.
    const filters: string[] = [];
    filters.push(
      `anullsrc=channel_layout=stereo:sample_rate=48000,` +
      `atrim=duration=${totalDurationSec.toFixed(6)},asetpts=PTS-STARTPTS[base]`,
    );
    if (keepOriginalAudio) {
      filters.push(
        `[0:a]aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,` +
        `atrim=duration=${totalDurationSec.toFixed(6)},asetpts=PTS-STARTPTS,volume=${(originalAudioVolume / 100).toFixed(3)}[aorig]`,
      );
    }
    prepared.forEach((s, i) => {
      const delayMs = Math.max(0, Math.round(s.sourceStart * 1000));
      const tempo = atempoChain(s.factor);
      const chain = [
        'aresample=48000',
        'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo',
        ...tempo,
        `adelay=${delayMs}|${delayMs}`,
      ].join(',');
      filters.push(`[${i + 1}:a]${chain}[a${i}]`);
    });
    const mixInputs = ['[base]', ...(keepOriginalAudio ? ['[aorig]'] : []), ...prepared.map((_, i) => `[a${i}]`)].join('');
    const mixCount = prepared.length + 1 + (keepOriginalAudio ? 1 : 0);
    filters.push(`${mixInputs}amix=inputs=${mixCount}:duration=first:normalize=0[adub]`);

    // Visual caption work requires a video re-encode; otherwise preserve the source stream.
    const wantSubtitles = args.subtitles === true && prepared.some((s) => (s.text ?? '').trim());
    const subtitleConfig: SubtitleConfig = { ...DEFAULT_SUBTITLE_CONFIG, ...(args.subtitleConfig ?? {}) };
    const outputAspectRatio = args.outputAspectRatio ?? 'original';
    const [outputW, outputH] = localizeFrameDimensions(vw, vh, outputAspectRatio);
    const hasFrameTransform = outputAspectRatio !== 'original' || outputW !== vw || outputH !== vh;
    let assPath: string | null = null;
    const videoArgs: string[] = [];
    let videoOutput = '0:v';
    if (hasFrameTransform) {
      filters.push(`[0:v]scale=${outputW}:${outputH}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos,pad=${outputW}:${outputH}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[vframe]`);
      videoOutput = 'vframe';
    }
    const coverGraph = sourceSubtitleCoverFilters(subtitleConfig, outputW, outputH, videoOutput);
    videoOutput = coverGraph?.output ?? videoOutput;
    if (coverGraph) filters.push(...coverGraph.filters);
    if (wantSubtitles) {
      assPath = path.join(os.tmpdir(), `gensuite-dub-${projectId}-${Date.now()}.ass`);
      await fs.writeFile(assPath, buildRedubAssFile(prepared, outputW, outputH, subtitleConfig), 'utf8');
      const assArgs = [`f='${escapeAssPath(assPath)}'`];
      if (process.platform === 'win32' && process.env.WINDIR) {
        assArgs.push(`fontsdir='${escapeAssPath(path.join(process.env.WINDIR, 'Fonts'))}'`);
      }
      filters.push(`[${videoOutput}]ass=${assArgs.join(':')}[vsub]`);
      videoOutput = 'vsub';
    }
    if (wantSubtitles || coverGraph || hasFrameTransform) {
      videoArgs.push('-map', `[${videoOutput}]`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p');
    } else {
      videoArgs.push('-map', '0:v', '-c:v', 'copy');
    }

    // A long video yields a huge filter graph (one chain per line + amix), which
    // overflows Windows' ~32k command-line limit and fails with ENAMETOOLONG.
    // Write the graph to a temp file and pass it via -filter_complex_script.
    const filterScriptPath = path.join(os.tmpdir(), `gensuite-dub-${projectId}-${Date.now()}.filter`);
    await fs.writeFile(filterScriptPath, filters.join(';'), 'utf8');

    const ffArgs = [
      '-y',
      ...inputs,
      '-filter_complex_script', filterScriptPath,
      ...videoArgs,
      '-map', '[adub]',
      '-c:a', 'aac',
      '-movflags', '+faststart',
      '-shortest',
      '-progress', 'pipe:2',
      '-nostats',
      outPath,
    ];

    const child = spawn(binary, ffArgs, { cwd: path.dirname(binary), stdio: ['ignore', 'ignore', 'pipe'] });
    const cleanupSubs = () => {
      if (assPath) fs.unlink(assPath).catch(() => {});
      fs.unlink(filterScriptPath).catch(() => {});
    };

    return await new Promise<string>((resolve, reject) => {
      let stderr = '';
      let progressBuffer = '';
      let lastProgressSec = -1;
      child.stderr?.on('data', (d) => {
        const line = String(d);
        stderr += line;
        progressBuffer += line;
        const matches = [...progressBuffer.matchAll(/out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
        const match = matches.at(-1);
        if (match) {
          const secs = (+match[1]) * 3600 + (+match[2]) * 60 + parseFloat(match[3]);
          if (secs > lastProgressSec) {
            lastProgressSec = secs;
            win?.webContents.send('ffmpeg:progress', {
              projectId,
              timeSec: Math.min(secs, totalDurationSec),
              totalSec: totalDurationSec,
              phase: 'encoding',
            });
          }
        }
        if (progressBuffer.length > 8192) progressBuffer = progressBuffer.slice(-4096);
      });
      child.on('error', (err) => {
        cleanupSubs();
        log.error('video completion spawn failed', { code: (err as NodeJS.ErrnoException).code });
        reject(new Error('Không thể khởi động quá trình hoàn thiện video.'));
      });
      child.on('close', (code) => {
        cleanupSubs();
        if (code === 0) {
          win?.webContents.send('ffmpeg:progress', {
            projectId,
            timeSec: totalDurationSec,
            totalSec: totalDurationSec,
            phase: 'complete',
          });
          if (args.revealOutput !== false) shell.showItemInFolder(outPath);
          resolve(outPath);
        } else {
          log.error('video completion failed', { code, detail: stderr.slice(-1600) });
          reject(new Error('Không thể hoàn thiện video. Hãy kiểm tra các tệp đầu vào và thử lại.'));
        }
      });
    });
  });
}
