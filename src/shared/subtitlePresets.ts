import type { SubtitleConfig, SubtitlePreset, SubtitleStyle } from './types';

export const DEFAULT_SUBTITLE_PRESET_ID = 'modern';

export const BUILTIN_SUBTITLE_PRESETS: SubtitlePreset[] = [
  {
    id: 'modern', name: 'Hiện đại', builtIn: true,
    style: {
      fontFamily: 'Arial', fontSizePct: 4.2, textColor: '#F8FAFC', highlightColor: '#FBD34F',
      futureOpacity: 40, backgroundStyle: 'rounded', backgroundColor: '#0F172A', backgroundOpacity: 74,
      backgroundRadius: 12, outlineColor: '#0F172A', outlineWidth: 1.4, shadowDepth: 2,
      highlightGlow: 8, position: 'bottom', marginPct: 7, bold: true, italic: false, uppercase: false,
      wordsPerPage: 6,
    },
  },
  {
    id: 'minimal', name: 'Tối giản', builtIn: true,
    style: {
      fontFamily: 'Segoe UI', fontSizePct: 4, textColor: '#FFFFFF', highlightColor: '#67E8F9',
      futureOpacity: 55, backgroundStyle: 'none', backgroundColor: '#000000', backgroundOpacity: 0,
      backgroundRadius: 0, outlineColor: '#000000', outlineWidth: 2.8, shadowDepth: 2,
      highlightGlow: 5, position: 'bottom', marginPct: 8, bold: true, italic: false, uppercase: false,
      wordsPerPage: 7,
    },
  },
  {
    id: 'dynamic', name: 'Năng động', builtIn: true,
    style: {
      fontFamily: 'Arial Black', fontSizePct: 4.5, textColor: '#FFFFFF', highlightColor: '#A3E635',
      futureOpacity: 35, backgroundStyle: 'rounded', backgroundColor: '#020617', backgroundOpacity: 62,
      backgroundRadius: 16, outlineColor: '#020617', outlineWidth: 1.8, shadowDepth: 3,
      highlightGlow: 11, position: 'middle', marginPct: 7, bold: true, italic: false, uppercase: true,
      wordsPerPage: 5,
    },
  },
  {
    id: 'cinematic', name: 'Điện ảnh', builtIn: true,
    style: {
      fontFamily: 'Georgia', fontSizePct: 3.8, textColor: '#FFF7ED', highlightColor: '#F59E0B',
      futureOpacity: 50, backgroundStyle: 'bar', backgroundColor: '#000000', backgroundOpacity: 48,
      backgroundRadius: 0, outlineColor: '#000000', outlineWidth: 1.2, shadowDepth: 3,
      highlightGlow: 4, position: 'bottom', marginPct: 9, bold: true, italic: true, uppercase: false,
      wordsPerPage: 7,
    },
  },
];

export function subtitleConfigFromStyle(style: SubtitleStyle, presetId = ''): SubtitleConfig {
  const yPct = style.position === 'top' ? 12 : style.position === 'middle' ? 50 : 88;
  return {
    enabled: true,
    presetId,
    ...style,
    xPct: 50,
    yPct,
    widthPct: 88,
    originalSubtitleCover: {
      enabled: false,
      mode: 'overlay',
      xPct: 18,
      yPct: 76,
      widthPct: 64,
      heightPct: 14,
      opacity: 82,
      blurStrength: 14,
      featherPct: 12,
      color: '#0F172A',
    },
    originalSubtitleCovers: [],
  };
}

export function subtitleStyleFromConfig(config: SubtitleConfig): SubtitleStyle {
  const {
    enabled: _enabled,
    presetId: _presetId,
    xPct: _xPct,
    yPct: _yPct,
    widthPct: _widthPct,
    originalSubtitleCover: _originalSubtitleCover,
    originalSubtitleCovers: _originalSubtitleCovers,
    ...style
  } = config;
  return style;
}

export const DEFAULT_SUBTITLE_CONFIG: SubtitleConfig = subtitleConfigFromStyle(
  BUILTIN_SUBTITLE_PRESETS[0].style,
  DEFAULT_SUBTITLE_PRESET_ID,
);

export function findSubtitlePreset(id: string, custom: SubtitlePreset[] = []): SubtitlePreset {
  return [...BUILTIN_SUBTITLE_PRESETS, ...custom].find((preset) => preset.id === id)
    ?? BUILTIN_SUBTITLE_PRESETS[0];
}
