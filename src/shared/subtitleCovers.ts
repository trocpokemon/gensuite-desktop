import type { OriginalSubtitleCoverConfig, OriginalSubtitleCoverLayer, SubtitleConfig } from './types';

const MIN_COVER_DURATION_SEC = 0.25;

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function subtitleCoverLayers(config: SubtitleConfig): OriginalSubtitleCoverLayer[] {
  if (Array.isArray(config.originalSubtitleCovers) && config.originalSubtitleCovers.length) {
    return config.originalSubtitleCovers.map((layer, index) => ({
      ...layer,
      id: typeof layer.id === 'string' && layer.id ? layer.id : `cover_${index + 1}`,
      name: typeof layer.name === 'string' && layer.name.trim() ? layer.name.trim() : `Vùng che ${index + 1}`,
      startSec: Math.max(0, finite(layer.startSec, 0)),
      endSec: typeof layer.endSec === 'number' && Number.isFinite(layer.endSec)
        ? Math.max(Math.max(0, finite(layer.startSec, 0)) + MIN_COVER_DURATION_SEC, layer.endSec)
        : undefined,
    }));
  }
  const legacy = config.originalSubtitleCover;
  if (!legacy?.enabled) return [];
  return [{ ...legacy, id: 'cover_legacy', name: 'Vùng che 1', startSec: 0 }];
}

export function withSubtitleCoverLayers(config: SubtitleConfig, layers: OriginalSubtitleCoverLayer[]): SubtitleConfig {
  const first = layers[0];
  const legacy: OriginalSubtitleCoverConfig = first
    ? {
      enabled: first.enabled,
      mode: first.mode,
      xPct: first.xPct,
      yPct: first.yPct,
      widthPct: first.widthPct,
      heightPct: first.heightPct,
      opacity: first.opacity,
      blurStrength: first.blurStrength,
      featherPct: first.featherPct,
      color: first.color,
    }
    : { ...config.originalSubtitleCover, enabled: false };
  return { ...config, originalSubtitleCover: legacy, originalSubtitleCovers: layers };
}

export function coverIsActive(layer: OriginalSubtitleCoverLayer, timeSec: number): boolean {
  return layer.enabled && timeSec >= layer.startSec && (layer.endSec === undefined || timeSec < layer.endSec);
}
