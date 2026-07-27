import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Check, Download, FileText, FolderOpen, KeyRound, Languages, Loader2, Mic, Save, Upload } from 'lucide-react';
import { AudioPlayer } from './AudioPlayer';
import { EngineToggle } from './EngineToggle';
import { VoiceConfigPanel, GENMAX_LANGUAGE_IDS } from './VoiceConfigPanel';
import { useProjectStore, uid } from '../store/projectStore';
import { useSettingsStore } from '../store/settingsStore';
import { getVoiceProvider } from '../providers/voice';
import { getTranscriptionProvider } from '../providers/transcription';
import { getScriptProvider } from '../providers/script';
import { errorMessage, missingKeyService, serviceLabel } from '../providers/errors';
import { localFileUrl } from '../shared/localFile';
import type { ScriptEngine, TranscriptSegment } from '../shared/types';

export type QuickToolId = 'download' | 'voice' | 'srt' | 'translate';

interface Props {
  tool: QuickToolId;
  onClose: () => void;
  onOpenSettings: () => void;
}

const META: Record<QuickToolId, { title: string; eyebrow: string }> = {
  download: { title: 'Tải video', eyebrow: 'Công cụ tải video' },
  voice: { title: 'Tạo Voice AI', eyebrow: 'Văn bản thành giọng nói' },
  srt: { title: 'Xuất phụ đề SRT', eyebrow: 'Nhận dạng lời thoại' },
  translate: { title: 'Dịch nội dung', eyebrow: 'Văn bản & tệp SRT' },
};

const TARGET_LANGUAGES: Array<[string, string]> = [
  ['vietnamese', 'Tiếng Việt'], ['english', 'English'], ['chinese', '中文'], ['japanese', '日本語'],
  ['korean', '한국어'], ['thai', 'ภาษาไทย'], ['french', 'Français'], ['german', 'Deutsch'],
  ['spanish', 'Español'], ['portuguese', 'Português'], ['indonesian', 'Bahasa Indonesia'], ['russian', 'Русский'],
];

function timecode(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const hh = Math.floor(ms / 3_600_000);
  const mm = Math.floor((ms % 3_600_000) / 60_000);
  const ss = Math.floor((ms % 60_000) / 1000);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}

function segmentsToSrt(segments: TranscriptSegment[]): string {
  return segments.map((segment, index) => `${index + 1}\n${timecode(segment.start)} --> ${timecode(segment.end)}\n${segment.text.trim()}`).join('\n\n');
}

function parseTranslationInput(content: string): { segments: TranscriptSegment[]; srt: boolean } {
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim();
  const blocks = normalized.split(/\n{2,}/);
  const segments: TranscriptSegment[] = [];
  let isSrt = false;
  blocks.forEach((block, index) => {
    const lines = block.split('\n');
    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex >= 0) {
      isSrt = true;
      const match = lines[timingIndex].match(/(\d+):(\d+):(\d+)[,.](\d+)\s+-->\s+(\d+):(\d+):(\d+)[,.](\d+)/);
      const toSeconds = (offset: number) => match ? Number(match[offset]) * 3600 + Number(match[offset + 1]) * 60 + Number(match[offset + 2]) + Number(match[offset + 3].padEnd(3, '0').slice(0, 3)) / 1000 : index * 4;
      segments.push({ id: uid('tr_'), start: toSeconds(1), end: toSeconds(5), text: lines.slice(timingIndex + 1).join('\n').trim() });
    }
  });
  if (!isSrt) {
    const chunks = normalized.split(/\n+/).map((line) => line.trim()).filter(Boolean);
    chunks.forEach((text, index) => segments.push({ id: uid('tr_'), start: index, end: index + 1, text }));
  }
  return { segments, srt: isSrt };
}

function ResultPath({ path }: { path: string }) {
  if (!path) return null;
  return <div className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-emerald-400/20 bg-emerald-400/[0.06] px-4 py-3 text-xs text-emerald-100/75"><span className="min-w-0 truncate"><Check size={14} className="mr-2 inline text-emerald-300" />{path}</span><button onClick={() => window.gensuite.shell.showItemInFolder(path)} className="shrink-0 rounded-lg border border-white/10 px-3 py-1.5 font-bold text-white/65 hover:bg-white/5"><FolderOpen size={13} className="mr-1.5 inline" />Mở thư mục</button></div>;
}

export function QuickToolWorkspace({ tool, onClose, onOpenSettings }: Props) {
  const meta = META[tool];
  return (
    <div className="fixed inset-x-0 bottom-0 top-[34px] z-30 flex flex-col bg-[#121213] voice-sheet-in">
      <header className="flex h-20 shrink-0 items-center gap-4 border-b border-white/10 px-8">
        <button onClick={onClose} className="grid h-10 w-10 place-items-center rounded-xl border border-white/10 text-white/50 hover:bg-white/5 hover:text-white"><ArrowLeft size={18} /></button>
        <div><div className="text-[10px] font-bold uppercase tracking-[0.18em] text-emerald-400/75">{meta.eyebrow}</div><h1 className="mt-1 text-xl font-bold">{meta.title}</h1></div>
      </header>
      {tool === 'download' && <DownloadTool />}
      {tool === 'voice' && <VoiceTool onOpenSettings={onOpenSettings} />}
      {tool === 'srt' && <SrtTool />}
      {tool === 'translate' && <TranslateTool onOpenSettings={onOpenSettings} />}
    </div>
  );
}

function ToolShell({ children }: { children: React.ReactNode }) {
  return <div className="min-h-0 flex-1 overflow-y-auto"><div className="mx-auto max-w-3xl px-8 py-10">{children}</div></div>;
}

function DownloadTool() {
  const projectId = useProjectStore((state) => state.project.id);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [percent, setPercent] = useState(0);
  const [phase, setPhase] = useState('');
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  useEffect(() => window.gensuite.ytdlp.onProgress((progress) => { if (progress.projectId === projectId) { setPercent(progress.percent); setPhase(progress.phase || ''); } }), [projectId]);
  const run = async () => {
    if (!url.trim() || busy) return;
    setBusy(true); setError(''); setResult(''); setPercent(0);
    try {
      const sourcePath = await window.gensuite.ytdlp.download({ projectId, url: url.trim() });
      const saved = await window.gensuite.files.saveCopy({ sourcePath, defaultName: 'video.mp4' });
      if (saved) setResult(saved);
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  };
  return <ToolShell><div className="workspace-panel rounded-2xl p-7"><div className="mb-5 inline-flex rounded-xl bg-cyan-400/10 p-3 text-cyan-300"><Download size={23} /></div><h2 className="text-lg font-bold">Dán liên kết video</h2><p className="mt-2 text-sm leading-6 text-white/40">Hỗ trợ tải video từ nhiều nền tảng phổ biến và tự động chọn chất lượng tốt nhất.</p><input autoFocus value={url} onChange={(event) => setUrl(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && void run()} placeholder="https://youtube.com/watch?v=…" className="field-surface mt-6 w-full rounded-xl px-4 py-3.5 text-sm outline-none" /><button onClick={() => void run()} disabled={!url.trim() || busy} className="primary-action mt-4 flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-bold disabled:opacity-40">{busy ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}{busy ? (phase === 'merging' ? 'Đang hoàn thiện video…' : `Đang tải ${Math.round(percent)}%`) : 'Tải video'}</button>{busy && <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-cyan-400 transition-all" style={{ width: `${percent}%` }} /></div>}{error && <p className="mt-4 text-sm text-red-300">{error}</p>}<ResultPath path={result} /></div></ToolShell>;
}

function VoiceTool({ onOpenSettings }: { onOpenSettings: () => void }) {
  const project = useProjectStore((state) => state.project);
  const keys = useSettingsStore((state) => state.keys);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [audioPath, setAudioPath] = useState('');
  const [savedPath, setSavedPath] = useState('');
  const [missingKey, setMissingKey] = useState<string | null>(null);
  const [error, setError] = useState('');
  const synthesize = async () => {
    if (!text.trim() || busy) return;
    const engine = project.settings.voiceEngine;
    const config = project.settings.voiceConfigs[engine];
    if ((engine === 'elevenlabs' || engine === 'minimax') && !GENMAX_LANGUAGE_IDS.includes(config.language)) { setError('Hãy chọn ngôn ngữ trước khi tạo giọng.'); return; }
    setBusy(true); setError(''); setMissingKey(null); setSavedPath('');
    try {
      const result = await getVoiceProvider(engine, keys).synthesize({ projectId: project.id, segmentId: uid('quick_voice_'), text: text.trim(), voiceId: config.voiceId, modelId: config.modelId, language: config.language, speed: config.speed, temperature: config.temperature, stability: config.stability, similarityBoost: config.similarityBoost, style: config.style, useSpeakerBoost: config.useSpeakerBoost, pitch: config.pitch, volume: config.volume, deliveryMode: config.deliveryMode });
      setAudioPath(result.audioPath);
    } catch (err) { const service = missingKeyService(err); if (service) setMissingKey(service); else setError(errorMessage(err)); } finally { setBusy(false); }
  };
  const save = async () => { if (audioPath) { const path = await window.gensuite.files.saveCopy({ sourcePath: audioPath, defaultName: 'gensuite-voice.mp3' }); if (path) setSavedPath(path); } };
  return <div className="flex min-h-0 flex-1"><section className="min-w-0 flex-1 overflow-y-auto"><div className="mx-auto max-w-3xl px-8 py-10"><div className="workspace-panel rounded-2xl p-7"><div className="mb-5 inline-flex rounded-xl bg-violet-400/10 p-3 text-violet-300"><Mic size={23} /></div><h2 className="text-lg font-bold">Nội dung cần đọc</h2><textarea autoFocus value={text} onChange={(event) => setText(event.target.value)} rows={10} placeholder="Nhập hoặc dán văn bản tại đây…" className="field-surface mt-5 w-full resize-y rounded-xl p-4 text-sm leading-6 outline-none" /><div className="mt-2 text-right text-[11px] text-white/30">{text.trim().length.toLocaleString('vi-VN')} ký tự</div>{missingKey && <div className="mt-4 flex items-center justify-between rounded-xl border border-amber-400/25 bg-amber-400/10 p-3 text-sm text-amber-100/75"><span><KeyRound size={15} className="mr-2 inline" />Thiếu API key cho {serviceLabel(missingKey)}</span><button onClick={onOpenSettings} className="rounded-lg bg-amber-300 px-3 py-1.5 text-xs font-bold text-black">Cài đặt</button></div>}{error && <p className="mt-4 text-sm text-red-300">{error}</p>}<button onClick={() => void synthesize()} disabled={!text.trim() || busy} className="primary-action mt-4 flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-bold disabled:opacity-40">{busy ? <Loader2 size={16} className="animate-spin" /> : <Mic size={16} />}{busy ? 'Đang tạo giọng…' : 'Tạo Voice AI'}</button>{audioPath && <div className="mt-5 rounded-xl border border-white/10 bg-black/15 p-4"><AudioPlayer src={localFileUrl(audioPath)!} /><button onClick={() => void save()} className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-xs font-bold text-white/65 hover:bg-white/5"><Save size={14} />Lưu audio</button></div>}<ResultPath path={savedPath} /></div></div></section><aside className="relative flex h-full w-[400px] shrink-0 flex-col border-l border-white/10 bg-[#0f0f10]"><VoiceConfigPanel onMissingKey={setMissingKey} /></aside></div>;
}

function SrtTool() {
  const project = useProjectStore((state) => state.project);
  const [sourcePath, setSourcePath] = useState('');
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState('');
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  useEffect(() => window.gensuite.whisper.onProgress((progress) => setPhase(progress.phase === 'downloading-model' ? `Đang chuẩn bị dữ liệu nhận dạng ${Math.round(progress.percent || 0)}%` : progress.phase === 'extracting' ? 'Đang chuẩn bị âm thanh…' : progress.phase === 'transcribing' ? 'Đang nhận dạng lời thoại…' : '')), []);
  const choose = async () => { const path = await window.gensuite.ytdlp.import(project.id); if (path) { setSourcePath(path); setResult(''); setError(''); } };
  const run = async () => { if (!sourcePath || busy) return; setBusy(true); setError(''); setResult(''); try { const segments = await getTranscriptionProvider('local', useSettingsStore.getState().keys).transcribe({ projectId: project.id, sourcePath, model: project.settings.whisperModel }); const path = await window.gensuite.files.saveText({ content: `${segmentsToSrt(segments)}\n`, defaultName: 'phu-de.srt', extensions: ['srt'] }); if (path) setResult(path); } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); } };
  const name = sourcePath.replace(/\\/g, '/').split('/').pop();
  return <ToolShell><div className="workspace-panel rounded-2xl p-7"><div className="mb-5 inline-flex rounded-xl bg-amber-400/10 p-3 text-amber-300"><FileText size={23} /></div><h2 className="text-lg font-bold">Tạo SRT từ video hoặc audio</h2><p className="mt-2 text-sm leading-6 text-white/40">Nhận dạng lời thoại trực tiếp trên thiết bị và giữ chính xác các mốc thời gian.</p><button onClick={() => void choose()} disabled={busy} className="mt-6 flex min-h-24 w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-white/15 bg-white/[0.02] text-sm text-white/55 hover:border-amber-300/40 hover:text-white"><Upload size={20} className="text-amber-300" /><span className="max-w-[90%] truncate">{name || 'Chọn video hoặc audio'}</span></button><button onClick={() => void run()} disabled={!sourcePath || busy} className="primary-action mt-4 flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-bold disabled:opacity-40">{busy ? <Loader2 size={16} className="animate-spin" /> : <FileText size={16} />}{busy ? phase || 'Đang xử lý…' : 'Nhận dạng và xuất SRT'}</button>{error && <p className="mt-4 text-sm text-red-300">{error}</p>}<ResultPath path={result} /></div></ToolShell>;
}

function TranslateTool({ onOpenSettings }: { onOpenSettings: () => void }) {
  const project = useProjectStore((state) => state.project);
  const setScriptEngine = useProjectStore((state) => state.setScriptEngine);
  const keys = useSettingsStore((state) => state.keys);
  const [source, setSource] = useState('');
  const [sourceName, setSourceName] = useState('');
  const [target, setTarget] = useState('vietnamese');
  const [output, setOutput] = useState('');
  const [wasSrt, setWasSrt] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [missingKey, setMissingKey] = useState<string | null>(null);
  const parsed = useMemo(() => source.trim() ? parseTranslationInput(source) : { segments: [], srt: false }, [source]);
  const importFile = async () => { const file = await window.gensuite.files.pickText(); if (file) { setSource(file.content); setSourceName(file.name); setOutput(''); } };
  const run = async () => { if (!parsed.segments.length || busy) return; setBusy(true); setError(''); setMissingKey(null); try { const translated = await getScriptProvider(project.settings.scriptEngine, keys, project.settings.scriptModel).translateSegments({ segments: parsed.segments, targetLanguage: target }); setWasSrt(parsed.srt); setOutput(parsed.srt ? segmentsToSrt(translated) : translated.map((segment) => segment.text).join('\n')); } catch (err) { const service = missingKeyService(err); if (service) setMissingKey(service); else setError(errorMessage(err)); } finally { setBusy(false); } };
  const save = async () => { if (!output) return; const ext = wasSrt ? 'srt' : 'txt'; await window.gensuite.files.saveText({ content: `${output}\n`, defaultName: sourceName ? `${sourceName.replace(/\.(srt|txt)$/i, '')}-${target}.${ext}` : `ban-dich.${ext}`, extensions: [ext] }); };
  return <ToolShell><div className="workspace-panel rounded-2xl p-7"><div className="flex flex-wrap items-start justify-between gap-4"><div><div className="mb-4 inline-flex rounded-xl bg-emerald-400/10 p-3 text-emerald-300"><Languages size={23} /></div><h2 className="text-lg font-bold">Dịch văn bản hoặc phụ đề</h2></div><EngineToggle value={project.settings.scriptEngine} onChange={(value: ScriptEngine) => setScriptEngine(value)} options={[{ value: 'gemini', label: 'Google AI', badge: 'free' }, { value: 'gensuite', label: 'GenSuite', badge: 'cloud', premium: true }]} /></div><div className="mt-6 grid gap-4 md:grid-cols-2"><div><div className="mb-2 flex items-center justify-between"><label className="text-xs font-bold text-white/50">Nội dung gốc</label><button onClick={() => void importFile()} className="flex items-center gap-1.5 text-xs font-bold text-emerald-300 hover:text-emerald-200"><Upload size={13} />Nhập TXT/SRT</button></div><textarea value={source} onChange={(event) => { setSource(event.target.value); setSourceName(''); setOutput(''); }} rows={14} placeholder="Dán văn bản hoặc nội dung SRT…" className="field-surface w-full resize-y rounded-xl p-4 text-sm leading-6 outline-none" /></div><div><div className="mb-2 flex items-center justify-between"><label className="text-xs font-bold text-white/50">Bản dịch</label>{output && <button onClick={() => void save()} className="flex items-center gap-1.5 text-xs font-bold text-emerald-300"><Save size={13} />Lưu {wasSrt ? 'SRT' : 'TXT'}</button>}</div><textarea readOnly value={output} rows={14} placeholder="Bản dịch sẽ xuất hiện tại đây…" className="field-surface w-full resize-y rounded-xl p-4 text-sm leading-6 text-white/75 outline-none" /></div></div><div className="mt-4 flex flex-wrap items-end gap-3"><label className="min-w-52 flex-1 text-xs font-bold text-white/50">Ngôn ngữ đích<select value={target} onChange={(event) => setTarget(event.target.value)} className="field-surface mt-2 w-full rounded-xl px-3 py-3 text-sm text-white outline-none">{TARGET_LANGUAGES.map(([value, label]) => <option key={value} value={value} className="bg-[#181819]">{label}</option>)}</select></label><button onClick={() => void run()} disabled={!parsed.segments.length || busy} className="primary-action flex min-w-48 items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-bold disabled:opacity-40">{busy ? <Loader2 size={16} className="animate-spin" /> : <Languages size={16} />}{busy ? 'Đang dịch…' : 'Dịch ngay'}</button></div>{parsed.srt && <p className="mt-3 text-xs text-emerald-300/65">Đã nhận diện tệp SRT · mốc thời gian sẽ được giữ nguyên.</p>}{missingKey && <div className="mt-4 flex items-center justify-between rounded-xl border border-amber-400/25 bg-amber-400/10 p-3 text-sm text-amber-100/75"><span><KeyRound size={15} className="mr-2 inline" />Thiếu API key cho {serviceLabel(missingKey)}</span><button onClick={onOpenSettings} className="rounded-lg bg-amber-300 px-3 py-1.5 text-xs font-bold text-black">Cài đặt</button></div>}{error && <p className="mt-4 text-sm text-red-300">{error}</p>}</div></ToolShell>;
}
