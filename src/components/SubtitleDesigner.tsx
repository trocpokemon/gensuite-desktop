import { useEffect, useMemo, useRef, useState } from 'react';
import { BookmarkCheck, Eye, EyeOff, Maximize2, Minus, Move, Plus, Save, ScanLine, Trash2 } from 'lucide-react';
import type { LocalizeAspectRatio, OriginalSubtitleCoverLayer, OriginalSubtitleCoverMode, SubtitleBackgroundStyle, SubtitleConfig, SubtitlePosition, SubtitlePreset } from '../shared/types';
import { BUILTIN_SUBTITLE_PRESETS, subtitleStyleFromConfig } from '../shared/subtitlePresets';
import { subtitleCoverLayers, withSubtitleCoverLayers } from '../shared/subtitleCovers';
import { useSettingsStore } from '../store/settingsStore';
import { SubtitleStylePreview, type SubtitleEditMode } from './SubtitleStylePreview';
import { AppSelect, type AppSelectOption } from './AppSelect';

interface Caption { start: number; end: number; text: string; }

interface Props {
  config: SubtitleConfig;
  onChange: (next: SubtitleConfig) => void;
  ratio: LocalizeAspectRatio;
  onRatioChange?: (ratio: LocalizeAspectRatio) => void;
  backgroundPath?: string;
  backgroundIsVideo?: boolean;
  captions?: Caption[];
  reviewLoading?: boolean;
  reviewProgress?: number;
}

const FONTS = ['Arial', 'Segoe UI', 'Arial Black', 'Tahoma', 'Verdana', 'Georgia', 'Times New Roman', 'Microsoft YaHei', 'Malgun Gothic', 'Yu Gothic'];
const POSITIONS: Array<[SubtitlePosition, string]> = [['top', 'Trên'], ['middle', 'Giữa'], ['bottom', 'Dưới']];
const BACKGROUNDS: Array<[SubtitleBackgroundStyle, string]> = [['rounded', 'Hộp bo mềm'], ['bar', 'Dải ngang'], ['none', 'Không nền']];
const FONT_OPTIONS = FONTS.map((font) => ({ value: font, label: font }));
const POSITION_OPTIONS = POSITIONS.map(([value, label]) => ({ value, label }));
const BACKGROUND_OPTIONS = BACKGROUNDS.map(([value, label]) => ({ value, label }));
const RATIO_OPTIONS: AppSelectOption<LocalizeAspectRatio>[] = [
  { value: 'original', label: 'Theo video gốc' },
  { value: '16:9', label: '16:9 · Ngang' },
  { value: '9:16', label: '9:16 · Dọc' },
];

function clamp(value: number, min: number, max: number) { return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min)); }

function clock(seconds: number) {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(Math.floor(safe % 60)).padStart(2, '0')}`;
}

function InspectorSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="border-b border-white/[0.07] px-4 py-4"><h3 className="mb-3 text-[10px] font-black uppercase tracking-[0.14em] text-white/35">{title}</h3><div className="space-y-3">{children}</div></section>;
}

function SelectField({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: AppSelectOption[] }) {
  return <label className="block"><span className="mb-1.5 block text-[10px] font-semibold text-white/40">{label}</span><AppSelect value={value} onChange={onChange} options={options} ariaLabel={label} className="rounded-lg px-3 py-2 text-xs" /></label>;
}

function NumberField({ label, value, min, max, step = 1, suffix = '', onChange }: { label: string; value: number; min: number; max: number; step?: number; suffix?: string; onChange: (value: number) => void }) {
  return <label className="block"><span className="mb-1.5 flex items-center justify-between text-[10px] font-semibold text-white/40"><span>{label}</span><span className="text-white/25">{suffix}</span></span><input type="number" value={value} min={min} max={max} step={step} onChange={(event) => onChange(clamp(Number(event.target.value), min, max))} className="field-surface w-full rounded-lg px-3 py-2 text-xs font-semibold text-white/75 outline-none" /></label>;
}

function SliderField({ label, value, min, max, step = 1, suffix = '', onChange }: { label: string; value: number; min: number; max: number; step?: number; suffix?: string; onChange: (value: number) => void }) {
  return <label className="block"><span className="mb-2 flex items-center justify-between text-[10px] font-semibold text-white/40"><span>{label}</span><span className="text-white/60">{value}{suffix}</span></span><input type="range" value={value} min={min} max={max} step={step} onChange={(event) => onChange(clamp(Number(event.target.value), min, max))} className="w-full accent-emerald-400" /></label>;
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label className="flex items-center justify-between rounded-lg border border-white/[0.07] bg-white/[0.025] px-3 py-2"><span className="text-[10px] font-semibold text-white/45">{label}</span><input type="color" value={value} onChange={(event) => onChange(event.target.value)} className="h-7 w-9 cursor-pointer rounded border-0 bg-transparent" /></label>;
}

export function SubtitleDesigner({ config, onChange, ratio, onRatioChange, backgroundPath, backgroundIsVideo, captions = [], reviewLoading, reviewProgress }: Props) {
  const preferences = useSettingsStore((state) => state.keys);
  const savePreferences = useSettingsStore((state) => state.save);
  const [editMode, setEditMode] = useState<SubtitleEditMode>('subtitle');
  const [zoom, setZoom] = useState(1);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [seekTime, setSeekTime] = useState<number>();
  const [creating, setCreating] = useState(false);
  const [presetName, setPresetName] = useState('');
  const [message, setMessage] = useState('');
  const [dirty, setDirty] = useState(false);
  const [selectedCoverId, setSelectedCoverId] = useState('');
  const canvasRef = useRef<HTMLElement>(null);
  const timelineTrackRef = useRef<HTMLDivElement>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const presets = useMemo(() => [...BUILTIN_SUBTITLE_PRESETS, ...(preferences.subtitlePresets ?? [])], [preferences.subtitlePresets]);
  const selectedPreset = presets.find((preset) => preset.id === config.presetId);
  const selectedCustom = selectedPreset && !selectedPreset.builtIn ? selectedPreset : null;
  const timelineDuration = Math.max(1, duration, ...captions.map((caption) => caption.end));
  const activeCaptionIndex = captions.findIndex((caption) => currentTime >= caption.start && currentTime < caption.end);
  const covers = subtitleCoverLayers(config);
  const selectedCover = covers.find((cover) => cover.id === selectedCoverId) ?? covers[0];

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const updateSize = () => {
      const rect = canvas.getBoundingClientRect();
      setCanvasSize({ width: rect.width, height: rect.height });
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!covers.length) {
      if (selectedCoverId) setSelectedCoverId('');
      return;
    }
    if (!covers.some((cover) => cover.id === selectedCoverId)) setSelectedCoverId(covers[0].id);
  }, [covers, selectedCoverId]);

  const update = (patch: Partial<SubtitleConfig>) => { setDirty(true); onChange({ ...config, ...patch }); };
  const setCovers = (next: OriginalSubtitleCoverLayer[]) => onChange(withSubtitleCoverLayers(config, next));
  const updateCover = (patch: Partial<OriginalSubtitleCoverLayer>) => {
    if (!selectedCover) return;
    setCovers(covers.map((cover) => cover.id === selectedCover.id ? { ...cover, ...patch } : cover));
  };
  const addCover = () => {
    const id = `cover_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const startSec = clamp(currentTime, 0, Math.max(0, timelineDuration - 0.25));
    const layer: OriginalSubtitleCoverLayer = {
      ...config.originalSubtitleCover,
      enabled: true,
      id,
      name: `Vùng che ${covers.length + 1}`,
      startSec,
      endSec: Math.min(timelineDuration, startSec + 5),
    };
    setSelectedCoverId(id);
    setEditMode('cover');
    setCovers([...covers, layer]);
  };
  const removeCover = () => {
    if (!selectedCover) return;
    const next = covers.filter((cover) => cover.id !== selectedCover.id);
    setSelectedCoverId(next[0]?.id ?? '');
    setCovers(next);
  };
  const beginCoverTimeDrag = (event: React.PointerEvent, layer: OriginalSubtitleCoverLayer, mode: 'start' | 'end' | 'move') => {
    event.preventDefault();
    event.stopPropagation();
    const rect = timelineTrackRef.current?.getBoundingClientRect();
    if (!rect?.width) return;
    setSelectedCoverId(layer.id);
    setEditMode('cover');
    setSeekTime(layer.startSec);
    const initialStart = clamp(layer.startSec, 0, timelineDuration);
    const initialEnd = clamp(layer.endSec ?? timelineDuration, initialStart + 0.25, timelineDuration);
    const snapshot = covers;
    const startX = event.clientX;
    const onMove = (moveEvent: PointerEvent) => {
      const delta = ((moveEvent.clientX - startX) / rect.width) * timelineDuration;
      let startSec = initialStart;
      let endSec = initialEnd;
      if (mode === 'start') startSec = clamp(initialStart + delta, 0, initialEnd - 0.25);
      if (mode === 'end') endSec = clamp(initialEnd + delta, initialStart + 0.25, timelineDuration);
      if (mode === 'move') {
        const length = initialEnd - initialStart;
        startSec = clamp(initialStart + delta, 0, Math.max(0, timelineDuration - length));
        endSec = startSec + length;
      }
      onChange(withSubtitleCoverLayers(config, snapshot.map((cover) => cover.id === layer.id ? { ...cover, startSec, endSec } : cover)));
    };
    const onEnd = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
  };
  const applyPreset = (id: string) => {
    const preset = presets.find((item) => item.id === id);
    if (!preset) return;
    const positionY = preset.style.position === 'top' ? 12 : preset.style.position === 'middle' ? 50 : 88;
    setDirty(false);
    onChange({ enabled: config.enabled, presetId: preset.id, ...preset.style, xPct: 50, yPct: positionY, widthPct: config.widthPct, originalSubtitleCover: config.originalSubtitleCover, originalSubtitleCovers: covers });
  };
  const persist = async (nextPresets: SubtitlePreset[], defaultId = preferences.defaultSubtitlePresetId) => savePreferences({ ...preferences, subtitlePresets: nextPresets, defaultSubtitlePresetId: defaultId });
  const createPreset = async () => {
    const name = presetName.trim();
    if (!name) return;
    const preset: SubtitlePreset = { id: `custom_${Date.now().toString(36)}`, name, style: subtitleStyleFromConfig(config) };
    try { await persist([...(preferences.subtitlePresets ?? []), preset]); onChange({ ...config, presetId: preset.id }); setDirty(false); setPresetName(''); setCreating(false); setMessage('Đã lưu preset mới.'); }
    catch { setMessage('Không thể lưu preset. Vui lòng thử lại.'); }
  };
  const updatePreset = async () => {
    if (!selectedCustom) return;
    try { await persist((preferences.subtitlePresets ?? []).map((preset) => preset.id === selectedCustom.id ? { ...preset, style: subtitleStyleFromConfig(config) } : preset)); setDirty(false); setMessage('Đã cập nhật preset.'); }
    catch { setMessage('Không thể cập nhật preset. Vui lòng thử lại.'); }
  };
  const deletePreset = async () => {
    if (!selectedCustom || !window.confirm(`Xóa preset “${selectedCustom.name}”?`)) return;
    const remaining = (preferences.subtitlePresets ?? []).filter((preset) => preset.id !== selectedCustom.id);
    const nextDefault = preferences.defaultSubtitlePresetId === selectedCustom.id ? BUILTIN_SUBTITLE_PRESETS[0].id : preferences.defaultSubtitlePresetId;
    try { await persist(remaining, nextDefault); applyPreset(BUILTIN_SUBTITLE_PRESETS[0].id); setMessage('Đã xóa preset.'); }
    catch { setMessage('Không thể xóa preset. Vui lòng thử lại.'); }
  };
  const setDefault = async () => {
    if (!config.presetId || dirty) { setMessage('Hãy lưu thiết kế trước khi đặt mặc định.'); return; }
    try { await persist(preferences.subtitlePresets ?? [], config.presetId); setMessage('Preset này sẽ dùng cho dự án mới.'); }
    catch { setMessage('Không thể đổi preset mặc định. Vui lòng thử lại.'); }
  };

  return <div className="grid h-full min-h-[620px] grid-cols-[58px_minmax(0,1fr)_300px] grid-rows-[54px_minmax(320px,1fr)_166px] overflow-hidden rounded-xl border border-white/[0.09] bg-[#111112] shadow-2xl">
    <header className="col-span-3 flex min-w-0 items-center justify-between gap-3 border-b border-white/[0.08] bg-[#181819] px-3">
      <div className="flex min-w-0 items-center gap-2">
        <div className="mr-2 min-w-0"><p className="truncate text-xs font-bold text-white/85">Trình chỉnh sửa phụ đề</p></div>
        <AppSelect value={ratio} onChange={(value) => onRatioChange?.(value)} options={RATIO_OPTIONS} ariaLabel="Tỷ lệ video" className="w-auto min-w-36 rounded-lg px-2.5 py-2 text-[10px] font-semibold" />
      </div>
      <div className="flex items-center gap-1 rounded-lg border border-white/[0.07] bg-black/20 p-1">
        <button type="button" onClick={() => setZoom((value) => clamp(value - 0.25, 0.5, 2))} className="grid size-7 place-items-center rounded text-white/45 hover:bg-white/[0.08] hover:text-white"><Minus size={13} /></button>
        <button type="button" onClick={() => setZoom(1)} className="min-w-12 rounded px-2 py-1.5 text-[10px] font-semibold text-white/55 hover:bg-white/[0.08]">{Math.round(zoom * 100)}%</button>
        <button type="button" onClick={() => setZoom((value) => clamp(value + 0.25, 0.5, 2))} className="grid size-7 place-items-center rounded text-white/45 hover:bg-white/[0.08] hover:text-white"><Plus size={13} /></button>
        <button type="button" title="Vừa khung" onClick={() => setZoom(1)} className="grid size-7 place-items-center rounded text-white/45 hover:bg-white/[0.08] hover:text-white"><Maximize2 size={13} /></button>
      </div>
    </header>

    <aside className="row-start-2 flex flex-col items-center gap-2 border-r border-white/[0.08] bg-[#151516] py-3">
      <button type="button" title="Chỉnh phụ đề" onClick={() => setEditMode('subtitle')} className={`flex h-12 w-11 flex-col items-center justify-center gap-1 rounded-lg text-[9px] font-semibold ${editMode === 'subtitle' ? 'bg-emerald-400 text-black' : 'text-white/40 hover:bg-white/[0.05] hover:text-white'}`}><Move size={16} /> Phụ đề</button>
      <button type="button" title="Khoanh vùng che" onClick={() => setEditMode('cover')} className={`flex h-12 w-11 flex-col items-center justify-center gap-1 rounded-lg text-[9px] font-semibold ${editMode === 'cover' ? 'bg-emerald-400 text-black' : 'text-white/40 hover:bg-white/[0.05] hover:text-white'}`}><ScanLine size={16} /> Vùng che</button>
    </aside>

    <main ref={canvasRef} className="relative row-start-2 min-h-0 overflow-auto bg-[#09090a] [background-image:radial-gradient(circle_at_center,rgba(255,255,255,.035)_0,transparent_58%)]">
      <div className="flex min-h-full min-w-full items-center justify-center p-8">
        <SubtitleStylePreview ratio={ratio} backgroundPath={backgroundPath} backgroundIsVideo={backgroundIsVideo} captions={captions} config={config} onChange={onChange} loading={reviewLoading} loadingProgress={reviewProgress} editMode={editMode} onEditModeChange={setEditMode} showToolbar={false} zoom={zoom} viewportWidth={canvasSize.width} viewportHeight={canvasSize.height} seekTime={seekTime} onPlaybackTimeChange={(time, total) => { setCurrentTime(time); setDuration(total); }} selectedCoverId={selectedCover?.id} onSelectedCoverIdChange={setSelectedCoverId} />
      </div>
    </main>

    <aside className="col-start-3 row-span-2 row-start-2 min-h-0 overflow-y-auto border-l border-white/[0.08] bg-[#171718]">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-white/[0.08] bg-[#171718]/95 px-4 py-3 backdrop-blur"><div><p className="text-xs font-bold text-white/80">{editMode === 'subtitle' ? 'Thuộc tính phụ đề' : selectedCover?.name ?? 'Vùng che'}</p><p className="mt-0.5 text-[9px] text-white/30">Thay đổi hiển thị trực tiếp trên canvas</p></div>{editMode === 'subtitle' ? <button type="button" onClick={() => update({ enabled: !config.enabled })} className="grid size-8 place-items-center rounded-lg border border-white/[0.08] text-white/45 hover:text-white">{config.enabled ? <Eye size={15} /> : <EyeOff size={15} />}</button> : selectedCover ? <button type="button" onClick={() => updateCover({ enabled: !selectedCover.enabled })} className="grid size-8 place-items-center rounded-lg border border-white/[0.08] text-white/45 hover:text-white">{selectedCover.enabled ? <Eye size={15} /> : <EyeOff size={15} />}</button> : null}</div>

      {editMode === 'subtitle' ? <>
        <InspectorSection title="Thiết kế">
          <SelectField label="Preset" value={config.presetId} onChange={applyPreset} options={[{ value: '', label: 'Thiết kế hiện tại', disabled: true }, ...presets.map((preset) => ({ value: preset.id, label: `${preset.name}${dirty && preset.id === config.presetId ? ' · Đã sửa' : ''}` }))]} />
          <div className="flex flex-wrap gap-1.5"><button type="button" onClick={() => void setDefault()} className="inline-flex items-center gap-1 rounded-lg border border-white/[0.08] px-2 py-1.5 text-[9px] font-semibold text-white/45 hover:text-white"><BookmarkCheck size={11} /> Mặc định</button>{selectedCustom && <><button type="button" onClick={() => void updatePreset()} className="inline-flex items-center gap-1 rounded-lg border border-white/[0.08] px-2 py-1.5 text-[9px] font-semibold text-white/45 hover:text-white"><Save size={11} /> Cập nhật</button><button type="button" onClick={() => void deletePreset()} className="grid size-7 place-items-center rounded-lg border border-red-400/15 text-red-300/60"><Trash2 size={11} /></button></>}<button type="button" onClick={() => setCreating(true)} className="inline-flex items-center gap-1 rounded-lg bg-emerald-400/10 px-2 py-1.5 text-[9px] font-semibold text-emerald-300"><Plus size={11} /> Preset mới</button></div>
          {creating && <div className="flex gap-1.5"><input autoFocus value={presetName} onChange={(event) => setPresetName(event.target.value)} placeholder="Tên preset" className="field-surface min-w-0 flex-1 rounded-lg px-2 py-1.5 text-[10px] outline-none" /><button type="button" onClick={() => void createPreset()} className="rounded-lg bg-emerald-400 px-2 text-[9px] font-bold text-black">Lưu</button></div>}
          {message && <p className="text-[9px] text-emerald-300/75">{message}</p>}
        </InspectorSection>
        <InspectorSection title="Chữ và bố cục">
          <SelectField label="Phông chữ" value={config.fontFamily} onChange={(fontFamily) => update({ fontFamily })} options={FONT_OPTIONS} />
          <div className="grid grid-cols-2 gap-2"><NumberField label="Cỡ chữ" value={config.fontSizePct} min={0.5} max={15} step={0.1} suffix="%" onChange={(fontSizePct) => update({ fontSizePct })} /><NumberField label="Độ rộng" value={config.widthPct} min={15} max={96} suffix="%" onChange={(widthPct) => update({ widthPct })} /><NumberField label="Vị trí X" value={config.xPct} min={0} max={100} step={0.1} suffix="%" onChange={(xPct) => update({ xPct })} /><NumberField label="Vị trí Y" value={config.yPct} min={0} max={100} step={0.1} suffix="%" onChange={(yPct) => update({ yPct })} /></div>
          <div className="grid grid-cols-2 gap-2"><SelectField label="Vị trí nhanh" value={config.position} onChange={(value) => { const position = value as SubtitlePosition; update({ position, yPct: position === 'top' ? config.marginPct : position === 'middle' ? 50 : 100 - config.marginPct }); }} options={POSITION_OPTIONS} /><NumberField label="Từ mỗi cụm" value={config.wordsPerPage} min={2} max={10} onChange={(wordsPerPage) => update({ wordsPerPage })} /></div>
          <div className="flex flex-wrap gap-3 text-[10px] font-semibold text-white/50">{([['bold', 'Đậm'], ['italic', 'Nghiêng'], ['uppercase', 'Viết hoa']] as const).map(([key, label]) => <label key={key} className="flex cursor-pointer items-center gap-1.5"><input type="checkbox" checked={config[key]} onChange={(event) => update({ [key]: event.target.checked })} className="size-3.5 accent-emerald-400" />{label}</label>)}</div>
        </InspectorSection>
        <InspectorSection title="Màu sắc"><div className="grid grid-cols-2 gap-2"><ColorField label="Chữ" value={config.textColor} onChange={(textColor) => update({ textColor })} /><ColorField label="Highlight" value={config.highlightColor} onChange={(highlightColor) => update({ highlightColor })} /><ColorField label="Nền" value={config.backgroundColor} onChange={(backgroundColor) => update({ backgroundColor })} /><ColorField label="Viền" value={config.outlineColor} onChange={(outlineColor) => update({ outlineColor })} /></div></InspectorSection>
        <InspectorSection title="Nền và hiệu ứng">
          <SelectField label="Kiểu nền" value={config.backgroundStyle} onChange={(value) => update({ backgroundStyle: value as SubtitleBackgroundStyle })} options={BACKGROUND_OPTIONS} />
          <SliderField label="Độ mờ nền" value={config.backgroundOpacity} min={0} max={100} suffix="%" onChange={(backgroundOpacity) => update({ backgroundOpacity })} /><SliderField label="Độ bo nền" value={config.backgroundRadius} min={0} max={30} onChange={(backgroundRadius) => update({ backgroundRadius })} /><SliderField label="Độ dày viền" value={config.outlineWidth} min={0} max={6} step={0.2} onChange={(outlineWidth) => update({ outlineWidth })} /><SliderField label="Đổ bóng" value={config.shadowDepth} min={0} max={8} onChange={(shadowDepth) => update({ shadowDepth })} />
        </InspectorSection>
      </> : selectedCover ? <>
        <InspectorSection title="Layer vùng che">
          <div className="flex gap-2"><input value={selectedCover.name} onChange={(event) => updateCover({ name: event.target.value.slice(0, 60) })} aria-label="Tên vùng che" className="field-surface min-w-0 flex-1 rounded-lg px-3 py-2 text-[10px] font-semibold outline-none" /><button type="button" onClick={addCover} className="inline-flex items-center gap-1 rounded-lg bg-emerald-400/10 px-2.5 text-[9px] font-bold text-emerald-300"><Plus size={11} /> Thêm</button></div>
          <div className="grid grid-cols-2 gap-2"><NumberField label="Bắt đầu" value={Math.round(selectedCover.startSec * 10) / 10} min={0} max={Math.max(0, (selectedCover.endSec ?? timelineDuration) - 0.25)} step={0.1} suffix="giây" onChange={(startSec) => updateCover({ startSec })} /><NumberField label="Kết thúc" value={Math.round((selectedCover.endSec ?? timelineDuration) * 10) / 10} min={selectedCover.startSec + 0.25} max={timelineDuration} step={0.1} suffix="giây" onChange={(endSec) => updateCover({ endSec })} /></div>
          <p className="text-[9px] leading-4 text-white/30">Kéo thân layer để đổi vị trí; kéo hai mép trên timeline để cắt ngắn hoặc kéo dài.</p>
        </InspectorSection>
        <InspectorSection title="Kiểu xử lý">
          <div className="space-y-2">{([['overlay', 'Nền bán trong suốt', 'Che chắc chắn'], ['blur', 'Làm mờ', 'Giữ màu nền'], ['restore', 'Phục hồi nền', 'Tự nhiên hơn']] as Array<[OriginalSubtitleCoverMode, string, string]>).map(([mode, label, hint]) => <button key={mode} type="button" onClick={() => updateCover({ enabled: true, mode })} className={`w-full rounded-lg border px-3 py-2.5 text-left ${selectedCover.mode === mode ? 'border-emerald-400/40 bg-emerald-400/10' : 'border-white/[0.07] bg-black/10 hover:border-white/15'}`}><span className={`block text-[11px] font-bold ${selectedCover.mode === mode ? 'text-emerald-200' : 'text-white/65'}`}>{label}</span><span className="mt-0.5 block text-[9px] text-white/30">{hint}</span></button>)}</div>
        </InspectorSection>
        <InspectorSection title="Kích thước và vị trí"><div className="grid grid-cols-2 gap-2"><NumberField label="Vị trí X" value={selectedCover.xPct} min={0} max={100} step={0.1} suffix="%" onChange={(xPct) => updateCover({ xPct })} /><NumberField label="Vị trí Y" value={selectedCover.yPct} min={0} max={100} step={0.1} suffix="%" onChange={(yPct) => updateCover({ yPct })} /><NumberField label="Độ rộng" value={selectedCover.widthPct} min={2} max={100} step={0.1} suffix="%" onChange={(widthPct) => updateCover({ widthPct })} /><NumberField label="Chiều cao" value={selectedCover.heightPct} min={2} max={100} step={0.1} suffix="%" onChange={(heightPct) => updateCover({ heightPct })} /></div></InspectorSection>
        <InspectorSection title="Hiệu ứng">
          {selectedCover.mode === 'overlay' ? <><ColorField label="Màu vùng che" value={selectedCover.color} onChange={(color) => updateCover({ color })} /><SliderField label="Độ đậm" value={selectedCover.opacity} min={20} max={100} suffix="%" onChange={(opacity) => updateCover({ opacity })} /></> : <SliderField label={selectedCover.mode === 'blur' ? 'Mức làm mờ' : 'Mức phục hồi'} value={selectedCover.blurStrength} min={2} max={30} onChange={(blurStrength) => updateCover({ blurStrength })} />}
          <SliderField label="Độ mềm viền" value={selectedCover.featherPct ?? 12} min={0} max={40} suffix="%" onChange={(featherPct) => updateCover({ featherPct })} />
          <button type="button" onClick={removeCover} className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-red-400/15 px-3 py-2 text-[10px] font-semibold text-red-300/65 hover:bg-red-400/10"><Trash2 size={12} /> Xóa layer vùng che</button>
        </InspectorSection>
      </> : <div className="p-5 text-center"><p className="text-xs font-semibold text-white/55">Chưa có vùng che</p><p className="mt-2 text-[10px] leading-5 text-white/30">Bấm Thêm vùng hoặc kéo trực tiếp trên canvas để tạo layer mới.</p><button type="button" onClick={addCover} className="primary-action mt-4 inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-[10px] font-bold"><Plus size={12} /> Thêm vùng che</button></div>}
    </aside>

    <section className="col-span-2 row-start-3 overflow-hidden border-t border-white/[0.08] bg-[#141415]">
      <div className="flex h-9 items-center gap-3 border-b border-white/[0.07] px-3"><span className="text-[10px] font-bold text-white/55">Timeline</span><span className="text-[10px] tabular-nums text-white/30">{clock(currentTime)} / {clock(timelineDuration)}</span><div className="ml-auto flex items-center gap-2"><span className="hidden text-[9px] text-white/25 lg:inline">Kéo thân layer để di chuyển · kéo hai mép để cắt</span><button type="button" onClick={addCover} className="inline-flex items-center gap-1 rounded-md bg-amber-300/10 px-2 py-1 text-[9px] font-bold text-amber-200"><Plus size={10} /> Thêm vùng</button></div></div>
      <div className="grid h-[126px] grid-cols-[92px_minmax(0,1fr)] overflow-y-auto text-[9px]">
        <div className="border-r border-white/[0.07] text-white/35">
          <div className="flex h-8 items-center px-3">Video</div>
          {covers.map((layer, index) => <button key={layer.id} type="button" onClick={() => { setEditMode('cover'); setSelectedCoverId(layer.id); setSeekTime(layer.startSec); }} className={`flex h-8 w-full items-center gap-1.5 border-t border-white/[0.04] px-3 text-left ${selectedCover?.id === layer.id ? 'bg-amber-300/8 text-amber-200' : 'hover:bg-white/[0.03]'}`}><span className="text-[8px] text-white/20">{index + 1}</span><span className="truncate">{layer.name}</span></button>)}
          <div className="flex h-12 items-center px-3">Phụ đề</div>
        </div>
        <div ref={timelineTrackRef} className="relative min-w-0 overflow-hidden">
          <span className="pointer-events-none absolute inset-y-0 z-30 w-px bg-emerald-300 shadow-[0_0_8px_rgba(110,231,183,.7)]" style={{ left: `${clamp((currentTime / timelineDuration) * 100, 0, 100)}%` }} />
          <div className="relative h-8 border-b border-white/[0.05] px-1 py-2"><div className="h-full rounded bg-white/[0.08]" /></div>
          {covers.map((layer) => {
            const endSec = clamp(layer.endSec ?? timelineDuration, layer.startSec + 0.25, timelineDuration);
            const selected = selectedCover?.id === layer.id;
            return <div key={layer.id} className="relative h-8 border-b border-white/[0.05] px-1 py-1.5">
              <div title={`${layer.name}: ${clock(layer.startSec)} – ${clock(endSec)}`} className={`absolute inset-y-1.5 min-w-[10px] overflow-hidden rounded ${selected ? 'bg-amber-300/40 text-amber-50 ring-1 ring-amber-200/70' : 'bg-amber-300/20 text-amber-100/60 ring-1 ring-amber-300/30 hover:bg-amber-300/30'}`} style={{ left: `${clamp(layer.startSec / timelineDuration * 100, 0, 100)}%`, width: `${Math.max(0.5, (endSec - layer.startSec) / timelineDuration * 100)}%` }}>
                <button type="button" aria-label={`Di chuyển ${layer.name}`} onPointerDown={(event) => beginCoverTimeDrag(event, layer, 'move')} className="absolute inset-0 cursor-grab px-2 text-left active:cursor-grabbing"><span className="block truncate text-[8px] font-bold">{layer.name}</span></button>
                <button type="button" aria-label={`Cắt đầu ${layer.name}`} onPointerDown={(event) => beginCoverTimeDrag(event, layer, 'start')} className="absolute inset-y-0 left-0 z-10 w-2 cursor-ew-resize bg-amber-100/70 opacity-80 focus-visible:outline focus-visible:outline-1 focus-visible:outline-white" />
                <button type="button" aria-label={`Cắt cuối ${layer.name}`} onPointerDown={(event) => beginCoverTimeDrag(event, layer, 'end')} className="absolute inset-y-0 right-0 z-10 w-2 cursor-ew-resize bg-amber-100/70 opacity-80 focus-visible:outline focus-visible:outline-1 focus-visible:outline-white" />
              </div>
            </div>;
          })}
          <div className="relative h-12 px-1 py-2">{captions.map((caption, index) => <button key={`${caption.start}-${index}`} type="button" title={caption.text} onClick={() => { setEditMode('subtitle'); setSeekTime(caption.start); }} className={`absolute inset-y-1.5 min-w-[3px] overflow-hidden rounded px-1.5 text-left text-[8px] font-semibold transition ${activeCaptionIndex === index ? 'bg-emerald-400 text-black ring-1 ring-emerald-200' : 'bg-emerald-400/15 text-emerald-100/55 ring-1 ring-emerald-400/20 hover:bg-emerald-400/25'}`} style={{ left: `${(caption.start / timelineDuration) * 100}%`, width: `${Math.max(0.35, ((caption.end - caption.start) / timelineDuration) * 100)}%` }}><span className="block truncate">{caption.text}</span></button>)}</div>
        </div>
      </div>
    </section>
  </div>;
}
