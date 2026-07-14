import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, KeyRound, Loader2, Mic, Sparkles, Zap } from 'lucide-react';
import { uid, useProjectStore } from '../store/projectStore';
import { useSettingsStore } from '../store/settingsStore';
import { getVoiceProvider, RESCUE_ENGINE } from '../providers/voice';
import { getScriptProvider } from '../providers/script';
import type { IVoiceProvider } from '../providers/voice';
import { missingKeyService, serviceLabel, errorMessage } from '../providers/errors';
import { localFileUrl } from '../shared/localFile';
import type { Scene, VoiceEngine } from '../shared/types';
import { AudioPlayer } from '../components/AudioPlayer';
import { VoiceConfigPanel, GENMAX_LANGUAGE_IDS } from '../components/VoiceConfigPanel';

interface Props { onOpenSettings: () => void; }

export function SoundStage({ onOpenSettings }: Props) {
  const project = useProjectStore((state) => state.project);
  const updateScene = useProjectStore((state) => state.updateScene);
  const setScenes = useProjectStore((state) => state.setScenes);
  const setStep = useProjectStore((state) => state.setStep);
  const setVoiceEngine = useProjectStore((state) => state.setVoiceEngine);
  const keys = useSettingsStore((state) => state.keys);
  const engine = project.settings.voiceEngine;

  const [missingKey, setMissingKey] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkCurrentSceneId, setBulkCurrentSceneId] = useState<string | null>(null);
  const [bulkCompleted, setBulkCompleted] = useState(0);
  const [scenePrepBusy, setScenePrepBusy] = useState(false);
  const [scenePrepError, setScenePrepError] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [rescuable, setRescuable] = useState<Record<string, boolean>>({});
  const liveProviders = useRef<Record<string, IVoiceProvider>>({});
  const scenePrepStartedRef = useRef('');

  const synthesize = async (sceneId: string, text: string, engineOverride?: VoiceEngine) => {
    const useEngine = engineOverride ?? engine;
    const useConfig = project.settings.voiceConfigs[useEngine];
    if ((useEngine === 'elevenlabs' || useEngine === 'minimax') && !GENMAX_LANGUAGE_IDS.includes(useConfig.language)) {
      setErrors((old) => ({ ...old, [sceneId]: 'Hãy chọn ngôn ngữ trước khi tạo giọng.' }));
      return;
    }
    if (useEngine === 'elevenlabs' && useConfig.language === 'vietnamese' && useConfig.modelId !== 'eleven_v3') {
      setErrors((old) => ({ ...old, [sceneId]: 'Tiếng Việt chỉ được hỗ trợ trên Eleven v3.' }));
      return;
    }
    setBusy((old) => ({ ...old, [sceneId]: true }));
    setErrors((old) => ({ ...old, [sceneId]: '' }));
    setMissingKey(null);
    const provider = getVoiceProvider(useEngine, keys);
    liveProviders.current[sceneId] = provider;
    setRescuable((old) => ({ ...old, [sceneId]: provider.isLocal }));
    try {
      const result = await provider.synthesize({
        projectId: project.id, segmentId: sceneId, text,
        voiceId: useConfig.voiceId, modelId: useConfig.modelId, language: useConfig.language,
        speed: useConfig.speed, temperature: useConfig.temperature,
        stability: useConfig.stability, similarityBoost: useConfig.similarityBoost,
        style: useConfig.style, useSpeakerBoost: useConfig.useSpeakerBoost,
        pitch: useConfig.pitch, volume: useConfig.volume, deliveryMode: useConfig.deliveryMode,
      });
      updateScene(sceneId, { audioPath: result.audioPath, audioDuration: result.durationSec });
    } catch (err) {
      if (errorMessage(err) === 'edgetts:killed') return;
      const service = missingKeyService(err);
      if (service) setMissingKey(service);
      else setErrors((old) => ({ ...old, [sceneId]: errorMessage(err) }));
    } finally {
      if (liveProviders.current[sceneId] === provider) delete liveProviders.current[sceneId];
      setBusy((old) => ({ ...old, [sceneId]: false }));
      setRescuable((old) => ({ ...old, [sceneId]: false }));
    }
  };

  const rescue = async (sceneId: string, text: string) => {
    liveProviders.current[sceneId]?.cancel?.();
    setVoiceEngine(RESCUE_ENGINE);
    await synthesize(sceneId, text, RESCUE_ENGINE);
  };

  const synthesizeAll = async () => {
    setBulkBusy(true);
    setBulkCompleted(0);
    try {
      for (let index = 0; index < project.scenes.length; index += 1) {
        const scene = project.scenes[index];
        setBulkCurrentSceneId(scene.id);
        await synthesize(scene.id, scene.narration);
        setBulkCompleted(index + 1);
      }
    } finally {
      setBulkCurrentSceneId(null);
      setBulkBusy(false);
    }
  };

  const prepareVoiceScenes = async () => {
    const content = project.script.approvedContent || project.script.content;
    if (!content.trim() || !project.topic) return;
    setScenePrepBusy(true);
    setScenePrepError('');
    try {
      const rows = await getScriptProvider(project.settings.scriptEngine, keys).generateStoryboard({
        content,
        visualStyle: project.topic.visualStyle,
        negativePrompt: project.topic.negativePrompt,
      });
      let cursor = 0;
      const scenes: Scene[] = rows.map((row) => {
        let start = content.indexOf(row.narration, cursor);
        if (start < 0) start = cursor;
        const end = Math.min(content.length, start + row.narration.length);
        cursor = end;
        return {
          id: uid('s_'),
          narration: row.narration,
          imagePrompt: row.imagePrompt,
          keyword: row.keyword,
          textStart: start,
          textEnd: end,
          visualType: 'stock-image',
          negativePrompt: project.topic?.negativePrompt,
        };
      });
      setScenes(scenes);
    } catch (error) {
      const service = missingKeyService(error);
      if (service) setMissingKey(service);
      setScenePrepError(service ? 'Cần API key để chia nội dung thành các phân cảnh đọc.' : errorMessage(error));
    } finally {
      setScenePrepBusy(false);
    }
  };

  useEffect(() => {
    const prepKey = `${project.id}:${project.script.approvedContent.length}`;
    if (project.script.status !== 'approved' || project.scenes.length || !project.topic || scenePrepStartedRef.current === prepKey) return;
    scenePrepStartedRef.current = prepKey;
    void prepareVoiceScenes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, project.script.status, project.script.approvedContent, project.scenes.length, project.topic?.id]);

  const allDone = project.scenes.length > 0 && project.scenes.every((scene) => scene.audioPath);
  const bulkCurrentIndex = project.scenes.findIndex((scene) => scene.id === bulkCurrentSceneId);
  if (!project.scenes.length) return <div className="mx-auto flex h-full max-w-3xl flex-col items-center justify-center gap-4 p-12 text-center text-white/55">{scenePrepBusy ? <><Loader2 size={28} className="animate-spin text-emerald-400" /><p className="font-semibold text-white/75">Đang chia nội dung thành các phân cảnh đọc…</p><p className="max-w-md text-xs leading-5 text-white/35">Bước này chuẩn bị từng đoạn audio trước khi bạn chọn hình ảnh ở Storyboard.</p></> : <><Mic size={28} className="text-emerald-400" /><p className="font-semibold text-white/75">Chưa thể chuẩn bị phân cảnh đọc</p>{scenePrepError && <p className="max-w-lg text-xs text-red-300">{scenePrepError}</p>}<div className="flex gap-2"><button onClick={() => { scenePrepStartedRef.current = ''; void prepareVoiceScenes(); }} className="primary-action rounded-xl px-5 py-3 font-bold">Thử lại</button><button onClick={() => setStep('content')} className="rounded-xl border border-white/10 px-5 py-3 font-semibold text-white/65">Về Nội dung</button></div></>}</div>;

  const footer = (
    <>
      <button onClick={allDone ? () => setStep('storyboard') : synthesizeAll} disabled={bulkBusy || Object.values(busy).some(Boolean)} className="primary-action flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-bold disabled:opacity-45">{bulkBusy ? <Loader2 size={16} className="animate-spin" /> : allDone ? <ArrowRight size={16} /> : <Sparkles size={16} />}{bulkBusy ? `Đang tạo ${Math.max(1, bulkCurrentIndex + 1)}/${project.scenes.length}…` : allDone ? 'Sang bước Storyboard' : 'Tạo giọng cho tất cả'}</button>
      <p className="text-[10px] leading-4 text-white/25">Thay đổi engine, giọng hoặc thông số sẽ yêu cầu tạo lại audio để giữ project đồng nhất.</p>
    </>
  );

  return (
    <div className="flex h-full min-h-0">
      <section className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-8 py-10">
          <header className="mb-6"><div className="mb-2 text-[11px] font-bold uppercase tracking-[0.16em] text-emerald-400/80">Bước 04 · Giọng đọc</div><h1 className="text-3xl font-bold tracking-[-0.04em]">Phòng thu âm</h1><p className="mt-2 text-sm text-text/50">Chọn nhà cung cấp, giọng và thông số một lần rồi áp dụng cho toàn bộ bài đọc.</p></header>
          {missingKey && <div className="mb-5 flex items-center justify-between rounded-xl border border-amber-400/30 bg-amber-400/10 p-4 text-sm"><span className="flex items-center gap-2"><KeyRound size={16} /> Thiếu API key cho {serviceLabel(missingKey)}.</span><button onClick={onOpenSettings} className="rounded-lg bg-amber-300 px-3 py-2 text-xs font-bold text-black">Mở Cài đặt</button></div>}
          {bulkBusy && <div className="sticky top-3 z-30 mb-5 overflow-hidden rounded-2xl border border-emerald-400/25 bg-[#102019]/95 p-4 shadow-[0_16px_45px_rgba(0,0,0,0.38)] backdrop-blur-xl"><div className="flex items-center justify-between gap-4"><span className="flex items-center gap-2 text-sm font-bold text-emerald-200"><Loader2 size={16} className="animate-spin text-emerald-400" /> Đang tạo giọng cho phân cảnh {Math.max(1, bulkCurrentIndex + 1)}/{project.scenes.length}</span><span className="text-xs font-semibold text-white/45">Đã xong {bulkCompleted}/{project.scenes.length}</span></div><div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-teal-400 transition-all duration-500" style={{ width: `${(bulkCompleted / project.scenes.length) * 100}%` }} /></div><p className="mt-2 text-[11px] text-white/40">Bạn có thể tiếp tục theo dõi; các phân cảnh còn lại đang chờ trong hàng đợi.</p></div>}
          <ol className="flex flex-col gap-4">
            {project.scenes.map((scene, index) => (
              <li key={scene.id} className={`workspace-panel rounded-2xl p-5 transition-all duration-300 ${bulkCurrentSceneId === scene.id ? 'border-emerald-400/45 bg-emerald-400/[0.045] shadow-[0_0_0_1px_rgba(52,211,153,0.06),0_16px_40px_rgba(0,0,0,0.22)]' : ''}`}>
                <div className="mb-3 flex items-center justify-between"><span className="text-xs font-bold uppercase tracking-wide text-emerald-300">Phân cảnh {index + 1}</span>{bulkCurrentSceneId === scene.id ? <span className="flex items-center gap-1.5 text-xs font-semibold text-emerald-300"><Loader2 size={14} className="animate-spin" /> Đang tạo</span> : scene.audioPath ? <span className="flex items-center gap-1 text-xs text-emerald-300"><Check size={14} /> {scene.audioDuration ? `${scene.audioDuration.toFixed(1)}s` : 'Đã tạo'}</span> : bulkBusy && bulkCurrentIndex >= 0 && index > bulkCurrentIndex ? <span className="flex items-center gap-1.5 text-xs text-white/35"><span className="h-1.5 w-1.5 rounded-full bg-white/25" /> Đang chờ</span> : null}</div>
                <p className="mb-4 text-sm leading-6 text-white/85">{scene.narration}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <button onClick={() => synthesize(scene.id, scene.narration)} disabled={busy[scene.id] || bulkBusy} className="flex items-center gap-1 rounded-lg bg-emerald-400 px-3 py-2 text-sm font-bold text-[#07120f] disabled:opacity-45">{busy[scene.id] ? <Loader2 size={15} className="animate-spin" /> : <Mic size={15} />}{busy[scene.id] ? 'Đang tạo…' : scene.audioPath ? 'Tạo lại' : 'Đọc'}</button>
                  {scene.audioPath && <AudioPlayer src={localFileUrl(scene.audioPath)!} onDuration={(audioDuration) => { if (Math.abs((scene.audioDuration ?? 0) - audioDuration) > 0.1) updateScene(scene.id, { audioDuration }); }} className="min-w-[320px] flex-1" />}
                  {busy[scene.id] && rescuable[scene.id] && <button onClick={() => rescue(scene.id, scene.narration)} className="flex items-center gap-1 rounded-lg bg-amber-400 px-3 py-2 text-xs font-bold text-black"><Zap size={14} /> Đổi sang Cloud</button>}
                </div>
                {errors[scene.id] && <p className="mt-3 text-xs text-red-300">{errors[scene.id]}</p>}
              </li>
            ))}
          </ol>
        </div>
      </section>

      <aside className="relative flex h-full w-[400px] shrink-0 flex-col border-l border-white/10 bg-[#0f0f10] shadow-[-18px_0_50px_rgba(0,0,0,0.18)] 2xl:w-[450px]">
        <VoiceConfigPanel footer={footer} onMissingKey={setMissingKey} />
      </aside>
    </div>
  );
}
