import { ipcMain, BrowserWindow, dialog, shell, app } from 'electron';
import { spawn } from 'node:child_process';
import { constants as fsConstants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FfmpegProgress, LocalizeAspectRatio, SubtitleConfig, SubtitleWordTiming } from '../../src/shared/types';
import type { AppErrorCode, AppErrorContext, IpcResult } from '../../src/shared/appErrors';
import { DEFAULT_SUBTITLE_CONFIG } from '../../src/shared/subtitlePresets';
import { subtitleCoverLayers } from '../../src/shared/subtitleCovers';
import { projectDir } from './project';
import { appFailure, appFailureResult, appSuccess, type AppFailure } from './appErrors';

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
  audioDuration?: number;
};

type RedubArgs = {
  projectId: string;
  sourceVideoPath: string;
  segments: RedubSegment[];
  maxTempoFactor?: number;
  subtitles?: boolean;
  subtitleConfig?: SubtitleConfig;
  outputAspectRatio?: LocalizeAspectRatio;
  originalAudioVolume?: number;
  musicPath?: string;
  musicVolume?: number;
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

function emitFfmpegProgress(win: BrowserWindow | null, progress: FfmpegProgress): void {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  try {
    win.webContents.send('ffmpeg:progress', progress);
  } catch {
    // A long render may outlive its window. Progress delivery must never crash
    // the media job or the main process.
  }
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
  const covers = subtitleCoverLayers(config).filter((cover) => cover.enabled);
  if (!covers.length) return null;
  const filters: string[] = [];
  let currentInput = input;

  covers.forEach((cover, index) => {
    const prefix = `vcover${index}`;
    const output = `${prefix}out`;
    const x = Math.max(0, Math.min(w - 2, Math.round(w * cover.xPct / 100))) & ~1;
    const y = Math.max(0, Math.min(h - 2, Math.round(h * cover.yPct / 100))) & ~1;
    const width = Math.max(2, Math.min(w - x, Math.round(w * cover.widthPct / 100))) & ~1;
    const height = Math.max(2, Math.min(h - y, Math.round(h * cover.heightPct / 100))) & ~1;
    const featherPx = Math.max(0, Math.round(Math.min(width, height) * Math.max(0, Math.min(40, cover.featherPct ?? 12)) / 100));
    const start = Math.max(0, cover.startSec).toFixed(3);
    const enable = cover.endSec === undefined
      ? `gte(t,${start})`
      : `between(t,${start},${Math.max(cover.startSec + 0.25, cover.endSec).toFixed(3)})`;
    const overlay = (area: string) => `[${prefix}base][${area}]overlay=${x}:${y}:enable='${enable}'[${output}]`;
    const featherMask = (opacity = 1) => {
      const peak = Math.round(255 * Math.max(0, Math.min(1, opacity)));
      return `color=c=white:s=${width}x${height},format=gray,geq=lum='${peak}*min(1,min(min(X,W-1-X),min(Y,H-1-Y))/${featherPx})'[${prefix}mask]`;
    };

    if (cover.mode === 'blur') {
      const strength = Math.max(2, Math.min(30, Math.round(cover.blurStrength)));
      filters.push(
        `[${currentInput}]split=2[${prefix}base][${prefix}source]`,
        `[${prefix}source]crop=${width}:${height}:${x}:${y},boxblur=luma_radius=${strength}:luma_power=2:chroma_radius=${Math.max(1, Math.round(strength / 2))}:chroma_power=1[${prefix}area]`,
      );
      if (featherPx > 0) {
        filters.push(featherMask(), `[${prefix}area][${prefix}mask]alphamerge[${prefix}blend]`, overlay(`${prefix}blend`));
      } else filters.push(overlay(`${prefix}area`));
    } else if (cover.mode === 'restore') {
      filters.push(
        `[${currentInput}]split=2[${prefix}base][${prefix}source]`,
        `[${prefix}source]delogo=x=${x}:y=${y}:w=${width}:h=${height}:show=0,crop=${width}:${height}:${x}:${y}[${prefix}area]`,
      );
      if (featherPx > 0) {
        filters.push(featherMask(), `[${prefix}area][${prefix}mask]alphamerge[${prefix}blend]`, overlay(`${prefix}blend`));
      } else filters.push(overlay(`${prefix}area`));
    } else {
      const color = /^#[0-9a-f]{6}$/i.test(cover.color) ? `0x${cover.color.slice(1)}` : '0x0F172A';
      const opacity = Math.max(0.2, Math.min(1, cover.opacity / 100));
      if (featherPx > 0) {
        filters.push(
          `color=c=${color}:s=${width}x${height},format=rgba[${prefix}area]`,
          featherMask(opacity),
          `[${prefix}area][${prefix}mask]alphamerge[${prefix}blend]`,
          `[${currentInput}][${prefix}blend]overlay=${x}:${y}:enable='${enable}'[${output}]`,
        );
      } else {
        filters.push(`[${currentInput}]drawbox=x=${x}:y=${y}:w=${width}:h=${height}:color=${color}@${opacity.toFixed(3)}:t=fill:enable='${enable}'[${output}]`);
      }
    }
    currentInput = output;
  });

  return { filters, output: currentInput };
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

const MEDIA_PROBE_TIMEOUT_MS = 90_000;
const MEDIA_PROCESS_INACTIVITY_TIMEOUT_MS = 180_000;
const MEDIA_INACTIVITY_GRACE_MS = 20_000;
const MEDIA_TERMINATION_GRACE_MS = 10_000;

class MediaProbeFailure extends Error {
  constructor(
    readonly kind: 'spawn' | 'timeout' | 'invalid',
    readonly systemCode?: string,
    readonly exitCode?: number | null,
  ) {
    super(kind);
    this.name = 'MediaProbeFailure';
  }
}

async function runMediaProbe<T>(args: string[], parse: (stdout: string, exitCode: number | null) => T | undefined): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      const binary = ffprobeBinary();
      child = spawn(binary, args, { cwd: path.dirname(binary), stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (error) {
      reject(new MediaProbeFailure('spawn', normalizedSystemCode(error)));
      return;
    }
    let stdout = '';
    let settled = false;
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    let closeFallback: NodeJS.Timeout | undefined;
    const finish = (value?: T, error?: MediaProbeFailure) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (closeFallback) clearTimeout(closeFallback);
      value !== undefined ? resolve(value) : reject(error ?? new MediaProbeFailure('invalid'));
    };
    timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
      closeFallback = setTimeout(
        () => finish(undefined, new MediaProbeFailure('timeout')),
        MEDIA_TERMINATION_GRACE_MS,
      );
    }, MEDIA_PROBE_TIMEOUT_MS);
    child.stdout?.on('data', (data) => { stdout += String(data); });
    child.once('error', (error) => finish(
      undefined,
      timedOut
        ? new MediaProbeFailure('timeout')
        : new MediaProbeFailure('spawn', normalizedSystemCode(error)),
    ));
    child.once('close', (code) => {
      if (timedOut) {
        finish(undefined, new MediaProbeFailure('timeout'));
        return;
      }
      try {
        const value = parse(stdout, code);
        finish(value, value === undefined ? new MediaProbeFailure('invalid', undefined, code) : undefined);
      } catch {
        finish(undefined, new MediaProbeFailure('invalid', undefined, code));
      }
    });
  });
}

// Read a required video stream. Re-dubbing cannot continue with an audio-only
// or damaged source, so this probe deliberately has no synthetic fallback.
async function probeVideoDimensions(videoPath: string): Promise<[number, number]> {
  return runMediaProbe([
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height',
    '-of', 'csv=s=x:p=0', videoPath,
  ], (stdout, code) => {
    const match = stdout.trim().match(/(\d+)x(\d+)/);
    const width = Number(match?.[1]);
    const height = Number(match?.[2]);
    return code === 0 && Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0
      ? [width, height]
      : undefined;
  });
}

async function probeVideoDuration(videoPath: string): Promise<number> {
  return runMediaProbe([
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=duration:format=duration',
    '-of', 'json', videoPath,
  ], (stdout, code) => {
    const payload = JSON.parse(stdout) as { streams?: Array<{ duration?: unknown }>; format?: { duration?: unknown } };
    const duration = [payload.streams?.[0]?.duration, payload.format?.duration]
      .map((value) => Number(value))
      .find((value) => Number.isFinite(value) && value > 0);
    return code === 0 && payload.streams?.length && typeof duration === 'number' ? duration : undefined;
  });
}

async function probeAudioDuration(audioPath: string): Promise<number> {
  return runMediaProbe([
    '-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=index,duration:format=duration',
    '-of', 'json', audioPath,
  ], (stdout, code) => {
    const payload = JSON.parse(stdout) as { streams?: Array<{ duration?: unknown }>; format?: { duration?: unknown } };
    const duration = [payload.format?.duration, payload.streams?.[0]?.duration]
      .map((value) => Number(value))
      .find((value) => Number.isFinite(value) && value > 0);
    return code === 0 && payload.streams?.length && typeof duration === 'number' ? duration : undefined;
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
  return runMediaProbe([
    '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=index', '-of', 'csv=p=0', videoPath,
  ], (stdout, code) => code === 0 ? Boolean(stdout.trim()) : undefined);
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

const REDUB_PROBE_CONCURRENCY = 8;
const REDUB_BATCH_MAX_INPUTS = 64;
const REDUB_BATCH_ARG_BUDGET = 12_000;
const REDUB_BATCH_MAX_SPAN_SEC = 240;
const REDUB_INPUT_VALIDATION_PERCENT = 10;
const REDUB_AUDIO_PREP_PERCENT = 35;
const REDUB_TIMING_TOLERANCE_SEC = 1;

type PreparedRedubSegment = RedubSegment & {
  segmentNumber: number;
  segmentCount: number;
  ttsDur: number;
  factor: number;
  effectiveDuration: number;
};

type RedubAudioBatch = {
  segments: PreparedRedubSegment[];
  startSec: number;
  durationSec: number;
};

type RedubSpeechTrack = {
  audioPath: string;
  startSec: number;
  factor?: number;
  groupNumber?: number;
  groupCount?: number;
};

class MediaProcessFailure extends Error {
  constructor(
    readonly kind: 'spawn' | 'exit' | 'timeout',
    readonly systemCode: string | undefined,
    readonly exitCode: number | null,
    readonly detail: string,
  ) {
    super(kind);
    this.name = 'MediaProcessFailure';
  }
}

function normalizedSystemCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  const value = (error as { code?: unknown }).code;
  return typeof value === 'string' ? value.toUpperCase() : undefined;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const failures: unknown[] = [];
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (true) {
      if (failures.length) return;
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      try {
        results[index] = await mapper(items[index], index);
      } catch (error) {
        if (!failures.length) failures.push(error);
        return;
      }
    }
  });
  await Promise.allSettled(workers);
  if (failures.length) throw failures[0];
  return results;
}

function segmentCommandCost(segment: PreparedRedubSegment): number {
  return segment.audioPath.length + 16;
}

function needsRedubAudioBatches(segments: PreparedRedubSegment[]): boolean {
  return segments.length > REDUB_BATCH_MAX_INPUTS
    || segments.reduce((total, segment) => total + segmentCommandCost(segment), 0) > REDUB_BATCH_ARG_BUDGET;
}

function makeRedubAudioBatch(segments: PreparedRedubSegment[]): RedubAudioBatch {
  const startSec = Math.max(0, Math.min(...segments.map((segment) => segment.sourceStart)));
  const endSec = Math.max(
    startSec + 0.1,
    ...segments.map((segment) => Math.max(
      segment.sourceEnd,
      segment.sourceStart + segment.effectiveDuration,
    )),
  );
  return { segments, startSec, durationSec: Math.max(0.1, endSec - startSec) };
}

function partitionRedubAudioBatches(segments: PreparedRedubSegment[]): RedubAudioBatch[] {
  const sorted = [...segments].sort((left, right) => left.sourceStart - right.sourceStart);
  const batches: RedubAudioBatch[] = [];
  let current: PreparedRedubSegment[] = [];
  let currentCost = 0;

  const flush = () => {
    if (!current.length) return;
    batches.push(makeRedubAudioBatch(current));
    current = [];
    currentCost = 0;
  };

  for (const segment of sorted) {
    const cost = segmentCommandCost(segment);
    const startSec = current.length ? Math.max(0, current[0].sourceStart) : Math.max(0, segment.sourceStart);
    const candidateEnd = Math.max(
      segment.sourceEnd,
      segment.sourceStart + segment.effectiveDuration,
      ...current.map((item) => Math.max(item.sourceEnd, item.sourceStart + item.effectiveDuration)),
    );
    const exceedsLimit = current.length > 0 && (
      current.length >= REDUB_BATCH_MAX_INPUTS
      || currentCost + cost > REDUB_BATCH_ARG_BUDGET
      || candidateEnd - startSec > REDUB_BATCH_MAX_SPAN_SEC
    );
    if (exceedsLimit) flush();
    current.push(segment);
    currentCost += cost;
  }
  flush();
  return batches;
}

async function runMediaProcess(options: {
  binary: string;
  args: string[];
  onProgress?: (timeSec: number) => void;
  inactivityTimeoutMs?: number;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(options.binary, options.args, {
        cwd: path.dirname(options.binary),
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (error) {
      reject(new MediaProcessFailure('spawn', normalizedSystemCode(error), null, ''));
      return;
    }

    let settled = false;
    let detail = '';
    let progressBuffer = '';
    let lastProgressSec = -1;
    let timedOut = false;
    let inactivityTimer: NodeJS.Timeout | undefined;
    let inactivityGrace: NodeJS.Timeout | undefined;
    let closeFallback: NodeJS.Timeout | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (inactivityTimer) clearTimeout(inactivityTimer);
      if (inactivityGrace) clearTimeout(inactivityGrace);
      if (closeFallback) clearTimeout(closeFallback);
      error ? reject(error) : resolve();
    };
    const timeoutFailure = () => new MediaProcessFailure('timeout', 'ETIMEDOUT', null, detail);
    const armInactivityWatchdog = () => {
      if (settled || timedOut) return;
      if (inactivityTimer) clearTimeout(inactivityTimer);
      if (inactivityGrace) clearTimeout(inactivityGrace);
      inactivityGrace = undefined;
      inactivityTimer = setTimeout(() => {
        inactivityTimer = undefined;
        inactivityGrace = setTimeout(() => {
          timedOut = true;
          child.kill();
          closeFallback = setTimeout(() => finish(timeoutFailure()), MEDIA_TERMINATION_GRACE_MS);
        }, MEDIA_INACTIVITY_GRACE_MS);
      }, options.inactivityTimeoutMs ?? MEDIA_PROCESS_INACTIVITY_TIMEOUT_MS);
    };
    armInactivityWatchdog();

    child.stderr?.on('data', (data) => {
      const line = String(data);
      armInactivityWatchdog();
      detail = `${detail}${line}`.slice(-16_000);
      if (!options.onProgress) return;
      progressBuffer = `${progressBuffer}${line}`.slice(-16_000);
      const matches = [...progressBuffer.matchAll(/out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
      const match = matches.at(-1);
      if (!match) return;
      const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number.parseFloat(match[3]);
      if (Number.isFinite(seconds) && seconds > lastProgressSec) {
        lastProgressSec = seconds;
        options.onProgress(seconds);
      }
    });
    child.once('error', (error) => {
      finish(timedOut
        ? timeoutFailure()
        : new MediaProcessFailure('spawn', normalizedSystemCode(error), null, detail));
    });
    child.once('close', (code) => {
      finish(timedOut
        ? timeoutFailure()
        : code === 0 ? undefined : new MediaProcessFailure('exit', undefined, code, detail));
    });
  });
}

function processFailure(
  error: unknown,
  fallback: AppFailure,
  context?: AppErrorContext,
  writeTarget: 'temporary' | 'output' = 'output',
  classifyExitPermission = true,
): AppFailure {
  if (!(error instanceof MediaProcessFailure)) return fallback;
  const detail = error.detail.toLowerCase();
  const diagnostics = {
    processKind: error.kind,
    systemCode: error.systemCode,
    exitCode: error.exitCode ?? undefined,
  };
  if (error.kind === 'timeout') {
    const code = fallback.code === 'VIDEO_AUDIO_PREPARATION_FAILED'
      ? 'VIDEO_AUDIO_PREPARATION_TIMEOUT'
      : 'VIDEO_COMPLETION_TIMEOUT';
    return appFailure(code, context ?? fallback.context, { ...diagnostics, classifier: 'inactivity-timeout' });
  }
  if (error.systemCode === 'ENAMETOOLONG' || error.systemCode === 'E2BIG' || /argument list too long|filename or extension is too long/.test(detail)) {
    return appFailure('VIDEO_TOO_MANY_SEGMENTS', context, { ...diagnostics, classifier: 'argument-limit' });
  }
  if (error.systemCode === 'ENOENT') {
    return appFailure('VIDEO_COMPONENT_UNAVAILABLE', context, { ...diagnostics, classifier: 'component-missing' });
  }
  if (error.systemCode === 'EACCES' || error.systemCode === 'EPERM') {
    return appFailure('VIDEO_PROCESS_START_DENIED', context, { ...diagnostics, classifier: 'start-denied' });
  }
  if (error.systemCode === 'ENOSPC' || /no space left|not enough space|disk(?: is)? full/.test(detail)) {
    return writeTarget === 'output'
      ? appFailure('OUTPUT_STORAGE_FULL', context, { ...diagnostics, classifier: 'storage-full' })
      : appFailure('TEMP_STORAGE_FULL', context, { ...diagnostics, classifier: 'storage-full' });
  }
  if (/permission denied|access is denied|read-only file system/.test(detail)) {
    if (error.kind === 'exit' && !classifyExitPermission) {
      return appFailure(fallback.code, context ?? fallback.context, { ...diagnostics, classifier: 'permission-unclassified' });
    }
    return writeTarget === 'output'
      ? appFailure('OUTPUT_PERMISSION_DENIED', context, { ...diagnostics, classifier: 'write-denied' })
      : appFailure('TEMP_STORAGE_PERMISSION_DENIED', context, { ...diagnostics, classifier: 'write-denied' });
  }
  if (error.kind === 'spawn') {
    return appFailure('VIDEO_PROCESS_START_FAILED', context, { ...diagnostics, classifier: 'start-failed' });
  }
  return appFailure(fallback.code, context ?? fallback.context, { ...diagnostics, classifier: 'process-exit' });
}

function probeInfrastructureFailure(
  error: unknown,
  timeoutCode: AppErrorCode,
  context?: AppErrorContext,
): AppFailure | null {
  if (!(error instanceof MediaProbeFailure)) return null;
  const diagnostics = {
    processKind: error.kind,
    systemCode: error.systemCode,
    exitCode: error.exitCode ?? undefined,
  };
  if (error.kind === 'timeout') {
    return appFailure(timeoutCode, context, { ...diagnostics, classifier: 'probe-timeout' });
  }
  if (error.systemCode === 'ENOENT') {
    return appFailure('VIDEO_COMPONENT_UNAVAILABLE', context, { ...diagnostics, classifier: 'component-missing' });
  }
  if (error.systemCode === 'EACCES' || error.systemCode === 'EPERM') {
    return appFailure('VIDEO_PROCESS_START_DENIED', context, { ...diagnostics, classifier: 'start-denied' });
  }
  if (error.kind === 'spawn') {
    return appFailure('VIDEO_PROCESS_START_FAILED', context, { ...diagnostics, classifier: 'probe-start-failed' });
  }
  return null;
}

function fileFailure(
  error: unknown,
  purpose: 'temporary' | 'output',
  context?: AppErrorContext,
): AppFailure {
  const code = normalizedSystemCode(error);
  if (code === 'ENOSPC') {
    return purpose === 'output'
      ? appFailure('OUTPUT_STORAGE_FULL', context, { systemCode: code, classifier: 'storage-full' })
      : appFailure('TEMP_STORAGE_FULL', context, { systemCode: code, classifier: 'storage-full' });
  }
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    return purpose === 'output'
      ? appFailure('OUTPUT_PERMISSION_DENIED', context, { systemCode: code, classifier: 'write-denied' })
      : appFailure('TEMP_STORAGE_PERMISSION_DENIED', context, { systemCode: code, classifier: 'write-denied' });
  }
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return purpose === 'output'
      ? appFailure('OUTPUT_DIRECTORY_UNAVAILABLE', context, { systemCode: code, classifier: 'directory-missing' })
      : appFailure('TEMP_STORAGE_UNAVAILABLE', context, { systemCode: code, classifier: 'temporary-unavailable' });
  }
  return purpose === 'output'
    ? appFailure('OUTPUT_WRITE_FAILED', context, { systemCode: code, classifier: 'write-failed' })
    : appFailure('TEMP_STORAGE_UNAVAILABLE', context, { systemCode: code, classifier: 'temporary-unavailable' });
}

function inputFileFailure(
  error: unknown,
  input: 'source-video' | 'segment-audio' | 'background-audio',
  context?: AppErrorContext,
): AppFailure {
  const systemCode = normalizedSystemCode(error);
  const diagnostics = { systemCode, classifier: 'input-access' };
  const permissionDenied = systemCode === 'EACCES' || systemCode === 'EPERM';
  const unavailable = systemCode === 'ENOENT' || systemCode === 'ENOTDIR';

  if (input === 'source-video') {
    if (permissionDenied) return appFailure('VIDEO_SOURCE_PERMISSION_DENIED', context, diagnostics);
    if (unavailable) return appFailure('VIDEO_SOURCE_UNAVAILABLE', context, diagnostics);
    return appFailure('VIDEO_SOURCE_UNREADABLE', context, diagnostics);
  }
  if (input === 'segment-audio') {
    if (permissionDenied) return appFailure('VIDEO_SEGMENT_AUDIO_PERMISSION_DENIED', context, diagnostics);
    if (unavailable) return appFailure('VIDEO_SEGMENT_AUDIO_UNAVAILABLE', context, diagnostics);
    return appFailure('VIDEO_SEGMENT_AUDIO_UNREADABLE', context, diagnostics);
  }
  if (permissionDenied) return appFailure('BACKGROUND_AUDIO_PERMISSION_DENIED', context, diagnostics);
  if (unavailable) return appFailure('BACKGROUND_AUDIO_UNAVAILABLE', context, diagnostics);
  return appFailure('BACKGROUND_AUDIO_UNREADABLE', context, diagnostics);
}

async function ensureFileReadable(filePath: string): Promise<void> {
  const handle = await fs.open(filePath, 'r');
  await handle.close();
}

async function preparedSegmentInputFailure(
  segments: PreparedRedubSegment[],
): Promise<AppFailure | null> {
  const failures = await mapWithConcurrency(segments, REDUB_PROBE_CONCURRENCY, async (segment) => {
    const context = { segmentNumber: segment.segmentNumber, segmentCount: segment.segmentCount };
    try {
      await probeAudioDuration(segment.audioPath);
      return null;
    } catch (error) {
      const probeFailure = probeInfrastructureFailure(error, 'VIDEO_SEGMENT_AUDIO_VALIDATION_TIMEOUT', context);
      if (probeFailure) return probeFailure;
      try {
        await ensureFileReadable(segment.audioPath);
      } catch (error) {
        return inputFileFailure(error, 'segment-audio', context);
      }
      return appFailure('VIDEO_SEGMENT_AUDIO_UNREADABLE', context);
    }
  });
  return failures.find((failure): failure is AppFailure => failure !== null) ?? null;
}

async function speechTrackInputFailure(tracks: RedubSpeechTrack[]): Promise<AppFailure | null> {
  const failures = await mapWithConcurrency(tracks, REDUB_PROBE_CONCURRENCY, async (track, index) => {
    try {
      await probeAudioDuration(track.audioPath);
      return null;
    } catch (error) {
      const context = {
        groupNumber: track.groupNumber ?? index + 1,
        groupCount: track.groupCount ?? tracks.length,
      };
      return probeInfrastructureFailure(error, 'VIDEO_AUDIO_PREPARATION_TIMEOUT', context)
        ?? appFailure('VIDEO_AUDIO_PREPARATION_FAILED', context);
    }
  });
  return failures.find((failure): failure is AppFailure => failure !== null) ?? null;
}

async function createRedubBatchTrack(options: {
  binary: string;
  directory: string;
  batch: RedubAudioBatch;
  groupNumber: number;
  groupCount: number;
}): Promise<RedubSpeechTrack> {
  const { binary, directory, batch, groupNumber, groupCount } = options;
  const context = { groupNumber, groupCount };
  const label = String(groupNumber - 1).padStart(3, '0');
  const filterPath = path.join(directory, `voice-group-${label}.filter`);
  const outputPath = path.join(directory, `voice-group-${label}.flac`);
  const inputs: string[] = [];
  const filters: string[] = [
    `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${batch.durationSec.toFixed(6)},asetpts=PTS-STARTPTS[base]`,
  ];

  batch.segments.forEach((segment, index) => {
    inputs.push('-i', segment.audioPath);
    const delayMs = Math.max(0, Math.round((segment.sourceStart - batch.startSec) * 1000));
    const chain = [
      'aresample=48000',
      'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo',
      ...atempoChain(segment.factor),
      `adelay=${delayMs}|${delayMs}`,
    ].join(',');
    filters.push(`[${index}:a]${chain}[voice${index}]`);
  });
  const mixInputs = ['[base]', ...batch.segments.map((_, index) => `[voice${index}]`)].join('');
  // Keep the longest actual voice instead of trimming to cached/rounded
  // duration estimates. The final full-video base still caps total output.
  filters.push(`${mixInputs}amix=inputs=${batch.segments.length + 1}:duration=longest:normalize=0[group]`);

  try {
    await fs.writeFile(filterPath, filters.join(';'), 'utf8');
  } catch (error) {
    throw fileFailure(error, 'temporary', context);
  }

  try {
    await runMediaProcess({
      binary,
      args: [
        '-y', ...inputs,
        '-filter_complex_script', filterPath,
        '-map', '[group]', '-c:a', 'flac', '-ar', '48000', '-ac', '2',
        '-progress', 'pipe:2', '-nostats', outputPath,
      ],
    });
  } catch (error) {
    const classified = processFailure(
      error,
      appFailure('VIDEO_AUDIO_PREPARATION_FAILED', context),
      context,
      'temporary',
      false,
    );
    if (classified.code === 'VIDEO_AUDIO_PREPARATION_FAILED' && error instanceof MediaProcessFailure && error.kind === 'exit') {
      const inputFailure = await preparedSegmentInputFailure(batch.segments);
      if (inputFailure) {
        throw appFailure(inputFailure.code, inputFailure.context, {
          ...classified.internalDiagnostics,
          ...inputFailure.internalDiagnostics,
        });
      }
      throw processFailure(
        error,
        appFailure('VIDEO_AUDIO_PREPARATION_FAILED', context),
        context,
        'temporary',
        true,
      );
    }
    throw classified;
  }
  return { audioPath: outputPath, startSec: batch.startSec, groupNumber, groupCount };
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

    emitFfmpegProgress(win, { projectId, timeSec: 0, phase: 'preparing' });
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
    emitFfmpegProgress(win, {
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
            emitFfmpegProgress(win, {
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
          emitFfmpegProgress(win, {
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

  // Re-dub: long projects first produce a small number of timeline-aligned voice
  // groups. The final pass therefore receives only a few short temporary paths
  // instead of hundreds of user paths at once.
  ipcMain.handle('ffmpeg:redub', async (e, args: RedubArgs): Promise<IpcResult<string | null>> => {
    const projectId = String(args?.projectId ?? '').trim();
    const sourceVideoPath = String(args?.sourceVideoPath ?? '').trim();
    const segments = Array.isArray(args?.segments) ? args.segments : [];
    const segmentCount = segments.length;
    const win = BrowserWindow.fromWebContents(e.sender);
    let activeStage = 'validation';
    let groupCount = 0;
    let tempDirectory: string | null = null;
    let partialOutputPath: string | null = null;
    let backupOutputPath: string | null = null;
    let outPath: string | null = null;
    let outputCommitted = false;

    try {
      if (!sourceVideoPath) {
        throw appFailure('VIDEO_SOURCE_REQUIRED');
      }
      if (!segments.length) {
        throw appFailure('VIDEO_SEGMENTS_EMPTY');
      }

      const binary = ffmpegBinary();
      const probe = ffprobeBinary();
      try {
        await Promise.all([fs.access(binary), fs.access(probe)]);
      } catch {
        throw appFailure('VIDEO_COMPONENT_UNAVAILABLE');
      }
      try {
        await ensureFileReadable(sourceVideoPath);
      } catch (error) {
        throw inputFileFailure(error, 'source-video');
      }
      for (let index = 0; index < segments.length; index += 1) {
        try {
          await ensureFileReadable(segments[index].audioPath);
        } catch (error) {
          throw inputFileFailure(error, 'segment-audio', { segmentNumber: index + 1, segmentCount });
        }
      }
      const musicPath = args.musicPath?.trim() || '';
      if (musicPath) {
        try {
          await ensureFileReadable(musicPath);
        } catch (error) {
          throw inputFileFailure(error, 'background-audio');
        }
        try {
          await probeAudioDuration(musicPath);
        } catch (error) {
          const probeFailure = probeInfrastructureFailure(error, 'BACKGROUND_AUDIO_VALIDATION_TIMEOUT');
          if (probeFailure) throw probeFailure;
          try {
            await ensureFileReadable(musicPath);
          } catch (accessError) {
            throw inputFileFailure(accessError, 'background-audio');
          }
          throw appFailure('BACKGROUND_AUDIO_UNREADABLE');
        }
      }

      activeStage = 'probing-source';
      emitFfmpegProgress(win, { projectId, timeSec: 0, percent: 0, phase: 'preparing' });
      let videoDur: number;
      let vw: number;
      let vh: number;
      try {
        videoDur = await probeVideoDuration(sourceVideoPath);
        [vw, vh] = await probeVideoDimensions(sourceVideoPath);
      } catch (error) {
        const probeFailure = probeInfrastructureFailure(error, 'VIDEO_SOURCE_VALIDATION_TIMEOUT');
        if (probeFailure) throw probeFailure;
        try {
          await ensureFileReadable(sourceVideoPath);
        } catch (accessError) {
          throw inputFileFailure(accessError, 'source-video');
        }
        throw appFailure('VIDEO_SOURCE_UNREADABLE');
      }
      const originalAudioVolume = Math.max(0, Math.min(100, Number(args.originalAudioVolume ?? 8)));
      let keepOriginalAudio = false;
      if (originalAudioVolume > 0) {
        try {
          keepOriginalAudio = await probeHasAudio(sourceVideoPath);
        } catch (error) {
          const probeFailure = probeInfrastructureFailure(error, 'VIDEO_SOURCE_VALIDATION_TIMEOUT');
          if (probeFailure) throw probeFailure;
          try {
            await ensureFileReadable(sourceVideoPath);
          } catch (accessError) {
            throw inputFileFailure(accessError, 'source-video');
          }
          throw appFailure('VIDEO_SOURCE_UNREADABLE');
        }
      }

      activeStage = 'probing-voice';
      let validatedSegmentCount = 0;
      const prepared = await mapWithConcurrency(segments, REDUB_PROBE_CONCURRENCY, async (segment, index): Promise<PreparedRedubSegment> => {
        let ttsDur: number;
        const knownDuration = Number(segment.audioDuration);
        if (Number.isFinite(knownDuration) && knownDuration > 0) {
          try {
            const stat = await fs.stat(segment.audioPath);
            if (!stat.isFile() || stat.size <= 0) throw new Error('empty-audio');
            ttsDur = knownDuration;
          } catch (error) {
            throw inputFileFailure(error, 'segment-audio', { segmentNumber: index + 1, segmentCount });
          }
        } else {
          try {
            ttsDur = await probeAudioDuration(segment.audioPath);
          } catch (error) {
            const context = { segmentNumber: index + 1, segmentCount };
            const probeFailure = probeInfrastructureFailure(error, 'VIDEO_SEGMENT_AUDIO_VALIDATION_TIMEOUT', context);
            if (probeFailure) throw probeFailure;
            try {
              await ensureFileReadable(segment.audioPath);
            } catch (accessError) {
              throw inputFileFailure(accessError, 'segment-audio', context);
            }
            throw appFailure('VIDEO_SEGMENT_AUDIO_UNREADABLE', context);
          }
        }
        const parsedSourceStart = Number(segment.sourceStart);
        const parsedSourceEnd = Number(segment.sourceEnd);
        if (
          !Number.isFinite(parsedSourceStart)
          || !Number.isFinite(parsedSourceEnd)
          || parsedSourceStart < 0
          || parsedSourceEnd < parsedSourceStart
          || parsedSourceStart > videoDur + REDUB_TIMING_TOLERANCE_SEC
          || parsedSourceEnd > videoDur + REDUB_TIMING_TOLERANCE_SEC
        ) {
          throw appFailure('VIDEO_SEGMENT_TIMING_INVALID', { segmentNumber: index + 1, segmentCount });
        }
        const sourceStart = Math.min(videoDur, parsedSourceStart);
        const sourceEnd = Math.min(videoDur, parsedSourceEnd);
        const windowLen = Math.max(0, sourceEnd - sourceStart);
        const requestedFactor = windowLen > 0 && ttsDur > windowLen ? ttsDur / windowLen : 1;
        const maxTempoFactor = Number(args.maxTempoFactor);
        const factor = Number.isFinite(maxTempoFactor) && maxTempoFactor >= 1
          ? Math.min(requestedFactor, maxTempoFactor)
          : requestedFactor;
        validatedSegmentCount += 1;
        emitFfmpegProgress(win, {
          projectId,
          timeSec: 0,
          totalSec: videoDur,
          percent: Math.round((validatedSegmentCount / segmentCount) * REDUB_INPUT_VALIDATION_PERCENT),
          phase: 'preparing',
        });
        return {
          ...segment,
          segmentNumber: index + 1,
          segmentCount,
          sourceStart,
          sourceEnd,
          ttsDur,
          factor,
          effectiveDuration: ttsDur / Math.max(1, factor),
        };
      });

      activeStage = 'selecting-output';
      if (args.automaticOutputName || (args.outputDirectory && path.isAbsolute(args.outputDirectory))) {
        const outputDir = args.outputDirectory && path.isAbsolute(args.outputDirectory)
          ? args.outputDirectory
          : path.join(projectDir(projectId), 'output');
        try {
          await fs.mkdir(outputDir, { recursive: true });
        } catch (error) {
          throw fileFailure(error, 'output');
        }
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
        const saveOptions = {
          title: 'Lưu video đã lồng tiếng',
          defaultPath: path.join(app.getPath('videos'), `gensuite-dub-${Date.now()}.mp4`),
          filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
        };
        const saveResult = win
          ? await dialog.showSaveDialog(win, saveOptions)
          : await dialog.showSaveDialog(saveOptions);
        if (saveResult.canceled || !saveResult.filePath) return appSuccess(null);
        outPath = saveResult.filePath;
      }

      activeStage = 'creating-temporary-storage';
      try {
        tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'gensuite-redub-'));
      } catch (error) {
        throw fileFailure(error, 'temporary');
      }

      const totalDurationSec = videoDur;
      const useBatches = needsRedubAudioBatches(prepared);
      let speechTracks: RedubSpeechTrack[];
      if (useBatches) {
        activeStage = 'mixing-voice-groups';
        const batches = partitionRedubAudioBatches(prepared);
        groupCount = batches.length;
        speechTracks = [];
        emitFfmpegProgress(win, {
          projectId,
          timeSec: 0,
          totalSec: totalDurationSec,
          percent: REDUB_INPUT_VALIDATION_PERCENT,
          phase: 'mixing-audio',
          groupNumber: 0,
          groupCount,
        });
        for (let index = 0; index < batches.length; index += 1) {
          speechTracks.push(await createRedubBatchTrack({
            binary,
            directory: tempDirectory,
            batch: batches[index],
            groupNumber: index + 1,
            groupCount,
          }));
          emitFfmpegProgress(win, {
            projectId,
            timeSec: 0,
            totalSec: totalDurationSec,
            percent: Math.round(
              REDUB_INPUT_VALIDATION_PERCENT
              + ((index + 1) / groupCount) * (REDUB_AUDIO_PREP_PERCENT - REDUB_INPUT_VALIDATION_PERCENT),
            ),
            phase: 'mixing-audio',
            groupNumber: index + 1,
            groupCount,
          });
        }
      } else {
        speechTracks = prepared.map((segment) => ({
          audioPath: segment.audioPath,
          startSec: segment.sourceStart,
          factor: segment.factor,
        }));
      }

      activeStage = 'building-final-video';
      const inputs: string[] = ['-i', sourceVideoPath];
      speechTracks.forEach((track) => inputs.push('-i', track.audioPath));
      const wantMusic = Boolean(musicPath);
      if (wantMusic) inputs.push('-stream_loop', '-1', '-i', musicPath);

      const filters: string[] = [
        `anullsrc=channel_layout=stereo:sample_rate=48000,` +
        `atrim=duration=${totalDurationSec.toFixed(6)},asetpts=PTS-STARTPTS[base]`,
      ];
      if (keepOriginalAudio) {
        filters.push(
          `[0:a]aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,` +
          `atrim=duration=${totalDurationSec.toFixed(6)},asetpts=PTS-STARTPTS,volume=${(originalAudioVolume / 100).toFixed(3)}[aorig]`,
        );
      }
      speechTracks.forEach((track, index) => {
        const delayMs = Math.max(0, Math.round(track.startSec * 1000));
        const chain = [
          'aresample=48000',
          'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo',
          ...(track.factor ? atempoChain(track.factor) : []),
          `adelay=${delayMs}|${delayMs}`,
        ].join(',');
        filters.push(`[${index + 1}:a]${chain}[a${index}]`);
      });
      if (wantMusic) {
        const musicInputIndex = speechTracks.length + 1;
        const musicVolume = Math.max(0, Math.min(100, Number(args.musicVolume ?? 18))) / 100;
        const fade = Math.min(3, totalDurationSec / 2);
        const fadeStart = Math.max(0, totalDurationSec - fade);
        filters.push(
          `[${musicInputIndex}:a]aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,` +
          `atrim=duration=${totalDurationSec.toFixed(6)},asetpts=PTS-STARTPTS,volume=${musicVolume.toFixed(3)},` +
          `afade=t=out:st=${fadeStart.toFixed(3)}:d=${fade.toFixed(3)}[amus]`,
        );
      }
      const mixInputs = [
        '[base]',
        ...(keepOriginalAudio ? ['[aorig]'] : []),
        ...speechTracks.map((_, index) => `[a${index}]`),
        ...(wantMusic ? ['[amus]'] : []),
      ].join('');
      const mixCount = speechTracks.length + 1 + (keepOriginalAudio ? 1 : 0) + (wantMusic ? 1 : 0);
      filters.push(`${mixInputs}amix=inputs=${mixCount}:duration=first:normalize=0[adub]`);

      const wantSubtitles = args.subtitles === true && prepared.some((segment) => (segment.text ?? '').trim());
      const subtitleConfig: SubtitleConfig = { ...DEFAULT_SUBTITLE_CONFIG, ...(args.subtitleConfig ?? {}) };
      const outputAspectRatio = args.outputAspectRatio ?? 'original';
      const [outputW, outputH] = localizeFrameDimensions(vw, vh, outputAspectRatio);
      const hasFrameTransform = outputAspectRatio !== 'original' || outputW !== vw || outputH !== vh;
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
        const assPath = path.join(tempDirectory, 'subtitles.ass');
        try {
          await fs.writeFile(assPath, buildRedubAssFile(prepared, outputW, outputH, subtitleConfig), 'utf8');
        } catch (error) {
          throw fileFailure(error, 'temporary');
        }
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

      const filterScriptPath = path.join(tempDirectory, 'final.filter');
      try {
        await fs.writeFile(filterScriptPath, filters.join(';'), 'utf8');
      } catch (error) {
        throw fileFailure(error, 'temporary');
      }

      const extension = path.extname(outPath) || '.mp4';
      const baseName = path.basename(outPath, extension).replace(/[^\p{L}\p{N}._-]+/gu, '-') || 'video';
      partialOutputPath = path.join(path.dirname(outPath), `.${baseName}.gensuite-${Date.now()}.part${extension}`);
      const startPercent = useBatches ? REDUB_AUDIO_PREP_PERCENT : REDUB_INPUT_VALIDATION_PERCENT;
      emitFfmpegProgress(win, {
        projectId,
        timeSec: 0,
        totalSec: totalDurationSec,
        percent: startPercent,
        phase: 'encoding',
      });

      activeStage = 'completing-video';
      try {
        await runMediaProcess({
          binary,
          args: [
            '-y', ...inputs,
            '-filter_complex_script', filterScriptPath,
            ...videoArgs,
            '-map', '[adub]', '-c:a', 'aac', '-movflags', '+faststart', '-shortest',
            '-progress', 'pipe:2', '-nostats', partialOutputPath,
          ],
          onProgress: (seconds) => {
            const ratio = Math.min(1, seconds / totalDurationSec);
            const percent = Math.round(startPercent + ratio * (100 - startPercent));
            emitFfmpegProgress(win, {
              projectId,
              timeSec: Math.min(seconds, totalDurationSec),
              totalSec: totalDurationSec,
              percent,
              phase: 'encoding',
            });
          },
        });
      } catch (error) {
        const classified = processFailure(
          error,
          appFailure('VIDEO_PROCESS_FAILED'),
          undefined,
          'output',
          false,
        );
        if (classified.code === 'VIDEO_PROCESS_FAILED' && error instanceof MediaProcessFailure && error.kind === 'exit') {
          try {
            await ensureFileReadable(sourceVideoPath);
          } catch (accessError) {
            const failure = inputFileFailure(accessError, 'source-video');
            throw appFailure(failure.code, failure.context, {
              ...classified.internalDiagnostics,
              ...failure.internalDiagnostics,
            });
          }
          try {
            await probeVideoDuration(sourceVideoPath);
            await probeVideoDimensions(sourceVideoPath);
          } catch (probeError) {
            const probeFailure = probeInfrastructureFailure(probeError, 'VIDEO_SOURCE_VALIDATION_TIMEOUT');
            if (probeFailure) {
              throw appFailure(probeFailure.code, probeFailure.context, {
                ...classified.internalDiagnostics,
                ...probeFailure.internalDiagnostics,
              });
            }
            throw appFailure('VIDEO_SOURCE_UNREADABLE', undefined, classified.internalDiagnostics);
          }
          const voiceInputFailure = useBatches
            ? await speechTrackInputFailure(speechTracks)
            : await preparedSegmentInputFailure(prepared);
          if (voiceInputFailure) {
            throw appFailure(voiceInputFailure.code, voiceInputFailure.context, {
              ...classified.internalDiagnostics,
              ...voiceInputFailure.internalDiagnostics,
            });
          }
          if (musicPath) {
            try {
              await ensureFileReadable(musicPath);
            } catch (accessError) {
              const failure = inputFileFailure(accessError, 'background-audio');
              throw appFailure(failure.code, failure.context, {
                ...classified.internalDiagnostics,
                ...failure.internalDiagnostics,
              });
            }
            try {
              await probeAudioDuration(musicPath);
            } catch (probeError) {
              const probeFailure = probeInfrastructureFailure(probeError, 'BACKGROUND_AUDIO_VALIDATION_TIMEOUT');
              if (probeFailure) {
                throw appFailure(probeFailure.code, probeFailure.context, {
                  ...classified.internalDiagnostics,
                  ...probeFailure.internalDiagnostics,
                });
              }
              throw appFailure('BACKGROUND_AUDIO_UNREADABLE', undefined, classified.internalDiagnostics);
            }
          }
          try {
            await fs.access(path.dirname(partialOutputPath), fsConstants.W_OK);
          } catch (outputError) {
            throw fileFailure(outputError, 'output');
          }
          throw processFailure(error, appFailure('VIDEO_PROCESS_FAILED'), undefined, 'output', true);
        }
        throw classified;
      }

      let outputStat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        outputStat = await fs.stat(partialOutputPath);
      } catch (error) {
        throw fileFailure(error, 'output');
      }
      if (!outputStat.isFile() || outputStat.size === 0) {
        throw appFailure('VIDEO_OUTPUT_INVALID');
      }
      const outputProbeResults = await Promise.allSettled([
        probeVideoDuration(partialOutputPath),
        probeVideoDimensions(partialOutputPath),
        probeAudioDuration(partialOutputPath),
      ] as const);
      const [durationProbe, dimensionsProbe, audioProbe] = outputProbeResults;
      if (durationProbe.status === 'rejected' || dimensionsProbe.status === 'rejected' || audioProbe.status === 'rejected') {
        const infrastructureFailure = outputProbeResults
          .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          .map((result) => probeInfrastructureFailure(result.reason, 'VIDEO_OUTPUT_VALIDATION_TIMEOUT'))
          .find((failure): failure is AppFailure => failure !== null);
        if (infrastructureFailure) throw infrastructureFailure;
        throw appFailure('VIDEO_OUTPUT_INVALID');
      }
      const outputDuration = durationProbe.value;
      const durationTolerance = Math.max(1, Math.min(5, totalDurationSec * 0.001));
      if (outputDuration < totalDurationSec - durationTolerance) {
        throw appFailure('VIDEO_OUTPUT_INVALID');
      }

      activeStage = 'committing-output';
      const targetExists = await fs.access(outPath).then(() => true).catch(() => false);
      if (targetExists) {
        backupOutputPath = `${outPath}.gensuite-backup-${Date.now()}`;
        try {
          await fs.rename(outPath, backupOutputPath);
        } catch (error) {
          throw fileFailure(error, 'output');
        }
      }
      try {
        await fs.rename(partialOutputPath, outPath);
        partialOutputPath = null;
        outputCommitted = true;
      } catch (error) {
        if (backupOutputPath) {
          try {
            await fs.rename(backupOutputPath, outPath);
            backupOutputPath = null;
          } catch (restoreError) {
            const recoveryFailure = fileFailure(restoreError, 'output');
            throw appFailure('OUTPUT_RECOVERY_FAILED', recoveryFailure.context, {
              ...recoveryFailure.internalDiagnostics,
              classifier: 'output-rollback-failed',
            });
          }
        }
        throw fileFailure(error, 'output');
      }
      if (backupOutputPath && outputCommitted) {
        const committedTargetExists = await fs.access(outPath).then(() => true).catch(() => false);
        if (committedTargetExists) {
          const removed = await fs.rm(backupOutputPath, { force: true }).then(() => true).catch(() => false);
          if (removed) backupOutputPath = null;
        }
      }

      emitFfmpegProgress(win, {
        projectId,
        timeSec: totalDurationSec,
        totalSec: totalDurationSec,
        percent: 100,
        phase: 'complete',
      });
      if (args.revealOutput !== false) shell.showItemInFolder(outPath);
      return appSuccess(outPath);
    } catch (error) {
      return appFailureResult<string | null>(error, 'UNEXPECTED', {
        operation: 'video-completion',
        activeStage,
        segmentCount,
        groupCount,
        usedBatches: groupCount > 0,
      });
    } finally {
      if (partialOutputPath) await fs.rm(partialOutputPath, { force: true }).catch(() => {});
      if (backupOutputPath && outPath && !outputCommitted) {
        const targetExists = await fs.access(outPath).then(() => true).catch(() => false);
        if (!targetExists) {
          await fs.rename(backupOutputPath, outPath).then(() => { backupOutputPath = null; }).catch(() => {});
        }
      }
      // Delete the backup only after this operation itself committed the new
      // output. If restore failed or another process raced us, preserve it.
      if (backupOutputPath && outPath && outputCommitted) {
        const committedTargetExists = await fs.access(outPath).then(() => true).catch(() => false);
        if (committedTargetExists) {
          await fs.rm(backupOutputPath, { force: true }).then(() => { backupOutputPath = null; }).catch(() => {});
        }
      }
      if (tempDirectory) await fs.rm(tempDirectory, { recursive: true, force: true }).catch(() => {});
    }
  });
}
