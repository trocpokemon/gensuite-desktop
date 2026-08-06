import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Maximize, Minimize, Move, Pause, Play, ScanLine, Volume2, VolumeX } from 'lucide-react';
import { localFileUrl } from '../shared/localFile';
import { coverIsActive, subtitleCoverLayers, withSubtitleCoverLayers } from '../shared/subtitleCovers';
import type { OriginalSubtitleCoverLayer, SubtitleConfig } from '../shared/types';

interface TimedPreviewCaption { start: number; end: number; text: string; }

interface Props {
  ratio: 'original' | '16:9' | '9:16';
  backgroundPath?: string;
  backgroundIsVideo?: boolean;
  compact?: boolean;
  config: SubtitleConfig;
  onChange: (next: SubtitleConfig) => void;
  captions?: TimedPreviewCaption[];
  loading?: boolean;
  loadingProgress?: number;
  editMode?: SubtitleEditMode;
  onEditModeChange?: (mode: SubtitleEditMode) => void;
  showToolbar?: boolean;
  zoom?: number;
  viewportWidth?: number;
  viewportHeight?: number;
  seekTime?: number;
  onPlaybackTimeChange?: (currentTime: number, duration: number) => void;
  selectedCoverId?: string;
  onSelectedCoverIdChange?: (id: string) => void;
}

export type SubtitleEditMode = 'subtitle' | 'cover';
type DragState = {
  kind: 'subtitle' | 'subtitle-resize' | 'subtitle-width' | 'cover' | 'draw' | 'resize';
  startX: number;
  startY: number;
  initial: { x: number; y: number; width: number; height: number; fontSize: number };
  corner?: string;
  coverId?: string;
  coverLayers?: OriginalSubtitleCoverLayer[];
};

function withOpacity(color: string, opacity: number): string {
  const value = color.replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(value)) return `rgba(0,0,0,${opacity / 100})`;
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${opacity / 100})`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clock(seconds: number): string {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const minutes = Math.floor(safe / 60);
  return `${String(minutes).padStart(2, '0')}:${String(Math.floor(safe % 60)).padStart(2, '0')}`;
}

export function SubtitleStylePreview({ ratio, backgroundPath, backgroundIsVideo, config, onChange, captions = [], loading = false, loadingProgress = 0, editMode: controlledEditMode, onEditModeChange, showToolbar = true, zoom = 1, viewportWidth = 0, viewportHeight = 0, seekTime, onPlaybackTimeChange, selectedCoverId, onSelectedCoverIdChange }: Props) {
  const fullscreenRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [internalEditMode, setInternalEditMode] = useState<SubtitleEditMode>('subtitle');
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenSize, setFullscreenSize] = useState({ width: 0, height: 0 });
  const editMode = controlledEditMode ?? internalEditMode;
  const setEditMode = (mode: SubtitleEditMode) => {
    setInternalEditMode(mode);
    onEditModeChange?.(mode);
  };
  const [stageHeight, setStageHeight] = useState(430);
  const [sourceAspect, setSourceAspect] = useState(16 / 9);
  const stageAspect = ratio === '16:9' ? 16 / 9 : ratio === '9:16' ? 9 / 16 : sourceAspect;
  const editorHeight = 430;
  const frameWidth = Math.min(764, editorHeight * stageAspect);
  const frameHeight = frameWidth / stageAspect;
  const backgroundUrl = localFileUrl(backgroundPath);
  const covers = subtitleCoverLayers(config);
  const cover = covers.find((item) => item.id === selectedCoverId) ?? covers[0];
  const activeCaption = useMemo(
    () => captions.find((item) => currentTime >= item.start && currentTime < item.end),
    [captions, currentTime],
  );
  const previewText = activeCaption?.text?.trim() || (captions.length ? 'Đang chờ câu thoại tiếp theo…' : 'Phụ đề nổi bật theo lời đọc');
  const allWords = previewText.split(/\s+/).filter(Boolean);
  const globalActiveWord = activeCaption && activeCaption.end > activeCaption.start
    ? clamp(Math.floor(((currentTime - activeCaption.start) / (activeCaption.end - activeCaption.start)) * allWords.length), 0, Math.max(0, allWords.length - 1))
    : Math.min(1, Math.max(0, allWords.length - 1));
  const pageSize = Math.max(1, config.wordsPerPage);
  const pageStart = Math.floor(globalActiveWord / pageSize) * pageSize;
  const words = allWords.slice(pageStart, pageStart + pageSize);
  const activeWord = globalActiveWord - pageStart;
  const outline = Math.max(0, config.outlineWidth * 0.55);
  const textShadow = [
    outline ? `${outline}px 0 ${config.outlineColor}, -${outline}px 0 ${config.outlineColor}, 0 ${outline}px ${config.outlineColor}, 0 -${outline}px ${config.outlineColor}` : '',
    config.shadowDepth ? `${config.shadowDepth * 0.45}px ${config.shadowDepth * 0.45}px ${config.shadowDepth}px rgba(0,0,0,.9)` : '',
  ].filter(Boolean).join(', ');

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const updateSize = () => setStageHeight(stage.getBoundingClientRect().height || 430);
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const syncFullscreen = () => {
      const active = document.fullscreenElement === fullscreenRef.current;
      setIsFullscreen(active);
      if (active) requestAnimationFrame(() => {
        const rect = fullscreenRef.current?.getBoundingClientRect();
        if (rect) setFullscreenSize({ width: rect.width, height: rect.height });
      });
    };
    document.addEventListener('fullscreenchange', syncFullscreen);
    return () => document.removeEventListener('fullscreenchange', syncFullscreen);
  }, []);

  useEffect(() => {
    if (!isFullscreen) return;
    const update = () => {
      const rect = fullscreenRef.current?.getBoundingClientRect();
      if (rect) setFullscreenSize({ width: rect.width, height: rect.height });
    };
    window.addEventListener('resize', update);
    update();
    return () => window.removeEventListener('resize', update);
  }, [isFullscreen]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || seekTime === undefined || !Number.isFinite(seekTime)) return;
    video.currentTime = clamp(seekTime, 0, video.duration || seekTime);
    setCurrentTime(video.currentTime);
  }, [seekTime]);

  useEffect(() => {
    onPlaybackTimeChange?.(currentTime, duration);
  }, [currentTime, duration, onPlaybackTimeChange]);

  const togglePlayback = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play(); else video.pause();
  };

  const toggleFullscreen = async () => {
    if (document.fullscreenElement === fullscreenRef.current) await document.exitFullscreen();
    else await fullscreenRef.current?.requestFullscreen();
  };

  const stagePoint = (event: React.PointerEvent) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: clamp(((event.clientX - rect.left) / rect.width) * 100, 0, 100),
      y: clamp(((event.clientY - rect.top) / rect.height) * 100, 0, 100),
    };
  };

  const beginSubtitleDrag = (event: React.PointerEvent) => {
    event.stopPropagation();
    const point = stagePoint(event);
    dragRef.current = { kind: 'subtitle', startX: point.x, startY: point.y, initial: { x: config.xPct, y: config.yPct, width: config.widthPct, height: 0, fontSize: config.fontSizePct } };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const beginSubtitleResize = (event: React.PointerEvent) => {
    event.stopPropagation();
    const point = stagePoint(event);
    dragRef.current = { kind: 'subtitle-resize', startX: point.x, startY: point.y, initial: { x: config.xPct, y: config.yPct, width: config.widthPct, height: 0, fontSize: config.fontSizePct } };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const beginSubtitleWidth = (event: React.PointerEvent, edge: 'l' | 'r') => {
    event.stopPropagation();
    const point = stagePoint(event);
    dragRef.current = { kind: 'subtitle-width', corner: edge, startX: point.x, startY: point.y, initial: { x: config.xPct, y: config.yPct, width: config.widthPct, height: 0, fontSize: config.fontSizePct } };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const updateCover = (coverId: string, patch: Partial<OriginalSubtitleCoverLayer>, source = covers) => {
    const next = source.map((item) => item.id === coverId ? { ...item, ...patch } : item);
    onChange(withSubtitleCoverLayers(config, next));
  };

  const beginCoverDrag = (event: React.PointerEvent, layer: OriginalSubtitleCoverLayer, kind: 'cover' | 'resize', corner?: string) => {
    event.stopPropagation();
    onSelectedCoverIdChange?.(layer.id);
    const point = stagePoint(event);
    dragRef.current = { kind, corner, coverId: layer.id, coverLayers: covers, startX: point.x, startY: point.y, initial: { x: layer.xPct, y: layer.yPct, width: layer.widthPct, height: layer.heightPct, fontSize: config.fontSizePct } };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const beginDraw = (event: React.PointerEvent) => {
    if (editMode !== 'cover') return;
    const point = stagePoint(event);
    const id = `cover_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const layer: OriginalSubtitleCoverLayer = {
      ...config.originalSubtitleCover,
      enabled: true,
      id,
      name: `Vùng che ${covers.length + 1}`,
      startSec: Math.max(0, currentTime),
      endSec: duration > currentTime ? Math.min(duration, currentTime + 5) : currentTime + 5,
      xPct: point.x,
      yPct: point.y,
      widthPct: 1,
      heightPct: 1,
    };
    const coverLayers = [...covers, layer];
    dragRef.current = { kind: 'draw', coverId: id, coverLayers, startX: point.x, startY: point.y, initial: { x: point.x, y: point.y, width: 0, height: 0, fontSize: config.fontSizePct } };
    onSelectedCoverIdChange?.(id);
    onChange(withSubtitleCoverLayers(config, coverLayers));
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveDrag = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const point = stagePoint(event);
    const dx = point.x - drag.startX;
    const dy = point.y - drag.startY;
    if (drag.kind === 'subtitle') {
      const halfWidth = config.widthPct / 2;
      onChange({ ...config, xPct: clamp(drag.initial.x + dx, halfWidth, 100 - halfWidth), yPct: clamp(drag.initial.y + dy, 5, 95) });
      return;
    }
    if (drag.kind === 'subtitle-resize') {
      const scaleDelta = (dx + dy) * 0.08;
      onChange({ ...config, fontSizePct: Math.round(clamp(drag.initial.fontSize + scaleDelta, 0.5, 15) * 10) / 10 });
      return;
    }
    if (drag.kind === 'subtitle-width') {
      const delta = dx * (drag.corner === 'l' ? -2 : 2);
      const maximumWidth = Math.max(15, Math.min(96, 2 * Math.min(drag.initial.x, 100 - drag.initial.x)));
      onChange({ ...config, widthPct: Math.round(clamp(drag.initial.width + delta, 15, maximumWidth) * 10) / 10 });
      return;
    }
    if (drag.kind === 'draw') {
      const x = Math.min(drag.startX, point.x);
      const y = Math.min(drag.startY, point.y);
      if (drag.coverId) updateCover(drag.coverId, { enabled: true, xPct: x, yPct: y, widthPct: Math.max(2, Math.abs(point.x - drag.startX)), heightPct: Math.max(2, Math.abs(point.y - drag.startY)) }, drag.coverLayers);
      return;
    }
    if (drag.kind === 'cover') {
      if (drag.coverId) updateCover(drag.coverId, { xPct: clamp(drag.initial.x + dx, 0, 100 - drag.initial.width), yPct: clamp(drag.initial.y + dy, 0, 100 - drag.initial.height) }, drag.coverLayers);
      return;
    }
    let { x, y, width, height } = drag.initial;
    if (drag.corner?.includes('l')) { x = clamp(x + dx, 0, x + width - 3); width = drag.initial.width - (x - drag.initial.x); }
    if (drag.corner?.includes('r')) width = clamp(width + dx, 3, 100 - x);
    if (drag.corner?.includes('t')) { y = clamp(y + dy, 0, y + height - 3); height = drag.initial.height - (y - drag.initial.y); }
    if (drag.corner?.includes('b')) height = clamp(height + dy, 3, 100 - y);
    if (drag.coverId) updateCover(drag.coverId, { xPct: x, yPct: y, widthPct: width, heightPct: height }, drag.coverLayers);
  };

  const endDrag = () => { dragRef.current = null; };
  const coverVisual = (layer: OriginalSubtitleCoverLayer): React.CSSProperties => {
    const feather = clamp(layer.featherPct ?? 12, 0, 40);
    const featherMask: React.CSSProperties = feather > 0 ? {
      WebkitMaskImage: `linear-gradient(to right, transparent 0%, black ${feather}%, black ${100 - feather}%, transparent 100%), linear-gradient(to bottom, transparent 0%, black ${feather}%, black ${100 - feather}%, transparent 100%)`,
      WebkitMaskComposite: 'source-in',
      maskImage: `linear-gradient(to right, transparent 0%, black ${feather}%, black ${100 - feather}%, transparent 100%), linear-gradient(to bottom, transparent 0%, black ${feather}%, black ${100 - feather}%, transparent 100%)`,
      maskComposite: 'intersect',
    } : {};
    return layer.mode === 'overlay'
      ? { background: withOpacity(layer.color, layer.opacity), ...featherMask }
      : layer.mode === 'blur'
        ? { backdropFilter: `blur(${Math.max(2, layer.blurStrength)}px)`, background: 'rgba(8,12,18,.12)', ...featherMask }
        : { backdropFilter: `blur(${Math.max(5, layer.blurStrength * 0.7)}px)`, background: 'rgba(255,255,255,.05)', ...featherMask };
  };
  const fullscreenFrameWidth = Math.min(fullscreenSize.width || frameWidth, (fullscreenSize.height || frameHeight) * stageAspect);
  const fullscreenFrameHeight = fullscreenFrameWidth / stageAspect;
  const fitScale = !showToolbar && viewportWidth > 0 && viewportHeight > 0
    ? Math.max(0.5, Math.min((viewportWidth - 64) / frameWidth, (viewportHeight - 64) / frameHeight))
    : 1;
  const editorScale = fitScale * zoom;

  return (
    <div className="flex flex-col gap-2">
      {showToolbar && <div className="flex flex-wrap items-center justify-between gap-2">
        <div><span className="block text-[11px] font-semibold text-white/60">Review video và phụ đề</span><span className="text-[10px] text-white/30">{clock(currentTime)} · kéo trực tiếp trên khung hình</span></div>
        <div className="flex flex-wrap items-center gap-1 rounded-lg border border-white/[0.08] bg-black/25 p-1 text-[10px] font-semibold">
          <label className="flex items-center gap-1.5 px-1.5 text-white/45">Cỡ chữ<input type="number" min={0.5} max={15} step={0.1} value={config.fontSizePct} onChange={(event) => onChange({ ...config, fontSizePct: clamp(Number(event.target.value), 0.5, 15) })} className="w-14 rounded bg-white/[0.07] px-1.5 py-1 text-right text-white/75 outline-none" />%</label>
          <label className="flex items-center gap-1.5 px-1.5 text-white/45">Rộng<input type="number" min={15} max={96} step={1} value={config.widthPct} onChange={(event) => onChange({ ...config, widthPct: clamp(Number(event.target.value), 15, 96) })} className="w-14 rounded bg-white/[0.07] px-1.5 py-1 text-right text-white/75 outline-none" />%</label>
          <button type="button" onClick={() => setEditMode('subtitle')} className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 ${editMode === 'subtitle' ? 'bg-emerald-400 text-black' : 'text-white/45 hover:text-white'}`}><Move size={12} /> Di chuyển phụ đề</button>
          <button type="button" onClick={() => setEditMode('cover')} className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 ${editMode === 'cover' ? 'bg-emerald-400 text-black' : 'text-white/45 hover:text-white'}`}><ScanLine size={12} /> Khoanh vùng che</button>
        </div>
      </div>}
      <div ref={fullscreenRef} className={`flex justify-center ${isFullscreen ? 'h-screen w-screen items-center bg-black p-0' : 'py-1'}`}>
        <div
          ref={stageRef}
          onPointerDown={beginDraw}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          className={`relative select-none overflow-hidden rounded-lg border border-white/[0.08] bg-black shadow-xl ${editMode === 'cover' ? 'cursor-crosshair' : ''}`}
          style={{ aspectRatio: String(stageAspect), width: isFullscreen ? fullscreenFrameWidth : frameWidth * editorScale, height: isFullscreen ? fullscreenFrameHeight : frameHeight * editorScale, maxWidth: isFullscreen ? 'none' : showToolbar ? '100%' : 'none', touchAction: 'none' }}
        >
          {backgroundUrl && (backgroundIsVideo ? (
            <video ref={videoRef} src={backgroundUrl} playsInline preload="metadata" muted={muted} onLoadedMetadata={(event) => { const video = event.currentTarget; if (video.videoWidth > 0 && video.videoHeight > 0) setSourceAspect(video.videoWidth / video.videoHeight); setDuration(video.duration || 0); }} onDurationChange={(event) => setDuration(event.currentTarget.duration || 0)} onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} className="absolute inset-0 h-full w-full object-contain" />
          ) : (
            <img src={backgroundUrl} alt="" className="absolute inset-0 h-full w-full object-contain" draggable={false} />
          ))}

          {covers.map((layer, layerIndex) => {
            const selected = layer.id === cover?.id;
            const active = coverIsActive(layer, currentTime);
            if (!active && !(editMode === 'cover' && selected && layer.enabled)) return null;
            return <div
              key={layer.id}
              onPointerDown={(event) => beginCoverDrag(event, layer, 'cover')}
              className={`absolute ${editMode === 'cover' ? 'cursor-move rounded-sm border border-dashed' : 'pointer-events-none'} ${selected ? 'border-emerald-200' : 'border-white/30 opacity-70'}`}
              style={{ zIndex: 10 + layerIndex, left: `${layer.xPct}%`, top: `${layer.yPct}%`, width: `${layer.widthPct}%`, height: `${layer.heightPct}%` }}
            >
              <span className="pointer-events-none absolute inset-0" style={coverVisual(layer)} />
              {editMode === 'cover' && selected && <>
                <span className="absolute -top-5 left-0 whitespace-nowrap text-[9px] font-semibold text-emerald-200/80">{layer.name}</span>
                {(['lt', 'rt', 'lb', 'rb'] as const).map((corner) => <button key={corner} type="button" aria-label="Đổi kích thước vùng che" onPointerDown={(event) => beginCoverDrag(event, layer, 'resize', corner)} className={`absolute size-6 cursor-nwse-resize ${corner.includes('l') ? '-left-3' : '-right-3'} ${corner.includes('t') ? '-top-3' : '-bottom-3'}`}><span className="pointer-events-none absolute left-1/2 top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-black/70 bg-emerald-200 shadow" /></button>)}
              </>}
            </div>;
          })}

          {config.enabled && <div
            onPointerDown={beginSubtitleDrag}
            className={`absolute z-20 flex -translate-x-1/2 -translate-y-1/2 justify-center ${editMode === 'subtitle' ? 'cursor-move rounded-sm outline outline-1 outline-emerald-300/70' : 'pointer-events-none'}`}
            style={{ left: `${config.xPct}%`, top: `${config.yPct}%`, width: `${config.widthPct}%`, maxWidth: '96%' }}
          >
            <div className={`px-4 py-2 text-center ${config.backgroundStyle === 'bar' ? 'w-full' : ''}`} style={{ background: config.backgroundStyle === 'none' ? 'transparent' : withOpacity(config.backgroundColor, config.backgroundOpacity), borderRadius: config.backgroundStyle === 'rounded' ? config.backgroundRadius : 0 }}>
              <p className="whitespace-normal break-words leading-snug tracking-[-0.02em]" style={{ fontFamily: `"${config.fontFamily}", sans-serif`, fontSize: Math.max(1, stageHeight * config.fontSizePct / 100), fontWeight: config.bold ? 800 : 400, fontStyle: config.italic ? 'italic' : 'normal', color: config.textColor, textShadow, textTransform: config.uppercase ? 'uppercase' : 'none' }}>
                {words.map((word, index) => <span key={`${word}-${index}`} style={index === activeWord ? { color: config.highlightColor, textShadow: `0 0 ${config.highlightGlow}px ${config.highlightColor}` } : index > activeWord ? { opacity: config.futureOpacity / 100 } : undefined}>{index ? ' ' : ''}{word}</span>)}
              </p>
            </div>
            {editMode === 'subtitle' && <>
              <button type="button" aria-label="Kéo để đổi độ rộng phụ đề bên trái" title="Kéo ngang để đổi độ rộng" onPointerDown={(event) => beginSubtitleWidth(event, 'l')} className="absolute -left-3 top-1/2 h-8 w-6 -translate-y-1/2 cursor-ew-resize"><span className="pointer-events-none absolute left-1/2 top-1/2 h-5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-black/70 bg-emerald-200 shadow" /></button>
              <button type="button" aria-label="Kéo để đổi độ rộng phụ đề bên phải" title="Kéo ngang để đổi độ rộng" onPointerDown={(event) => beginSubtitleWidth(event, 'r')} className="absolute -right-3 top-1/2 h-8 w-6 -translate-y-1/2 cursor-ew-resize"><span className="pointer-events-none absolute left-1/2 top-1/2 h-5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-black/70 bg-emerald-200 shadow" /></button>
            </>}
            {editMode === 'subtitle' && <button type="button" aria-label="Kéo để đổi cỡ phụ đề" title="Kéo để đổi cỡ phụ đề" onPointerDown={beginSubtitleResize} className="absolute -bottom-3 -right-3 size-6 cursor-nwse-resize"><span className="pointer-events-none absolute left-1/2 top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-black/70 bg-emerald-200 shadow" /></button>}
          </div>}
          {isFullscreen && <div onPointerDown={(event) => event.stopPropagation()} className="absolute left-1/2 top-4 z-40 flex -translate-x-1/2 items-center gap-1 rounded-xl border border-white/15 bg-black/70 p-1.5 shadow-xl backdrop-blur-md">
            <label className="flex items-center gap-1.5 px-2 text-[11px] font-semibold text-white/65">Cỡ chữ<input type="number" min={0.5} max={15} step={0.1} value={config.fontSizePct} onChange={(event) => onChange({ ...config, fontSizePct: clamp(Number(event.target.value), 0.5, 15) })} className="w-14 rounded-md bg-white/10 px-1.5 py-1 text-right text-white outline-none" />%</label>
            <label className="flex items-center gap-1.5 px-2 text-[11px] font-semibold text-white/65">Rộng<input type="number" min={15} max={96} step={1} value={config.widthPct} onChange={(event) => onChange({ ...config, widthPct: clamp(Number(event.target.value), 15, 96) })} className="w-14 rounded-md bg-white/10 px-1.5 py-1 text-right text-white outline-none" />%</label>
            <button type="button" onClick={() => setEditMode('subtitle')} className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-[11px] font-semibold ${editMode === 'subtitle' ? 'bg-emerald-400 text-black' : 'text-white/70 hover:bg-white/10'}`}><Move size={13} /> Phụ đề</button>
            <button type="button" onClick={() => setEditMode('cover')} className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-[11px] font-semibold ${editMode === 'cover' ? 'bg-emerald-400 text-black' : 'text-white/70 hover:bg-white/10'}`}><ScanLine size={13} /> Vùng che</button>
          </div>}
          {covers.some((layer) => coverIsActive(layer, currentTime) && layer.mode === 'restore') && <span className="absolute right-2 top-2 z-30 rounded bg-black/65 px-2 py-1 text-[9px] text-white/65">Bản xem trước gần đúng</span>}
          {loading && <div className="absolute inset-0 z-50 grid place-items-center bg-[#111722]/95 px-8 text-center"><div className="w-full max-w-xs"><Loader2 size={24} className="mx-auto animate-spin text-emerald-300" /><p className="mt-3 text-sm font-bold text-white/75">Đang tải video review… {Math.round(clamp(loadingProgress, 0, 100))}%</p><div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-emerald-400 transition-all" style={{ width: `${clamp(loadingProgress, 0, 100)}%` }} /></div></div></div>}
          {!backgroundUrl && !loading && <div className="absolute inset-0 z-40 grid place-items-center bg-[#111722] px-8 text-center"><div><p className="text-sm font-bold text-white/70">Chưa có video nguồn để review</p><p className="mt-2 text-xs leading-5 text-white/35">Quay lại bước Video & ngôn ngữ, chọn video rồi mở lại bước Phụ đề.</p></div></div>}
          {backgroundUrl && backgroundIsVideo && <div onPointerDown={(event) => event.stopPropagation()} className="absolute inset-x-0 bottom-0 z-40 flex items-center gap-2 bg-gradient-to-t from-black/90 via-black/55 to-transparent px-3 pb-2 pt-8 opacity-90 transition hover:opacity-100">
            <button type="button" onClick={togglePlayback} aria-label={playing ? 'Tạm dừng' : 'Phát'} className="grid size-8 shrink-0 place-items-center rounded-full text-white hover:bg-white/15">{playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}</button>
            <span className="shrink-0 text-[10px] font-semibold tabular-nums text-white/80">{clock(currentTime)} / {clock(duration)}</span>
            <input type="range" min={0} max={Math.max(duration, 0.01)} step={0.01} value={Math.min(currentTime, Math.max(duration, 0.01))} onChange={(event) => { const next = Number(event.target.value); if (videoRef.current) videoRef.current.currentTime = next; setCurrentTime(next); }} aria-label="Thời gian video" className="min-w-0 flex-1 accent-emerald-400" />
            <button type="button" onClick={() => setMuted((value) => !value)} aria-label={muted ? 'Bật âm thanh' : 'Tắt âm thanh'} className="grid size-8 shrink-0 place-items-center rounded-full text-white hover:bg-white/15">{muted ? <VolumeX size={17} /> : <Volume2 size={17} />}</button>
            <button type="button" onClick={() => void toggleFullscreen()} aria-label={isFullscreen ? 'Thoát toàn màn hình' : 'Toàn màn hình'} className="grid size-8 shrink-0 place-items-center rounded-full text-white hover:bg-white/15">{isFullscreen ? <Minimize size={17} /> : <Maximize size={17} />}</button>
          </div>}
        </div>
      </div>
    </div>
  );
}
