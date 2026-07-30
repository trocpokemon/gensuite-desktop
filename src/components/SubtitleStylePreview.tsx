import { localFileUrl } from '../shared/localFile';
import type { SubtitleConfig } from '../shared/types';

interface Props {
  ratio: '16:9' | '9:16';
  backgroundPath?: string;
  backgroundIsVideo?: boolean;
  compact?: boolean;
  config: SubtitleConfig;
}

function withOpacity(color: string, opacity: number): string {
  const value = color.replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(value)) return `rgba(0,0,0,${opacity / 100})`;
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${opacity / 100})`;
}

export function SubtitleStylePreview({ ratio, backgroundPath, backgroundIsVideo, compact = false, config }: Props) {
  const portrait = ratio === '9:16';
  const stageH = compact ? 156 : portrait ? 260 : 190;
  const stageW = portrait ? (stageH * 9) / 16 : (stageH * 16) / 9;
  const backgroundUrl = localFileUrl(backgroundPath);
  const positionClass = config.position === 'top' ? 'top-[7%]' : config.position === 'middle' ? 'top-1/2 -translate-y-1/2' : 'bottom-[7%]';
  const outline = Math.max(0, config.outlineWidth * 0.55);
  const textShadow = [
    outline ? `${outline}px 0 ${config.outlineColor}, -${outline}px 0 ${config.outlineColor}, 0 ${outline}px ${config.outlineColor}, 0 -${outline}px ${config.outlineColor}` : '',
    config.shadowDepth ? `${config.shadowDepth * 0.45}px ${config.shadowDepth * 0.45}px ${config.shadowDepth}px rgba(0,0,0,.9)` : '',
  ].filter(Boolean).join(', ');

  return (
    <div className="flex flex-col gap-2">
      <span className="text-[11px] text-white/40">Xem trước phong cách mới</span>
      <div className="flex justify-center rounded-xl border border-white/[0.08] bg-black/35 p-3">
        <div
          className="relative overflow-hidden rounded-lg bg-gradient-to-br from-slate-700 via-slate-900 to-black"
          style={{ width: stageW, height: stageH }}
        >
          {backgroundUrl && (backgroundIsVideo ? (
            <video src={backgroundUrl} muted playsInline preload="metadata" className="absolute inset-0 h-full w-full object-cover" />
          ) : (
            <img src={backgroundUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
          ))}
          <div className={`absolute inset-x-[6%] flex justify-center ${positionClass}`} style={{ transform: config.position === 'middle' ? 'translateY(-50%)' : undefined }}>
            <div
              className={`px-4 py-2.5 text-center ${config.backgroundStyle === 'bar' ? 'w-full' : ''}`}
              style={{
                background: config.backgroundStyle === 'none' ? 'transparent' : withOpacity(config.backgroundColor, config.backgroundOpacity),
                borderRadius: config.backgroundStyle === 'rounded' ? config.backgroundRadius : 0,
              }}
            >
              <p
                className="leading-snug tracking-[-0.02em]"
                style={{
                  fontFamily: `"${config.fontFamily}", sans-serif`,
                  fontSize: Math.max(11, stageH * (config.fontSizePct / 100)),
                  fontWeight: config.bold ? 800 : 400,
                  fontStyle: config.italic ? 'italic' : 'normal',
                  color: config.textColor,
                  textShadow,
                  textTransform: config.uppercase ? 'uppercase' : 'none',
                }}
              >
                Phụ đề <span style={{ color: config.highlightColor, textShadow: `0 0 ${config.highlightGlow}px ${config.highlightColor}` }}>nổi bật</span> theo lời đọc
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
