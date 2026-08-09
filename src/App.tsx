import { useEffect, useState } from 'react';
import { AudioLines, BookOpenText, Check, Clapperboard, FileVideo, Film, Home, Languages, LayoutTemplate, LogOut, Mic, Play } from 'lucide-react';
import { TitleBar } from './components/TitleBar';
import { GlobalDialogs } from './components/GlobalDialogs';
import { ProjectHome } from './components/ProjectHome';
import { SignInScreen } from './auth/SignInScreen';
import { SettingsPanel } from './settings/SettingsPanel';
import { TopicStudio } from './steps/TopicStudio';
import { DirectorRoom } from './steps/DirectorRoom';
import { ArtDepartment } from './steps/ArtDepartment';
import { SoundStage } from './steps/SoundStage';
import { Timeline } from './steps/Timeline';
import { LocalizeStudio, type LocalizeSetupStep } from './steps/LocalizeStudio';
import { NarrationStudio, type NarrationSetupStep } from './steps/NarrationStudio';
import { useProjectStore } from './store/projectStore';
import { useSettingsStore } from './store/settingsStore';
import { useTopicStore } from './store/topicStore';
import { useAuthStore } from './store/authStore';
import { useEntitlementStore } from './store/entitlementStore';
import type { StepId } from './shared/types';
import { useUpdateStore } from './store/updateStore';
import { useLocalizeRuntimeStore } from './store/localizeRuntimeStore';

const TOPIC_STEPS: Array<{ id: StepId; label: string; icon: typeof Film }> = [
  { id: 'topic', label: '1. Chủ đề', icon: LayoutTemplate },
  { id: 'content', label: '2. Nội dung', icon: BookOpenText },
  { id: 'voice', label: '3. Giọng đọc', icon: Mic },
  { id: 'storyboard', label: '4. Storyboard', icon: Clapperboard },
  { id: 'timeline', label: '5. Xuất video', icon: Film },
];

const LOCALIZE_STEPS: Array<{ id: LocalizeSetupStep; label: string; description: string; icon: typeof Film }> = [
  { id: 'source', label: 'Thiết lập', description: 'Video, ngôn ngữ và giọng đọc', icon: FileVideo },
  { id: 'process', label: 'Xử lý & xuất', description: 'Tạo dự án CapCut', icon: Play },
];

const NARRATION_STEPS: Array<{ id: NarrationSetupStep; label: string; description: string; icon: typeof Film }> = [
  { id: 'source', label: 'Video & thiết lập', description: 'Chọn nguồn và kiểu lời', icon: FileVideo },
  { id: 'script', label: 'Nội dung', description: 'Review và chỉnh lời', icon: BookOpenText },
  { id: 'voice', label: 'Giọng đọc', description: 'Chọn giọng và tự căn', icon: Mic },
  { id: 'export', label: 'Kiểm tra & tạo', description: 'Âm thanh và xuất video', icon: Play },
];

export default function App() {
  const hydrated = useProjectStore((state) => state.hydrated);
  const hydrate = useProjectStore((state) => state.hydrate);
  const home = useProjectStore((state) => state.home);
  const project = useProjectStore((state) => state.project);
  const localizeRuntime = useLocalizeRuntimeStore((state) => state.jobs[project.id]);
  const initializeLocalizeRuntime = useLocalizeRuntimeStore((state) => state.initialize);
  const setName = useProjectStore((state) => state.setName);
  const setStep = useProjectStore((state) => state.setStep);
  const goHome = useProjectStore((state) => state.goHome);
  const loadSettings = useSettingsStore((state) => state.load);
  const loadTopics = useTopicStore((state) => state.load);
  const authStatus = useAuthStore((state) => state.status);
  const authEmail = useAuthStore((state) => state.email);
  const initAuth = useAuthStore((state) => state.init);
  const signOut = useAuthStore((state) => state.signOut);
  const loadEntitlements = useEntitlementStore((state) => state.load);
  const resetEntitlements = useEntitlementStore((state) => state.reset);
  const initializeUpdater = useUpdateStore((state) => state.initialize);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [localizeSetupStep, setLocalizeSetupStep] = useState<LocalizeSetupStep>('source');
  const [localizeNavigationLocked, setLocalizeNavigationLocked] = useState(false);
  const [localizeSourceReady, setLocalizeSourceReady] = useState(Boolean(project.sourceVideoPath));
  const [narrationSetupStep, setNarrationSetupStep] = useState<NarrationSetupStep>('source');
  const [narrationNavigationLocked, setNarrationNavigationLocked] = useState(false);
  const localizeSourceChoicesConfirmed = Boolean(
    project.settings.localizeSourceLanguageConfirmed
    && project.settings.localizeTargetLanguageConfirmed
    && project.settings.localizeAccuracyConfirmed,
  );
  const activeVoiceConfig = project.settings.voiceConfigs[project.settings.voiceEngine];
  const localizeVoiceReady = Boolean(project.settings.localizeVoiceProviderConfirmed && activeVoiceConfig.voiceId);
  const narrationSourceReady = Boolean(project.sourceVideoPath);
  const narrationScriptReady = Boolean(project.narrationWorkflow?.summary && project.scenes.length);
  const narrationVoiceReady = narrationScriptReady && project.scenes.every((scene) => Boolean(scene.audioPath));
  const projectTypeLabel = project.kind === 'narrate'
    ? 'Video Review'
    : project.kind === 'localize'
      ? 'Dịch & lồng tiếng'
      : project.topic?.name ?? 'Chưa chọn chủ đề';

  useEffect(() => { initAuth(); }, [initAuth]);
  useEffect(() => { initializeUpdater(); }, [initializeUpdater]);
  useEffect(() => {
    hydrate();
    loadSettings();
    loadTopics();
    void initializeLocalizeRuntime();
  }, [hydrate, initializeLocalizeRuntime, loadSettings, loadTopics]);
  useEffect(() => window.gensuite.whisper.onProgress((progress) => {
    if (!progress.projectId) return;
    const runtimeStore = useLocalizeRuntimeStore.getState();
    const job = runtimeStore.jobs[progress.projectId];
    if (!job || job.status !== 'running' || job.stage !== 'recognition') return;
    const percent = progress.phase === 'extracting' ? 2
      : progress.phase === 'downloading-model' ? Math.min(10, (progress.percent ?? 0) / 10)
        : progress.phase === 'complete' ? 99 : Math.max(10, progress.percent ?? 10);
    const detail = progress.phase === 'extracting' ? 'Đang chuẩn bị âm thanh'
      : progress.phase === 'downloading-model' ? 'Đang chuẩn bị dữ liệu nhận dạng'
        : progress.chunkNumber && progress.chunkCount ? `Đang xử lý phần ${progress.chunkNumber}/${progress.chunkCount}` : 'Đang nhận dạng lời thoại';
    const steps = job.steps.map((step) => step.id === 'recognition'
      ? { ...step, status: 'active' as const, percent: Math.max(step.percent, Math.min(99, percent)), detail }
      : step);
    runtimeStore.update(progress.projectId, job.runId, { steps, lastActivityAt: Date.now() });
    void window.gensuite.localize.update({
      projectId: progress.projectId,
      operationId: job.runId,
      stage: 'recognition',
      status: 'running',
      stageStatus: progress.phase === 'extracting' || progress.phase === 'downloading-model' ? 'preflight' : 'running',
      percent: steps.find((step) => step.id === 'recognition')?.percent ?? percent,
      label: detail,
    }).then((result) => {
      if (result.ok) useLocalizeRuntimeStore.getState().acceptManifest(result.value);
    });
  }), []);
  useEffect(() => window.gensuite.ytdlp.onProgress((progress) => {
    if (!progress.projectId) return;
    const runtimeStore = useLocalizeRuntimeStore.getState();
    const job = runtimeStore.jobs[progress.projectId];
    if (!job || job.status !== 'running' || job.stage !== 'download') return;
    const percent = Math.max(0, Math.min(99, progress.percent ?? 0));
    const detail = progress.phase === 'merging' ? 'Đang hoàn thiện video tải về' : 'Đang tải video';
    const steps = job.steps.map((step) => step.id === 'download'
      ? { ...step, status: 'active' as const, percent: Math.max(step.percent, percent), detail }
      : step);
    runtimeStore.update(progress.projectId, job.runId, { steps, lastActivityAt: Date.now() });
    void window.gensuite.localize.update({
      projectId: progress.projectId,
      operationId: job.runId,
      stage: 'download',
      status: 'running',
      stageStatus: progress.phase === 'merging' ? 'validating' : 'running',
      percent,
      label: detail,
    }).then((result) => {
      if (result.ok) useLocalizeRuntimeStore.getState().acceptManifest(result.value);
    });
  }), []);
  useEffect(() => {
    if (authStatus === 'signedIn') void loadEntitlements();
    else if (authStatus === 'signedOut') resetEntitlements();
  }, [authStatus, loadEntitlements, resetEntitlements]);
  useEffect(() => {
    if (authStatus !== 'signedIn') return undefined;
    const refreshCredits = () => { void loadEntitlements(); };
    window.addEventListener('focus', refreshCredits);
    return () => window.removeEventListener('focus', refreshCredits);
  }, [authStatus, loadEntitlements]);
  useEffect(() => {
    setLocalizeSetupStep(localizeRuntime ? 'process' : 'source');
    setLocalizeSourceReady(Boolean(project.sourceVideoPath));
    setNarrationSetupStep('source');
  }, [project.id, localizeRuntime?.status]);

  return (
    <div className="app-background flex h-full flex-col bg-background text-text">
      <TitleBar onOpenSettings={authStatus === 'signedIn' ? () => setSettingsOpen(true) : undefined} />
      <GlobalDialogs />
      {authStatus !== 'signedIn' ? (
        authStatus === 'loading' ? (
          <div className="flex flex-1 items-center justify-center text-text/50">Đang kiểm tra đăng nhập…</div>
        ) : (
          <SignInScreen />
        )
      ) : (
        <>
          {!hydrated ? <div className="flex flex-1 items-center justify-center text-text/50">Đang tải thư viện dự án…</div> : home ? <ProjectHome onOpenSettings={() => setSettingsOpen(true)} /> : (
            <div className="flex min-h-0 flex-1">
              <nav className="flex w-64 shrink-0 flex-col border-r border-white/10 bg-[#1c1c1d] px-3 pb-4 pt-5 shadow-[8px_0_32px_rgba(0,0,0,0.08)]">
                <button onClick={goHome} className="mb-5 flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold text-white/45 hover:bg-white/5 hover:text-white"><Home size={15} /> Tất cả dự án</button>
                <div className="mb-7 px-3">
                  <div className="mb-2 text-[11px] font-semibold text-white/30">Dự án hiện tại</div>
                  <input
                    value={project.name}
                    onChange={(event) => setName(event.target.value)}
                    aria-label="Tên dự án"
                    className="-mx-2 w-[calc(100%+16px)] rounded-lg border-0 bg-transparent px-2 py-1.5 text-base font-bold tracking-[-0.02em] text-white/90 outline-none transition-colors duration-200 hover:bg-white/[0.025] focus:bg-white/[0.045] focus:text-white focus-visible:outline-none"
                  />
                  <p className="mt-1.5 truncate text-[11px] font-medium text-emerald-300/70">{projectTypeLabel}</p>
                </div>
                <div className="mb-2 px-3 text-[11px] font-semibold text-white/30">Quy trình sản xuất</div>
                {project.kind === 'localize' ? <div className="flex flex-1 flex-col">
                  <div className="mb-2 flex items-center gap-2 px-3 text-[12px] font-bold text-white/65"><Languages size={15} className="text-emerald-400" /> Bản địa hóa</div>
                  <ul className="relative flex flex-col gap-1 before:absolute before:bottom-5 before:left-[27px] before:top-5 before:w-px before:bg-white/[0.08]">
                    {LOCALIZE_STEPS.map(({ id, label, description, icon: Icon }, index) => {
                      const active = localizeSetupStep === id;
                      const completed = index < LOCALIZE_STEPS.findIndex((item) => item.id === localizeSetupStep);
                      const prerequisiteMissing = index > 0 && (!localizeSourceReady || !localizeSourceChoicesConfirmed || !localizeVoiceReady);
                      return <li key={id} className="relative"><button type="button" disabled={localizeNavigationLocked || prerequisiteMissing} onClick={() => setLocalizeSetupStep(id)} className={`group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition disabled:cursor-not-allowed disabled:opacity-40 ${active ? 'bg-emerald-400/10 text-white ring-1 ring-emerald-400/20' : 'text-white/45 hover:bg-white/[0.04] hover:text-white/75'}`}><span className={`relative z-10 grid size-8 shrink-0 place-items-center rounded-lg ${active ? 'bg-emerald-400 text-black' : completed ? 'bg-emerald-400/15 text-emerald-300' : 'bg-[#222223] text-white/30'}`}>{completed ? <Check size={14} /> : <Icon size={14} />}</span><span className="min-w-0"><span className="block text-[12px] font-bold">{index + 1}. {label}</span><span className="mt-0.5 block truncate text-[9px] text-white/25">{description}</span></span></button></li>;
                    })}
                  </ul>
                </div> : project.kind === 'narrate' ? <div className="flex flex-1 flex-col">
                  <div className="mb-2 flex items-center gap-2 px-3 text-[12px] font-bold text-white/65"><AudioLines size={15} className="text-emerald-400" /> Video Review</div>
                  <ul className="relative flex flex-col gap-1 before:absolute before:bottom-5 before:left-[27px] before:top-5 before:w-px before:bg-white/[0.08]">
                    {NARRATION_STEPS.map(({ id, label, description, icon: Icon }, index) => {
                      const active = narrationSetupStep === id;
                      const completed = index < NARRATION_STEPS.findIndex((item) => item.id === narrationSetupStep);
                      const prerequisiteMissing = (index > 0 && !narrationSourceReady) || (index > 1 && !narrationScriptReady) || (index > 2 && !narrationVoiceReady);
                      return <li key={id} className="relative"><button type="button" disabled={narrationNavigationLocked || prerequisiteMissing} onClick={() => setNarrationSetupStep(id)} className={`group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition disabled:cursor-not-allowed disabled:opacity-40 ${active ? 'bg-emerald-400/10 text-white ring-1 ring-emerald-400/20' : 'text-white/45 hover:bg-white/[0.04] hover:text-white/75'}`}><span className={`relative z-10 grid size-8 shrink-0 place-items-center rounded-lg ${active ? 'bg-emerald-400 text-black' : completed ? 'bg-emerald-400/15 text-emerald-300' : 'bg-[#222223] text-white/30'}`}>{completed ? <Check size={14} /> : <Icon size={14} />}</span><span className="min-w-0"><span className="block text-[12px] font-bold">{index + 1}. {label}</span><span className="mt-0.5 block truncate text-[9px] text-white/25">{description}</span></span></button></li>;
                    })}
                  </ul>
                </div> : <ul className="flex flex-1 flex-col gap-1">
                  {TOPIC_STEPS.map(({ id, label, icon: Icon }) => {
                    const active = project.currentStep === id;
                    return <li key={id}><button onClick={() => setStep(id)} className={`group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[13px] font-semibold transition ${active ? 'bg-white/10 text-white' : 'text-white/50 hover:bg-white/5 hover:text-white'}`}><Icon size={17} className={active ? 'text-emerald-400' : 'text-white/30'} />{label}</button></li>;
                  })}
                </ul>}
                {authEmail && (
                  <div className="mt-4 flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-[11px] text-white/35">
                    <span className="truncate" title={authEmail}>{authEmail}</span>
                    <button onClick={signOut} title="Đăng xuất" className="shrink-0 rounded p-1 text-white/40 hover:bg-white/5 hover:text-white"><LogOut size={14} /></button>
                  </div>
                )}
              </nav>
              <main className="min-w-0 flex-1 overflow-y-auto bg-black/5">
                {project.currentStep === 'localize' && <LocalizeStudio onOpenSettings={() => setSettingsOpen(true)} setupStep={localizeSetupStep} onSetupStepChange={setLocalizeSetupStep} onNavigationLockChange={setLocalizeNavigationLocked} onSourceReadyChange={setLocalizeSourceReady} />}
                {project.currentStep === 'narrate' && <NarrationStudio onOpenSettings={() => setSettingsOpen(true)} setupStep={narrationSetupStep} onSetupStepChange={setNarrationSetupStep} onNavigationLockChange={setNarrationNavigationLocked} />}
                {project.currentStep === 'topic' && <TopicStudio />}
                {project.currentStep === 'content' && <DirectorRoom onOpenSettings={() => setSettingsOpen(true)} />}
                {project.currentStep === 'storyboard' && <ArtDepartment onOpenSettings={() => setSettingsOpen(true)} />}
                {project.currentStep === 'voice' && <SoundStage onOpenSettings={() => setSettingsOpen(true)} />}
                {project.currentStep === 'timeline' && <Timeline />}
              </main>
            </div>
          )}
          {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
        </>
      )}
    </div>
  );
}
