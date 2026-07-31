import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, ChevronRight, FileVideo, KeyRound, Layers3, Loader2, Link2, LogIn, Play, RotateCcw, SlidersHorizontal, Subtitles, Trash2, Upload, Volume2, Wand2, X } from 'lucide-react';
import { useProjectStore } from '../store/projectStore';
import { useSettingsStore } from '../store/settingsStore';
import { EngineToggle } from '../components/EngineToggle';
import { VoiceConfigPanel } from '../components/VoiceConfigPanel';
import { SubtitleDesigner } from '../components/SubtitleDesigner';
import { getTranscriptionProvider } from '../providers/transcription';
import { getScriptProvider } from '../providers/script';
import { getVoiceProvider } from '../providers/voice';
import { missingKeyService, serviceLabel, errorMessage, loginRequiredPlatform, type VideoLoginPlatform } from '../providers/errors';
import type { SubtitleConfig, WhisperModelName } from '../shared/types';
import { alignSceneSubtitle, hasFreshSubtitleTiming } from '../shared/subtitleAlignment';
import { useEntitlementStore } from '../store/entitlementStore';

interface Props { onOpenSettings: () => void; }

// Target languages offered for the re-dub. Values are the labels sent to the LLM
// translation prompt; keep them human-readable since the prompt embeds them.
const TARGET_LANGUAGES: Array<[string, string]> = [
  ['vietnamese', 'Tiếng Việt'], ['english', 'English'], ['chinese', 'Chinese (Mandarin)'],
  ['japanese', 'Japanese'], ['korean', 'Korean'], ['french', 'French'], ['german', 'German'],
  ['spanish', 'Spanish'], ['portuguese', 'Portuguese'], ['italian', 'Italian'], ['russian', 'Russian'],
  ['thai', 'Thai'], ['indonesian', 'Indonesian'], ['hindi', 'Hindi'], ['arabic', 'Arabic'],
];

// A source language is mandatory so speech recognition never silently guesses
// the wrong language for an entire video.
const SOURCE_LANGUAGES: Array<[string, string]> = [
  ['vi', 'Tiếng Việt'], ['en', 'English'], ['zh', 'Chinese'],
  ['ja', 'Japanese'], ['ko', 'Korean'], ['fr', 'French'], ['de', 'German'], ['es', 'Spanish'],
  ['ru', 'Russian'], ['th', 'Thai'], ['hi', 'Hindi'], ['ar', 'Arabic'],
];

const WHISPER_MODELS: Array<[WhisperModelName, string]> = [
  ['tiny', 'Nhanh nhất'],
  ['base', 'Cân bằng · Khuyến nghị'],
  ['small', 'Chính xác hơn'],
  ['medium', 'Chính xác cao nhất'],
];

// The paid translation flow uses GenSuite's Gemini model; free uses Google AI Studio directly.
const GENSUITE_TRANSLATE_MODEL = 'google-ai-studio/gemini-3.1-flash-lite';

type Stage = 'idle' | 'download' | 'transcribe' | 'translate' | 'voice' | 'voice-error' | 'align' | 'merge' | 'done' | 'error';
type SetupStep = 'source' | 'voice' | 'subtitle' | 'export';
type TaskMode = 'single' | 'batch';
type BatchStatus = 'queued' | 'processing' | 'done' | 'error';

interface BatchItem {
  id: string;
  kind: 'file' | 'url';
  value: string;
  label: string;
  status: BatchStatus;
  resultPath?: string;
  error?: string;
}

const SETUP_STEPS: Array<{ id: SetupStep; label: string; description: string; icon: typeof FileVideo }> = [
  { id: 'source', label: 'Video & ngôn ngữ', description: 'Chọn nguồn và ngôn ngữ', icon: FileVideo },
  { id: 'voice', label: 'Giọng đọc', description: 'Chọn chất giọng phù hợp', icon: Wand2 },
  { id: 'subtitle', label: 'Phụ đề', description: 'Chọn preset hiển thị', icon: Subtitles },
  { id: 'export', label: 'Kiểm tra & tạo', description: 'Âm thanh và tổng quan', icon: Play },
];

function transcriptHasAbnormalRepetition(segments: Array<{ text: string }>): boolean {
  if (segments.length < 8) return false;
  const normalized = segments.map((segment) => segment.text.trim().toLocaleLowerCase().replace(/\s+/g, ' '));
  const counts = new Map<string, number>();
  let longestRun = 1;
  let currentRun = 1;
  for (let index = 0; index < normalized.length; index += 1) {
    const text = normalized[index];
    if (!text) continue;
    counts.set(text, (counts.get(text) ?? 0) + 1);
    if (index > 0 && text === normalized[index - 1]) {
      currentRun += 1;
      longestRun = Math.max(longestRun, currentRun);
    } else {
      currentRun = 1;
    }
  }
  const mostRepeated = Math.max(0, ...counts.values());
  return longestRun >= 6 || (mostRepeated >= 8 && mostRepeated / segments.length >= 0.4);
}

export function LocalizeStudio({ onOpenSettings }: Props) {
  const project = useProjectStore((state) => state.project);
  const setWhisperModel = useProjectStore((state) => state.setWhisperModel);
  const setScriptEngine = useProjectStore((state) => state.setScriptEngine);
  const setScriptModel = useProjectStore((state) => state.setScriptModel);
  const setSourceVideo = useProjectStore((state) => state.setSourceVideo);
  const patchSettings = useProjectStore((state) => state.patchSettings);
  const keys = useSettingsStore((state) => state.keys);
  const entitlementStatus = useEntitlementStore((state) => state.status);
  const canUseCloud = useEntitlementStore((state) => state.features.localizeCloud);

  const whisperModel = project.settings.whisperModel;
  const scriptEngine = project.settings.scriptEngine;
  const sub = project.settings.subtitle;
  const sourcePath = project.sourceVideoPath;

  const [url, setUrl] = useState('');
  const [taskMode, setTaskMode] = useState<TaskMode>('single');
  const [batchUrlInput, setBatchUrlInput] = useState('');
  const [batchItems, setBatchItems] = useState<BatchItem[]>([]);
  const [activeBatchId, setActiveBatchId] = useState<string | null>(null);
  const [setupStep, setSetupStep] = useState<SetupStep>('source');
  const [sourceLanguage, setSourceLanguage] = useState(project.sourceLanguage && project.sourceLanguage !== 'auto' ? project.sourceLanguage : 'vi');
  const [targetLanguage, setTargetLanguage] = useState(project.targetLanguage || 'vietnamese');
  const selectedSourceLanguage = SOURCE_LANGUAGES.some(([value]) => value === sourceLanguage) ? sourceLanguage : 'vi';

  const [stage, setStage] = useState<Stage>('idle');
  const [downloadPercent, setDownloadPercent] = useState(0);
  const [downloadPhase, setDownloadPhase] = useState('');
  const [transcribePhase, setTranscribePhase] = useState('');
  const [modelPercent, setModelPercent] = useState<number | null>(null);
  const [voiceProgress, setVoiceProgress] = useState({ done: 0, total: 0 });
  const [voiceErrorMsg, setVoiceErrorMsg] = useState('');
  const [mergePercent, setMergePercent] = useState(0);
  const [alignmentProgress, setAlignmentProgress] = useState({ done: 0, total: 0 });
  const [resultPath, setResultPath] = useState('');
  const [missingKey, setMissingKey] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [videoLoginPlatform, setVideoLoginPlatform] = useState<VideoLoginPlatform | null>(null);
  const [videoLoginBusy, setVideoLoginBusy] = useState(false);
  const [videoSessionCleared, setVideoSessionCleared] = useState(false);

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

  const importBatchFiles = async () => {
    if (running) return;
    setError('');
    try {
      const filePaths = await window.gensuite.ytdlp.importMany(project.id);
      if (!filePaths.length) return;
      setBatchItems((current) => [
        ...current,
        ...filePaths.map((filePath, index): BatchItem => ({
          id: `file-${Date.now()}-${index}`,
          kind: 'file',
          value: filePath,
          label: filePath.replace(/\\/g, '/').split('/').pop() || `Video ${current.length + index + 1}`,
          status: 'queued',
        })),
      ]);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const addBatchLinks = () => {
    const links = batchUrlInput.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    if (!links.length) return;
    setBatchItems((current) => {
      const existing = new Set(current.map((item) => item.value));
      const additions = links.filter((link) => !existing.has(link)).map((link, index): BatchItem => ({
        id: `url-${Date.now()}-${index}`,
        kind: 'url',
        value: link,
        label: `Video từ liên kết ${current.filter((item) => item.kind === 'url').length + index + 1}`,
        status: 'queued',
      }));
      return [...current, ...additions];
    });
    setBatchUrlInput('');
  };

  const removeBatchItem = (id: string) => {
    if (running) return;
    setBatchItems((current) => current.filter((item) => item.id !== id));
  };

  // Free translation = Google AI Studio (gemini engine); paid = GenSuite with the
  // Gemini model id. The toggle owns both scriptEngine and scriptModel.
  const setTranslatePaid = (paid: boolean) => {
    if (paid && (entitlementStatus !== 'ready' || !canUseCloud)) {
      setError(entitlementStatus === 'ready' ? 'Xử lý trực tuyến trong quy trình này cần gói Basic trở lên.' : 'Đang kiểm tra quyền tài khoản. Vui lòng thử lại sau.');
      return;
    }
    setError('');
    if (paid) { setScriptEngine('gensuite'); setScriptModel(GENSUITE_TRANSLATE_MODEL); }
    else { setScriptEngine('gemini'); setScriptModel(''); }
  };

  useEffect(() => {
    if (entitlementStatus === 'ready' && !canUseCloud && scriptEngine === 'gensuite') setTranslatePaid(false);
  }, [canUseCloud, entitlementStatus, scriptEngine]);

  const resetRunProgress = () => {
    setResultPath('');
    setDownloadPercent(0);
    setMergePercent(0);
    setVoiceProgress({ done: 0, total: 0 });
    setAlignmentProgress({ done: 0, total: 0 });
  };

  const processSource = async (input: { sourcePath?: string; url?: string; automaticOutputName?: string; batch?: boolean }): Promise<string | null> => {
    const store = useProjectStore.getState();
    const settings = store.project.settings;
    const projectId = store.project.id;

    setStage('download');
    let src = input.sourcePath || '';
    if (input.url) src = await window.gensuite.ytdlp.download({ projectId, url: input.url });
    if (!src) throw new Error('Không tìm thấy video nguồn để xử lý.');
    useProjectStore.getState().setSourceVideo(src);

    setStage('transcribe');
    const transcriber = getTranscriptionProvider('local', keys, 'localize-cloud');
    const segments = await transcriber.transcribe({
      projectId, sourcePath: src, model: settings.whisperModel, language: selectedSourceLanguage,
    });
    if (transcriptHasAbnormalRepetition(segments)) {
      throw new Error('Kết quả nhận dạng bị lặp bất thường. Hãy chọn đúng ngôn ngữ gốc hoặc tăng chất lượng nhận dạng rồi thử lại.');
    }
    useProjectStore.getState().setTranscript(segments);

    setStage('translate');
    const translator = getScriptProvider(settings.scriptEngine, keys, settings.scriptModel, 'localize-cloud');
    const translated = await translator.translateSegments({
      segments, targetLanguage, sourceLanguage: selectedSourceLanguage,
    });
    useProjectStore.getState().setLanguages({ sourceLanguage: selectedSourceLanguage, targetLanguage });
    useProjectStore.getState().buildScenesFromTranscript(translated);

    srcRef.current = src;
    return await voiceAndMerge({
      batch: input.batch,
      automaticOutputName: input.automaticOutputName,
    });
  };

  const prepareRun = () => {
    setSetupStep('export');
    setError('');
    setMissingKey(null);
    setVideoLoginPlatform(null);
    setVideoSessionCleared(false);
    resetRunProgress();
  };

  const run = async () => {
    if (running) return;
    if (taskMode === 'batch') {
      await runBatch();
      return;
    }
    prepareRun();
    try {
      await processSource({ sourcePath: url.trim() ? undefined : sourcePath, url: url.trim() || undefined });
    } catch (err) {
      const service = missingKeyService(err);
      const loginPlatform = loginRequiredPlatform(err);
      if (service) setMissingKey(service);
      else if (loginPlatform) setVideoLoginPlatform(loginPlatform);
      else setError(errorMessage(err));
      setStage('error');
    }
  };

  const runBatch = async () => {
    if (running || !batchItems.length) return;
    prepareRun();
    const queue = batchItems.filter((item) => item.status !== 'done');
    let completed = batchItems.filter((item) => item.status === 'done').length;
    let failed = 0;

    for (const item of queue) {
      setActiveBatchId(item.id);
      resetRunProgress();
      setBatchItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, status: 'processing', error: undefined } : entry));
      try {
        const cleanLabel = item.label.replace(/\.[^.]+$/, '').replace(/-\d{10,}-\d+$/, '');
        const out = await processSource({
          sourcePath: item.kind === 'file' ? item.value : undefined,
          url: item.kind === 'url' ? item.value : undefined,
          automaticOutputName: `${cleanLabel}-long-tieng`,
          batch: true,
        });
        if (!out) throw new Error('Video chưa được lưu thành công.');
        completed += 1;
        setBatchItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, status: 'done', resultPath: out } : entry));
      } catch (err) {
        failed += 1;
        const message = errorMessage(err);
        setBatchItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, status: 'error', error: message } : entry));
        const service = missingKeyService(err);
        const loginPlatform = loginRequiredPlatform(err);
        if (service || loginPlatform) {
          if (service) setMissingKey(service);
          if (loginPlatform) setVideoLoginPlatform(loginPlatform);
          setError('Hàng đợi đã tạm dừng. Hãy hoàn tất cấu hình cần thiết rồi chạy lại các video chưa xong.');
          break;
        }
      }
    }

    setActiveBatchId(null);
    if (completed > 0) setResultPath(`${completed} video đã hoàn thành${failed ? ` · ${failed} video lỗi` : ''}`);
    setStage(completed > 0 ? 'done' : 'error');
    if (!completed && failed) setError('Chưa có video nào hoàn thành. Bạn có thể xem lỗi tại từng mục và chạy lại.');
  };

  const loginVideoPlatform = async () => {
    if (!videoLoginPlatform || videoLoginBusy || running) return;
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
    if (!videoLoginPlatform || videoLoginBusy || running) return;
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

  // Voice every scene, then merge. Scenes that already have an audioPath are
  // skipped, so this doubles as the resume path: after a scene fails (e.g. edge-tts
  // rate-limit), "Thử lại" re-runs this and only the unfinished scenes are voiced.
  const voiceAndMerge = async (options?: { batch?: boolean; automaticOutputName?: string }): Promise<string | null> => {
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
    const voice = getVoiceProvider(settings.voiceEngine, keys, 'localize-cloud');
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
        useProjectStore.getState().updateScene(scene.id, {
          audioPath: result.audioPath,
          audioDuration: result.durationSec,
          subtitleWords: result.wordTimings,
          subtitleTimingText: result.wordTimings?.length ? scene.narration : undefined,
          subtitleTimingAudioPath: result.wordTimings?.length ? result.audioPath : undefined,
        });
        setVoiceProgress({ done: doneCount(), total: scenes.length });
      } catch (err) {
        if (options?.batch) throw err;
        const service = missingKeyService(err);
        if (service) { setMissingKey(service); setStage('error'); return null; }
        setVoiceErrorMsg(errorMessage(err));
        setVoiceProgress({ done: doneCount(), total: scenes.length });
        setStage('voice-error');
        return null;
      }
    }

    // 5 · Measure word timing from the generated voice before burning captions.
    let finalScenes = useProjectStore.getState().project.scenes;
    if (settings.subtitle.enabled) {
      setStage('align');
      setAlignmentProgress({ done: 0, total: finalScenes.length });
      for (let index = 0; index < finalScenes.length; index += 1) {
        const scene = finalScenes[index];
        const wordTimings = await alignSceneSubtitle(scene, projectId, targetLanguage);
        if (!hasFreshSubtitleTiming(scene)) {
          useProjectStore.getState().updateScene(scene.id, {
            subtitleWords: wordTimings,
            subtitleTimingText: scene.narration,
            subtitleTimingAudioPath: scene.audioPath,
          });
        }
        setAlignmentProgress({ done: index + 1, total: finalScenes.length });
      }
      finalScenes = useProjectStore.getState().project.scenes;
    }

    // 6 · Merge the dubbed lines back over the original video.
    setStage('merge');
    const redubSegments = finalScenes
      .filter((s) => s.audioPath && typeof s.sourceStart === 'number' && typeof s.sourceEnd === 'number')
      .map((s) => ({ audioPath: s.audioPath as string, sourceStart: s.sourceStart as number, sourceEnd: s.sourceEnd as number, text: s.narration, wordTimings: s.subtitleWords }));
    if (!redubSegments.length) throw new Error('Không có câu thoại nào để lồng tiếng.');
    const out = await window.gensuite.ffmpeg.redub({
      projectId, sourceVideoPath: src, segments: redubSegments,
      subtitles: settings.subtitle.enabled,
      subtitleConfig: settings.subtitle,
      originalAudioVolume: settings.originalAudioVolume,
      automaticOutputName: options?.automaticOutputName,
      revealOutput: options?.batch ? false : undefined,
    });
    if (!out) { setStage('idle'); return null; } // save dialog cancelled
    useProjectStore.getState().setDubbedVideo(out);
    setResultPath(out);
    setStage('done');
    return out;
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
      case 'download': return downloadPhase === 'preparing' ? 'Đang chuẩn bị và xác nhận quyền truy cập…'
        : downloadPhase === 'merging' ? 'Đang ghép video tải về…'
        : `Đang tải video ${Math.round(downloadPercent)}%`;
      case 'transcribe':
        return transcribePhase === 'extracting' ? 'Đang trích âm thanh…'
          : transcribePhase === 'downloading-model' ? `Đang chuẩn bị dữ liệu nhận dạng${modelPercent !== null ? ` ${modelPercent}%` : '…'}`
          : transcribePhase === 'transcribing' ? 'Đang nhận dạng lời thoại…' : 'Đang nhận dạng…';
      case 'translate': return 'Đang dịch lời thoại…';
      case 'voice': return `Đang lồng tiếng ${voiceProgress.done}/${voiceProgress.total}…`;
      case 'align': return `Đang căn phụ đề với lời đọc ${alignmentProgress.done}/${alignmentProgress.total}…`;
      case 'merge': return `Đang ghép vào video gốc ${mergePercent}%`;
      default: return '';
    }
  };

  const sourceReady = taskMode === 'batch' ? batchItems.length > 0 : Boolean(url.trim() || sourcePath);
  const completedBatchCount = batchItems.filter((item) => item.status === 'done').length;
  const remainingBatchCount = batchItems.length - completedBatchCount;
  const voiceConfig = project.settings.voiceConfigs[project.settings.voiceEngine];
  const currentStepIndex = SETUP_STEPS.findIndex((item) => item.id === setupStep);
  const sourceLanguageLabel = SOURCE_LANGUAGES.find(([value]) => value === selectedSourceLanguage)?.[1] ?? selectedSourceLanguage;
  const targetLanguageLabel = TARGET_LANGUAGES.find(([value]) => value === targetLanguage)?.[1] ?? targetLanguage;
  const stepReady = (id: SetupStep) => id === 'source' ? sourceReady : id === 'voice' ? Boolean(voiceConfig.voiceId) : true;
  const goNext = () => {
    const next = SETUP_STEPS[currentStepIndex + 1];
    if (next) setSetupStep(next.id);
  };
  const goBack = () => {
    const previous = SETUP_STEPS[currentStepIndex - 1];
    if (previous) setSetupStep(previous.id);
  };

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden px-6 py-5">
      <header className="mx-auto flex w-full max-w-5xl shrink-0 items-center justify-between gap-5 pb-4">
        <div className="min-w-0">
          <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.18em] text-emerald-400/75">Bản địa hóa video</div>
          <h1 className="truncate text-2xl font-bold tracking-[-0.04em]">Tạo bản lồng tiếng</h1>
          <p className="mt-1 text-xs text-white/40">Hoàn thành 4 bước, sau đó GenSuite tự xử lý phần còn lại.</p>
        </div>
        <div className="flex shrink-0 items-center rounded-xl border border-white/[0.08] bg-white/[0.025] p-1 text-xs">
          <button type="button" disabled={running} onClick={() => setTaskMode('single')} className={`flex items-center gap-2 rounded-lg px-3 py-2 font-bold transition disabled:cursor-default ${taskMode === 'single' ? 'bg-white/[0.08] text-white' : 'text-white/35 hover:text-white/65'}`}><FileVideo size={14} /> 1 video</button>
          <button type="button" disabled={running} onClick={() => setTaskMode('batch')} className={`flex items-center gap-2 rounded-lg px-3 py-2 font-bold transition disabled:cursor-default ${taskMode === 'batch' ? 'bg-emerald-400/15 text-emerald-200' : 'text-white/35 hover:text-white/65'}`}><Layers3 size={14} /> Hàng loạt{batchItems.length ? ` (${batchItems.length})` : ''}</button>
        </div>
      </header>

        <section className="workspace-panel mx-auto min-h-0 w-full max-w-5xl flex-1 overflow-y-auto rounded-2xl p-5">
          {missingKey && <div className="mb-4 flex items-center justify-between rounded-xl border border-amber-400/25 bg-amber-400/10 p-3 text-xs"><span className="flex items-center gap-2"><KeyRound size={15} /> Thiếu API key cho {serviceLabel(missingKey)}.</span><button onClick={onOpenSettings} className="rounded-lg bg-amber-300 px-3 py-2 font-bold text-black">Mở Cài đặt</button></div>}
          {error && <p className="mb-4 rounded-xl border border-red-400/20 bg-red-400/5 p-3 text-xs text-red-300">{error}</p>}
          {videoLoginPlatform && <div className="mb-4 rounded-xl border border-amber-400/25 bg-amber-400/10 p-4 text-xs text-amber-100"><p className="flex items-center gap-2 font-bold"><LogIn size={15} /> Cần xác nhận quyền truy cập video</p><p className="mt-2 leading-5 text-amber-100/65">Mở cửa sổ xác nhận, hoàn tất thao tác rồi quay lại đây. Ứng dụng không đọc thông tin đăng nhập của bạn.</p>{videoSessionCleared && <p className="mt-2 text-emerald-300">Đã xóa phiên cũ.</p>}<div className="mt-3 flex gap-2"><button onClick={() => void loginVideoPlatform()} disabled={videoLoginBusy} className="inline-flex items-center gap-2 rounded-lg bg-amber-300 px-3 py-2 font-bold text-black disabled:opacity-50">{videoLoginBusy ? <Loader2 size={13} className="animate-spin" /> : <LogIn size={13} />} Mở cửa sổ xác nhận</button><button onClick={() => void clearVideoPlatformSession()} disabled={videoLoginBusy} className="inline-flex items-center gap-2 rounded-lg border border-amber-200/20 px-3 py-2 text-amber-100/70"><Trash2 size={13} /> Xóa phiên cũ</button></div></div>}

          {setupStep === 'source' && <div className="mx-auto max-w-3xl">
            <div className="mb-5"><div className="flex items-center gap-2 text-base font-bold"><FileVideo size={18} className="text-emerald-300" /> Chọn video và ngôn ngữ</div><p className="mt-1 text-xs text-white/35">Đây là thông tin tối thiểu để nhận dạng và dịch chính xác.</p></div>
            {taskMode === 'single' ? <div className="rounded-2xl border border-white/[0.07] bg-black/15 p-4">
              <div className="field-surface flex items-center gap-3 rounded-xl px-4 py-3"><Link2 size={16} className="text-white/30" /><input value={url} onChange={(event) => setUrl(event.target.value)} disabled={running} placeholder="Dán liên kết video…" className="min-w-0 flex-1 bg-transparent text-sm outline-none" /></div>
              <div className="my-3 flex items-center gap-3 text-[10px] uppercase tracking-wider text-white/20"><span className="h-px flex-1 bg-white/[0.07]" />hoặc<span className="h-px flex-1 bg-white/[0.07]" /></div>
              <button onClick={importFile} disabled={running} className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 px-4 py-3 text-sm font-semibold text-white/65 hover:border-emerald-400/30 hover:text-white"><Upload size={15} /> Chọn file trên máy</button>
              {sourceName && !url.trim() && <p className="mt-3 flex items-center gap-2 truncate text-xs text-emerald-300"><Check size={14} /> {sourceName}</p>}
            </div> : <div className="rounded-2xl border border-white/[0.07] bg-black/15 p-4">
              <div className="grid gap-3 md:grid-cols-[1fr_auto]">
                <textarea value={batchUrlInput} onChange={(event) => setBatchUrlInput(event.target.value)} disabled={running} rows={3} placeholder={'Dán nhiều liên kết, mỗi dòng một video…'} className="field-surface min-h-24 resize-none rounded-xl px-4 py-3 text-sm leading-6 outline-none" />
                <div className="flex gap-2 md:w-40 md:flex-col">
                  <button type="button" onClick={addBatchLinks} disabled={running || !batchUrlInput.trim()} className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-white/10 px-3 py-2 text-xs font-bold text-white/60 hover:text-white disabled:opacity-35"><Link2 size={14} /> Thêm liên kết</button>
                  <button type="button" onClick={importBatchFiles} disabled={running} className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-emerald-400/20 bg-emerald-400/[0.06] px-3 py-2 text-xs font-bold text-emerald-200"><Upload size={14} /> Chọn nhiều file</button>
                </div>
              </div>
              <div className="mt-4 flex items-center justify-between"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-white/30">Hàng đợi · {batchItems.length} video</span>{batchItems.length > 0 && !running && <button type="button" onClick={() => setBatchItems([])} className="text-[10px] font-bold text-white/30 hover:text-red-300">Xóa danh sách</button>}</div>
              <div className="mt-2 max-h-56 space-y-2 overflow-y-auto pr-1">
                {!batchItems.length && <div className="grid min-h-20 place-items-center rounded-xl border border-dashed border-white/[0.08] text-xs text-white/25">Chưa có video trong hàng đợi</div>}
                {batchItems.map((item, index) => <div key={item.id} className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 ${item.status === 'processing' ? 'border-emerald-400/30 bg-emerald-400/[0.06]' : item.status === 'error' ? 'border-red-400/20 bg-red-400/[0.04]' : 'border-white/[0.06] bg-white/[0.02]'}`}>
                  <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg text-[10px] font-black ${item.status === 'done' ? 'bg-emerald-400 text-black' : item.status === 'processing' ? 'bg-emerald-400/15 text-emerald-300' : item.status === 'error' ? 'bg-red-400/10 text-red-300' : 'bg-white/[0.05] text-white/35'}`}>{item.status === 'done' ? <Check size={13} /> : item.status === 'processing' ? <Loader2 size={13} className="animate-spin" /> : index + 1}</span>
                  <button type="button" disabled={!item.resultPath} onClick={() => item.resultPath && window.gensuite.shell.showItemInFolder(item.resultPath)} className="min-w-0 flex-1 text-left disabled:cursor-default"><span className="block truncate text-xs font-semibold text-white/70">{item.label}</span><span className={`mt-0.5 block truncate text-[10px] ${item.status === 'error' ? 'text-red-300/70' : 'text-white/25'}`}>{item.status === 'queued' ? 'Đang chờ' : item.status === 'processing' ? stageLabel() : item.status === 'done' ? 'Hoàn thành · Bấm để mở vị trí tệp' : item.error}</span></button>
                  {!running && <button type="button" onClick={() => removeBatchItem(item.id)} className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-white/25 hover:bg-white/[0.05] hover:text-white"><X size={13} /></button>}
                </div>)}
              </div>
              <p className="mt-3 text-[10px] leading-4 text-white/25">Các video dùng chung cấu hình bên dưới và được xử lý lần lượt để giữ máy ổn định.</p>
            </div>}
            <div className="mt-4 grid gap-3 md:grid-cols-3">
              <label className="space-y-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-white/35">Ngôn ngữ gốc</span><select value={selectedSourceLanguage} onChange={(event) => setSourceLanguage(event.target.value)} disabled={running} className="field-surface w-full rounded-xl px-3 py-3 text-sm outline-none">{SOURCE_LANGUAGES.map(([value, label]) => <option key={value} value={value} className="bg-[#181819]">{label}</option>)}</select></label>
              <label className="space-y-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-white/35">Dịch sang</span><select value={targetLanguage} onChange={(event) => setTargetLanguage(event.target.value)} disabled={running} className="field-surface w-full rounded-xl px-3 py-3 text-sm outline-none">{TARGET_LANGUAGES.map(([value, label]) => <option key={value} value={value} className="bg-[#181819]">{label}</option>)}</select></label>
              <label className="space-y-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-white/35">Độ chính xác</span><select value={whisperModel} onChange={(event) => setWhisperModel(event.target.value as WhisperModelName)} disabled={running} className="field-surface w-full rounded-xl px-3 py-3 text-sm outline-none">{WHISPER_MODELS.map(([value, label]) => <option key={value} value={value} className="bg-[#181819]">{label}</option>)}</select></label>
            </div>
            <div className="mt-4 rounded-2xl border border-white/[0.07] p-4"><EngineToggle<'free' | 'paid'> label="Cách dịch" value={scriptEngine === 'gensuite' ? 'paid' : 'free'} options={[{ value: 'free', label: 'Dùng khóa riêng', hint: 'Dùng khóa dịch thuật bạn đã cấu hình', badge: 'free' }, { value: 'paid', label: 'Dùng credits', hint: canUseCloud ? 'Trừ credits trong tài khoản' : 'Cần gói Basic trở lên', premium: true, badge: 'cloud', disabled: entitlementStatus !== 'ready' || !canUseCloud }]} onChange={(value) => setTranslatePaid(value === 'paid')} /></div>
          </div>}

          {setupStep === 'voice' && <div className="flex min-h-full flex-col">
            <div className="mb-4"><div className="flex items-center gap-2 text-base font-bold"><Wand2 size={18} className="text-emerald-300" /> Chọn giọng đọc</div><p className="mt-1 text-xs text-white/35">Nghe thử và chọn một giọng phù hợp với ngôn ngữ đích.</p></div>
            <div className="relative min-h-[480px] flex-1 overflow-hidden rounded-2xl border border-white/[0.07] bg-[#0f0f10]"><VoiceConfigPanel feature="localize-cloud" onMissingKey={setMissingKey} /></div>
          </div>}

          {setupStep === 'subtitle' && <div className="mx-auto max-w-4xl">
            <div className="mb-4 flex items-start justify-between gap-4"><div><div className="flex items-center gap-2 text-base font-bold"><Subtitles size={18} className="text-emerald-300" /> Thiết kế phụ đề</div><p className="mt-1 text-xs text-white/35">Chọn preset trước; chỉ mở tùy chỉnh chi tiết khi cần.</p></div><label className="flex shrink-0 cursor-pointer items-center gap-2 rounded-xl border border-white/10 px-3 py-2 text-xs font-semibold text-white/65"><input type="checkbox" checked={sub.enabled} onChange={(event) => patchSub({ enabled: event.target.checked })} className="size-4 accent-emerald-400" /> Bật phụ đề</label></div>
            {sub.enabled ? <SubtitleDesigner config={sub} onChange={(next) => patchSettings({ subtitle: next })} ratio="16:9" /> : <div className="grid min-h-56 place-items-center rounded-2xl border border-dashed border-white/10 text-center"><div><Subtitles size={28} className="mx-auto text-white/20" /><p className="mt-3 text-sm text-white/45">Video sẽ được tạo không có phụ đề mới.</p></div></div>}
          </div>}

          {setupStep === 'export' && <div className="mx-auto max-w-3xl">
            <div className="mb-5"><div className="flex items-center gap-2 text-base font-bold"><SlidersHorizontal size={18} className="text-emerald-300" /> Kiểm tra trước khi tạo</div><p className="mt-1 text-xs text-white/35">Mọi thiết lập quan trọng được gom tại đây.</p></div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-2xl border border-white/[0.07] bg-black/15 p-4"><span className="text-[10px] font-black uppercase tracking-wider text-white/30">Video nguồn</span><p className="mt-2 truncate text-sm font-semibold text-white/80">{taskMode === 'batch' ? `${batchItems.length} video trong hàng đợi` : sourceName || (url.trim() ? 'Video từ liên kết' : 'Chưa chọn video')}</p></div>
              <div className="rounded-2xl border border-white/[0.07] bg-black/15 p-4"><span className="text-[10px] font-black uppercase tracking-wider text-white/30">Ngôn ngữ</span><p className="mt-2 text-sm font-semibold text-white/80">{sourceLanguageLabel} <ChevronRight size={13} className="mx-1 inline text-emerald-300" /> {targetLanguageLabel}</p></div>
              <div className="rounded-2xl border border-white/[0.07] bg-black/15 p-4"><span className="text-[10px] font-black uppercase tracking-wider text-white/30">Giọng đọc</span><p className="mt-2 truncate text-sm font-semibold text-white/80">{voiceConfig.voiceId ? 'Đã chọn giọng' : 'Chưa chọn giọng'}</p></div>
              <div className="rounded-2xl border border-white/[0.07] bg-black/15 p-4"><span className="text-[10px] font-black uppercase tracking-wider text-white/30">Phụ đề</span><p className="mt-2 text-sm font-semibold text-white/80">{sub.enabled ? 'Đang bật' : 'Đang tắt'}</p></div>
            </div>
            <div className="mt-4 rounded-2xl border border-white/[0.07] p-5"><div className="flex items-center justify-between"><span className="flex items-center gap-2 text-sm font-bold"><Volume2 size={16} className="text-emerald-300" /> Âm thanh video gốc</span><span className="text-xs font-bold text-emerald-300">{project.settings.originalAudioVolume}%</span></div><p className="mt-2 text-[11px] text-white/35">Giữ nhẹ không khí và âm thanh nền bên dưới giọng mới.</p><input type="range" min={0} max={40} step={1} value={project.settings.originalAudioVolume} onChange={(event) => patchSettings({ originalAudioVolume: Number(event.target.value) })} disabled={running} className="mt-4 w-full accent-emerald-400" /><div className="mt-1 flex justify-between text-[10px] text-white/25"><span>Tắt tiếng gốc</span><span>Rõ hơn</span></div></div>

            {stage === 'voice-error' && <div className="mt-4 rounded-2xl border border-amber-400/25 bg-amber-400/10 p-4"><p className="text-sm font-bold text-amber-200">Lồng tiếng bị gián đoạn ở đoạn {voiceProgress.done + 1}/{voiceProgress.total}</p>{voiceErrorMsg && <p className="mt-2 text-xs text-amber-200/65">{voiceErrorMsg}</p>}<button onClick={retryVoice} className="mt-3 inline-flex items-center gap-2 rounded-lg bg-amber-300 px-3 py-2 text-xs font-bold text-black"><RotateCcw size={13} /> Tiếp tục từ đoạn lỗi</button></div>}
            {stage === 'done' && resultPath && <div className="mt-4 flex items-center gap-2 rounded-2xl border border-emerald-400/25 bg-emerald-400/10 p-4 text-sm text-emerald-200"><Check size={16} /> Hoàn tất: <span className="truncate font-semibold">{taskMode === 'batch' ? resultPath : resultPath.replace(/\\/g, '/').split('/').pop()}</span></div>}
          </div>}
        </section>

      <footer className="mx-auto mt-4 flex w-full max-w-5xl shrink-0 items-center gap-3 rounded-2xl border border-white/[0.08] bg-[#151516]/95 p-3 shadow-2xl backdrop-blur-xl">
        {running ? <div className="min-w-0 flex-1 px-2"><p className="flex items-center gap-2 truncate text-xs font-semibold text-emerald-200"><Loader2 size={15} className="shrink-0 animate-spin" /> {taskMode === 'batch' && activeBatchId ? `Video ${Math.max(1, batchItems.findIndex((item) => item.id === activeBatchId) + 1)}/${batchItems.length} · ` : ''}{stageLabel()}</p><div className="mt-2 h-1 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-emerald-400 transition-all" style={{ width: `${stage === 'download' ? downloadPercent : stage === 'merge' ? mergePercent : stage === 'align' ? (alignmentProgress.total ? (alignmentProgress.done / alignmentProgress.total) * 100 : 0) : stage === 'voice' && voiceProgress.total ? (voiceProgress.done / voiceProgress.total) * 100 : 18}%` }} /></div></div> : <div className="min-w-0 flex-1 px-2"><p className="truncate text-xs font-semibold text-white/60">Bước {currentStepIndex + 1}/4 · {SETUP_STEPS[currentStepIndex].label}</p><p className="mt-0.5 truncate text-[10px] text-white/25">{sourceReady ? taskMode === 'batch' ? `${batchItems.length} video · ${completedBatchCount} đã xong` : `${sourceLanguageLabel} → ${targetLanguageLabel}` : 'Hãy chọn video để bắt đầu'}</p></div>}
        {currentStepIndex > 0 && !running && <button onClick={goBack} className="inline-flex items-center gap-2 rounded-xl border border-white/10 px-4 py-3 text-xs font-bold text-white/55 hover:text-white"><ArrowLeft size={14} /> Quay lại</button>}
        {setupStep !== 'export' ? <button onClick={goNext} disabled={running || !stepReady(setupStep)} className="primary-action inline-flex items-center gap-2 rounded-xl px-5 py-3 text-xs font-bold disabled:opacity-40">Tiếp tục <ChevronRight size={14} /></button> : <button onClick={run} disabled={running || !sourceReady || !voiceConfig.voiceId || (taskMode === 'batch' && remainingBatchCount === 0)} className="primary-action inline-flex min-w-40 items-center justify-center gap-2 rounded-xl px-5 py-3 text-xs font-bold disabled:opacity-40">{running ? <><Loader2 size={15} className="animate-spin" /> Đang xử lý</> : <><Play size={15} /> {taskMode === 'batch' ? remainingBatchCount === 0 ? 'Đã hoàn tất' : completedBatchCount ? 'Chạy phần còn lại' : `Tạo ${batchItems.length} video` : 'Tạo video'}</>}</button>}
      </footer>
      </div>

      <aside className="flex h-full w-[238px] shrink-0 flex-col overflow-y-auto border-l border-white/[0.08] bg-[#171718] p-3">
        <div className="px-3 pb-3 pt-2 text-[10px] font-black uppercase tracking-[0.16em] text-white/30">Thiết lập</div>
        <nav className="space-y-1">
          {SETUP_STEPS.map((item, index) => {
            const Icon = item.icon;
            const active = item.id === setupStep;
            const ready = stepReady(item.id);
            return <button key={item.id} type="button" disabled={running} onClick={() => setSetupStep(item.id)} className={`flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition disabled:cursor-default ${active ? 'bg-emerald-400/10 text-white ring-1 ring-emerald-400/25' : 'text-white/50 hover:bg-white/[0.04] hover:text-white/80'}`}>
              <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg text-xs font-bold ${active ? 'bg-emerald-400 text-[#07120f]' : 'bg-white/[0.05] text-white/40'}`}>{ready && index < currentStepIndex ? <Check size={15} /> : <Icon size={15} />}</span>
              <span className="min-w-0 flex-1"><span className="block text-xs font-bold">{index + 1}. {item.label}</span><span className="mt-0.5 block truncate text-[10px] text-white/30">{item.description}</span></span>
              {active && <ChevronRight size={14} className="text-emerald-300" />}
            </button>;
          })}
        </nav>
        <div className="mt-auto border-t border-white/[0.06] px-3 pb-1 pt-4 text-[10px] leading-4 text-white/30">
          Cấu hình được lưu theo dự án. Bạn có thể quay lại chỉnh bất kỳ bước nào trước khi tạo.
        </div>
      </aside>
    </div>
  );
}
