import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, CheckCircle2, ChevronDown, ClipboardCopy, FileVideo, FolderOpen, KeyRound, Layers3, Link2, Loader2, LogIn, Play, RotateCcw, Sparkles, Trash2, Upload, X } from 'lucide-react';
import { AppSelect } from '../components/AppSelect';
import { EngineToggle } from '../components/EngineToggle';
import { PipelineProgressPanel, type PipelineProgressStep } from '../components/PipelineProgressPanel';
import { VoiceConfigPanel } from '../components/VoiceConfigPanel';
import { getScriptProvider } from '../providers/script';
import { clientAppError, normalizedClientAppError } from '../providers/clientAppError';
import { errorMessage, loginRequiredPlatform, missingKeyService, type VideoLoginPlatform } from '../providers/errors';
import { getTranscriptionProvider, type ITranscriptionProvider } from '../providers/transcription';
import { getVoiceProvider, type IVoiceProvider } from '../providers/voice';
import { probeUsableAudio } from '../providers/voice/audioUtils';
import { capCutVoiceById } from '../providers/voice/capcutTtsCatalog';
import { EDGE_TTS_FALLBACK_VOICES, edgeVoiceName } from '../providers/voice/edgeTtsCatalog';
import type { AppErrorCode, AppErrorContext, PublicAppError } from '../shared/appErrors';
import { diagnosticSummaryForError, rememberDiagnostic } from '../shared/diagnosticSummary';
import { transcriptHasAbnormalRepetition } from '../shared/transcriptQuality';
import type { ProjectState, TranscriptSegment, WhisperModelName } from '../shared/types';
import { useEntitlementStore } from '../store/entitlementStore';
import { isInsufficientCreditsError } from '../store/creditPromptStore';
import { useProjectStore } from '../store/projectStore';
import { useSettingsStore } from '../store/settingsStore';

interface Props {
  onOpenSettings: () => void;
  setupStep: LocalizeSetupStep;
  onSetupStepChange: (step: LocalizeSetupStep) => void;
  onNavigationLockChange?: (locked: boolean) => void;
  onSourceReadyChange?: (ready: boolean) => void;
}

export type LocalizeSetupStep = 'source' | 'process';
type Stage = 'idle' | 'download' | 'recognition' | 'translation' | 'voice' | 'capcut' | 'done' | 'error';
type PipelineStageId = 'download' | 'recognition' | 'translation' | 'voice' | 'capcut';
type SourceInputMode = 'link' | 'file';
interface PipelineFailureSnapshot {
  error: PublicAppError;
  occurredAt: string;
}

const SOURCE_LANGUAGES = [
  ['vi', 'Tiếng Việt'], ['en', 'English'], ['zh', 'Chinese'], ['ja', 'Japanese'], ['ko', 'Korean'],
  ['fr', 'French'], ['de', 'German'], ['es', 'Spanish'], ['ru', 'Russian'], ['th', 'Thai'], ['hi', 'Hindi'], ['ar', 'Arabic'],
] as const;
const TARGET_LANGUAGES = [
  ['vietnamese', 'Tiếng Việt'], ['english', 'English'], ['chinese', 'Chinese (Mandarin)'], ['japanese', 'Japanese'],
  ['korean', 'Korean'], ['french', 'French'], ['german', 'German'], ['spanish', 'Spanish'], ['portuguese', 'Portuguese'],
  ['italian', 'Italian'], ['russian', 'Russian'], ['thai', 'Thai'], ['indonesian', 'Indonesian'], ['hindi', 'Hindi'], ['arabic', 'Arabic'],
] as const;
const ACCURACY_LEVELS: Array<[WhisperModelName, string]> = [
  ['tiny', 'Nhanh nhất'], ['base', 'Cân bằng · Khuyến nghị'], ['small', 'Chính xác hơn'], ['medium', 'Chính xác cao nhất'],
];
const SOURCE_OPTIONS = [{ value: '', label: 'Chọn ngôn ngữ gốc', disabled: true }, ...SOURCE_LANGUAGES.map(([value, label]) => ({ value, label }))];
const TARGET_OPTIONS = [{ value: '', label: 'Chọn ngôn ngữ đích', disabled: true }, ...TARGET_LANGUAGES.map(([value, label]) => ({ value, label }))];
const ACCURACY_OPTIONS = [{ value: '', label: 'Chọn độ chính xác', disabled: true }, ...ACCURACY_LEVELS.map(([value, label]) => ({ value, label }))];
const GENSUITE_TRANSLATE_MODEL = 'google-ai-studio/gemini-3.1-flash-lite';

const PIPELINE_DEFINITIONS: Array<Pick<PipelineProgressStep, 'id' | 'label'>> = [
  { id: 'download', label: 'Tải video' },
  { id: 'recognition', label: 'Nhận dạng' },
  { id: 'translation', label: 'Dịch' },
  { id: 'voice', label: 'Tạo voice' },
  { id: 'capcut', label: 'Dự án CapCut' },
];
const PIPELINE_FALLBACK_CODES: Record<PipelineStageId, AppErrorCode> = {
  download: 'VIDEO_SOURCE_UNREADABLE',
  recognition: 'TRANSCRIPTION_UNEXPECTED',
  translation: 'TRANSLATION_UNEXPECTED',
  voice: 'VOICE_UNEXPECTED',
  capcut: 'CAPCUT_EXPORT_FAILED',
};

function initialPipelineProgress(): PipelineProgressStep[] {
  return PIPELINE_DEFINITIONS.map((step) => ({ ...step, status: 'pending', percent: 0 }));
}

const VOICE_ENGINE_LABELS: Record<ProjectState['settings']['voiceEngine'], string> = {
  capcuttts: 'GenVoice Free TTS 2',
  edgetts: 'GenVoice Free TTS 1',
  genvoice: 'GenVoice',
  elevenlabs: 'ElevenLabs',
  minimax: 'MiniMax',
};

function languageLabel(value: string): string {
  return [...SOURCE_LANGUAGES, ...TARGET_LANGUAGES].find(([id]) => id === value)?.[1] ?? value;
}

function friendlyVoiceLabel(project: ProjectState): string {
  if (!project.settings.localizeVoiceProviderConfirmed) return 'Chưa chọn giọng';
  const engine = project.settings.voiceEngine;
  const voiceId = project.settings.voiceConfigs[engine].voiceId;
  if (engine === 'capcuttts') return capCutVoiceById(voiceId)?.name || VOICE_ENGINE_LABELS[engine];
  if (engine === 'edgetts') {
    const voice = EDGE_TTS_FALLBACK_VOICES.find((item) => item.shortName === voiceId);
    return voice ? edgeVoiceName(voice) : VOICE_ENGINE_LABELS[engine];
  }
  return VOICE_ENGINE_LABELS[engine];
}

function videoPlatformFromUrl(value: string): VideoLoginPlatform | null {
  try {
    const host = new URL(value).hostname.replace(/^www\./, '');
    if (host === 'douyin.com' || host.endsWith('.douyin.com')) return 'douyin';
    if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) return 'tiktok';
  } catch {
    // Invalid URLs are handled by the downloader's structured source error.
  }
  return null;
}

function validScenes(project: ProjectState) {
  return project.scenes.filter((scene) => typeof scene.sourceStart === 'number' && typeof scene.sourceEnd === 'number' && scene.sourceEnd > scene.sourceStart && scene.narration.trim());
}

function restorePipelineProgress(project: ProjectState): PipelineProgressStep[] {
  const scenes = validScenes(project);
  const recognized = project.transcriptionVersion === 4 && Boolean(project.transcript?.length);
  const translated = recognized && scenes.length > 0;
  const voiceCount = scenes.filter((scene) => Boolean(scene.audioPath)).length;
  const voicePercent = scenes.length ? Math.round((voiceCount / scenes.length) * 100) : 0;
  return PIPELINE_DEFINITIONS.map((definition): PipelineProgressStep => {
    if (definition.id === 'download') return project.sourceVideoPath
      ? { ...definition, status: 'completed', percent: 100, detail: 'Video đã sẵn sàng' }
      : { ...definition, status: 'pending', percent: 0 };
    if (definition.id === 'recognition') return recognized
      ? { ...definition, status: 'completed', percent: 100, detail: `${project.transcript?.length ?? 0} đoạn đã lưu` }
      : { ...definition, status: 'pending', percent: 0 };
    if (definition.id === 'translation') return translated
      ? { ...definition, status: 'completed', percent: 100, detail: `${scenes.length} câu đã dịch` }
      : { ...definition, status: 'pending', percent: 0, detail: recognized ? 'Có thể tiếp tục' : undefined };
    if (definition.id === 'voice') return translated && voiceCount === scenes.length
      ? { ...definition, status: 'completed', percent: 100, detail: `${voiceCount} câu đã tạo` }
      : { ...definition, status: 'pending', percent: voicePercent, detail: voiceCount ? `Đã lưu ${voiceCount}/${scenes.length} câu · Có thể tiếp tục` : undefined };
    return project.capcutDraftPath
      ? { ...definition, status: 'completed', percent: 100, detail: 'Dự án đã sẵn sàng' }
      : { ...definition, status: 'pending', percent: 0 };
  });
}

function normalizePipelineError(error: unknown, stage: PipelineStageId, context?: AppErrorContext): PublicAppError {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  if (raw.includes('AUTH_REQUIRED:gensuite')) return clientAppError(stage === 'voice' ? 'VOICE_AUTH_REQUIRED' : stage === 'translation' ? 'TRANSLATION_AUTH_REQUIRED' : 'TRANSCRIPTION_ACCESS_DENIED', context);
  if (raw.includes('UPGRADE_REQUIRED:basic')) return clientAppError(stage === 'voice' ? 'VOICE_UPGRADE_REQUIRED' : stage === 'translation' ? 'TRANSLATION_UPGRADE_REQUIRED' : 'TRANSCRIPTION_ACCESS_DENIED', context);
  if (missingKeyService(error)) return clientAppError(stage === 'voice' ? 'VOICE_SERVICE_ACCESS_DENIED' : stage === 'translation' ? 'TRANSLATION_ACCESS_DENIED' : 'TRANSCRIPTION_ACCESS_DENIED', context);
  if (isInsufficientCreditsError(error) && (stage === 'translation' || stage === 'voice')) return clientAppError(stage === 'translation' ? 'TRANSLATION_CREDITS_INSUFFICIENT' : 'VOICE_CREDITS_INSUFFICIENT', context);
  return normalizedClientAppError(error, PIPELINE_FALLBACK_CODES[stage], context);
}

export function LocalizeStudio({ onOpenSettings, setupStep, onSetupStepChange, onNavigationLockChange, onSourceReadyChange }: Props) {
  const project = useProjectStore((state) => state.project);
  const keys = useSettingsStore((state) => state.keys);
  const entitlementStatus = useEntitlementStore((state) => state.status);
  const canUseCloud = useEntitlementStore((state) => state.features.localizeCloud);
  const refreshEntitlements = useEntitlementStore((state) => state.load);
  const [url, setUrl] = useState(project.settings.localizeSourceUrl ?? '');
  const [sourceInputMode, setSourceInputMode] = useState<SourceInputMode>(project.settings.localizeSourceInputMode ?? 'link');
  const [sourceLanguage, setSourceLanguage] = useState(project.sourceLanguage ?? 'vi');
  const [targetLanguage, setTargetLanguage] = useState(project.targetLanguage ?? 'vietnamese');
  const [stage, setStage] = useState<Stage>('idle');
  const [pipelineProgress, setPipelineProgress] = useState<PipelineProgressStep[]>(() => restorePipelineProgress(project));
  const [lastActivityAt, setLastActivityAt] = useState(Date.now());
  const [activityClock, setActivityClock] = useState(Date.now());
  const [downloadPercent, setDownloadPercent] = useState(0);
  const [downloadLabel, setDownloadLabel] = useState('');
  const [error, setError] = useState('');
  const [missingKey, setMissingKey] = useState<string | null>(null);
  const [validationAttempt, setValidationAttempt] = useState(0);
  const [detailsOpen, setDetailsOpen] = useState(true);
  const [diagnosticCopyState, setDiagnosticCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const [pipelineFailure, setPipelineFailure] = useState<PipelineFailureSnapshot | null>(null);
  const [videoLoginPlatform, setVideoLoginPlatform] = useState<VideoLoginPlatform | null>(null);
  const [videoLoginBusy, setVideoLoginBusy] = useState(false);
  const [videoSessionCleared, setVideoSessionCleared] = useState(false);
  const studioRef = useRef<HTMLDivElement | null>(null);
  const activeStageRef = useRef<PipelineStageId | null>(null);
  const transcriberRef = useRef<ITranscriptionProvider | null>(null);
  const voiceRef = useRef<IVoiceProvider | null>(null);
  const restoredProjectIdRef = useRef(project.id);
  const running = !['idle', 'done', 'error'].includes(stage);
  const sourceName = project.sourceVideoPath?.replace(/\\/g, '/').split('/').pop() ?? '';

  const touchStage = useCallback((id: PipelineStageId, percent: number, detail?: string) => {
    activeStageRef.current = id;
    setLastActivityAt(Date.now());
    setPipelineProgress((current) => current.map((step) => step.id === id
      ? { ...step, status: 'active', percent: Math.max(step.status === 'active' ? step.percent : 0, Math.min(99, Math.max(0, percent))), detail }
      : step));
  }, []);
  const completeStage = useCallback((id: PipelineStageId, detail = 'Hoàn tất') => {
    if (activeStageRef.current === id) activeStageRef.current = null;
    setLastActivityAt(Date.now());
    setPipelineProgress((current) => current.map((step) => step.id === id ? { ...step, status: 'completed', percent: 100, detail } : step));
  }, []);
  const failStage = useCallback((id: PipelineStageId, detail: string) => {
    if (activeStageRef.current === id) activeStageRef.current = null;
    setPipelineProgress((current) => current.map((step) => step.id === id ? { ...step, status: 'error', detail } : step));
  }, []);

  useEffect(() => {
    if (restoredProjectIdRef.current === project.id) return;
    restoredProjectIdRef.current = project.id;
    setUrl(project.settings.localizeSourceUrl ?? '');
    setSourceInputMode(project.settings.localizeSourceInputMode ?? 'link');
    setSourceLanguage(project.sourceLanguage ?? 'vi');
    setTargetLanguage(project.targetLanguage ?? 'vietnamese');
    setPipelineProgress(restorePipelineProgress(project));
    setDetailsOpen(true);
    setDiagnosticCopyState('idle');
    setPipelineFailure(null);
    setStage('idle');
    setError('');
    setVideoLoginPlatform(null);
    setVideoSessionCleared(false);
  }, [project]);
  useEffect(() => { onSourceReadyChange?.(Boolean(project.sourceVideoPath)); }, [onSourceReadyChange, project.sourceVideoPath]);
  useEffect(() => { onNavigationLockChange?.(running); return () => onNavigationLockChange?.(false); }, [onNavigationLockChange, running]);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setActivityClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [running]);
  useEffect(() => window.gensuite.ytdlp.onProgress((progress) => {
    if (progress.projectId !== project.id) return;
    const percent = Math.max(0, Math.min(99, progress.percent ?? 0));
    setDownloadPercent(percent);
    setDownloadLabel(progress.phase === 'merging' ? 'Đang hoàn thiện video tải về' : 'Đang tải video');
    if (activeStageRef.current === 'download') touchStage('download', percent, `${Math.round(percent)}%`);
  }), [project.id, touchStage]);
  useEffect(() => window.gensuite.whisper.onProgress((progress) => {
    if (activeStageRef.current !== 'recognition') return;
    const percent = progress.phase === 'extracting' ? 2 : progress.phase === 'downloading-model' ? Math.min(10, (progress.percent ?? 0) / 10) : Math.max(10, progress.percent ?? 10);
    const detail = progress.phase === 'extracting' ? 'Đang chuẩn bị âm thanh'
      : progress.phase === 'downloading-model' ? 'Đang chuẩn bị dữ liệu nhận dạng'
        : progress.chunkNumber && progress.chunkCount ? `Đang xử lý phần ${progress.chunkNumber}/${progress.chunkCount}` : 'Đang nhận dạng lời thoại';
    touchStage('recognition', percent, detail);
  }), [touchStage]);

  const reportFailure = useCallback((failure: unknown, fallback: PipelineStageId) => {
    const normalized = normalizePipelineError(failure, activeStageRef.current ?? fallback);
    rememberDiagnostic(normalized);
    setPipelineFailure({ error: normalized, occurredAt: new Date().toISOString() });
    const storedUrl = useProjectStore.getState().project.settings.localizeSourceUrl ?? '';
    const loginPlatform = loginRequiredPlatform(failure)
      ?? (normalized.code === 'VIDEO_SOURCE_UNREADABLE' ? videoPlatformFromUrl(storedUrl) : null);
    if (loginPlatform) {
      const platformName = loginPlatform === 'douyin' ? 'Douyin' : 'TikTok';
      const message = `${platformName} cần xác nhận quyền truy cập video. Mã chẩn đoán: ${normalized.diagnosticId}.`;
      setVideoLoginPlatform(loginPlatform);
      setVideoSessionCleared(false);
      failStage(activeStageRef.current ?? fallback, message);
      setError('');
      setStage('error');
      return normalized;
    }
    const message = errorMessage(normalized);
    failStage(activeStageRef.current ?? fallback, message);
    setError(message);
    setStage('error');
    return normalized;
  }, [failStage]);

  const copyFailureDiagnostics = async () => {
    if (!pipelineFailure) return;
    try {
      await navigator.clipboard.writeText(diagnosticSummaryForError(pipelineFailure.error, pipelineFailure.occurredAt));
      setDiagnosticCopyState('copied');
    } catch {
      setDiagnosticCopyState('error');
    }
  };

  const importFile = async () => {
    if (running) return;
    setError('');
    try {
      const path = await window.gensuite.ytdlp.import(project.id);
      if (!path) return;
      useProjectStore.getState().setSourceVideo(path);
      useProjectStore.getState().patchSettings({ localizeSourceInputMode: 'file', localizePreparedSourceMode: 'file' });
      setSourceInputMode('file');
      setPipelineProgress(restorePipelineProgress(useProjectStore.getState().project));
    } catch (failure) {
      setError(errorMessage(normalizedClientAppError(failure, 'VIDEO_SOURCE_UNREADABLE')));
    }
  };

  const setTranslatePaid = (paid: boolean) => {
    if (paid && (entitlementStatus !== 'ready' || !canUseCloud)) {
      setError(entitlementStatus === 'ready' ? 'Xử lý trực tuyến trong quy trình này cần gói Basic trở lên.' : 'Đang kiểm tra quyền tài khoản. Vui lòng thử lại sau.');
      return;
    }
    const store = useProjectStore.getState();
    store.setScriptEngine(paid ? 'gensuite' : 'gemini');
    store.setScriptModel(paid ? GENSUITE_TRANSLATE_MODEL : '');
    setError('');
  };

  const ensureSourceVideo = async (): Promise<string> => {
    const current = useProjectStore.getState().project;
    const requestedUrl = url.trim();
    const preparedForSelectedMode = current.sourceVideoPath
      && current.settings.localizePreparedSourceMode === sourceInputMode
      && (sourceInputMode === 'file' || !requestedUrl || requestedUrl === current.settings.localizePreparedSourceUrl);
    if (preparedForSelectedMode && current.sourceVideoPath) {
      completeStage('download', 'Video đã sẵn sàng');
      return current.sourceVideoPath;
    }
    if (!url.trim()) throw clientAppError('VIDEO_SOURCE_REQUIRED');
    setStage('download');
    setDownloadPercent(0);
    setDownloadLabel('Đang chuẩn bị tải video');
    touchStage('download', 0, 'Đang chuẩn bị');
    const path = await window.gensuite.ytdlp.download({ projectId: current.id, url: url.trim() });
    if (!path) throw clientAppError('VIDEO_SOURCE_UNREADABLE');
    useProjectStore.getState().setSourceVideo(path);
    useProjectStore.getState().patchSettings({ localizePreparedSourceMode: 'link', localizeSourceInputMode: 'link', localizeSourceUrl: requestedUrl, localizePreparedSourceUrl: requestedUrl });
    completeStage('download', 'Video đã tải xong');
    return path;
  };

  const recognizeAndTranslate = async (sourcePath: string) => {
    let current = useProjectStore.getState().project;
    const scenes = validScenes(current);
    const cached = current.transcriptionVersion === 4 && Boolean(current.transcript?.length) && scenes.length > 0
      && current.sourceLanguage === sourceLanguage && current.targetLanguage === targetLanguage;
    if (cached) {
      completeStage('recognition', 'Đã có dữ liệu nhận dạng');
      completeStage('translation', 'Đã có bản dịch');
      return;
    }
    let segments = current.transcript;
    if (!(current.transcriptionVersion === 4 && segments?.length && current.sourceLanguage === sourceLanguage)) {
      setStage('recognition');
      touchStage('recognition', 0, 'Đang bắt đầu nhận dạng');
      const transcriber = getTranscriptionProvider(current.settings.transcriptionEngine, keys, 'localize-cloud');
      transcriberRef.current = transcriber;
      try {
        segments = await transcriber.transcribe({ projectId: current.id, sourcePath, model: current.settings.whisperModel, language: sourceLanguage });
      } finally {
        if (transcriberRef.current === transcriber) transcriberRef.current = null;
      }
      if (!segments.length) throw clientAppError('TRANSCRIPTION_NO_SPEECH');
      if (transcriptHasAbnormalRepetition(segments)) throw clientAppError('TRANSCRIPTION_REPETITION_DETECTED');
      useProjectStore.getState().setTranscript(segments);
      completeStage('recognition', `${segments.length} đoạn đã nhận dạng`);
    } else {
      completeStage('recognition', 'Đã có dữ liệu nhận dạng');
    }
    if (!segments?.length) throw clientAppError('TRANSLATION_INPUT_REQUIRED');
    current = useProjectStore.getState().project;
    setStage('translation');
    touchStage('translation', 0, 'Đang chuẩn bị bản dịch');
    const translator = getScriptProvider(current.settings.scriptEngine, keys, current.settings.scriptModel, 'localize-cloud');
    let translated: TranscriptSegment[];
    try {
      translated = await translator.translateSegments({
        projectId: current.id, segments, targetLanguage, sourceLanguage,
        onProgress: (progress) => touchStage('translation', progress.totalSegments ? (progress.completedSegments / progress.totalSegments) * 100 : 0,
          progress.phase === 'validating' ? 'Đang kiểm tra bản dịch' : `Đang dịch nhóm ${Math.max(1, progress.batchNumber)}/${Math.max(1, progress.batchCount)}`),
      });
    } catch (failure) {
      const service = missingKeyService(failure);
      if (service) setMissingKey(service);
      throw failure;
    }
    useProjectStore.getState().setLanguages({ sourceLanguage, targetLanguage });
    useProjectStore.getState().buildScenesFromTranscript(translated);
    completeStage('translation', `${translated.length} câu đã dịch`);
  };

  const createVoices = async () => {
    const current = useProjectStore.getState().project;
    const scenes = validScenes(current);
    if (!scenes.length) throw clientAppError('VIDEO_SEGMENTS_EMPTY');
    setStage('voice');
    touchStage('voice', 0, 'Đang chuẩn bị tạo voice');
    const provider = getVoiceProvider(current.settings.voiceEngine, keys, 'localize-cloud');
    voiceRef.current = provider;
    const config = current.settings.voiceConfigs[current.settings.voiceEngine];
    for (let index = 0; index < scenes.length; index += 1) {
      let scene = useProjectStore.getState().project.scenes.find((item) => item.id === scenes[index].id) ?? scenes[index];
      if (scene.audioPath) {
        const usable = await probeUsableAudio(scene.audioPath);
        if (usable) {
          if (Math.abs((scene.audioDuration ?? 0) - usable.durationSec) > 0.1) useProjectStore.getState().updateScene(scene.id, { audioDuration: usable.durationSec });
          touchStage('voice', ((index + 1) / scenes.length) * 100, `Đã tạo ${index + 1}/${scenes.length} câu`);
          continue;
        }
        useProjectStore.getState().updateScene(scene.id, { audioPath: undefined, audioDuration: undefined });
        scene = { ...scene, audioPath: undefined, audioDuration: undefined };
      }
      try {
        const result = await provider.synthesize({
          projectId: current.id, segmentId: scene.id, text: scene.narration, voiceId: config.voiceId, modelId: config.modelId,
          language: config.language, speed: config.speed, temperature: config.temperature, stability: config.stability,
          similarityBoost: config.similarityBoost, style: config.style, useSpeakerBoost: config.useSpeakerBoost,
          pitch: config.pitch, volume: config.volume, deliveryMode: config.deliveryMode,
          onProgress: (progress) => touchStage('voice', ((index + (progress.totalChunks ? progress.completedChunks / progress.totalChunks : 0)) / scenes.length) * 100,
            `Đang tạo câu ${index + 1}/${scenes.length}`),
        });
        useProjectStore.getState().updateScene(scene.id, { audioPath: result.audioPath, audioDuration: result.durationSec });
      } catch (failure) {
        throw normalizePipelineError(failure, 'voice', { segmentNumber: index + 1, segmentCount: scenes.length });
      }
      touchStage('voice', ((index + 1) / scenes.length) * 100, `Đã tạo ${index + 1}/${scenes.length} câu`);
    }
    voiceRef.current = null;
    completeStage('voice', `${scenes.length} câu đã tạo`);
  };

  const createCapCutDraft = async () => {
    const current = useProjectStore.getState().project;
    const scenes = validScenes(current);
    if (!current.sourceVideoPath || !scenes.length || scenes.some((scene) => !scene.audioPath || !scene.audioDuration)) throw clientAppError('CAPCUT_EXPORT_INPUT_INVALID');
    setStage('capcut');
    touchStage('capcut', 10, 'Đang chuẩn bị các track chỉnh sửa');
    const result = await window.gensuite.capcut.exportDraft({
      projectId: current.id,
      projectName: current.name,
      sourceVideoPath: current.sourceVideoPath,
      segments: scenes.map((scene) => ({
        audioPath: scene.audioPath as string,
        sourceStart: scene.sourceStart as number,
        sourceEnd: scene.sourceEnd as number,
        text: scene.narration,
        audioDuration: scene.audioDuration as number,
      })),
      // Plain editable captions only. Styling and effects belong in CapCut.
      subtitles: true,
      captionLanguage: current.targetLanguage,
      originalAudioVolume: 0,
      draftsDirectory: current.settings.capcutDraftsDirectory || undefined,
    });
    if (!result.ok) throw result.error;
    useProjectStore.getState().setCapCutDraft(result.value);
    completeStage('capcut', 'Dự án đã sẵn sàng');
    setStage('done');
    void refreshEntitlements();
  };

  const runPipeline = async (downloadFirst = false, transitionStarted = false) => {
    if (running && !transitionStarted) return;
    setError('');
    setDiagnosticCopyState('idle');
    setPipelineFailure(null);
    setMissingKey(null);
    setVideoLoginPlatform(null);
    setVideoSessionCleared(false);
    if (downloadFirst) setPipelineProgress(initialPipelineProgress());
    try {
      const sourcePath = await ensureSourceVideo();
      await recognizeAndTranslate(sourcePath);
      await createVoices();
      await createCapCutDraft();
    } catch (failure) {
      reportFailure(failure, activeStageRef.current ?? 'download');
    }
  };

  const chooseCapCutDirectory = async () => {
    if (running) return;
    setError('');
    const result = await window.gensuite.capcut.selectDraftsDirectory();
    if (!result.ok) { setError(errorMessage(result.error)); return; }
    if (result.value) useProjectStore.getState().patchSettings({ capcutDraftsDirectory: result.value });
  };

  const cancelCurrent = async () => {
    if (stage === 'recognition') {
      transcriberRef.current?.cancel?.();
      await window.gensuite.whisper.cancel(project.id).catch(() => false);
    } else if (stage === 'voice') voiceRef.current?.cancel?.();
  };

  const loginVideoPlatform = async () => {
    if (!videoLoginPlatform || videoLoginBusy || running) return;
    const platform = videoLoginPlatform;
    const platformName = platform === 'douyin' ? 'Douyin' : 'TikTok';
    setVideoLoginBusy(true);
    setError('');
    setVideoSessionCleared(false);
    try {
      const ready = platform === 'douyin'
        ? await window.gensuite.ytdlp.loginDouyin()
        : await window.gensuite.ytdlp.loginTikTok();
      if (!ready) {
        setError(`Chưa hoàn tất xác nhận quyền truy cập ${platformName}. Vui lòng thử lại.`);
        return;
      }
      setVideoLoginPlatform(null);
      await runPipeline(false);
    } catch {
      setError(`Không thể mở cửa sổ xác nhận ${platformName}. Vui lòng thử lại.`);
    } finally {
      setVideoLoginBusy(false);
    }
  };

  const clearVideoPlatformSession = async () => {
    if (!videoLoginPlatform || videoLoginBusy || running) return;
    const platform = videoLoginPlatform;
    setVideoLoginBusy(true);
    setError('');
    try {
      if (platform === 'douyin') await window.gensuite.ytdlp.clearDouyinSession();
      else await window.gensuite.ytdlp.clearTikTokSession();
      setVideoSessionCleared(true);
    } catch {
      setError('Không thể xóa phiên truy cập cũ. Vui lòng thử lại.');
    } finally {
      setVideoLoginBusy(false);
    }
  };

  const sourceChoicesReady = Boolean(project.settings.localizeSourceLanguageConfirmed && project.settings.localizeTargetLanguageConfirmed && project.settings.localizeAccuracyConfirmed);
  const voiceConfig = project.settings.voiceConfigs[project.settings.voiceEngine];
  const validationVisible = validationAttempt > 0;
  const sourcePreparedForMode = Boolean(project.sourceVideoPath
    && project.settings.localizePreparedSourceMode === sourceInputMode
    && (sourceInputMode === 'file' || !url.trim() || url.trim() === project.settings.localizePreparedSourceUrl));
  const sourceSelectionChanged = sourceInputMode === 'link'
    && Boolean(url.trim())
    && url.trim() !== (project.settings.localizePreparedSourceUrl ?? '');
  const replacingExistingSource = sourceSelectionChanged && Boolean(project.sourceVideoPath);
  const sourceInputMissing = sourceInputMode === 'link' ? !url.trim() && !sourcePreparedForMode : !sourcePreparedForMode;
  const missingVideo = validationVisible && sourceInputMissing;
  const missingSourceLanguage = validationVisible && !project.settings.localizeSourceLanguageConfirmed;
  const missingTargetLanguage = validationVisible && !project.settings.localizeTargetLanguageConfirmed;
  const missingAccuracy = validationVisible && !project.settings.localizeAccuracyConfirmed;
  const missingVoiceProvider = validationVisible && !project.settings.localizeVoiceProviderConfirmed;
  const missingVoice = validationVisible && Boolean(project.settings.localizeVoiceProviderConfirmed) && !voiceConfig.voiceId;
  const startValidationMissing = sourceInputMissing
    || !sourceChoicesReady || !project.settings.localizeVoiceProviderConfirmed || !voiceConfig.voiceId;
  const startFromSetup = () => {
    if (running) return;
    if (startValidationMissing) {
      setValidationAttempt((current) => current + 1);
      setError('Vui lòng hoàn tất các mục bắt buộc được đánh dấu bên dưới.');
      window.setTimeout(() => {
        const invalid = studioRef.current?.querySelector<HTMLElement>('[data-validation-error="true"]');
        invalid?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 0);
      return;
    }
    setError('');
    setPipelineProgress(initialPipelineProgress());
    setStage('download');
    touchStage('download', 0, 'Đang chuẩn bị tải video');
    onSetupStepChange('process');
    // Let the process screen paint before starting any disk or network work.
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => void runPipeline(true, true));
    });
  };
  const activeStep = pipelineProgress.find((step) => step.status === 'active');
  const failedStep = pipelineProgress.find((step) => step.status === 'error');
  const capcutReady = Boolean(project.capcutDraftPath
    && pipelineProgress.find((step) => step.id === 'capcut')?.status === 'completed');
  const inactivitySeconds = running ? Math.max(0, Math.floor((activityClock - lastActivityAt) / 1000)) : 0;

  return <div ref={studioRef} className="mx-auto flex min-h-full w-full max-w-[1180px] flex-col px-5 py-5">
    <div className="mb-4">
      <p className="text-[10px] font-black uppercase tracking-[0.22em] text-emerald-400">Bản địa hóa video</p>
      <h1 className="mt-1 text-2xl font-black tracking-tight text-white">Dịch và tạo dự án chỉnh sửa</h1>
      <p className="mt-1 text-xs text-white/35">GenSuite xử lý lời thoại và giọng đọc; bạn hoàn thiện phụ đề, hiệu ứng và bố cục trong CapCut.</p>
    </div>

    {error && <div className="mb-4 rounded-xl border border-red-400/20 bg-red-400/[0.07] px-4 py-3 text-xs text-red-200">{error}</div>}
    {missingKey && <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-amber-300/20 bg-amber-300/[0.06] px-4 py-3"><p className="flex items-center gap-2 text-xs text-amber-100"><KeyRound size={14} /> Cần hoàn tất cấu hình cho nguồn đã chọn.</p><button type="button" onClick={onOpenSettings} className="rounded-lg border border-white/10 px-3 py-2 text-[10px] font-bold text-white/70">Mở cài đặt</button></div>}

    {setupStep === 'source' ? <div className="grid flex-1 gap-4 lg:grid-cols-[1.05fr_0.95fr]">
      <section className="rounded-2xl border border-white/[0.08] bg-white/[0.025] p-5">
        <div className="flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-xl bg-emerald-400/10 text-emerald-300"><FileVideo size={19} /></span><div><h2 className="text-base font-black text-white">Video và ngôn ngữ</h2><p className="text-[11px] text-white/35">Video phải tải xong trước khi chuyển sang xử lý.</p></div></div>
        <div key={`video-${missingVideo ? validationAttempt : 0}`} data-validation-error={missingVideo || undefined} className={`mt-5 rounded-2xl border p-4 ${missingVideo ? 'validation-attention' : 'border-white/[0.07]'}`}>
          <div role="tablist" aria-label="Nguồn video" className="grid grid-cols-2 rounded-xl border border-white/[0.07] bg-black/20 p-1">
            <button type="button" role="tab" aria-selected={sourceInputMode === 'link'} onClick={() => { setSourceInputMode('link'); useProjectStore.getState().patchSettings({ localizeSourceInputMode: 'link' }); }} disabled={running} className={`flex items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-[11px] font-bold transition ${sourceInputMode === 'link' ? 'bg-white/[0.09] text-white shadow-sm' : 'text-white/35 hover:text-white/60'} disabled:opacity-40`}><Link2 size={14} />Liên kết video</button>
            <button type="button" role="tab" aria-selected={sourceInputMode === 'file'} onClick={() => { setSourceInputMode('file'); useProjectStore.getState().patchSettings({ localizeSourceInputMode: 'file' }); }} disabled={running} className={`flex items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-[11px] font-bold transition ${sourceInputMode === 'file' ? 'bg-white/[0.09] text-white shadow-sm' : 'text-white/35 hover:text-white/60'} disabled:opacity-40`}><Upload size={14} />File từ máy</button>
          </div>
          {sourceInputMode === 'link' ? <div role="tabpanel" className="pt-4">
            <label htmlFor="localize-video-url" className="text-[10px] font-black uppercase tracking-[0.14em] text-white/35">Đường dẫn video</label>
            <div className="field-surface mt-2 flex items-center gap-2 rounded-xl px-3 py-3"><Link2 size={15} className="text-white/30" /><input id="localize-video-url" value={url} onChange={(event) => { const nextUrl = event.target.value; setUrl(nextUrl); useProjectStore.getState().patchSettings({ localizeSourceUrl: nextUrl }); }} disabled={running} placeholder="Dán liên kết video…" className="min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-white/25" /></div>
            {sourceName && sourcePreparedForMode && <div className="mt-3 rounded-lg bg-emerald-400/[0.06] px-3 py-2.5"><p className="text-[11px] font-semibold text-emerald-300"><CheckCircle2 size={13} className="mr-1.5 inline" />Video từ liên kết đã sẵn sàng</p><p className="mt-1 truncate pl-[19px] text-[9px] text-white/30">{sourceName}</p></div>}
            {replacingExistingSource && <div className="mt-3 rounded-lg border border-amber-300/15 bg-amber-300/[0.05] px-3 py-2.5 text-[10px] leading-4 text-amber-100/65">Liên kết đã thay đổi. Khi bắt đầu xử lý, video mới sẽ thay thế dữ liệu xử lý cũ trong dự án này.</div>}
          </div> : <div role="tabpanel" className="pt-4">
            <button type="button" onClick={() => void importFile()} disabled={running} className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-white/15 bg-white/[0.015] py-5 text-xs font-bold text-white/60 transition hover:border-emerald-300/30 hover:bg-emerald-300/[0.035] hover:text-emerald-100 disabled:opacity-40"><Upload size={16} /> Chọn video từ máy</button>
            {sourceName && project.settings.localizePreparedSourceMode === 'file' && <p className="mt-3 truncate rounded-lg bg-emerald-400/[0.06] px-3 py-2.5 text-[11px] font-semibold text-emerald-300"><CheckCircle2 size={13} className="mr-1.5 inline" />{sourceName}</p>}
          </div>}
          {missingVideo && <p className="mt-3 text-[10px] font-semibold text-red-300">{sourceInputMode === 'link' ? 'Vui lòng dán liên kết video.' : 'Vui lòng chọn file video từ máy.'}</p>}
        </div>
        {stage === 'download' && <div className="mt-4 rounded-xl border border-emerald-400/20 bg-emerald-400/[0.05] p-4"><div className="flex justify-between text-xs font-bold text-emerald-200"><span>{downloadLabel}</span><span>{Math.round(downloadPercent)}%</span></div><div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/[0.07]"><div className="h-full rounded-full bg-emerald-400 transition-[width]" style={{ width: `${downloadPercent}%` }} /></div></div>}
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label key={`source-language-${missingSourceLanguage ? validationAttempt : 0}`} data-validation-error={missingSourceLanguage || undefined} className="block min-w-0"><span className="mb-2 block text-[10px] font-black uppercase tracking-[0.12em] text-white/35">Ngôn ngữ gốc</span><AppSelect value={project.settings.localizeSourceLanguageConfirmed ? sourceLanguage : ''} options={SOURCE_OPTIONS} onChange={(value) => { setSourceLanguage(value); useProjectStore.getState().setLanguages({ sourceLanguage: value }); useProjectStore.getState().patchSettings({ localizeSourceLanguageConfirmed: true }); }} disabled={running} ariaLabel="Ngôn ngữ gốc" className={`rounded-xl px-3 py-3 text-sm ${missingSourceLanguage ? 'validation-attention' : ''}`} />{missingSourceLanguage && <span className="mt-2 block text-[10px] font-semibold text-red-300">Vui lòng chọn ngôn ngữ gốc.</span>}</label>
          <label key={`target-language-${missingTargetLanguage ? validationAttempt : 0}`} data-validation-error={missingTargetLanguage || undefined} className="block min-w-0"><span className="mb-2 block text-[10px] font-black uppercase tracking-[0.12em] text-white/35">Dịch sang</span><AppSelect value={project.settings.localizeTargetLanguageConfirmed ? targetLanguage : ''} options={TARGET_OPTIONS} onChange={(value) => { setTargetLanguage(value); useProjectStore.getState().setLanguages({ targetLanguage: value }); useProjectStore.getState().patchSettings({ localizeTargetLanguageConfirmed: true }); }} disabled={running} ariaLabel="Ngôn ngữ đích" className={`rounded-xl px-3 py-3 text-sm ${missingTargetLanguage ? 'validation-attention' : ''}`} />{missingTargetLanguage && <span className="mt-2 block text-[10px] font-semibold text-red-300">Vui lòng chọn ngôn ngữ đích.</span>}</label>
          <label key={`accuracy-${missingAccuracy ? validationAttempt : 0}`} data-validation-error={missingAccuracy || undefined} className="block min-w-0 sm:col-span-2"><span className="mb-2 block text-[10px] font-black uppercase tracking-[0.12em] text-white/35">Độ chính xác nhận dạng</span><AppSelect value={project.settings.localizeAccuracyConfirmed ? project.settings.whisperModel : ''} options={ACCURACY_OPTIONS} onChange={(value) => { useProjectStore.getState().setWhisperModel(value as WhisperModelName); useProjectStore.getState().patchSettings({ localizeAccuracyConfirmed: true }); }} disabled={running} ariaLabel="Độ chính xác nhận dạng" className={`rounded-xl px-3 py-3 text-sm ${missingAccuracy ? 'validation-attention' : ''}`} />{missingAccuracy && <span className="mt-2 block text-[10px] font-semibold text-red-300">Vui lòng chọn độ chính xác.</span>}</label>
        </div>
        <div className="mt-4 rounded-2xl border border-white/[0.07] p-4"><EngineToggle<'free' | 'paid'> label="Cách dịch" value={project.settings.scriptEngine === 'gensuite' ? 'paid' : 'free'} options={[{ value: 'free', label: 'Dùng khóa riêng', hint: 'Dùng cấu hình dịch của bạn', badge: 'free' }, { value: 'paid', label: 'Dùng credits', hint: canUseCloud ? 'Trừ credits trong tài khoản' : 'Cần gói Basic trở lên', premium: true, badge: 'cloud', disabled: entitlementStatus !== 'ready' || !canUseCloud }]} onChange={(value) => setTranslatePaid(value === 'paid')} /></div>
        <div className="mt-4 rounded-2xl border border-white/[0.07] p-4">
          <div className="flex items-center justify-between gap-3"><div><p className="flex items-center gap-2 text-sm font-bold text-white/75"><Layers3 size={15} className="text-emerald-300" /> Nơi lưu dự án CapCut</p><p className="mt-1 max-w-[390px] truncate text-[10px] text-white/30">{project.settings.capcutDraftsDirectory || 'Tự động tìm thư mục dự án'}</p></div><button type="button" onClick={() => void chooseCapCutDirectory()} disabled={running} className="rounded-lg border border-white/10 px-3 py-2 text-[10px] font-bold text-white/60"><FolderOpen size={13} className="mr-1.5 inline" />Chọn thư mục</button></div>
        </div>
      </section>
      <aside className="min-h-[680px] overflow-hidden rounded-2xl border border-white/[0.08] bg-[#0f0f10]"><VoiceConfigPanel feature="localize-cloud" onMissingKey={setMissingKey} validation={{ attempt: validationAttempt, providerMissing: missingVoiceProvider, voiceMissing: missingVoice }} /></aside>
    </div> : <section className="flex-1 p-5">
      <PipelineProgressPanel steps={pipelineProgress} running={running} inactivitySeconds={inactivitySeconds} />

      {videoLoginPlatform && <div className="mt-4 rounded-2xl border border-amber-300/25 bg-[linear-gradient(115deg,rgba(120,53,15,.2),rgba(245,158,11,.07))] p-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-amber-300/12 text-amber-200"><LogIn size={18} /></span>
          <div className="min-w-[220px] flex-1"><p className="text-sm font-black text-amber-100">Cần xác nhận quyền truy cập {videoLoginPlatform === 'douyin' ? 'Douyin' : 'TikTok'}</p><p className="mt-1 text-[10px] leading-4 text-amber-100/55">Mở cửa sổ xác nhận, hoàn tất thao tác rồi GenSuite sẽ tự thử tải lại video.</p>{videoSessionCleared && <p className="mt-1.5 text-[10px] font-semibold text-emerald-300">Đã xóa phiên cũ. Bạn có thể xác nhận lại.</p>}</div>
          <div className="flex items-center gap-2"><button type="button" onClick={() => void clearVideoPlatformSession()} disabled={videoLoginBusy} className="inline-flex items-center gap-2 rounded-xl border border-amber-200/15 px-3 py-2.5 text-[10px] font-bold text-amber-100/65 disabled:opacity-40"><Trash2 size={13} />Xóa phiên cũ</button><button type="button" onClick={() => void loginVideoPlatform()} disabled={videoLoginBusy} className="inline-flex items-center gap-2 rounded-xl bg-amber-300 px-4 py-2.5 text-[10px] font-black text-black disabled:opacity-50">{videoLoginBusy ? <Loader2 size={13} className="animate-spin" /> : <LogIn size={13} />}Mở cửa sổ xác nhận</button></div>
        </div>
      </div>}

      {stage === 'error' && failedStep && pipelineFailure && <div className="mt-4 flex flex-wrap items-center gap-3 rounded-2xl border border-red-300/20 bg-red-400/[0.06] p-4">
        <div className="min-w-[220px] flex-1">
          <p className="text-xs font-black text-red-100">Quá trình đã dừng</p>
          <p className="mt-1 text-[10px] leading-4 text-red-100/55">Sao chép thông tin chẩn đoán để gửi cho đội ngũ hỗ trợ. Nội dung không chứa video, đường dẫn hay dữ liệu riêng của bạn.</p>
          {diagnosticCopyState === 'copied' && <p className="mt-1.5 text-[10px] font-semibold text-emerald-300">Đã sao chép. Bạn có thể dán trực tiếp vào tin nhắn hỗ trợ.</p>}
          {diagnosticCopyState === 'error' && <p className="mt-1.5 text-[10px] font-semibold text-red-300">Chưa thể sao chép. Vui lòng thử lại.</p>}
        </div>
        <button type="button" onClick={() => void copyFailureDiagnostics()} className="inline-flex items-center gap-2 rounded-xl border border-red-200/20 bg-red-300/[0.07] px-4 py-3 text-[10px] font-black text-red-100 transition hover:bg-red-300/[0.12] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300/40">
          <ClipboardCopy size={14} />{diagnosticCopyState === 'copied' ? 'Đã sao chép' : 'Sao chép log lỗi'}
        </button>
      </div>}

      {capcutReady && !sourceSelectionChanged && <div className="relative mt-5 overflow-hidden rounded-2xl border border-emerald-300/25 bg-[linear-gradient(115deg,rgba(6,78,59,.34),rgba(16,185,129,.08)_48%,rgba(15,23,42,.18))] p-5 shadow-[0_22px_55px_rgba(0,0,0,.18)]">
        <div className="pointer-events-none absolute -right-16 -top-24 h-56 w-56 rounded-full bg-emerald-300/10 blur-3xl" />
        <div className="relative flex flex-wrap items-center gap-4">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl border border-emerald-200/25 bg-emerald-300/15 text-emerald-200 shadow-[0_0_30px_rgba(52,211,153,.12)]"><Sparkles size={21} /></span>
          <div className="min-w-[220px] flex-1"><p className="text-base font-black text-white">Dự án CapCut đã sẵn sàng</p><p className="mt-1 text-[11px] text-white/45">Mở CapCut để hoàn thiện phụ đề, hiệu ứng và bố cục theo phong cách của bạn.</p><div className="mt-3 flex flex-wrap gap-2"><span className="rounded-full border border-white/[0.08] bg-black/15 px-2.5 py-1 text-[9px] font-semibold text-white/55">{validScenes(project).length} câu thoại</span><span className="rounded-full border border-white/[0.08] bg-black/15 px-2.5 py-1 text-[9px] font-semibold text-white/55">{languageLabel(targetLanguage)}</span><span className="max-w-[220px] truncate rounded-full border border-white/[0.08] bg-black/15 px-2.5 py-1 text-[9px] font-semibold text-white/55">{friendlyVoiceLabel(project)}</span></div></div>
          <div className="flex flex-wrap items-center gap-2"><button type="button" onClick={() => void runPipeline(false)} className="inline-flex items-center gap-2 rounded-xl border border-white/10 px-3.5 py-3 text-[10px] font-bold text-white/55 transition hover:bg-white/[0.05] hover:text-white"><RotateCcw size={13} />Tạo lại</button><button type="button" onClick={() => window.gensuite.shell.showItemInFolder(project.capcutDraftPath!)} className="primary-action inline-flex items-center gap-2 rounded-xl px-4 py-3 text-[10px] font-black"><FolderOpen size={14} />Mở thư mục dự án</button></div>
        </div>
      </div>}

      <div className="mt-4 overflow-hidden rounded-xl border border-white/[0.055] bg-black/10">
        <button type="button" onClick={() => setDetailsOpen((open) => !open)} aria-expanded={detailsOpen} className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition hover:bg-white/[0.025]"><span><span className="block text-[11px] font-bold text-white/65">Chi tiết quá trình xử lý</span><span className="mt-0.5 block text-[9px] text-white/25">Video, ngôn ngữ, giọng đọc và tên dự án đầu ra</span></span><ChevronDown size={14} className={`text-white/30 transition-transform ${detailsOpen ? 'rotate-180' : ''}`} /></button>
        {detailsOpen && <div className="grid gap-px border-t border-white/[0.055] bg-white/[0.045] sm:grid-cols-2 lg:grid-cols-4">
          <div className="min-w-0 bg-[#151617] p-3.5"><p className="text-[8px] font-black uppercase tracking-[0.16em] text-white/25">Video</p><p className="mt-1.5 truncate text-[11px] font-bold text-white/65">{sourceName || 'Chưa chọn'}</p></div>
          <div className="min-w-0 bg-[#151617] p-3.5"><p className="text-[8px] font-black uppercase tracking-[0.16em] text-white/25">Ngôn ngữ</p><p className="mt-1.5 truncate text-[11px] font-bold text-white/65">{languageLabel(sourceLanguage)} → {languageLabel(targetLanguage)}</p></div>
          <div className="min-w-0 bg-[#151617] p-3.5"><p className="text-[8px] font-black uppercase tracking-[0.16em] text-white/25">Giọng đọc</p><p className="mt-1.5 truncate text-[11px] font-bold text-white/65">{friendlyVoiceLabel(project)}</p></div>
          <div className="min-w-0 bg-[#151617] p-3.5"><p className="text-[8px] font-black uppercase tracking-[0.16em] text-white/25">Kết quả</p><p className="mt-1.5 truncate text-[11px] font-bold text-white/65">{project.capcutDraftName || 'Đang chờ'}</p></div>
        </div>}
      </div>
    </section>}

    <footer className="sticky bottom-0 mt-4 flex items-center justify-between gap-3 rounded-2xl border border-white/[0.08] bg-[#151617]/95 px-4 py-3 backdrop-blur">
      <div><p className="text-xs font-bold text-white/65">{setupStep === 'source' ? 'Bước 1/2 · Thiết lập' : 'Bước 2/2 · Xử lý & xuất'}</p><p className="mt-0.5 text-[10px] text-white/25">{setupStep === 'source' ? 'Kiểm tra thiết lập trước khi bắt đầu' : activeStep?.detail || failedStep?.detail || (capcutReady ? 'Hoàn tất' : 'Sẵn sàng tiếp tục')}</p></div>
      <div className="flex items-center gap-2">
        {setupStep === 'process' && !running && <button type="button" onClick={() => onSetupStepChange('source')} className="inline-flex items-center gap-2 rounded-xl border border-white/10 px-4 py-3 text-xs font-bold text-white/55"><ArrowLeft size={15} />Thiết lập</button>}
        {running ? <button type="button" onClick={() => void cancelCurrent()} disabled={stage !== 'recognition' && stage !== 'voice'} className="inline-flex items-center gap-2 rounded-xl border border-red-400/20 px-4 py-3 text-xs font-bold text-red-200 disabled:opacity-30"><X size={15} />Dừng</button>
          : (!capcutReady || sourceSelectionChanged) && <button type="button" onClick={setupStep === 'source' ? startFromSetup : () => void runPipeline(false)} className="primary-action inline-flex min-w-44 items-center justify-center gap-2 rounded-xl px-5 py-3 text-xs font-black">{stage === 'error' ? <RotateCcw size={15} /> : <Play size={15} />}{stage === 'error' ? 'Thử lại từ checkpoint' : setupStep === 'source' ? 'Bắt đầu xử lý' : 'Tiếp tục xử lý'}</button>}
      </div>
    </footer>
  </div>;
}
