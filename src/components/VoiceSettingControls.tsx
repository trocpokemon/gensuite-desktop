import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Check, ChevronDown, Search } from 'lucide-react';
import type { GenSuiteModel } from '../providers/voice/GenSuiteVoiceAdapter';

export interface LanguageOption {
  value: string;
  label: string;
  countryCode: string;
}

export function CompactFilter({ label, value, options, onChange }: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value) || options[0];
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  return <div ref={rootRef} className="relative min-w-0">
    <span className="mb-1.5 block truncate text-[9px] font-black uppercase tracking-widest text-white/25">{label}</span>
    <button type="button" onClick={() => setOpen((current) => !current)} className={`flex w-full items-center gap-2 rounded-xl border px-3 py-2.5 text-[11px] font-semibold transition ${open ? 'border-teal-400/40 bg-teal-400/[0.05] text-white' : 'border-white/[0.08] bg-white/[0.025] text-white/65 hover:border-white/15'}`}><span className="min-w-0 flex-1 truncate text-left">{selected?.label || 'Tất cả'}</span><ChevronDown size={12} className={`shrink-0 text-white/30 transition ${open ? 'rotate-180' : ''}`} /></button>
    {open && <div className="absolute left-0 top-[calc(100%+6px)] z-50 max-h-60 min-w-full overflow-y-auto rounded-xl border border-white/10 bg-[#0a0a0a]/[0.98] p-1 shadow-[0_18px_50px_rgba(0,0,0,.75)] voice-pop-in">{options.map((option) => <button key={option.value} type="button" onClick={() => { onChange(option.value); setOpen(false); }} className={`flex w-full items-center justify-between whitespace-nowrap rounded-lg px-3 py-2 text-left text-[11px] ${option.value === value ? 'bg-teal-400/10 text-teal-300' : 'text-white/60 hover:bg-white/[0.05] hover:text-white'}`}><span>{option.label}</span>{option.value === value && <Check size={12} />}</button>)}</div>}
  </div>;
}

export function LanguageDropdown({ value, options, placeholder = 'Chọn ngôn ngữ…', onChange }: {
  value: string;
  options: LanguageOption[];
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = options.find((item) => item.value === value);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return normalized ? options.filter((item) => `${item.label} ${item.value}`.toLowerCase().includes(normalized)) : options;
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  return <div ref={rootRef} className="relative">
    <button type="button" onClick={() => setOpen((current) => !current)} className={`flex w-full items-center gap-2.5 rounded-xl border bg-white/[0.03] px-3.5 py-3 text-xs font-semibold text-white/80 transition ${open ? 'border-emerald-400/70 ring-2 ring-emerald-400/10' : 'border-white/10 hover:border-white/20'}`}>
      {selected ? <><img src={`https://flagcdn.com/w40/${selected.countryCode}.png`} alt="" className="h-[14px] w-5 rounded-[2px] object-cover ring-1 ring-white/10" /><span className="min-w-0 flex-1 truncate text-left">{selected.label}</span></> : <span className="flex-1 text-left font-normal text-white/30">{placeholder}</span>}
      <ChevronDown size={14} className={`shrink-0 text-white/30 transition-transform ${open ? 'rotate-180 text-white/60' : ''}`} />
    </button>
    {open && <div className="absolute inset-x-0 top-[calc(100%+8px)] z-50 max-h-72 overflow-y-auto rounded-2xl border border-white/10 bg-[#0a0a0a]/[0.98] shadow-[0_20px_60px_-10px_rgba(0,0,0,0.85)] backdrop-blur-xl voice-pop-in">
      <div className="sticky top-0 border-b border-white/5 bg-[#0a0a0a]/95 p-2 backdrop-blur-xl"><label className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3"><Search size={13} className="text-white/30" /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Tìm ngôn ngữ…" className="w-full bg-transparent py-2.5 text-[11px] text-white/80 outline-none placeholder:text-white/25" /></label></div>
      <div className="py-1">{filtered.map((option) => <button key={option.value} type="button" onClick={() => { onChange(option.value); setOpen(false); setQuery(''); }} className={`flex w-full items-center gap-3 px-3 py-2.5 text-xs transition ${option.value === value ? 'bg-emerald-400/10 text-emerald-300' : 'text-white/70 hover:bg-white/[0.04] hover:text-white'}`}><img src={`https://flagcdn.com/w40/${option.countryCode}.png`} alt="" className="h-[14px] w-5 rounded-[2px] object-cover ring-1 ring-white/10" /><span className="min-w-0 flex-1 truncate text-left">{option.label}</span>{option.value === value && <Check size={14} />}</button>)}{!filtered.length && <p className="px-3 py-5 text-center text-[11px] text-white/30">Không tìm thấy ngôn ngữ.</p>}</div>
    </div>}
  </div>;
}

export function ModelPickerSheet({ models, selectedId, onSelect, onClose }: {
  models: GenSuiteModel[];
  selectedId: string;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  return <div className="absolute inset-0 z-30 flex flex-col bg-[#0f0f10] voice-sheet-in">
    <div className="flex items-center gap-3 border-b border-white/10 px-5 py-4"><button type="button" onClick={onClose} className="rounded-lg p-2 text-white/45 hover:bg-white/5 hover:text-white"><ArrowLeft size={17} /></button><div><h3 className="text-sm font-bold">Chọn mô hình</h3><p className="mt-0.5 text-[9px] uppercase tracking-wider text-white/30">Mô hình khả dụng từ GenSuite API</p></div></div>
    <div className="min-h-0 flex-1 overflow-y-auto p-4">{models.map((model) => <button key={model.id} type="button" onClick={() => { onSelect(model.id); onClose(); }} className={`mb-2 flex w-full items-center gap-3 rounded-xl border p-4 text-left transition ${model.id === selectedId ? 'border-emerald-400/35 bg-emerald-400/[0.07]' : 'border-white/5 bg-white/[0.02] hover:border-white/15 hover:bg-white/[0.04]'}`}><span className="min-w-0 flex-1"><span className="flex items-center gap-2"><span className="truncate text-xs font-bold text-white/85">{model.name}</span>{model.paidOnly && <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-1.5 py-0.5 text-[8px] font-black uppercase text-emerald-300">Mới nhất</span>}</span><span className="mt-1 block truncate font-mono text-[9px] text-white/25">{model.id}</span></span>{model.id === selectedId && <Check size={15} className="text-emerald-300" />}</button>)}</div>
  </div>;
}
