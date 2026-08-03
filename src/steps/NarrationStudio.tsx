import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, ArrowLeft, Captions, Check, CheckCircle2, ChevronRight, Clock3, Download, FileVideo, Film,
  FolderOpen, Link2, Loader2, Mic2, Music, Upload, X,
} from 'lucide-react';
import { useProjectStore } from '../store/projectStore';
import { useSettingsStore } from '../store/settingsStore';
import { useEntitlementStore } from '../store/entitlementStore';
import { errorMessage, missingKeyService, serviceLabel } from '../providers/errors';
import { getVoiceProvider } from '../providers/voice';
import { GENMAX_LANGUAGE_IDS, VoiceConfigPanel } from '../components/VoiceConfigPanel';
import { AudioPlayer } from '../components/AudioPlayer';
import { AppSelect } from '../components/AppSelect';
import { alignSceneSubtitle, hasFreshSubtitleTiming } from '../shared/subtitleAlignment';
import { localFileUrl } from '../shared/localFile';
import type { MusicConfig, NarrationDensity, NarrationProgressPhase, Scene, SubtitleConfig } from '../shared/types';

const NARRATION_LANGUAGES = [
  ['vi-VN', 'Tiếng Việt'], ['en-US', 'English'], ['zh-CN', '中文'], ['ja-JP', '日本語'],
  ['ko-KR', '한국어'], ['th-TH', 'ภาษาไทย'], ['id-ID', 'Bahasa Indonesia'],
] as const;

const NARRATION_AUDIENCES = [
  ['VN', 'Việt Nam'], ['US', 'Hoa Kỳ'], ['CN', 'Trung Quốc'], ['JP', 'Nhật Bản'],
  ['KR', 'Hàn Quốc'], ['TH', 'Thái Lan'], ['ID', 'Indonesia'],
] as const;

const NARRATION_DENSITIES: Array<[NarrationDensity, string]> = [
  ['sparse', 'Thưa — nhiều khoảng nghỉ'],
  ['balanced', 'Cân bằng — nhịp tự nhiên'],
  ['dense', 'Dày — review liên tục'],
];

const NARRATION_LANGUAGE_OPTIONS = NARRATION_LANGUAGES.map(([value, label]) => ({ value, label }));
const NARRATION_AUDIENCE_OPTIONS = NARRATION_AUDIENCES.map(([value, label]) => ({ value, label }));
const NARRATION_DENSITY_OPTIONS = NARRATION_DENSITIES.map(([value, label]) => ({ value, label }));

const MIN_SPEECH_RATIO: Record<NarrationDensity, number> = { sparse: 0, balanced: 0.3, dense: 0.35 };
const MAX_GAP_SECONDS: Record<NarrationDensity, number> = { sparse: 10, balanced: 6, dense: 3 };

export type NarrationSetupStep = 'source' | 'script' | 'voice' | 'export';

const SETUP_STEPS: Array<{ id: NarrationSetupStep; label: string }> = [
  { id: 'source', label: 'Video & thiết lập' },
  { id: 'script', label: 'Nội dung' },
  { id: 'voice', label: 'Giọng đọc' },
  { id: 'export', label: 'Kiểm tra & tạo' },
];

const PROGRESS_LABELS: Record<NarrationProgressPhase, string> = {
  preparing: 'Đang chuẩn bị video',
  'detecting-scenes': 'Đang nhận biết các cảnh',
  understanding: 'Đang hiểu diễn biến',
  writing: 'Đang viết lời thuyết minh',
  complete: 'Đã tạo xong bản nháp',
};

function sourceName(filePath?: string): string {
  return filePath?.split(/[\\/]/).filter(Boolean).at(-1) ?? '';
}

function timeLabel(seconds?: number): string {
  const value = Math.max(0, Math.round(seconds ?? 0));
  const minutes = Math.floor(value / 60);
  return `${String(minutes).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

function probeAudioDuration(audioPath: string): Promise<number> {
  return new Promise((resolve) => {
    const audio = new Audio();
    const done = (duration: number) => resolve(Number.isFinite(duration) && duration > 0 ? duration : 0);
    audio.addEventListener('loadedmetadata', () => done(audio.duration), { once: true });
    audio.addEventListener('error', () => done(0), { once: true });
    audio.src = localFileUrl(audioPath) ?? '';
  });
}

function narrationCoverage(scenes: Scene[], density: NarrationDensity) {
  const timelineEnd = Math.max(0, ...scenes.map((scene) => scene.sourceEnd ?? 0));
  const intervals = scenes.flatMap((scene) => {
    if (!scene.audioPath || !scene.audioDuration || scene.sourceStart == null) return [];
    return [{ start: scene.sourceStart, end: Math.min(scene.sourceEnd ?? timelineEnd, scene.sourceStart + scene.audioDuration) }];
  }).filter((item) => item.end > item.start).sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const interval of intervals) {
    const previous = merged.at(-1);
    if (previous && interval.start <= previous.end) previous.end = Math.max(previous.end, interval.end);
    else merged.push({ ...interval });
  }
  const spoken = merged.reduce((total, item) => total + item.end - item.start, 0);
  let cursor = 0;
  let longGaps = 0;
  for (const item of merged) {
    if (item.start - cursor > MAX_GAP_SECONDS[density]) longGaps += 1;
    cursor = Math.max(cursor, item.end);
  }
  if (timelineEnd - cursor > MAX_GAP_SECONDS[density]) longGaps += 1;
  return { percent: timelineEnd ? Math.round((spoken / timelineEnd) * 100) : 0, longGaps, timelineEnd, intervals: merged };
}

interface NarrationStudioProps {
  onOpenSettings: () => void;
  setupStep: NarrationSetupStep;
  onSetupStepChange: (step: NarrationSetupStep) => void;
  onNavigationLockChange: (locked: boolean) => void;
}

export function NarrationStudio({ onOpenSettings, setupStep, onSetupStepChange, onNavigationLockChange }: NarrationStudioProps) {
  const project = useProjectStore((state) => state.project);
  const setSourceVideo = useProjectStore((state) => state.setSourceVideo);
  const setScenes = useProjectStore((state) => state.setScenes);
  const updateScene = useProjectStore((state) => state.updateScene);
  const patchNarrationWorkflow = useProjectStore((state) => state.patchNarrationWorkflow);
  const patchSettings = useProjectStore((state) => state.patchSettings);
  const setDubbedVideo = useProjectStore((state) => state.setDubbedVideo);
  const keys = useSettingsStore((state) => state.keys);
  const refreshEntitlements = useEntitlementStore((state) => state.load);
  const [url, setUrl] = useState('');
  const [sourceMode, setSourceMode] = useState<'link' | 'file'>('link');
  const [sourceBusy, setSourceBusy] = useState(false);
  const [analysisBusy, setAnalysisBusy] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [voiceProgress, setVoiceProgress] = useState({ done: 0, total: 0, fitting: false });
  const [renderKind, setRenderKind] = useState<'preview' | 'final' | null>(null);
  const [renderPercent, setRenderPercent] = useState(0);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [analysisProgress, setAnalysisProgress] = useState(0);
  const [analysisPhase, setAnalysisPhase] = useState<NarrationProgressPhase>('preparing');
  const [missingService, setMissingService] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [importingMusic, setImportingMusic] = useState(false);
  const videoUrl = useMemo(() => localFileUrl(project.sourceVideoPath), [project.sourceVideoPath]);
  const previewUrl = useMemo(() => localFileUrl(project.narrationWorkflow?.previewPath), [project.narrationWorkflow?.previewPath]);
  const outputUrl = useMemo(() => localFileUrl(project.dubbedVideoPath), [project.dubbedVideoPath]);
  const hasAnalysis = Boolean(project.narrationWorkflow?.summary && project.sourceVideoPath);
  const allVoiced = project.scenes.length > 0 && project.scenes.every((scene) => Boolean(scene.audioPath));
  const sub = project.settings.subtitle;
  const music = project.settings.music;
  const narrationLanguage = project.settings.narrationLanguage;
  const narrationAudience = project.settings.narrationAudience;
  const narrationDensity = project.settings.narrationDensity;
  const coverage = useMemo(() => narrationCoverage(project.scenes, narrationDensity), [project.scenes, narrationDensity]);
  const outputChoiceChanged = hasAnalysis && (
    project.narrationWorkflow?.targetLanguage !== narrationLanguage
    || project.narrationWorkflow?.targetAudience !== narrationAudience
    || project.narrationWorkflow?.density !== narrationDensity
  );
  const running = sourceBusy || analysisBusy || voiceBusy || Boolean(renderKind);

  useEffect(() => {
    onNavigationLockChange(running);
    return () => onNavigationLockChange(false);
  }, [onNavigationLockChange, running]);

  useEffect(() => window.gensuite.ytdlp.onProgress((event) => {
    if (event.projectId !== project.id) return;
    setDownloadProgress(Math.max(0, Math.min(100, event.percent)));
  }), [project.id]);

  useEffect(() => window.gensuite.narration.onProgress((event) => {
    if (event.projectId !== project.id) return;
    setAnalysisPhase(event.phase);
    setAnalysisProgress(Math.max(0, Math.min(100, event.percent)));
    if (event.phase === 'understanding') patchNarrationWorkflow({ stage: 'analyzing' });
    if (event.phase === 'writing') patchNarrationWorkflow({ stage: 'planning' });
  }), [patchNarrationWorkflow, project.id]);

  useEffect(() => window.gensuite.ffmpeg.onProgress((event) => {
    if (event.projectId !== project.id) return;
    const percent = typeof event.percent === 'number'
      ? event.percent
      : event.totalSec && event.totalSec > 0 ? (event.timeSec / event.totalSec) * 100 : 0;
    setRenderPercent((current) => Math.max(
      current,
      Math.max(0, Math.min(100, event.phase === 'complete' ? 100 : percent)),
    ));
  }), [project.id]);

  const clearNotice = () => {
    setError('');
    setMissingService(null);
  };

  const importVideo = async () => {
    if (sourceBusy || analysisBusy || voiceBusy || renderKind) return;
    setSourceBusy(true);
    clearNotice();
    setDownloadProgress(0);
    try {
      const filePath = await window.gensuite.ytdlp.import(project.id);
      if (filePath) setSourceVideo(filePath);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSourceBusy(false);
    }
  };

  const downloadVideo = async () => {
    const value = url.trim();
    if (!value || sourceBusy || analysisBusy || voiceBusy || renderKind) return;
    setSourceBusy(true);
    clearNotice();
    setDownloadProgress(0);
    try {
      const filePath = await window.gensuite.ytdlp.download({ projectId: project.id, url: value });
      setSourceVideo(filePath);
      setUrl('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSourceBusy(false);
    }
  };

  const analyzeVideo = async () => {
    if (!project.sourceVideoPath || sourceBusy || analysisBusy || voiceBusy || renderKind) return;
    if (!keys.googleApiKey.trim()) {
      setMissingService('google');
      setError('');
      return;
    }
    setAnalysisBusy(true);
    clearNotice();
    setAnalysisPhase('preparing');
    setAnalysisProgress(3);
    patchNarrationWorkflow({ stage: 'segmenting', previewPath: undefined });
    try {
      const result = await window.gensuite.narration.analyze({
        projectId: project.id,
        sourceVideoPath: project.sourceVideoPath,
        targetLanguage: narrationLanguage,
        targetAudience: narrationAudience,
        density: narrationDensity,
      });
      const beatById = new Map(result.beats.map((beat) => [beat.id, beat]));
      const scenes = result.cues.map((cue) => ({
        id: cue.id,
        narration: cue.text,
        imagePrompt: cue.beatIds.map((id) => beatById.get(id)?.description).filter(Boolean).join(' · '),
        keyword: '',
        sourceStart: cue.preferredStartMs / 1000,
        sourceEnd: cue.windowEndMs / 1000,
        visualType: 'upload' as const,
        narrationFitStatus: 'pending' as const,
        narrationRevision: 0,
      })).sort((a, b) => a.sourceStart - b.sourceStart);
      setScenes(scenes);
      patchNarrationWorkflow({
        stage: 'review-ready',
        sourceFingerprint: result.sourceFingerprint,
        shotManifestPath: result.shotManifestPath,
        semanticManifestPath: result.semanticManifestPath,
        narrationPlanPath: result.narrationPlanPath,
        summary: result.summary,
        shotCount: result.shots.length,
        targetLanguage: narrationLanguage,
        targetAudience: narrationAudience,
        density: narrationDensity,
        previewPath: undefined,
      });
      onSetupStepChange('script');
    } catch (err) {
      const service = missingKeyService(err);
      if (service) setMissingService(service);
      else setError(errorMessage(err));
      patchNarrationWorkflow({ stage: 'failed' });
    } finally {
      setAnalysisBusy(false);
    }
  };

  const editNarration = (scene: Scene, narration: string) => {
    updateScene(scene.id, {
      narration,
      audioPath: undefined,
      audioDuration: undefined,
      subtitleWords: undefined,
      subtitleTimingText: undefined,
      subtitleTimingAudioPath: undefined,
      narrationFitStatus: 'pending',
      narrationRevision: 0,
    });
    patchNarrationWorkflow({ stage: 'review-ready', previewPath: undefined });
  };

  const validateVoiceConfig = (): string | null => {
    const settings = useProjectStore.getState().project.settings;
    const engine = settings.voiceEngine;
    const config = settings.voiceConfigs[engine];
    if (!config.voiceId) return 'Hãy chọn một giọng đọc trước khi tiếp tục.';
    if ((engine === 'elevenlabs' || engine === 'minimax') && !GENMAX_LANGUAGE_IDS.includes(config.language)) {
      return 'Hãy chọn ngôn ngữ cho giọng đọc trước khi tiếp tục.';
    }
    if (engine === 'elevenlabs' && config.language === 'vietnamese' && config.modelId !== 'eleven_v3') {
      return 'Giọng tiếng Việt cần dùng mô hình hỗ trợ tương ứng.';
    }
    return null;
  };

  const createVoices = async () => {
    if (voiceBusy || renderKind || !project.scenes.length) return;
    const validation = validateVoiceConfig();
    if (validation) { setError(validation); return; }
    setVoiceBusy(true);
    clearNotice();
    setVoiceProgress({ done: 0, total: project.scenes.length, fitting: false });
    patchNarrationWorkflow({ stage: 'synthesizing', previewPath: undefined });
    try {
      const snapshot = useProjectStore.getState().project;
      const engine = snapshot.settings.voiceEngine;
      const config = snapshot.settings.voiceConfigs[engine];
      const density = snapshot.settings.narrationDensity;
      const provider = getVoiceProvider(engine, keys);
      for (let index = 0; index < snapshot.scenes.length; index += 1) {
        const original = useProjectStore.getState().project.scenes.find((scene) => scene.id === snapshot.scenes[index].id);
        if (!original) continue;
        let text = original.narration.replace(/\s+/g, ' ').trim();
        if (!text) throw new Error(`Đoạn ${index + 1} chưa có lời thuyết minh.`);
        const windowSeconds = Math.max(0.8, (original.sourceEnd ?? 0) - (original.sourceStart ?? 0));
        let revision = 0;
        let result: Awaited<ReturnType<typeof provider.synthesize>> | null = null;
        let durationSec = 0;
        for (;;) {
          patchNarrationWorkflow({ stage: revision > 0 ? 'fitting' : 'synthesizing' });
          setVoiceProgress({ done: index, total: snapshot.scenes.length, fitting: revision > 0 });
          result = await provider.synthesize({
            projectId: snapshot.id,
            segmentId: original.id,
            text,
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
          });
          durationSec = result.durationSec > 0 ? result.durationSec : await probeAudioDuration(result.audioPath);
          const tooLong = durationSec > windowSeconds * 1.06;
          const tooShort = MIN_SPEECH_RATIO[density] > 0 && durationSec < windowSeconds * MIN_SPEECH_RATIO[density];
          if ((!tooLong && !tooShort) || revision >= 4) break;
          try {
            const rewritten = await window.gensuite.narration.rewrite({
              text,
              context: original.imagePrompt,
              targetDurationMs: Math.round(windowSeconds * (tooShort ? (density === 'dense' ? 0.62 : 0.52) : 1) * 1000),
              actualDurationMs: Math.round(durationSec * 1000),
              targetLanguage: narrationLanguage,
              targetAudience: narrationAudience,
              mode: tooShort ? 'expand' : 'shorten',
            });
            if (!rewritten.text || rewritten.text === text) break;
            text = rewritten.text;
            revision += 1;
          } catch (rewriteError) {
            const service = missingKeyService(rewriteError);
            if (service) setMissingService(service);
            break;
          }
        }
        if (!result) throw new Error('Chưa thể tạo giọng cho đoạn này.');
        const fits = durationSec <= windowSeconds * 1.06 && (MIN_SPEECH_RATIO[density] === 0 || durationSec >= windowSeconds * MIN_SPEECH_RATIO[density]);
        updateScene(original.id, {
          narration: text,
          audioPath: result.audioPath,
          audioDuration: durationSec,
          subtitleWords: result.wordTimings,
          subtitleTimingText: result.wordTimings?.length ? text : undefined,
          subtitleTimingAudioPath: result.wordTimings?.length ? result.audioPath : undefined,
          narrationFitStatus: fits ? 'fits' : 'needs-review',
          narrationRevision: revision,
        });
        setVoiceProgress({ done: index + 1, total: snapshot.scenes.length, fitting: false });
      }
      patchNarrationWorkflow({ stage: 'voice-ready', previewPath: undefined });
      onSetupStepChange('export');
      void refreshEntitlements();
    } catch (err) {
      const service = missingKeyService(err);
      if (service) setMissingService(service);
      else setError(errorMessage(err));
      patchNarrationWorkflow({ stage: 'failed' });
    } finally {
      setVoiceBusy(false);
    }
  };

  const patchSub = (patch: Partial<SubtitleConfig>) => patchSettings({ subtitle: { ...sub, ...patch } });
  const patchMusic = (patch: Partial<MusicConfig>) => patchSettings({ music: { ...music, ...patch } });

  const importMusic = async () => {
    if (importingMusic || renderKind) return;
    setImportingMusic(true);
    clearNotice();
    try {
      const result = await window.gensuite.music.import(project.id);
      if (result) patchMusic({ enabled: true, audioPath: result.audioPath, fileName: result.fileName });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setImportingMusic(false);
    }
  };

  const renderVideo = async (kind: 'preview' | 'final') => {
    if (renderKind || voiceBusy || !project.sourceVideoPath || !allVoiced) return;
    const ordered = [...project.scenes].sort((a, b) => (a.sourceStart ?? 0) - (b.sourceStart ?? 0));
    const unsafe = ordered.filter((scene, index) => {
      const start = scene.sourceStart ?? 0;
      const nextStart = ordered[index + 1]?.sourceStart;
      const safeEnd = Math.min(scene.sourceEnd ?? start, nextStart == null ? Number.POSITIVE_INFINITY : nextStart - 0.35);
      return !scene.audioDuration || safeEnd - start < 0.8 || scene.audioDuration / 1.08 > safeEnd - start;
    });
    if (unsafe.length) {
      setError(`${unsafe.length} đoạn lời chưa vừa khoảng đọc an toàn. Hãy tạo lại giọng; nếu vẫn còn cảnh báo, hãy phân tích lại video để sắp lại nhịp.`);
      return;
    }
    setRenderKind(kind);
    setRenderPercent(0);
    clearNotice();
    patchNarrationWorkflow({ stage: kind === 'final' ? 'quality-checking' : 'rendering' });
    try {
      let scenes = useProjectStore.getState().project.scenes;
      if (scenes.some((scene) => !scene.audioPath || typeof scene.sourceStart !== 'number' || typeof scene.sourceEnd !== 'number')) {
        throw new Error('Một số đoạn chưa đủ dữ liệu để hoàn thiện video.');
      }
      if (sub.enabled) {
        const language = project.settings.voiceConfigs[project.settings.voiceEngine].language;
        for (const scene of scenes) {
          const words = await alignSceneSubtitle(scene, project.id, language);
          if (!hasFreshSubtitleTiming(scene)) {
            updateScene(scene.id, {
              subtitleWords: words,
              subtitleTimingText: scene.narration,
              subtitleTimingAudioPath: scene.audioPath,
            });
          }
        }
        scenes = useProjectStore.getState().project.scenes;
      }
      patchNarrationWorkflow({ stage: 'rendering' });
      const completion = await window.gensuite.ffmpeg.redub({
        projectId: project.id,
        sourceVideoPath: project.sourceVideoPath,
        segments: scenes.map((scene) => ({
          audioPath: scene.audioPath as string,
          sourceStart: scene.sourceStart as number,
          sourceEnd: scene.sourceEnd as number,
          text: scene.narration,
          wordTimings: scene.subtitleWords,
          audioDuration: scene.audioDuration,
        })),
        maxTempoFactor: 1.08,
        subtitles: sub.enabled,
        subtitleConfig: sub,
        outputAspectRatio: project.settings.localizeAspectRatio,
        originalAudioVolume: project.settings.originalAudioVolume,
        musicPath: music.enabled ? music.audioPath : undefined,
        musicVolume: music.volume,
        automaticOutputName: kind === 'preview' ? `xem-truoc-${Date.now()}` : undefined,
        revealOutput: kind === 'final',
      });
      if (!completion.ok) throw completion.error;
      const out = completion.value;
      if (!out) {
        patchNarrationWorkflow({ stage: project.narrationWorkflow?.previewPath ? 'preview-ready' : 'voice-ready' });
        return;
      }
      if (kind === 'preview') patchNarrationWorkflow({ stage: 'preview-ready', previewPath: out });
      else {
        setDubbedVideo(out);
        patchNarrationWorkflow({ stage: 'complete' });
      }
    } catch (err) {
      setError(errorMessage(err));
      patchNarrationWorkflow({ stage: project.narrationWorkflow?.previewPath ? 'preview-ready' : 'voice-ready' });
    } finally {
      setRenderKind(null);
    }
  };

  const stage = project.narrationWorkflow?.stage;
  const currentStepIndex = SETUP_STEPS.findIndex((item) => item.id === setupStep);
  const stepReady = setupStep === 'source'
    ? Boolean(project.sourceVideoPath)
    : setupStep === 'script'
      ? project.scenes.length > 0
      : setupStep === 'voice'
        ? project.scenes.length > 0
        : allVoiced;
  const goBack = () => {
    const previous = SETUP_STEPS[currentStepIndex - 1];
    if (previous) onSetupStepChange(previous.id);
  };
  const goNext = async () => {
    if (setupStep === 'source') {
      if (hasAnalysis && !outputChoiceChanged) onSetupStepChange('script');
      else await analyzeVideo();
      return;
    }
    if (setupStep === 'script') { onSetupStepChange('voice'); return; }
    if (setupStep === 'voice') {
      if (allVoiced) onSetupStepChange('export');
      else await createVoices();
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden px-6 py-5">
      <header className="mx-auto flex w-full max-w-5xl shrink-0 items-center justify-between gap-5 pb-4">
        <div className="min-w-0">
          <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.18em] text-emerald-400/75">Thuyết minh video</div>
          <h1 className="truncate text-2xl font-bold tracking-[-0.04em]">Biến hình ảnh thành câu chuyện</h1>
          <p className="mt-1 text-xs text-white/40">Hoàn thành 4 bước, sau đó ứng dụng tự xử lý phần còn lại.</p>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
      {missingService && <div className="mx-auto mb-4 flex max-w-5xl items-center justify-between rounded-xl border border-amber-300/25 bg-amber-300/[0.08] p-3 text-xs text-amber-100/85"><span>Cần cấu hình quyền truy cập cho {serviceLabel(missingService)} trước khi chạy bước này.</span><button onClick={onOpenSettings} className="rounded-lg bg-amber-300 px-3 py-2 font-black text-black">Mở cài đặt</button></div>}
      {error && <div className="mx-auto mb-4 max-w-5xl rounded-xl border border-red-400/20 bg-red-400/[0.07] px-4 py-3 text-xs leading-5 text-red-100/80">{error}</div>}
      {setupStep === 'source' && <section className="workspace-panel mx-auto max-w-5xl rounded-2xl p-5">
        <div className="mx-auto max-w-3xl">
          <div className="mb-5 flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-xl bg-emerald-400/10 text-emerald-300"><FileVideo size={20} /></span><div><h2 className="text-base font-bold text-white">Chọn video và thiết lập</h2><p className="mt-1 text-xs text-white/35">Chọn một trong hai cách nhập video để bắt đầu.</p></div></div>

          <div className="mb-4 grid grid-cols-2 rounded-xl border border-white/[0.08] bg-black/20 p-1">
            <button type="button" onClick={() => setSourceMode('link')} disabled={running} className={`flex items-center justify-center gap-2 rounded-lg px-4 py-3 text-xs font-bold transition ${sourceMode === 'link' ? 'bg-emerald-400 text-black' : 'text-white/40 hover:bg-white/[0.04] hover:text-white/70'}`}><Link2 size={15} /> Lấy video từ liên kết</button>
            <button type="button" onClick={() => setSourceMode('file')} disabled={running} className={`flex items-center justify-center gap-2 rounded-lg px-4 py-3 text-xs font-bold transition ${sourceMode === 'file' ? 'bg-emerald-400 text-black' : 'text-white/40 hover:bg-white/[0.04] hover:text-white/70'}`}><Upload size={15} /> Chọn video từ máy</button>
          </div>

          <div className="rounded-2xl border border-white/[0.07] bg-black/15 p-4">
            {sourceMode === 'link' ? <div>
              <label className="block text-[10px] font-black uppercase tracking-[0.14em] text-white/35" htmlFor="narration-source-url">Liên kết video</label>
              <div className="mt-2 grid gap-3 sm:grid-cols-[1fr_auto]"><div className="field-surface flex items-center gap-3 rounded-xl px-4 py-3"><Link2 size={16} className="text-white/30" /><input id="narration-source-url" value={url} onChange={(event) => setUrl(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && void downloadVideo()} disabled={running} placeholder="Dán liên kết video…" className="min-w-0 flex-1 bg-transparent text-sm outline-none disabled:opacity-50" /></div><button onClick={() => void downloadVideo()} disabled={running || !url.trim()} className="primary-action inline-flex min-w-32 items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-bold disabled:opacity-40">{sourceBusy ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}{sourceBusy ? `${Math.round(downloadProgress)}%` : 'Lấy video'}</button></div>
            </div> : <button onClick={() => void importVideo()} disabled={running} className="flex min-h-44 w-full flex-col items-center justify-center rounded-xl border border-dashed border-white/15 bg-white/[0.02] text-center transition hover:border-emerald-400/40 hover:bg-emerald-400/[0.03] disabled:opacity-50">{sourceBusy ? <Loader2 size={25} className="mb-3 animate-spin text-emerald-300" /> : <Upload size={25} className="mb-3 text-emerald-300" />}<span className="text-sm font-bold text-white/85">Chọn video từ máy</span><span className="mt-1 text-xs text-white/35">Hỗ trợ các định dạng video phổ biến</span></button>}

            {videoUrl && <div className="mt-4 border-t border-white/[0.07] pt-4"><div className="overflow-hidden rounded-xl border border-white/[0.08] bg-black"><video src={videoUrl} controls preload="metadata" className="aspect-video max-h-80 w-full object-contain" /></div><div className="mt-3 flex items-center gap-2 text-xs font-semibold text-emerald-200"><Check size={14} /><span className="min-w-0 flex-1 truncate">{sourceName(project.sourceVideoPath)}</span>{sourceMode === 'file' && <button onClick={() => void importVideo()} disabled={running} className="rounded-lg border border-white/10 px-3 py-2 text-[10px] font-bold text-white/55 hover:text-white">Chọn video khác</button>}</div></div>}
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-3">
            <label className="space-y-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-white/35">Ngôn ngữ thuyết minh</span><AppSelect value={narrationLanguage} options={NARRATION_LANGUAGE_OPTIONS} onChange={(value) => patchSettings({ narrationLanguage: value })} disabled={running} ariaLabel="Ngôn ngữ thuyết minh" className="rounded-xl px-3 py-3 text-sm" /></label>
            <label className="space-y-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-white/35">Khán giả mục tiêu</span><AppSelect value={narrationAudience} options={NARRATION_AUDIENCE_OPTIONS} onChange={(value) => patchSettings({ narrationAudience: value })} disabled={running} ariaLabel="Khán giả mục tiêu" className="rounded-xl px-3 py-3 text-sm" /></label>
            <label className="space-y-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-white/35">Mật độ bình luận</span><AppSelect value={narrationDensity} options={NARRATION_DENSITY_OPTIONS} onChange={(value) => patchSettings({ narrationDensity: value })} disabled={running} ariaLabel="Mật độ bình luận" className="rounded-xl px-3 py-3 text-sm" /></label>
          </div>
          <p className="mt-3 text-[11px] leading-5 text-white/35">Ngôn ngữ video nguồn không quyết định lời đọc. Chế độ Dày phù hợp video review và chủ động lấp các khoảng trống dài.</p>
          {outputChoiceChanged && <div className="mt-4 rounded-xl border border-amber-300/25 bg-amber-300/[0.08] px-4 py-3 text-xs leading-5 text-amber-100/80">Bản nháp hiện tại chưa theo lựa chọn đầu ra này. Hãy phân tích lại để áp dụng thiết lập mới.</div>}
          {hasAnalysis && <div className="mt-4 rounded-xl border border-white/[0.07] bg-black/10 p-4"><p className="text-sm leading-6 text-white/60">{project.narrationWorkflow?.summary}</p><div className="mt-2 flex gap-4 text-xs text-white/35"><span>{project.narrationWorkflow?.shotCount ?? 0} cảnh</span><span>{project.scenes.length} đoạn lời</span></div></div>}
        </div>
      </section>}

      {setupStep === 'script' && hasAnalysis && <section className="workspace-panel mx-auto max-w-5xl rounded-2xl p-6">
        <div className="mb-5 flex items-end justify-between gap-4"><div><h2 className="text-lg font-bold text-white">Review nội dung thuyết minh</h2><p className="mt-1 text-xs text-white/40">Sửa từng đoạn trước khi tạo giọng. Mọi thay đổi được tự động lưu.</p></div><div className="text-xs font-semibold text-emerald-200/70">Bước 2/4</div></div>
        {project.scenes.length ? <div className="space-y-3">{project.scenes.map((scene, index) => {
          const windowDuration = Math.max(0.5, (scene.sourceEnd ?? 0) - (scene.sourceStart ?? 0));
          const words = scene.narration.trim().split(/\s+/).filter(Boolean).length;
          const dense = !scene.audioPath && words / windowDuration > 3;
          return <article key={scene.id} className="rounded-xl border border-white/[0.07] bg-black/15 p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-2"><span className="grid h-6 w-6 place-items-center rounded-md bg-emerald-400/10 text-[10px] font-black text-emerald-200">{index + 1}</span><span className="text-xs text-white/45">{scene.imagePrompt || 'Diễn biến trong video'}</span></div><div className={`flex items-center gap-1 text-[11px] ${scene.narrationFitStatus === 'needs-review' || dense ? 'text-amber-300' : scene.audioPath ? 'text-emerald-300/80' : 'text-white/45'}`}><Clock3 size={12} /> {timeLabel(scene.sourceStart)}–{timeLabel(scene.sourceEnd)} · {scene.audioDuration ? `${scene.audioDuration.toFixed(1)} giây` : `${words} từ`}{scene.narrationRevision ? ` · đã tự chỉnh ${scene.narrationRevision} lần` : dense ? ' · có thể hơi dài' : ''}</div></div>
            <textarea value={scene.narration} onChange={(event) => editNarration(scene, event.target.value)} rows={3} disabled={voiceBusy || Boolean(renderKind)} className="field-surface w-full resize-y rounded-xl px-4 py-3 text-sm leading-6 text-white/85 outline-none disabled:opacity-60" />
            {scene.audioPath && <div className="mt-3 flex items-center gap-3"><AudioPlayer src={localFileUrl(scene.audioPath)!} onDuration={(duration) => { if (Math.abs((scene.audioDuration ?? 0) - duration) > 0.1) updateScene(scene.id, { audioDuration: duration }); }} className="flex-1" />{scene.narrationFitStatus === 'needs-review' ? <span title="Lời chưa vừa khoảng đọc an toàn" className="flex shrink-0 items-center gap-1 text-xs text-amber-300"><AlertTriangle size={14} /> Cần chỉnh lại</span> : <span className="flex shrink-0 items-center gap-1 text-xs text-emerald-300"><CheckCircle2 size={14} /> Vừa thời lượng</span>}</div>}
          </article>;
        })}</div> : <div className="rounded-xl border border-white/[0.07] p-5 text-sm text-white/45">Video này không cần thêm lời ở các đoạn đã nhận biết.</div>}
      </section>}

      {setupStep === 'voice' && hasAnalysis && project.scenes.length > 0 && <section className="workspace-panel mx-auto max-w-5xl overflow-hidden rounded-2xl">
        <div className="grid lg:grid-cols-[minmax(0,1fr)_400px]">
          <div className="p-6 lg:border-r lg:border-white/[0.08]"><div className="mb-5 flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-xl bg-emerald-400/10 text-emerald-300"><Mic2 size={19} /></span><div><h2 className="text-lg font-bold">Tạo giọng và tự căn thời lượng</h2><p className="mt-1 text-xs leading-5 text-white/40">Mỗi câu có khoảng đọc riêng và khoảng nghỉ an toàn. Lời chưa vừa sẽ được điều chỉnh, không ép đọc quá nhanh.</p></div></div>
            {voiceBusy && <div className="mb-5 rounded-xl border border-emerald-400/20 bg-emerald-400/[0.06] p-4"><div className="flex items-center justify-between text-xs"><span className="flex items-center gap-2 font-bold text-emerald-200"><Loader2 size={14} className="animate-spin" /> {voiceProgress.fitting ? 'Đang tự điều chỉnh lời…' : 'Đang tạo giọng…'}</span><span className="text-white/45">{voiceProgress.done}/{voiceProgress.total}</span></div><div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-emerald-400 transition-all" style={{ width: `${voiceProgress.total ? voiceProgress.done / voiceProgress.total * 100 : 0}%` }} /></div></div>}
            {allVoiced && <div className="mb-5 rounded-xl border border-white/[0.07] bg-black/20 p-4"><div className="flex items-center justify-between text-xs"><span className="font-bold text-white/70">Độ phủ lời {coverage.percent}%</span><span className={coverage.longGaps ? 'text-amber-300' : 'text-emerald-300'}>{coverage.longGaps ? `${coverage.longGaps} khoảng trống dài` : 'Nhịp bình luận liền mạch'}</span></div><div className="relative mt-3 h-2 overflow-hidden rounded-full bg-amber-300/15">{coverage.timelineEnd > 0 && coverage.intervals.map((item, index) => <span key={index} className="absolute inset-y-0 rounded-full bg-emerald-400" style={{ left: `${item.start / coverage.timelineEnd * 100}%`, width: `${(item.end - item.start) / coverage.timelineEnd * 100}%` }} />)}</div></div>}
            <div className="space-y-2">{project.scenes.map((scene, index) => <div key={scene.id} className="flex items-center justify-between rounded-xl border border-white/[0.06] px-4 py-3 text-xs"><span className="text-white/65">Đoạn {index + 1}</span>{scene.audioPath ? <span className={`flex items-center gap-1 ${scene.narrationFitStatus === 'needs-review' ? 'text-amber-300' : 'text-emerald-300'}`}>{scene.narrationFitStatus === 'needs-review' ? <AlertTriangle size={13} /> : <Check size={13} />}{scene.audioDuration?.toFixed(1)} giây</span> : <span className="text-white/25">Chưa tạo</span>}</div>)}</div>
          </div>
          <aside className="h-[650px]"><VoiceConfigPanel onMissingKey={setMissingService} /></aside>
        </div>
      </section>}

      {setupStep === 'export' && allVoiced && <section className="workspace-panel mx-auto max-w-5xl rounded-2xl p-6">
        <div className="mb-5 flex items-center justify-between gap-4"><div><h2 className="text-lg font-bold">Kiểm tra trước khi tạo</h2><p className="mt-1 text-xs text-white/40">Chọn phần âm thanh, tạo bản xem trước rồi xuất video hoàn chỉnh.</p></div><div className="text-xs font-semibold text-emerald-200/70">Bước 4/4</div></div>
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="space-y-3">
            <label className="flex items-center gap-3 rounded-xl border border-white/[0.07] bg-black/15 p-4 text-sm"><input type="checkbox" checked={sub.enabled} onChange={(event) => patchSub({ enabled: event.target.checked })} disabled={Boolean(renderKind)} className="size-4 accent-emerald-400" /><Captions size={16} className="text-emerald-300" /><span>Chèn phụ đề theo lời đọc</span></label>
            <label className="block rounded-xl border border-white/[0.07] bg-black/15 p-4"><span className="flex justify-between text-xs text-white/60"><span>Âm thanh gốc</span><span>{project.settings.originalAudioVolume}%</span></span><input type="range" min={0} max={100} value={project.settings.originalAudioVolume} onChange={(event) => patchSettings({ originalAudioVolume: Number(event.target.value) })} disabled={Boolean(renderKind)} className="mt-3 w-full accent-emerald-400" /></label>
            <div className="rounded-xl border border-white/[0.07] bg-black/15 p-4"><div className="flex items-center gap-3"><Music size={16} className="text-emerald-300" /><span className="flex-1 text-sm">Nhạc nền</span>{music.audioPath ? <><span className="max-w-40 truncate text-[11px] text-white/35">{music.fileName}</span><button onClick={() => patchMusic({ enabled: false, audioPath: undefined, fileName: undefined })} disabled={Boolean(renderKind)} className="text-white/35 hover:text-red-300"><X size={15} /></button></> : <button onClick={() => void importMusic()} disabled={importingMusic || Boolean(renderKind)} className="flex items-center gap-1 rounded-lg border border-white/10 px-3 py-2 text-xs text-white/60">{importingMusic ? <Loader2 size={13} className="animate-spin" /> : <FolderOpen size={13} />} Chọn nhạc</button>}</div>{music.audioPath && <label className="mt-4 block"><span className="flex justify-between text-xs text-white/45"><span>Âm lượng nhạc</span><span>{music.volume}%</span></span><input type="range" min={0} max={100} value={music.volume} onChange={(event) => patchMusic({ enabled: true, volume: Number(event.target.value) })} disabled={Boolean(renderKind)} className="mt-2 w-full accent-emerald-400" /></label>}</div>
          </div>
          <div className="flex min-h-72 flex-col justify-center rounded-xl border border-white/[0.07] bg-black/40 p-3">{previewUrl ? <video src={previewUrl} controls preload="metadata" className="max-h-[420px] w-full rounded-lg object-contain" /> : <div className="text-center text-sm text-white/30">Bản xem trước sẽ xuất hiện ở đây.</div>}</div>
        </div>
        {renderKind && <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-white/[0.07]"><div className="h-full rounded-full bg-emerald-400 transition-all" style={{ width: `${Math.max(4, renderPercent)}%` }} /></div>}
        {stage === 'complete' && project.dubbedVideoPath && <div className="mt-5 rounded-xl border border-emerald-400/25 bg-emerald-400/[0.07] p-4"><div className="flex items-center justify-between gap-4"><span className="flex items-center gap-2 text-sm font-bold text-emerald-200"><CheckCircle2 size={17} /> Video đã hoàn thành</span><button onClick={() => window.gensuite.shell.showItemInFolder(project.dubbedVideoPath!)} className="flex items-center gap-2 rounded-lg border border-emerald-300/20 px-3 py-2 text-xs font-bold text-emerald-200"><FolderOpen size={14} /> Mở vị trí file</button></div>{outputUrl && <video src={outputUrl} controls preload="metadata" className="mt-4 max-h-[520px] w-full rounded-lg bg-black object-contain" />}</div>}
      </section>}
      </div>

      <footer className="mx-auto mt-4 flex w-full max-w-5xl shrink-0 items-center gap-3 rounded-2xl border border-white/[0.08] bg-[#151516]/95 p-3 shadow-2xl backdrop-blur-xl">
        {running ? <div className="min-w-0 flex-1 px-2"><p className="flex items-center gap-2 truncate text-xs font-semibold text-emerald-200"><Loader2 size={15} className="shrink-0 animate-spin" />{sourceBusy ? `Đang chuẩn bị video${downloadProgress ? ` ${Math.round(downloadProgress)}%` : ''}` : analysisBusy ? PROGRESS_LABELS[analysisPhase] : voiceBusy ? voiceProgress.fitting ? 'Đang tự điều chỉnh lời' : `Đang tạo giọng ${voiceProgress.done}/${voiceProgress.total}` : renderKind === 'preview' ? `Đang tạo bản xem trước ${Math.round(renderPercent)}%` : `Đang hoàn thiện ${Math.round(renderPercent)}%`}</p><div className="mt-2 h-1 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-emerald-400 transition-all" style={{ width: `${sourceBusy ? downloadProgress || 18 : analysisBusy ? analysisProgress : voiceBusy && voiceProgress.total ? voiceProgress.done / voiceProgress.total * 100 : renderPercent || 18}%` }} /></div></div> : <div className="min-w-0 flex-1 px-2"><p className="truncate text-xs font-semibold text-white/60">Bước {currentStepIndex + 1}/4 · {SETUP_STEPS[currentStepIndex].label}</p><p className="mt-0.5 truncate text-[10px] text-white/25">{project.sourceVideoPath ? setupStep === 'source' ? sourceName(project.sourceVideoPath) : setupStep === 'script' ? `${project.scenes.length} đoạn lời` : setupStep === 'voice' ? allVoiced ? 'Giọng đọc đã sẵn sàng' : 'Chọn giọng phù hợp để tiếp tục' : previewUrl ? 'Bản xem trước đã sẵn sàng' : 'Kiểm tra âm thanh trước khi tạo' : 'Hãy chọn video để bắt đầu'}</p></div>}
        {currentStepIndex > 0 && !running && <button onClick={goBack} className="inline-flex items-center gap-2 rounded-xl border border-white/10 px-4 py-3 text-xs font-bold text-white/55 hover:text-white"><ArrowLeft size={14} /> Quay lại</button>}
        {setupStep !== 'export' ? <button onClick={() => void goNext()} disabled={running || !stepReady} className="primary-action inline-flex min-w-36 items-center justify-center gap-2 rounded-xl px-5 py-3 text-xs font-bold disabled:opacity-40">{setupStep === 'source' ? hasAnalysis && !outputChoiceChanged ? 'Tiếp tục' : 'Phân tích & viết lời' : setupStep === 'voice' && !allVoiced ? 'Tạo giọng' : 'Tiếp tục'} <ChevronRight size={14} /></button> : <button onClick={() => void renderVideo(previewUrl ? 'final' : 'preview')} disabled={running || !allVoiced || stage === 'complete'} className="primary-action inline-flex min-w-40 items-center justify-center gap-2 rounded-xl px-5 py-3 text-xs font-bold disabled:opacity-40">{stage === 'complete' ? <><Check size={14} /> Đã hoàn tất</> : previewUrl ? <><Film size={14} /> Tạo video</> : <><Film size={14} /> Tạo bản xem trước</>}</button>}
      </footer>
    </div>
  );
}
