import { ipcMain, BrowserWindow, dialog, shell, app } from 'electron';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Video assembly via bundled FFmpeg. Builds a concat of image clips (one per
// scene, duration matched to its audio) muxed with the narration track.

type Scene = {
  id: string;
  imagePath: string;   // absolute path to chosen image or video in project dir
  visualType?: 'stock-image' | 'stock-video' | 'ai-image' | 'ai-video' | 'upload';
  audioPath: string;   // absolute path to segment audio
  durationSec: number; // measured audio duration
  narration?: string;  // caption text burned in when subtitles are enabled
};

type SubtitleConfig = {
  enabled: boolean;
  fontFamily: string;
  fontSizePct: number;
  primaryColor: string;
  outlineColor: string;
  outlineWidth: number;
  shadow: number;
  bold: boolean;
  position: 'top' | 'middle' | 'bottom';
  maxCharsPerLine: number;
};

const DEFAULT_SUBTITLE: SubtitleConfig = {
  enabled: true,
  fontFamily: 'Arial',
  fontSizePct: 5,
  primaryColor: '#FFFFFF',
  outlineColor: '#000000',
  outlineWidth: 3,
  shadow: 1,
  bold: true,
  position: 'bottom',
  maxCharsPerLine: 42,
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
};

type RedubArgs = {
  projectId: string;
  sourceVideoPath: string;
  segments: RedubSegment[];
  subtitles?: boolean;
  subtitleConfig?: SubtitleConfig;
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
    child.on('error', (error) => reject(new Error(`Không thể chạy FFprobe: ${error.message}`)));
    child.on('close', (code) => {
      const duration = Number.parseFloat(stdout.trim());
      if (code === 0 && Number.isFinite(duration) && duration > 0) resolve(duration);
      else reject(new Error(`Không đọc được thời lượng audio: ${stderr.slice(-300)}`));
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

// CJK ideographs, kana, Hangul, and full-width forms occupy two display cells;
// everything else counts as one. This lets us budget subtitle line length the way
// KrillinAI does, so a line of Chinese doesn't run twice as wide as a Latin line.
const CJK_RE = /[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯가-힯]/;
function isWideChar(ch: string): boolean { return CJK_RE.test(ch); }
function containsCJK(text: string): boolean { return CJK_RE.test(text); }
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += isWideChar(ch) ? 2 : 1;
  return width;
}

// Portrait (9:16) videos are much narrower, so cap the per-line budget tighter
// regardless of the user's setting — mirrors KrillinAI's vertical wrap limit.
const PORTRAIT_MAX_UNITS = 32;

// Trailing punctuation should never start a new line on its own.
const TRAILING_PUNCT_RE = /^[，。！？、；：,.!?;:）)】」』…]+$/;
function isTrailingPunct(token: string): boolean { return TRAILING_PUNCT_RE.test(token); }

// Balanced line packer: fills lines up to a display-width budget but first spreads
// the text across the minimum number of lines evenly (so the last line isn't a
// lonely tail). Tokens are runes for CJK (joiner '') or words for Latin (joiner ' ').
function packLines(tokens: string[], budget: number, joiner: string): string[] {
  const joinWidth = displayWidth(joiner);
  const total = tokens.reduce((sum, t) => sum + displayWidth(t), 0) + joinWidth * Math.max(0, tokens.length - 1);
  const numLines = Math.max(1, Math.ceil(total / budget));
  const target = Math.max(Math.ceil(budget / 2), Math.ceil(total / numLines));
  const lines: string[] = [];
  let current = '';
  let currentWidth = 0;
  for (const tok of tokens) {
    const tokWidth = displayWidth(tok);
    const addWidth = current ? joinWidth + tokWidth : tokWidth;
    if (current && currentWidth + addWidth > target && lines.length < numLines - 1 && !isTrailingPunct(tok)) {
      lines.push(current);
      current = tok;
      currentWidth = tokWidth;
    } else {
      current = current ? current + joiner + tok : tok;
      currentWidth += addWidth;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// Soft-wrap a caption to a per-line display-width budget, joined with the ASS hard
// break `\N`. CJK text (no word spaces) is split rune-by-rune; Latin text on word
// boundaries. Portrait videos always get a tighter cap. budget <= 0 in landscape
// disables wrapping.
function wrapCaption(text: string, maxUnits: number, isPortrait: boolean): string {
  const base = maxUnits > 0 ? maxUnits : Number.POSITIVE_INFINITY;
  const budget = isPortrait ? Math.min(base, PORTRAIT_MAX_UNITS) : base;
  if (!Number.isFinite(budget) || displayWidth(text) <= budget) return text;
  const tokens = containsCJK(text) ? [...text] : text.split(' ').filter(Boolean);
  const joiner = containsCJK(text) ? '' : ' ';
  return packLines(tokens, budget, joiner).join('\\N');
}

// Known CJK-capable font families the UI offers. When a caption contains CJK and
// the user already picked one of these, we honour their choice instead of forcing
// the OS default — so the font dropdown stays meaningful for CJK subtitles.
const CJK_FONTS = new Set([
  'Microsoft YaHei', 'SimHei', 'SimSun', 'KaiTi', 'NSimSun',
  'PingFang SC', 'Hiragino Sans GB', 'STHeiti',
  'Noto Sans CJK SC', 'Noto Serif CJK SC', 'Source Han Sans SC',
  'Malgun Gothic', 'Yu Gothic', 'Meiryo', 'MS Gothic',
]);
function isCjkFont(name: string): boolean { return CJK_FONTS.has(name.trim()); }

// A CJK-capable font family that ships by default on each OS, used when a caption
// contains CJK characters but the user's chosen font is Latin-only (it can't render
// those glyphs). libass resolves the family from the fonts dir passed to the filter.
function cjkFontFamily(): string {
  if (process.platform === 'win32') return 'Microsoft YaHei';
  if (process.platform === 'darwin') return 'PingFang SC';
  return 'Noto Sans CJK SC';
}

// Pick the font to write into the ASS style: keep the user's choice unless the
// caption needs CJK glyphs and their font can't provide them.
function resolveFontName(userFont: string, anyCJK: boolean): string {
  if (anyCJK && !isCjkFont(userFont)) return cjkFontFamily();
  return userFont;
}

// ASS numpad alignment: 8 = top-center, 5 = middle-center, 2 = bottom-center.
function alignmentFor(position: SubtitleConfig['position']): number {
  return position === 'top' ? 8 : position === 'middle' ? 5 : 2;
}

// Build a burned-in subtitle track timed to the *narration* audio, which is a
// straight concat — so each caption spans [cumulative, cumulative+durationSec],
// independent of the video crossfades.
function buildAssFile(scenes: Scene[], w: number, h: number, cfg: SubtitleConfig): string {
  const fontSize = Math.max(8, Math.round(h * (cfg.fontSizePct / 100)));
  // Outline/shadow are authored at 1080p; scale so they look consistent at 9:16.
  const scale = h / 1080;
  const outline = Math.max(0, Math.round(cfg.outlineWidth * scale));
  const shadow = Math.max(0, Math.round(cfg.shadow * scale));
  const marginV = Math.round(h * 0.07);
  const marginH = Math.round(w * 0.06);
  const bold = cfg.bold ? -1 : 0;
  const alignment = alignmentFor(cfg.position);
  const primary = hexToAssColor(cfg.primaryColor);
  const outlineColor = hexToAssColor(cfg.outlineColor);
  const isPortrait = h > w;
  const anyCJK = scenes.some((s) => containsCJK(s.narration ?? ''));
  const fontName = resolveFontName(cfg.fontFamily, anyCJK);

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${w}`,
    `PlayResY: ${h}`,
    'WrapStyle: 2', // honour our manual \N breaks, no auto-rewrap
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${fontName},${fontSize},${primary},&H000000FF,${outlineColor},&H80000000,${bold},0,0,0,100,100,0,0,1,${outline},${shadow},${alignment},${marginH},${marginH},${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const events: string[] = [];
  let elapsed = 0;
  for (const scene of scenes) {
    const text = wrapCaption(assEscape(scene.narration ?? ''), cfg.maxCharsPerLine, isPortrait);
    const start = elapsed;
    const end = elapsed + scene.durationSec;
    elapsed = end;
    if (!text) continue;
    events.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Default,,0,0,0,,${text}`);
  }

  return `${header.join('\n')}\n${events.join('\n')}\n`;
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
function buildRedubAssFile(segments: RedubSegment[], w: number, h: number, cfg: SubtitleConfig): string {
  const fontSize = Math.max(8, Math.round(h * (cfg.fontSizePct / 100)));
  const scale = h / 1080;
  const outline = Math.max(0, Math.round(cfg.outlineWidth * scale));
  const shadow = Math.max(0, Math.round(cfg.shadow * scale));
  const marginV = Math.round(h * 0.07);
  const marginH = Math.round(w * 0.06);
  const bold = cfg.bold ? -1 : 0;
  const alignment = alignmentFor(cfg.position);
  const primary = hexToAssColor(cfg.primaryColor);
  const outlineColor = hexToAssColor(cfg.outlineColor);
  const isPortrait = h > w;
  const anyCJK = segments.some((seg) => containsCJK(seg.text ?? ''));
  const fontName = resolveFontName(cfg.fontFamily, anyCJK);

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
    `Style: Default,${fontName},${fontSize},${primary},&H000000FF,${outlineColor},&H80000000,${bold},0,0,0,100,100,0,0,1,${outline},${shadow},${alignment},${marginH},${marginH},${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const events: string[] = [];
  for (const seg of segments) {
    const text = wrapCaption(assEscape(seg.text ?? ''), cfg.maxCharsPerLine, isPortrait);
    if (!text) continue;
    const end = seg.sourceEnd > seg.sourceStart ? seg.sourceEnd : seg.sourceStart + 1;
    events.push(`Dialogue: 0,${assTime(seg.sourceStart)},${assTime(end)},Default,,0,0,0,,${text}`);
  }

  return `${header.join('\n')}\n${events.join('\n')}\n`;
}

export function registerFfmpegIpc(): void {
  ipcMain.handle('ffmpeg:export', async (e, args: ExportArgs): Promise<string | null> => {
    const { projectId, scenes, ratio } = args;
    if (!scenes?.length) throw new Error('ffmpeg:export needs at least one scene');
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
      throw new Error('Không thể xuất video: thiếu FFmpeg hoặc file media/audio của một phân cảnh.');
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
    const subConfig = { ...DEFAULT_SUBTITLE, ...(args.subtitleConfig ?? {}) };
    const wantSubtitles = args.subtitles === true && preparedScenes.some((s) => (s.narration ?? '').trim());
    let assPath: string | null = null;
    let videoLabel = 'vout';
    if (wantSubtitles) {
      assPath = path.join(os.tmpdir(), `gensuite-subs-${projectId}-${Date.now()}.ass`);
      await fs.writeFile(assPath, buildAssFile(preparedScenes, w, h, subConfig), 'utf8');
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
        reject(new Error(`Không thể khởi động FFmpeg: ${err.message}`));
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
          reject(new Error(`FFmpeg exited ${code}: ${stderr.slice(-600)}`));
        }
      });
    });
  });

  // Re-dub: keep the original video untouched, drop its audio entirely, and lay
  // the translated speech back over it — each line time-stretched to fit its
  // source window and anchored at the original start time.
  ipcMain.handle('ffmpeg:redub', async (e, args: RedubArgs): Promise<string | null> => {
    const { projectId, sourceVideoPath, segments } = args;
    if (!sourceVideoPath) throw new Error('ffmpeg:redub needs a source video');
    if (!segments?.length) throw new Error('ffmpeg:redub needs at least one segment');
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
      throw new Error('Không thể lồng tiếng: thiếu FFmpeg hoặc file video gốc/audio.');
    }

    win?.webContents.send('ffmpeg:progress', { projectId, timeSec: 0, phase: 'preparing' });

    const videoDur = await probeDuration(sourceVideoPath).catch(() => 0);
    const [vw, vh] = await probeVideoDimensions(sourceVideoPath);

    // Measure each line's real TTS duration to decide how hard to compress it.
    const prepared = await Promise.all(segments.map(async (seg) => {
      const ttsDur = await probeDuration(seg.audioPath).catch(() => 0);
      const windowLen = Math.max(0, seg.sourceEnd - seg.sourceStart);
      const factor = windowLen > 0 && ttsDur > windowLen ? ttsDur / windowLen : 1;
      return { ...seg, ttsDur, factor };
    }));

    const saveRes = await dialog.showSaveDialog(win!, {
      title: 'Lưu video đã lồng tiếng',
      defaultPath: path.join(app.getPath('videos'), `gensuite-dub-${Date.now()}.mp4`),
      filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
    });
    if (saveRes.canceled || !saveRes.filePath) return null;
    const outPath = saveRes.filePath;

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
    const mixInputs = ['[base]', ...prepared.map((_, i) => `[a${i}]`)].join('');
    filters.push(`${mixInputs}amix=inputs=${prepared.length + 1}:duration=first:normalize=0[adub]`);

    // Subtitles force a video re-encode (the ass filter must touch the frames);
    // without them we stream-copy the original video untouched.
    const subConfig = { ...DEFAULT_SUBTITLE, ...(args.subtitleConfig ?? {}) };
    const wantSubtitles = args.subtitles === true && prepared.some((s) => (s.text ?? '').trim());
    let assPath: string | null = null;
    const videoArgs: string[] = [];
    if (wantSubtitles) {
      assPath = path.join(os.tmpdir(), `gensuite-dub-${projectId}-${Date.now()}.ass`);
      await fs.writeFile(assPath, buildRedubAssFile(prepared, vw, vh, subConfig), 'utf8');
      const assArgs = [`f='${escapeAssPath(assPath)}'`];
      if (process.platform === 'win32' && process.env.WINDIR) {
        assArgs.push(`fontsdir='${escapeAssPath(path.join(process.env.WINDIR, 'Fonts'))}'`);
      }
      filters.push(`[0:v]ass=${assArgs.join(':')}[vsub]`);
      videoArgs.push('-map', '[vsub]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p');
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
        reject(new Error(`Không thể khởi động FFmpeg: ${err.message}`));
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
          reject(new Error(`FFmpeg exited ${code}: ${stderr.slice(-600)}`));
        }
      });
    });
  });
}
