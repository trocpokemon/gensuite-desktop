import { useMemo, useState } from 'react';
import { BookmarkCheck, ChevronDown, Plus, Save, SlidersHorizontal, Trash2 } from 'lucide-react';
import type { SubtitleBackgroundStyle, SubtitleConfig, SubtitlePosition, SubtitlePreset, SubtitleStyle } from '../shared/types';
import { BUILTIN_SUBTITLE_PRESETS, subtitleStyleFromConfig } from '../shared/subtitlePresets';
import { useSettingsStore } from '../store/settingsStore';
import { SubtitleStylePreview } from './SubtitleStylePreview';

interface Props {
  config: SubtitleConfig;
  onChange: (next: SubtitleConfig) => void;
  ratio: '16:9' | '9:16';
  backgroundPath?: string;
  backgroundIsVideo?: boolean;
}

const FONTS = ['Arial', 'Segoe UI', 'Arial Black', 'Tahoma', 'Verdana', 'Georgia', 'Times New Roman', 'Microsoft YaHei', 'Malgun Gothic', 'Yu Gothic'];
const POSITIONS: Array<[SubtitlePosition, string]> = [['top', 'Trên'], ['middle', 'Giữa'], ['bottom', 'Dưới']];
const BACKGROUNDS: Array<[SubtitleBackgroundStyle, string]> = [['rounded', 'Hộp bo mềm'], ['bar', 'Dải ngang'], ['none', 'Không nền']];

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label className="flex items-center justify-between gap-3 rounded-lg border border-white/[0.06] bg-white/[0.025] px-3 py-2"><span className="text-[11px] text-white/50">{label}</span><input type="color" value={value} onChange={(event) => onChange(event.target.value)} className="h-7 w-9 cursor-pointer rounded border-0 bg-transparent" /></label>;
}

function RangeField({ label, value, min, max, step = 1, suffix = '', onChange }: { label: string; value: number; min: number; max: number; step?: number; suffix?: string; onChange: (value: number) => void }) {
  return <label className="flex flex-col gap-1.5"><span className="flex justify-between text-[11px] text-white/45"><span>{label}</span><span className="font-semibold text-white/65">{value}{suffix}</span></span><input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} className="accent-emerald-400" /></label>;
}

export function SubtitleDesigner({ config, onChange, ratio, backgroundPath, backgroundIsVideo }: Props) {
  const preferences = useSettingsStore((state) => state.keys);
  const savePreferences = useSettingsStore((state) => state.save);
  const [creating, setCreating] = useState(false);
  const [presetName, setPresetName] = useState('');
  const [message, setMessage] = useState('');
  const [dirty, setDirty] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const presets = useMemo(() => [...BUILTIN_SUBTITLE_PRESETS, ...(preferences.subtitlePresets ?? [])], [preferences.subtitlePresets]);
  const selectedPreset = presets.find((preset) => preset.id === config.presetId);
  const selectedCustom = selectedPreset && !selectedPreset.builtIn ? selectedPreset : null;

  const update = (patch: Partial<SubtitleStyle>) => { setDirty(true); onChange({ ...config, ...patch }); };
  const applyPreset = (id: string) => {
    const preset = presets.find((item) => item.id === id);
    if (preset) { setDirty(false); onChange({ enabled: config.enabled, presetId: preset.id, ...preset.style }); }
  };
  const persist = async (nextPresets: SubtitlePreset[], defaultId = preferences.defaultSubtitlePresetId) => {
    await savePreferences({ ...preferences, subtitlePresets: nextPresets, defaultSubtitlePresetId: defaultId });
  };
  const createPreset = async () => {
    const name = presetName.trim();
    if (!name) return;
    const preset: SubtitlePreset = { id: `custom_${Date.now().toString(36)}`, name, style: subtitleStyleFromConfig(config) };
    try {
      await persist([...(preferences.subtitlePresets ?? []), preset]);
      onChange({ ...config, presetId: preset.id });
      setDirty(false); setPresetName(''); setCreating(false); setMessage('Đã lưu preset mới.');
    } catch { setMessage('Không thể lưu preset. Vui lòng thử lại.'); }
  };
  const updatePreset = async () => {
    if (!selectedCustom) return;
    try {
      await persist((preferences.subtitlePresets ?? []).map((preset) => preset.id === selectedCustom.id ? { ...preset, style: subtitleStyleFromConfig(config) } : preset));
      setDirty(false); setMessage('Đã cập nhật preset.');
    } catch { setMessage('Không thể cập nhật preset. Vui lòng thử lại.'); }
  };
  const deletePreset = async () => {
    if (!selectedCustom) return;
    if (!window.confirm(`Xóa preset “${selectedCustom.name}”?`)) return;
    const remaining = (preferences.subtitlePresets ?? []).filter((preset) => preset.id !== selectedCustom.id);
    const nextDefault = preferences.defaultSubtitlePresetId === selectedCustom.id ? BUILTIN_SUBTITLE_PRESETS[0].id : preferences.defaultSubtitlePresetId;
    try {
      await persist(remaining, nextDefault);
      applyPreset(BUILTIN_SUBTITLE_PRESETS[0].id);
      setMessage('Đã xóa preset.');
    } catch { setMessage('Không thể xóa preset. Vui lòng thử lại.'); }
  };
  const setDefault = async () => {
    if (!config.presetId || dirty) { setMessage('Hãy lưu hoặc cập nhật thiết kế trước khi đặt mặc định.'); return; }
    try {
      await persist(preferences.subtitlePresets ?? [], config.presetId);
      setMessage('Preset này sẽ dùng cho dự án mới.');
    } catch { setMessage('Không thể đổi preset mặc định. Vui lòng thử lại.'); }
  };

  return (
    <div className="space-y-4">
      <SubtitleStylePreview ratio={ratio} backgroundPath={backgroundPath} backgroundIsVideo={backgroundIsVideo} config={config} />
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-[180px] flex-1"><span className="mb-1.5 block text-[11px] text-white/45">Preset thiết kế</span><select value={config.presetId} onChange={(event) => applyPreset(event.target.value)} className="field-surface w-full rounded-lg px-3 py-2 text-xs outline-none"><option value="" disabled>Thiết kế hiện tại</option>{presets.map((preset) => <option key={preset.id} value={preset.id} className="bg-[#181819]">{preset.name}{dirty && preset.id === config.presetId ? ' · Đã chỉnh sửa' : preferences.defaultSubtitlePresetId === preset.id ? ' · Mặc định' : ''}</option>)}</select></label>
        <button type="button" onClick={() => void setDefault()} className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-xs text-white/65 hover:border-emerald-400/35 hover:text-emerald-300"><BookmarkCheck size={14} /> Đặt mặc định</button>
        {selectedCustom && <><button type="button" onClick={() => void updatePreset()} className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-xs text-white/65 hover:text-white"><Save size={14} /> Cập nhật</button><button type="button" title="Xóa preset" onClick={() => void deletePreset()} className="rounded-lg border border-red-400/15 p-2 text-red-300/65 hover:bg-red-400/10"><Trash2 size={14} /></button></>}
        <button type="button" onClick={() => setCreating(true)} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-400/10 px-3 py-2 text-xs font-semibold text-emerald-300 hover:bg-emerald-400/15"><Plus size={14} /> Preset mới</button>
      </div>
      {creating && <div className="flex gap-2"><input autoFocus value={presetName} onChange={(event) => setPresetName(event.target.value)} placeholder="Tên preset…" className="field-surface min-w-0 flex-1 rounded-lg px-3 py-2 text-xs outline-none" /><button type="button" onClick={() => void createPreset()} className="rounded-lg bg-emerald-400 px-3 py-2 text-xs font-bold text-black">Lưu</button><button type="button" onClick={() => setCreating(false)} className="rounded-lg px-3 py-2 text-xs text-white/50">Hủy</button></div>}
      {message && <p className="text-[11px] text-emerald-300/80">{message}</p>}

      <button type="button" onClick={() => setAdvancedOpen((open) => !open)} className="flex w-full items-center justify-between rounded-xl border border-white/[0.08] bg-white/[0.02] px-4 py-3 text-left text-xs font-semibold text-white/60 hover:border-white/[0.15] hover:text-white/85"><span className="flex items-center gap-2"><SlidersHorizontal size={14} className="text-emerald-300" /> Tùy chỉnh chi tiết</span><ChevronDown size={15} className={`transition-transform ${advancedOpen ? 'rotate-180' : ''}`} /></button>
      {advancedOpen && <div className="space-y-4 border-t border-white/[0.08] pt-4">
        <div className="grid gap-4 md:grid-cols-3">
          <label><span className="mb-1.5 block text-[11px] text-white/45">Phông chữ</span><select value={config.fontFamily} onChange={(event) => update({ fontFamily: event.target.value })} className="field-surface w-full rounded-lg px-3 py-2 text-xs outline-none">{FONTS.map((font) => <option key={font} value={font} className="bg-[#181819]">{font}</option>)}</select></label>
          <label><span className="mb-1.5 block text-[11px] text-white/45">Kiểu nền</span><select value={config.backgroundStyle} onChange={(event) => update({ backgroundStyle: event.target.value as SubtitleBackgroundStyle })} className="field-surface w-full rounded-lg px-3 py-2 text-xs outline-none">{BACKGROUNDS.map(([value, label]) => <option key={value} value={value} className="bg-[#181819]">{label}</option>)}</select></label>
          <label><span className="mb-1.5 block text-[11px] text-white/45">Vị trí</span><select value={config.position} onChange={(event) => update({ position: event.target.value as SubtitlePosition })} className="field-surface w-full rounded-lg px-3 py-2 text-xs outline-none">{POSITIONS.map(([value, label]) => <option key={value} value={value} className="bg-[#181819]">{label}</option>)}</select></label>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4"><ColorField label="Màu chữ" value={config.textColor} onChange={(textColor) => update({ textColor })} /><ColorField label="Màu highlight" value={config.highlightColor} onChange={(highlightColor) => update({ highlightColor })} /><ColorField label="Màu nền" value={config.backgroundColor} onChange={(backgroundColor) => update({ backgroundColor })} /><ColorField label="Màu viền" value={config.outlineColor} onChange={(outlineColor) => update({ outlineColor })} /></div>
        <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3"><RangeField label="Cỡ chữ" value={config.fontSizePct} min={2} max={8} step={0.1} suffix="%" onChange={(fontSizePct) => update({ fontSizePct })} /><RangeField label="Số từ mỗi cụm" value={config.wordsPerPage} min={2} max={10} onChange={(wordsPerPage) => update({ wordsPerPage })} /><RangeField label="Khoảng cách mép" value={config.marginPct} min={2} max={25} suffix="%" onChange={(marginPct) => update({ marginPct })} /><RangeField label="Độ mờ nền" value={config.backgroundOpacity} min={0} max={100} suffix="%" onChange={(backgroundOpacity) => update({ backgroundOpacity })} /><RangeField label="Độ bo nền" value={config.backgroundRadius} min={0} max={30} onChange={(backgroundRadius) => update({ backgroundRadius })} /><RangeField label="Độ dày viền" value={config.outlineWidth} min={0} max={6} step={0.2} onChange={(outlineWidth) => update({ outlineWidth })} /><RangeField label="Đổ bóng" value={config.shadowDepth} min={0} max={8} onChange={(shadowDepth) => update({ shadowDepth })} /><RangeField label="Ánh sáng highlight" value={config.highlightGlow} min={0} max={16} onChange={(highlightGlow) => update({ highlightGlow })} /><RangeField label="Độ mờ chữ sắp đọc" value={config.futureOpacity} min={10} max={100} suffix="%" onChange={(futureOpacity) => update({ futureOpacity })} /></div>
        <div className="flex flex-wrap gap-4 text-xs text-white/60">{([['bold', 'In đậm'], ['italic', 'In nghiêng'], ['uppercase', 'Viết hoa']] as const).map(([key, label]) => <label key={key} className="flex cursor-pointer items-center gap-2"><input type="checkbox" checked={config[key]} onChange={(event) => update({ [key]: event.target.checked })} className="size-4 accent-emerald-400" />{label}</label>)}</div>
      </div>}
    </div>
  );
}
