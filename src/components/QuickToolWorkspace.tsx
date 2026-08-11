import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Check, Download, FileText, FolderOpen, KeyRound, Languages, Loader2, LogIn, Mic, Save, Subtitles, Trash2, Upload, X } from 'lucide-react';
import { AudioPlayer } from './AudioPlayer';
import { EngineToggle } from './EngineToggle';
import { AppSelect } from './AppSelect';
import { ImageStudioWorkspace } from './ImageStudioWorkspace';
import { VoiceConfigPanel, GENMAX_LANGUAGE_IDS } from './VoiceConfigPanel';
import { useProjectStore, uid } from '../store/projectStore';
import { useSettingsStore } from '../store/settingsStore';
import { getVoiceProvider } from '../providers/voice';
import { getTranscriptionProvider } from '../providers/transcription';
import { getScriptProvider } from '../providers/script';
import { errorMessage, loginRequiredPlatform, missingKeyService, serviceLabel, type VideoLoginPlatform } from '../providers/errors';
import { localFileUrl } from '../shared/localFile';
import { buildSrtContent, formatSrtPreviewTime, parseSrt, type SrtEntry } from '../shared/srt';
import type { ScriptEngine, TranscriptSegment } from '../shared/types';

export type QuickToolId = 'download' | 'voice' | 'srt' | 'translate' | 'image';

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
  image: { title: 'Tạo ảnh', eyebrow: 'Sáng tạo hình ảnh' },
};

const TARGET_LANGUAGES: Array<[string, string]> = [
  ['vietnamese', 'Tiếng Việt'], ['english', 'English'], ['chinese', '中文'], ['japanese', '日本語'],
  ['korean', '한국어'], ['thai', 'ภาษาไทย'], ['french', 'Français'], ['german', 'Deutsch'],
  ['spanish', 'Español'], ['portuguese', 'Português'], ['indonesian', 'Bahasa Indonesia'], ['russian', 'Русский'],
];
const TARGET_LANGUAGE_OPTIONS = TARGET_LANGUAGES.map(([value, label]) => ({ value, label }));

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
      {tool === 'image' && <ImageStudioWorkspace />}
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
  const [videoLoginPlatform, setVideoLoginPlatform] = useState<VideoLoginPlatform | null>(null);
  const [videoLoginBusy, setVideoLoginBusy] = useState(false);
  const [videoSessionCleared, setVideoSessionCleared] = useState(false);
  useEffect(() => window.gensuite.ytdlp.onProgress((progress) => { if (progress.projectId === projectId) { setPercent(progress.percent); setPhase(progress.phase || ''); } }), [projectId]);
  const run = async () => {
    if (!url.trim() || busy) return;
    setBusy(true); setError(''); setResult(''); setPercent(0); setVideoLoginPlatform(null); setVideoSessionCleared(false);
    try {
      const sourcePath = await window.gensuite.ytdlp.download({ projectId, url: url.trim() });
      const saved = await window.gensuite.files.saveCopy({ sourcePath, defaultName: 'video.mp4' });
      if (saved) setResult(saved);
    } catch (err) {
      const loginPlatform = loginRequiredPlatform(err);
      if (loginPlatform) setVideoLoginPlatform(loginPlatform);
      else setError(errorMessage(err));
    } finally { setBusy(false); }
  };
  const loginVideoPlatform = async () => {
    if (!videoLoginPlatform || videoLoginBusy || busy) return;
    const platform = videoLoginPlatform;
    const platformName = platform === 'douyin' ? 'Douyin' : 'TikTok';
    setVideoLoginBusy(true);
    setError('');
    setVideoSessionCleared(false);
    try {
      const sessionReady = platform === 'douyin'
        ? await window.gensuite.ytdlp.loginDouyin()
        : await window.gensuite.ytdlp.loginTikTok();
      if (!sessionReady) {
        setError(platform === 'douyin'
          ? 'Douyin chưa cấp được phiên khách. Vui lòng thử lại sau.'
          : 'Chưa hoàn tất đăng nhập TikTok. Hãy thử lại khi bạn sẵn sàng.');
        return;
      }
      setVideoLoginPlatform(null);
      await run();
    } catch {
      setError(`Không thể mở cửa sổ đăng nhập ${platformName}. Vui lòng thử lại.`);
    } finally {
      setVideoLoginBusy(false);
    }
  };
  const clearVideoPlatformSession = async () => {
    if (!videoLoginPlatform || videoLoginBusy || busy) return;
    const platform = videoLoginPlatform;
    const platformName = platform === 'douyin' ? 'Douyin' : 'TikTok';
    setVideoLoginBusy(true);
    setError('');
    try {
      if (platform === 'douyin') await window.gensuite.ytdlp.clearDouyinSession();
      else await window.gensuite.ytdlp.clearTikTokSession();
      setVideoSessionCleared(true);
    } catch {
      setError(`Không thể xóa phiên ${platformName}. Vui lòng thử lại.`);
    } finally {
      setVideoLoginBusy(false);
    }
  };
  return (
    <ToolShell>
      <div className="workspace-panel rounded-2xl p-7">
        <div className="mb-5 inline-flex rounded-xl bg-cyan-400/10 p-3 text-cyan-300"><Download size={23} /></div>
        <h2 className="text-lg font-bold">Dán liên kết video</h2>
        <p className="mt-2 text-sm leading-6 text-white/40">Hỗ trợ tải video từ nhiều nền tảng phổ biến và tự động chọn chất lượng tốt nhất.</p>
        <input autoFocus value={url} onChange={(event) => setUrl(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && void run()} disabled={busy || videoLoginBusy} placeholder="https://youtube.com/watch?v=…" className="field-surface mt-6 w-full rounded-xl px-4 py-3.5 text-sm outline-none disabled:opacity-50" />
        <button onClick={() => void run()} disabled={!url.trim() || busy || videoLoginBusy} className="primary-action mt-4 flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-bold disabled:opacity-40">
          {busy ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
          {busy ? (phase === 'preparing' ? 'Đang chuẩn bị video…' : phase === 'merging' ? 'Đang hoàn thiện video…' : `Đang tải ${Math.round(percent)}%`) : 'Tải video'}
        </button>
        {busy && <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-cyan-400 transition-all" style={{ width: `${percent}%` }} /></div>}
        {videoLoginPlatform && (
          <div className="mt-4 rounded-xl border border-amber-400/30 bg-amber-400/10 p-4 text-sm text-amber-100">
            <p className="flex items-center gap-2 font-semibold"><LogIn size={16} /> {videoLoginPlatform === 'douyin' ? 'Douyin cần xác nhận phiên truy cập' : 'TikTok cần đăng nhập để mở nội dung này'}</p>
            <p className="mt-2 text-xs leading-5 text-amber-100/65">{videoLoginPlatform === 'douyin' ? 'Trong cửa sổ Douyin, hãy bấm nút Đăng nhập rồi đóng cửa sổ; không cần nhập tài khoản.' : 'Một cửa sổ TikTok riêng sẽ mở để bạn tự đăng nhập.'} Ứng dụng không đọc mật khẩu hoặc dữ liệu từ trình duyệt chính.</p>
            {videoSessionCleared && <p className="mt-2 text-xs text-emerald-300">Đã xóa phiên cũ. Bạn có thể đăng nhập lại.</p>}
            <div className="mt-3 flex flex-wrap gap-2">
              <button onClick={() => void loginVideoPlatform()} disabled={videoLoginBusy} className="inline-flex items-center gap-2 rounded-lg bg-amber-300 px-4 py-2.5 text-xs font-bold text-black disabled:opacity-50">
                {videoLoginBusy ? <Loader2 size={14} className="animate-spin" /> : <LogIn size={14} />} {videoLoginPlatform === 'douyin' ? 'Mở Douyin làm mới phiên' : 'Đăng nhập TikTok'}
              </button>
              <button onClick={() => void clearVideoPlatformSession()} disabled={videoLoginBusy} className="inline-flex items-center gap-2 rounded-lg border border-amber-200/20 px-3 py-2.5 text-xs font-semibold text-amber-100/70 disabled:opacity-50">
                <Trash2 size={14} /> Xóa phiên cũ
              </button>
            </div>
          </div>
        )}
        {error && <p className="mt-4 text-sm text-red-300">{error}</p>}
        <ResultPath path={result} />
      </div>
    </ToolShell>
  );
}

function VoiceTool({ onOpenSettings }: { onOpenSettings: () => void }) {
  const project = useProjectStore((state) => state.project);
  const keys = useSettingsStore((state) => state.keys);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<'text' | 'srt'>('text');
  const [text, setText] = useState('');
  const [srtEntries, setSrtEntries] = useState<SrtEntry[]>([]);
  const [srtFileName, setSrtFileName] = useState('');
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState('');
  const [audioPath, setAudioPath] = useState('');
  const [savedPath, setSavedPath] = useState('');
  const [missingKey, setMissingKey] = useState<string | null>(null);
  const [error, setError] = useState('');
  const clearResult = () => { setAudioPath(''); setSavedPath(''); setError(''); setProgress(0); setProgressLabel(''); };
  const loadSrtFile = async (file: File) => {
    clearResult();
    if (!file.name.toLowerCase().endsWith('.srt')) { setError('Hãy chọn đúng tệp phụ đề có định dạng .SRT.'); return; }
    try {
      const entries = parseSrt(await file.text());
      if (!entries.length) { setError('Tệp SRT không có câu phụ đề hợp lệ. Hãy kiểm tra lại mốc thời gian và nội dung.'); return; }
      setSrtEntries(entries);
      setSrtFileName(file.name);
    } catch {
      setError('Không thể đọc tệp SRT này. Hãy kiểm tra tệp rồi thử lại.');
    }
  };
  const voiceRequest = (
    segmentId: string,
    content: string,
    onProgress?: Parameters<ReturnType<typeof getVoiceProvider>['synthesize']>[0]['onProgress'],
    srt?: { content: string; fileName: string },
  ) => {
    const engine = project.settings.voiceEngine;
    const config = project.settings.voiceConfigs[engine];
    return getVoiceProvider(engine, keys).synthesize({
      projectId: project.id,
      segmentId,
      text: content,
      voiceId: config.voiceId,
      modelId: config.modelId,
      language: config.language,
      speed: config.speed,
      temperature: config.temperature,
      stability: config.stability,
      similarityBoost: config.similarityBoost,
      style: config.style,
      useSpeakerBoost: config.useSpeakerBoost,
      pitch: config.pitch,
      volume: config.volume,
      deliveryMode: config.deliveryMode,
      srt,
      onProgress,
    });
  };
  const synthesize = async () => {
    const hasInput = mode === 'text' ? Boolean(text.trim()) : srtEntries.length > 0;
    if (!hasInput || busy) return;
    const engine = project.settings.voiceEngine;
    const config = project.settings.voiceConfigs[engine];
    if ((engine === 'elevenlabs' || engine === 'minimax') && !GENMAX_LANGUAGE_IDS.includes(config.language)) { setError('Hãy chọn ngôn ngữ trước khi tạo giọng.'); return; }
    setBusy(true); setError(''); setMissingKey(null); setSavedPath(''); setAudioPath(''); setProgress(0);
    try {
      if (mode === 'text') {
        setProgressLabel('Đang tạo giọng…');
        const result = await voiceRequest(uid('quick_voice_'), text.trim(), (event) => {
          const chunkProgress = event.totalChunks > 0 ? event.completedChunks / event.totalChunks : 0;
          setProgress(Math.min(95, Math.round(chunkProgress * 100)));
        });
        setAudioPath(result.audioPath);
      } else if (engine === 'elevenlabs' || engine === 'minimax') {
        setProgressLabel('Đang xử lý toàn bộ tệp SRT và căn thời gian…');
        const result = await voiceRequest(
          uid('quick_srt_native_'),
          srtEntries.map((entry) => entry.text).join('\n'),
          (event) => {
            const current = event.totalChunks > 0 ? event.completedChunks / event.totalChunks : 0;
            setProgress(Math.min(95, Math.round(current * 100)));
          },
          { content: buildSrtContent(srtEntries), fileName: srtFileName || 'subtitles.srt' },
        );
        setAudioPath(result.audioPath);
      } else {
        const timelineParts: Array<{ audioPath: string; startTime: number; endTime: number }> = [];
        for (let index = 0; index < srtEntries.length; index += 1) {
          const entry = srtEntries[index];
          setProgressLabel(`Đang tạo giọng cho câu ${index + 1}/${srtEntries.length}`);
          setProgress(Math.round(index / srtEntries.length * 90));
          const result = await voiceRequest(uid(`quick_srt_${index + 1}_`), entry.text, (event) => {
            const current = event.totalChunks > 0 ? event.completedChunks / event.totalChunks : 0;
            setProgress(Math.round(((index + current) / srtEntries.length) * 90));
          });
          timelineParts.push({ audioPath: result.audioPath, startTime: entry.startTime, endTime: entry.endTime });
        }
        setProgress(92);
        setProgressLabel('Đang ghép giọng theo mốc thời gian SRT…');
        const assembled = await window.gensuite.audio.assembleTimeline({ projectId: project.id, segmentId: uid('quick_srt_timeline_'), parts: timelineParts });
        if (!assembled.ok) throw assembled.error;
        setAudioPath(assembled.value.audioPath);
      }
      setProgress(100);
      setProgressLabel('Hoàn tất');
    } catch (err) { const service = missingKeyService(err); if (service) setMissingKey(service); else setError(errorMessage(err)); } finally { setBusy(false); }
  };
  const save = async () => { if (audioPath) { const path = await window.gensuite.files.saveCopy({ sourcePath: audioPath, defaultName: 'gensuite-voice.mp3' }); if (path) setSavedPath(path); } };
  const totalChars = srtEntries.reduce((sum, entry) => sum + entry.text.length, 0);
  const totalDuration = srtEntries.length ? srtEntries[srtEntries.length - 1].endTime : 0;
  const canGenerate = mode === 'text' ? Boolean(text.trim()) : srtEntries.length > 0;
  return <div className="flex min-h-0 flex-1"><section className="min-w-0 flex-1 overflow-y-auto"><div className="mx-auto max-w-3xl px-8 py-10"><div className="workspace-panel rounded-2xl p-7"><div className="mb-5 inline-flex rounded-xl bg-violet-400/10 p-3 text-violet-300"><Mic size={23} /></div><h2 className="text-lg font-bold">Nội dung cần đọc</h2><div className="mt-5 grid grid-cols-2 rounded-xl border border-white/10 bg-black/15 p-1"><button onClick={() => { setMode('text'); clearResult(); }} disabled={busy} className={`rounded-lg px-4 py-2.5 text-sm font-bold transition ${mode === 'text' ? 'bg-white/10 text-white shadow-sm' : 'text-white/40 hover:text-white/70'}`}><FileText size={15} className="mr-2 inline" />Văn bản</button><button onClick={() => { setMode('srt'); clearResult(); }} disabled={busy} className={`rounded-lg px-4 py-2.5 text-sm font-bold transition ${mode === 'srt' ? 'bg-white/10 text-white shadow-sm' : 'text-white/40 hover:text-white/70'}`}><Subtitles size={15} className="mr-2 inline" />Tệp SRT</button></div>{mode === 'text' ? <><textarea autoFocus value={text} onChange={(event) => { setText(event.target.value); clearResult(); }} rows={10} placeholder="Nhập hoặc dán văn bản tại đây…" className="field-surface mt-5 w-full resize-y rounded-xl p-4 text-sm leading-6 outline-none" /><div className="mt-2 text-right text-[11px] text-white/30">{text.trim().length.toLocaleString('vi-VN')} ký tự</div></> : <><input ref={fileInputRef} type="file" accept=".srt,application/x-subrip" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) void loadSrtFile(file); event.currentTarget.value = ''; }} />{srtEntries.length ? <div className="mt-5"><div className="flex items-center justify-between gap-4 rounded-xl border border-violet-300/20 bg-violet-400/[0.06] p-4"><div className="flex min-w-0 items-center gap-3"><div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-violet-400/10 text-violet-300"><Subtitles size={19} /></div><div className="min-w-0"><div className="truncate text-sm font-bold">{srtFileName}</div><div className="mt-1 text-[11px] text-white/35">{srtEntries.length.toLocaleString('vi-VN')} câu · {totalChars.toLocaleString('vi-VN')} ký tự · {formatSrtPreviewTime(totalDuration)}</div></div></div><button onClick={() => { setSrtEntries([]); setSrtFileName(''); clearResult(); }} disabled={busy} aria-label="Xóa tệp SRT" className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-white/35 hover:bg-white/5 hover:text-white"><X size={16} /></button></div><div className="mt-3 max-h-48 space-y-1 overflow-y-auto rounded-xl border border-white/8 bg-black/15 p-3">{srtEntries.slice(0, 8).map((entry) => <div key={`${entry.id}-${entry.startTime}`} className="flex items-start gap-3 rounded-lg px-2 py-1.5"><span className="shrink-0 font-mono text-[10px] tabular-nums text-violet-300/65">{formatSrtPreviewTime(entry.startTime)}</span><span className="line-clamp-2 text-xs leading-5 text-white/50">{entry.text}</span></div>)}{srtEntries.length > 8 && <div className="pt-1 text-center text-[10px] text-white/25">Còn {srtEntries.length - 8} câu khác</div>}</div><button onClick={() => fileInputRef.current?.click()} disabled={busy} className="mt-3 w-full rounded-lg border border-white/10 px-3 py-2 text-xs font-bold text-white/50 hover:bg-white/5 hover:text-white/75">Chọn tệp khác</button></div> : <button onClick={() => fileInputRef.current?.click()} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); const file = event.dataTransfer.files?.[0]; if (file) void loadSrtFile(file); }} className={`mt-5 flex min-h-64 w-full flex-col items-center justify-center rounded-xl border-2 border-dashed transition ${dragging ? 'border-violet-300 bg-violet-400/10' : 'border-white/10 bg-black/10 hover:border-violet-300/35 hover:bg-violet-400/[0.04]'}`}><span className="grid h-14 w-14 place-items-center rounded-2xl border border-white/10 bg-white/[0.03] text-violet-300"><Upload size={25} /></span><span className="mt-4 text-sm font-bold text-white/70">Chọn hoặc thả tệp SRT vào đây</span><span className="mt-2 text-xs text-white/30">Giọng đọc sẽ được đặt đúng theo mốc thời gian phụ đề</span></button>}</>}{busy && <div className="mt-4 rounded-xl border border-violet-300/15 bg-violet-400/[0.05] p-3"><div className="flex items-center justify-between gap-3 text-xs"><span className="truncate text-violet-100/70">{progressLabel}</span><strong className="text-violet-200">{progress}%</strong></div><div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-violet-300 transition-all" style={{ width: `${progress}%` }} /></div></div>}{missingKey && <div className="mt-4 flex items-center justify-between rounded-xl border border-amber-400/25 bg-amber-400/10 p-3 text-sm text-amber-100/75"><span><KeyRound size={15} className="mr-2 inline" />Thiếu API key cho {serviceLabel(missingKey)}</span><button onClick={onOpenSettings} className="rounded-lg bg-amber-300 px-3 py-1.5 text-xs font-bold text-black">Cài đặt</button></div>}{error && <p className="mt-4 text-sm text-red-300">{error}</p>}<button onClick={() => void synthesize()} disabled={!canGenerate || busy} className="primary-action mt-4 flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-bold disabled:opacity-40">{busy ? <Loader2 size={16} className="animate-spin" /> : <Mic size={16} />}{busy ? 'Đang tạo giọng…' : mode === 'srt' ? 'Tạo giọng theo SRT' : 'Tạo Voice AI'}</button>{audioPath && <div className="mt-5 rounded-xl border border-white/10 bg-black/15 p-4"><AudioPlayer src={localFileUrl(audioPath)!} /><button onClick={() => void save()} className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-xs font-bold text-white/65 hover:bg-white/5"><Save size={14} />Lưu audio</button></div>}<ResultPath path={savedPath} /></div></div></section><aside className="relative flex h-full w-[400px] shrink-0 flex-col border-l border-white/10 bg-[#0f0f10]"><VoiceConfigPanel onMissingKey={setMissingKey} /></aside></div>;
}

function SrtTool() {
  const project = useProjectStore((state) => state.project);
  const [sourcePath, setSourcePath] = useState('');
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState('');
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  useEffect(() => window.gensuite.whisper.onProgress((progress) => setPhase(progress.phase === 'downloading-model' ? `Đang chuẩn bị dữ liệu nhận dạng ${Math.round(progress.percent || 0)}%` : progress.phase === 'extracting' ? 'Đang chuẩn bị âm thanh…' : progress.phase === 'transcribing' ? `Đang nhận dạng lời thoại${typeof progress.percent === 'number' ? ` ${Math.round(progress.percent)}%` : '…'}` : '')), []);
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
  return <ToolShell><div className="workspace-panel rounded-2xl p-7"><div className="flex flex-wrap items-start justify-between gap-4"><div><div className="mb-4 inline-flex rounded-xl bg-emerald-400/10 p-3 text-emerald-300"><Languages size={23} /></div><h2 className="text-lg font-bold">Dịch văn bản hoặc phụ đề</h2></div><EngineToggle value={project.settings.scriptEngine} onChange={(value: ScriptEngine) => setScriptEngine(value)} options={[{ value: 'gemini', label: 'Google AI', badge: 'free' }, { value: 'gensuite', label: 'GenSuite', badge: 'cloud', premium: true }]} /></div><div className="mt-6 grid gap-4 md:grid-cols-2"><div><div className="mb-2 flex items-center justify-between"><label className="text-xs font-bold text-white/50">Nội dung gốc</label><button onClick={() => void importFile()} className="flex items-center gap-1.5 text-xs font-bold text-emerald-300 hover:text-emerald-200"><Upload size={13} />Nhập TXT/SRT</button></div><textarea value={source} onChange={(event) => { setSource(event.target.value); setSourceName(''); setOutput(''); }} rows={14} placeholder="Dán văn bản hoặc nội dung SRT…" className="field-surface w-full resize-y rounded-xl p-4 text-sm leading-6 outline-none" /></div><div><div className="mb-2 flex items-center justify-between"><label className="text-xs font-bold text-white/50">Bản dịch</label>{output && <button onClick={() => void save()} className="flex items-center gap-1.5 text-xs font-bold text-emerald-300"><Save size={13} />Lưu {wasSrt ? 'SRT' : 'TXT'}</button>}</div><textarea readOnly value={output} rows={14} placeholder="Bản dịch sẽ xuất hiện tại đây…" className="field-surface w-full resize-y rounded-xl p-4 text-sm leading-6 text-white/75 outline-none" /></div></div><div className="mt-4 flex flex-wrap items-end gap-3"><label className="min-w-52 flex-1 text-xs font-bold text-white/50">Ngôn ngữ đích<AppSelect value={target} options={TARGET_LANGUAGE_OPTIONS} onChange={setTarget} ariaLabel="Ngôn ngữ đích" className="mt-2 rounded-xl px-3 py-3 text-sm" /></label><button onClick={() => void run()} disabled={!parsed.segments.length || busy} className="primary-action flex min-w-48 items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-bold disabled:opacity-40">{busy ? <Loader2 size={16} className="animate-spin" /> : <Languages size={16} />}{busy ? 'Đang dịch…' : 'Dịch ngay'}</button></div>{parsed.srt && <p className="mt-3 text-xs text-emerald-300/65">Đã nhận diện tệp SRT · mốc thời gian sẽ được giữ nguyên.</p>}{missingKey && <div className="mt-4 flex items-center justify-between rounded-xl border border-amber-400/25 bg-amber-400/10 p-3 text-sm text-amber-100/75"><span><KeyRound size={15} className="mr-2 inline" />Thiếu API key cho {serviceLabel(missingKey)}</span><button onClick={onOpenSettings} className="rounded-lg bg-amber-300 px-3 py-1.5 text-xs font-bold text-black">Cài đặt</button></div>}{error && <p className="mt-4 text-sm text-red-300">{error}</p>}</div></ToolShell>;
}
