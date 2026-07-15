import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, FileVideo, KeyRound, Languages, Loader2, Link2, Mic, Play, RotateCcw, Subtitles, Upload, Wand2 } from 'lucide-react';
import { useProjectStore } from '../store/projectStore';
import { useSettingsStore } from '../store/settingsStore';
import { EngineToggle } from '../components/EngineToggle';
import { VoiceConfigPanel } from '../components/VoiceConfigPanel';
import { getTranscriptionProvider } from '../providers/transcription';
import { getScriptProvider } from '../providers/script';
import { getVoiceProvider } from '../providers/voice';
import { missingKeyService, serviceLabel, errorMessage } from '../providers/errors';
import type { SubtitleConfig, SubtitlePosition, TranscriptionEngine, WhisperModelName } from '../shared/types';

interface Props { onOpenSettings: () => void; }

// Target languages offered for the re-dub. Values are the labels sent to the LLM
// translation prompt; keep them human-readable since the prompt embeds them.
const TARGET_LANGUAGES: Array<[string, string]> = [
  ['vietnamese', 'Tiếng Việt'], ['english', 'English'], ['chinese', 'Chinese (Mandarin)'],
  ['japanese', 'Japanese'], ['korean', 'Korean'], ['french', 'French'], ['german', 'German'],
  ['spanish', 'Spanish'], ['portuguese', 'Portuguese'], ['italian', 'Italian'], ['russian', 'Russian'],
  ['thai', 'Thai'], ['indonesian', 'Indonesian'], ['hindi', 'Hindi'], ['arabic', 'Arabic'],
];

// Source-language hints for whisper. 'auto' lets the engine detect it.
const SOURCE_LANGUAGES: Array<[string, string]> = [
  ['auto', 'Tự động nhận diện'], ['en', 'English'], ['vi', 'Tiếng Việt'], ['zh', 'Chinese'],
  ['ja', 'Japanese'], ['ko', 'Korean'], ['fr', 'French'], ['de', 'German'], ['es', 'Spanish'],
  ['ru', 'Russian'], ['th', 'Thai'], ['hi', 'Hindi'], ['ar', 'Arabic'],
];

const WHISPER_MODELS: Array<[WhisperModelName, string]> = [
  ['tiny', 'Tiny · nhanh nhất, kém chính xác'],
  ['base', 'Base · cân bằng (khuyến nghị)'],
  ['small', 'Small · chính xác hơn, chậm hơn'],
  ['medium', 'Medium · chính xác nhất, nặng'],
];

const FONT_CHOICES = ['Arial', 'Times New Roman', 'Tahoma', 'Verdana', 'Georgia', 'Segoe UI'];
// CJK-capable families, offered so a Chinese/Japanese/Korean re-dub can pick a font
// that renders those glyphs. The names match CJK_FONTS in electron/ipc/ffmpeg.ts.
const CJK_FONT_CHOICES = ['Microsoft YaHei', 'SimHei', 'SimSun', 'PingFang SC', 'Noto Sans CJK SC', 'Malgun Gothic', 'Yu Gothic', 'Meiryo'];
const POSITION_LABELS: Record<SubtitlePosition, string> = { top: 'Trên', middle: 'Giữa', bottom: 'Dưới' };

// The paid translation flow uses GenSuite's Gemini model; free uses Google AI Studio directly.
const GENSUITE_TRANSLATE_MODEL = 'google-ai-studio/gemini-3.1-flash-lite';

type Stage = 'idle' | 'download' | 'transcribe' | 'translate' | 'voice' | 'voice-error' | 'merge' | 'done' | 'error';

export function LocalizeStudio({ onOpenSettings }: Props) {
  const project = useProjectStore((state) => state.project);
  const setTranscriptionEngine = useProjectStore((state) => state.setTranscriptionEngine);
  const setWhisperModel = useProjectStore((state) => state.setWhisperModel);
  const setScriptEngine = useProjectStore((state) => state.setScriptEngine);
  const setScriptModel = useProjectStore((state) => state.setScriptModel);
  const setSourceVideo = useProjectStore((state) => state.setSourceVideo);
  const patchSettings = useProjectStore((state) => state.patchSettings);
  const keys = useSettingsStore((state) => state.keys);

  const transcriptionEngine = project.settings.transcriptionEngine;
  const whisperModel = project.settings.whisperModel;
  const scriptEngine = project.settings.scriptEngine;
  const sub = project.settings.subtitle;
  const sourcePath = project.sourceVideoPath;

  const [url, setUrl] = useState('');
  const [sourceLanguage, setSourceLanguage] = useState(project.sourceLanguage || 'auto');
  const [targetLanguage, setTargetLanguage] = useState(project.targetLanguage || 'vietnamese');
  const [showSubOptions, setShowSubOptions] = useState(false);

  const [stage, setStage] = useState<Stage>('idle');
  const [downloadPercent, setDownloadPercent] = useState(0);
  const [downloadPhase, setDownloadPhase] = useState('');
  const [transcribePhase, setTranscribePhase] = useState('');
  const [modelPercent, setModelPercent] = useState<number | null>(null);
  const [voiceProgress, setVoiceProgress] = useState({ done: 0, total: 0 });
  const [voiceErrorMsg, setVoiceErrorMsg] = useState('');
  const [mergePercent, setMergePercent] = useState(0);
  const [resultPath, setResultPath] = useState('');
  const [missingKey, setMissingKey] = useState<string | null>(null);
  const [error, setError] = useState('');

  const running = stage !== 'idle' && stage !== 'done' && stage !== 'error' && stage !== 'voice-error';
  const runningRef = useRef(running);
  runningRef.current = running;

  // Source path is captured once at the start of a run so the voice/merge steps
  // (and any retry of a failed scene) can reuse it without re-downloading.
  const srcRef = useRef('');

  useEffect(() => window.gensuite.ytdlp.onProgress((p) => {
    if (p.projectId !== project.id) return;
    setDownloadPercent(p.percent);
    setDownloadPhase(p.phase ?? '');
  }), [project.id]);

  useEffect(() => window.gensuite.whisper.onProgress((p) => {
    setTranscribePhase(p.phase);
    setModelPercent(p.phase === 'downloading-model' && typeof p.percent === 'number' ? p.percent : null);
  }), []);

  useEffect(() => window.gensuite.ffmpeg.onProgress((p) => {
    if (p.projectId !== project.id || !p.totalSec) return;
    setMergePercent(Math.min(100, Math.round((p.timeSec / p.totalSec) * 100)));
  }), [project.id]);

  const sourceName = sourcePath ? sourcePath.replace(/\\/g, '/').split('/').pop() : '';

  const patchSub = (patch: Partial<SubtitleConfig>) => patchSettings({ subtitle: { ...sub, ...patch } });

  const importFile = async () => {
    if (running) return;
    setError('');
    try {
      const filePath = await window.gensuite.ytdlp.import(project.id);
      if (filePath) {
        setSourceVideo(filePath);
        setUrl('');
      }
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  // Free translation = Google AI Studio (gemini engine); paid = GenSuite with the
  // Gemini model id. The toggle owns both scriptEngine and scriptModel.
  const setTranslatePaid = (paid: boolean) => {
    if (paid) { setScriptEngine('gensuite'); setScriptModel(GENSUITE_TRANSLATE_MODEL); }
    else { setScriptEngine('gemini'); setScriptModel(''); }
  };

  const run = async () => {
    if (running) return;
    setError('');
    setMissingKey(null);
    setResultPath('');
    setDownloadPercent(0);
    setMergePercent(0);
    setVoiceProgress({ done: 0, total: 0 });

    try {
      const store = useProjectStore.getState();
      const settings = store.project.settings;
      const projectId = store.project.id;

      // 1 · Source: download the URL now, or reuse an imported file.
      setStage('download');
      let src = store.project.sourceVideoPath;
      if (url.trim()) {
        src = await window.gensuite.ytdlp.download({ projectId, url: url.trim() });
        useProjectStore.getState().setSourceVideo(src);
      }
      if (!src) throw new Error('Hãy dán link video hoặc chọn file trên máy trước khi bắt đầu.');

      // 2 · Transcribe.
      setStage('transcribe');
      const transcriber = getTranscriptionProvider(settings.transcriptionEngine, keys);
      const segments = await transcriber.transcribe({
        projectId, sourcePath: src, model: settings.whisperModel, language: sourceLanguage,
      });
      useProjectStore.getState().setTranscript(segments);

      // 3 · Translate, then turn each translated line into a timed scene.
      setStage('translate');
      const translator = getScriptProvider(settings.scriptEngine, keys, settings.scriptModel);
      const translated = await translator.translateSegments({
        segments, targetLanguage, sourceLanguage: sourceLanguage === 'auto' ? undefined : sourceLanguage,
      });
      useProjectStore.getState().setLanguages({ sourceLanguage, targetLanguage });
      useProjectStore.getState().buildScenesFromTranscript(translated);

      srcRef.current = src;
      await voiceAndMerge();
    } catch (err) {
      const service = missingKeyService(err);
      if (service) setMissingKey(service);
      else setError(errorMessage(err));
      setStage('error');
    }
  };

  // Voice every scene, then merge. Scenes that already have an audioPath are
  // skipped, so this doubles as the resume path: after a scene fails (e.g. edge-tts
  // rate-limit), "Thử lại" re-runs this and only the unfinished scenes are voiced.
  const voiceAndMerge = async () => {
    const store = useProjectStore.getState();
    const settings = store.project.settings;
    const projectId = store.project.id;
    const src = srcRef.current;

    // 4 · Voice each scene sequentially (cloud jobs and edge-tts both dislike
    // being hammered in parallel). A failure parks the run at 'voice-error'
    // rather than discarding the scenes already voiced.
    setStage('voice');
    setVoiceErrorMsg('');
    const scenes = useProjectStore.getState().project.scenes;
    const voice = getVoiceProvider(settings.voiceEngine, keys);
    const cfg = settings.voiceConfigs[settings.voiceEngine];
    const doneCount = () => useProjectStore.getState().project.scenes.filter((s) => s.audioPath).length;
    setVoiceProgress({ done: doneCount(), total: scenes.length });
    for (let i = 0; i < scenes.length; i += 1) {
      const scene = scenes[i];
      if (scene.audioPath) continue; // already voiced (fresh run skips nothing, retry skips the done ones)
      try {
        const result = await voice.synthesize({
          projectId, segmentId: scene.id, text: scene.narration,
          voiceId: cfg.voiceId, modelId: cfg.modelId, language: cfg.language,
          speed: cfg.speed, temperature: cfg.temperature, stability: cfg.stability,
          similarityBoost: cfg.similarityBoost, style: cfg.style, useSpeakerBoost: cfg.useSpeakerBoost,
          pitch: cfg.pitch, volume: cfg.volume, deliveryMode: cfg.deliveryMode,
        });
        useProjectStore.getState().updateScene(scene.id, { audioPath: result.audioPath, audioDuration: result.durationSec });
        setVoiceProgress({ done: doneCount(), total: scenes.length });
      } catch (err) {
        const service = missingKeyService(err);
        if (service) { setMissingKey(service); setStage('error'); return; }
        setVoiceErrorMsg(errorMessage(err));
        setVoiceProgress({ done: doneCount(), total: scenes.length });
        setStage('voice-error');
        return;
      }
    }

    // 5 · Merge the dubbed lines back over the original video.
    setStage('merge');
    const finalScenes = useProjectStore.getState().project.scenes;
    const redubSegments = finalScenes
      .filter((s) => s.audioPath && typeof s.sourceStart === 'number' && typeof s.sourceEnd === 'number')
      .map((s) => ({ audioPath: s.audioPath as string, sourceStart: s.sourceStart as number, sourceEnd: s.sourceEnd as number, text: s.narration }));
    if (!redubSegments.length) throw new Error('Không có câu thoại nào để lồng tiếng.');
    const out = await window.gensuite.ffmpeg.redub({
      projectId, sourceVideoPath: src, segments: redubSegments,
      subtitles: settings.subtitle.enabled, subtitleConfig: settings.subtitle,
    });
    if (!out) { setStage('idle'); return; } // save dialog cancelled
    useProjectStore.getState().setDubbedVideo(out);
    setResultPath(out);
    setStage('done');
  };

  // Retry after a scene failed mid-voicing: continue from where it stopped.
  const retryVoice = async () => {
    setError('');
    setMissingKey(null);
    try {
      await voiceAndMerge();
    } catch (err) {
      const service = missingKeyService(err);
      if (service) setMissingKey(service);
      else setError(errorMessage(err));
      setStage('error');
    }
  };

  const stageLabel = (): string => {
    switch (stage) {
      case 'download': return downloadPhase === 'merging' ? 'Đang ghép video tải về…' : `Đang tải video ${Math.round(downloadPercent)}%`;
      case 'transcribe':
        return transcribePhase === 'extracting' ? 'Đang trích âm thanh…'
          : transcribePhase === 'downloading-model' ? `Đang tải model nhận dạng${modelPercent !== null ? ` ${modelPercent}%` : '…'}`
          : transcribePhase === 'transcribing' ? 'Đang nhận dạng lời thoại…' : 'Đang nhận dạng…';
      case 'translate': return 'Đang dịch lời thoại…';
      case 'voice': return `Đang lồng tiếng ${voiceProgress.done}/${voiceProgress.total}…`;
      case 'merge': return `Đang ghép vào video gốc ${mergePercent}%`;
      default: return '';
    }
  };

  return (
    <div className="mx-auto min-h-0 max-w-3xl overflow-y-auto px-8 py-10">
      <header className="mb-6">
        <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.16em] text-emerald-400/80">Dịch & lồng tiếng video</div>
        <h1 className="text-3xl font-bold tracking-[-0.04em]">Dịch & lồng tiếng video</h1>
        <p className="mt-2 text-sm text-text/50">Dán link, chọn cấu hình rồi bấm một nút — tự động tải, nhận dạng, dịch, lồng tiếng và ghép lại vào video gốc.</p>
      </header>

      {/* 1 · Source */}
      <section className="workspace-panel mb-5 rounded-2xl p-5">
        <div className="mb-4 flex items-center gap-2 text-sm font-bold text-white"><FileVideo size={16} className="text-emerald-400" /> 1. Nguồn video</div>
        <div className="field-surface mb-3 flex items-center gap-3 rounded-xl px-4 py-3">
          <Link2 size={16} className="text-white/35" />
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={running}
            placeholder="Dán link YouTube, TikTok, Bilibili…"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none disabled:opacity-50"
          />
        </div>
        <button onClick={importFile} disabled={running} className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 px-4 py-3 text-sm font-semibold text-white/65 hover:border-white/20 disabled:opacity-45">
          <Upload size={15} /> Hoặc chọn file trên máy
        </button>
        {sourceName && !url.trim() && (
          <p className="mt-3 flex items-center gap-2 text-xs text-emerald-300"><Check size={14} /> {sourceName}</p>
        )}
      </section>

      {/* 2 · Recognition */}
      <section className="workspace-panel mb-5 rounded-2xl p-5">
        <div className="mb-4 flex items-center gap-2 text-sm font-bold text-white"><Mic size={16} className="text-emerald-400" /> 2. Nhận dạng lời thoại</div>
        <div className="mb-4">
          <EngineToggle<TranscriptionEngine>
            label="Bộ nhận dạng"
            value={transcriptionEngine}
            options={[
              { value: 'local', label: 'Whisper Local', hint: 'Miễn phí, chạy trên máy, tải model lần đầu', badge: 'free' },
              { value: 'cloud', label: 'GenSuite', hint: 'Trả phí, chính xác cao, cần GenSuite API key', premium: true, badge: 'cloud' },
            ]}
            onChange={setTranscriptionEngine}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1.5">
            <span className="text-[10px] font-black uppercase tracking-[0.16em] text-white/40">Ngôn ngữ gốc</span>
            <select value={sourceLanguage} onChange={(e) => setSourceLanguage(e.target.value)} disabled={running} className="field-surface w-full rounded-xl px-3 py-2.5 text-sm outline-none">
              {SOURCE_LANGUAGES.map(([value, label]) => <option key={value} value={value} className="bg-[#181819]">{label}</option>)}
            </select>
          </label>
          {transcriptionEngine === 'local' && (
            <label className="block space-y-1.5">
              <span className="text-[10px] font-black uppercase tracking-[0.16em] text-white/40">Model</span>
              <select value={whisperModel} onChange={(e) => setWhisperModel(e.target.value as WhisperModelName)} disabled={running} className="field-surface w-full rounded-xl px-3 py-2.5 text-sm outline-none">
                {WHISPER_MODELS.map(([value, label]) => <option key={value} value={value} className="bg-[#181819]">{label}</option>)}
              </select>
            </label>
          )}
        </div>
      </section>

      {/* 3 · Translate */}
      <section className="workspace-panel mb-5 rounded-2xl p-5">
        <div className="mb-4 flex items-center gap-2 text-sm font-bold text-white"><Languages size={16} className="text-emerald-400" /> 3. Ngôn ngữ dịch</div>
        <div className="mb-4">
          <EngineToggle<'free' | 'paid'>
            label="Bộ dịch"
            value={scriptEngine === 'gensuite' ? 'paid' : 'free'}
            options={[
              { value: 'free', label: 'Google AI Studio', hint: 'Miễn phí, cần Google AI Studio API key', badge: 'free' },
              { value: 'paid', label: 'GenSuite', hint: 'Trả phí, dùng model Gemini qua GenSuite', premium: true, badge: 'cloud' },
            ]}
            onChange={(v) => setTranslatePaid(v === 'paid')}
          />
        </div>
        <label className="block space-y-1.5">
          <span className="text-[10px] font-black uppercase tracking-[0.16em] text-white/40">Ngôn ngữ đích</span>
          <select value={targetLanguage} onChange={(e) => setTargetLanguage(e.target.value)} disabled={running} className="field-surface w-full rounded-xl px-3 py-2.5 text-sm outline-none">
            {TARGET_LANGUAGES.map(([value, label]) => <option key={value} value={value} className="bg-[#181819]">{label}</option>)}
          </select>
        </label>
      </section>

      {/* 4 · Voice */}
      <section className="workspace-panel mb-5 rounded-2xl p-5">
        <div className="mb-4 flex items-center gap-2 text-sm font-bold text-white"><Wand2 size={16} className="text-emerald-400" /> 4. Giọng đọc</div>
        <div className="relative h-[560px] overflow-hidden rounded-xl border border-white/[0.06] bg-[#0f0f10]">
          <VoiceConfigPanel onMissingKey={setMissingKey} />
        </div>
        <p className="mt-3 text-[11px] leading-4 text-white/25">Tiếng dịch được co giãn để khớp mốc thời gian câu gốc; toàn bộ tiếng gốc sẽ bị thay thế.</p>
      </section>

      {/* 5 · Subtitles */}
      <section className="workspace-panel mb-5 rounded-2xl p-5">
        <div className="flex items-center gap-2 text-sm font-bold text-white">
          <Subtitles size={16} className="text-emerald-400" /> 5. Phụ đề
          <label className="ml-auto flex cursor-pointer items-center gap-2 text-xs font-semibold text-white/60">
            <input type="checkbox" checked={sub.enabled} onChange={(e) => patchSub({ enabled: e.target.checked })} className="size-4 cursor-pointer accent-emerald-400" />
            Bật phụ đề (ngôn ngữ dịch)
          </label>
        </div>
        {sub.enabled && (
          <button
            type="button"
            onClick={() => setShowSubOptions((v) => !v)}
            className="mt-3 flex items-center gap-1.5 text-xs font-semibold text-emerald-300"
          >
            Tùy chỉnh <ChevronDown size={14} className={`transition-transform ${showSubOptions ? 'rotate-180' : ''}`} />
          </button>
        )}
        {sub.enabled && showSubOptions && (
          <div className="mt-3 grid grid-cols-2 gap-3 border-t border-white/10 pt-4 text-xs">
            <label className="flex flex-col gap-1.5">
              <span className="text-text/50">Phông chữ</span>
              <select value={sub.fontFamily} onChange={(e) => patchSub({ fontFamily: e.target.value })} className="rounded-md border border-white/10 bg-white/5 px-2 py-1.5 text-text">
                <optgroup label="Latin (Việt/Anh…)" className="bg-[#1a1a1a] text-white">
                  {FONT_CHOICES.map((f) => <option key={f} value={f} className="bg-[#1a1a1a] text-white">{f}</option>)}
                </optgroup>
                <optgroup label="CJK (Trung/Nhật/Hàn)" className="bg-[#1a1a1a] text-white">
                  {CJK_FONT_CHOICES.map((f) => <option key={f} value={f} className="bg-[#1a1a1a] text-white">{f}</option>)}
                </optgroup>
              </select>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-text/50">Vị trí</span>
              <select value={sub.position} onChange={(e) => patchSub({ position: e.target.value as SubtitlePosition })} className="rounded-md border border-white/10 bg-white/5 px-2 py-1.5 text-text">
                {(Object.keys(POSITION_LABELS) as SubtitlePosition[]).map((p) => <option key={p} value={p} className="bg-[#1a1a1a] text-white">{POSITION_LABELS[p]}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-text/50">Cỡ chữ ({sub.fontSizePct}% chiều cao)</span>
              <input type="range" min={2} max={12} step={0.5} value={sub.fontSizePct} onChange={(e) => patchSub({ fontSizePct: Number(e.target.value) })} className="accent-emerald-400" />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-text/50">Độ dày viền ({sub.outlineWidth}px)</span>
              <input type="range" min={0} max={8} step={1} value={sub.outlineWidth} onChange={(e) => patchSub({ outlineWidth: Number(e.target.value) })} className="accent-emerald-400" />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-text/50">Đổ bóng ({sub.shadow}px)</span>
              <input type="range" min={0} max={6} step={1} value={sub.shadow} onChange={(e) => patchSub({ shadow: Number(e.target.value) })} className="accent-emerald-400" />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-text/50">Độ rộng tối đa / dòng ({sub.maxCharsPerLine || 'không giới hạn'} · chữ CJK tính gấp đôi)</span>
              <input type="range" min={0} max={80} step={1} value={sub.maxCharsPerLine} onChange={(e) => patchSub({ maxCharsPerLine: Number(e.target.value) })} className="accent-emerald-400" />
            </label>
            <label className="flex items-center gap-2">
              <span className="text-text/50">Màu chữ</span>
              <input type="color" value={sub.primaryColor} onChange={(e) => patchSub({ primaryColor: e.target.value })} className="h-7 w-10 cursor-pointer rounded border border-white/10 bg-transparent" />
            </label>
            <label className="flex items-center gap-2">
              <span className="text-text/50">Màu viền</span>
              <input type="color" value={sub.outlineColor} onChange={(e) => patchSub({ outlineColor: e.target.value })} className="h-7 w-10 cursor-pointer rounded border border-white/10 bg-transparent" />
            </label>
            <label className="col-span-2 flex cursor-pointer items-center gap-2">
              <input type="checkbox" checked={sub.bold} onChange={(e) => patchSub({ bold: e.target.checked })} className="size-4 cursor-pointer accent-emerald-400" />
              <span className="text-text/70">In đậm</span>
            </label>
          </div>
        )}
      </section>

      {/* Errors */}
      {missingKey && (
        <div className="mb-5 flex items-center justify-between rounded-xl border border-amber-400/30 bg-amber-400/10 p-4 text-sm">
          <span className="flex items-center gap-2"><KeyRound size={16} /> Thiếu API key cho {serviceLabel(missingKey)}.</span>
          <button onClick={onOpenSettings} className="rounded-lg bg-amber-300 px-3 py-2 text-xs font-bold text-black">Mở Cài đặt</button>
        </div>
      )}
      {error && <p className="mb-5 rounded-xl border border-red-400/20 bg-red-400/5 p-3 text-sm text-red-300">{error}</p>}

      {/* Voice failed mid-run: keep the scenes already voiced, let the user retry
          just the unfinished ones without restarting the whole pipeline. */}
      {stage === 'voice-error' && (
        <div className="mb-5 rounded-2xl border border-amber-400/30 bg-amber-400/10 p-5">
          <p className="text-sm font-semibold text-amber-200">Lồng tiếng bị gián đoạn ở đoạn {voiceProgress.done + 1}/{voiceProgress.total}</p>
          {voiceErrorMsg && <p className="mt-2 text-xs leading-5 text-amber-200/70">{voiceErrorMsg}</p>}
          <p className="mt-2 text-xs text-amber-200/60">{voiceProgress.done} đoạn đã xong sẽ được giữ lại. Bấm thử lại để tiếp tục từ đoạn bị lỗi.</p>
          <button
            onClick={retryVoice}
            className="mt-4 inline-flex items-center gap-2 rounded-lg bg-amber-300 px-4 py-2.5 text-xs font-bold text-black hover:bg-amber-200"
          >
            <RotateCcw size={14} /> Thử lại đoạn này
          </button>
        </div>
      )}

      {/* Progress / result */}
      {running && (
        <div className="mb-5 rounded-2xl border border-emerald-400/20 bg-emerald-400/5 p-5">
          <p className="flex items-center gap-2 text-sm font-semibold text-emerald-200"><Loader2 size={16} className="animate-spin" /> {stageLabel()}</p>
          {(stage === 'download' || stage === 'merge' || stage === 'voice') && (
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10">
              <div className="h-full rounded-full bg-emerald-400 transition-all" style={{ width: `${stage === 'download' ? downloadPercent : stage === 'merge' ? mergePercent : voiceProgress.total ? (voiceProgress.done / voiceProgress.total) * 100 : 0}%` }} />
            </div>
          )}
        </div>
      )}
      {stage === 'done' && resultPath && (
        <div className="mb-5 flex items-center gap-2 rounded-2xl border border-emerald-400/30 bg-emerald-400/10 p-4 text-sm text-emerald-200">
          <Check size={16} /> Hoàn tất! Video đã lưu: <span className="truncate font-semibold">{resultPath.replace(/\\/g, '/').split('/').pop()}</span>
        </div>
      )}

      {/* Start */}
      <button
        onClick={run}
        disabled={running || (!url.trim() && !sourcePath)}
        className="primary-action flex w-full items-center justify-center gap-2 rounded-xl px-4 py-4 text-sm font-bold disabled:opacity-45"
      >
        {running ? <><Loader2 size={18} className="animate-spin" /> Đang xử lý…</> : <><Play size={18} /> Bắt đầu tạo</>}
      </button>
    </div>
  );
}
