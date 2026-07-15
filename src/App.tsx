import { useEffect, useState } from 'react';
import { BookOpenText, Clapperboard, Film, Home, Languages, LayoutTemplate, LogOut, Mic } from 'lucide-react';
import { TitleBar } from './components/TitleBar';
import { UpdateBanner } from './components/UpdateBanner';
import { ProjectHome } from './components/ProjectHome';
import { SignInScreen } from './auth/SignInScreen';
import { SettingsPanel } from './settings/SettingsPanel';
import { TopicStudio } from './steps/TopicStudio';
import { DirectorRoom } from './steps/DirectorRoom';
import { ArtDepartment } from './steps/ArtDepartment';
import { SoundStage } from './steps/SoundStage';
import { Timeline } from './steps/Timeline';
import { LocalizeStudio } from './steps/LocalizeStudio';
import { useProjectStore } from './store/projectStore';
import { useSettingsStore } from './store/settingsStore';
import { useTopicStore } from './store/topicStore';
import { useAuthStore } from './store/authStore';
import type { StepId } from './shared/types';

const TOPIC_STEPS: Array<{ id: StepId; label: string; icon: typeof Film }> = [
  { id: 'topic', label: '1. Chủ đề', icon: LayoutTemplate },
  { id: 'content', label: '2. Nội dung', icon: BookOpenText },
  { id: 'voice', label: '3. Giọng đọc', icon: Mic },
  { id: 'storyboard', label: '4. Storyboard', icon: Clapperboard },
  { id: 'timeline', label: '5. Xuất video', icon: Film },
];

// Localize projects run the whole re-dub pipeline (download → transcribe →
// translate → voice → merge) from one screen, so there is a single nav step.
const LOCALIZE_STEPS: Array<{ id: StepId; label: string; icon: typeof Film }> = [
  { id: 'localize', label: 'Bản địa hóa', icon: Languages },
];

export default function App() {
  const hydrated = useProjectStore((state) => state.hydrated);
  const hydrate = useProjectStore((state) => state.hydrate);
  const home = useProjectStore((state) => state.home);
  const project = useProjectStore((state) => state.project);
  const setName = useProjectStore((state) => state.setName);
  const setStep = useProjectStore((state) => state.setStep);
  const goHome = useProjectStore((state) => state.goHome);
  const loadSettings = useSettingsStore((state) => state.load);
  const loadTopics = useTopicStore((state) => state.load);
  const authStatus = useAuthStore((state) => state.status);
  const authEmail = useAuthStore((state) => state.email);
  const initAuth = useAuthStore((state) => state.init);
  const signOut = useAuthStore((state) => state.signOut);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const steps = project.kind === 'localize' ? LOCALIZE_STEPS : TOPIC_STEPS;

  useEffect(() => { initAuth(); }, [initAuth]);
  useEffect(() => { hydrate(); loadSettings(); loadTopics(); }, [hydrate, loadSettings, loadTopics]);

  return (
    <div className="app-background flex h-full flex-col bg-background text-text">
      <TitleBar onOpenSettings={authStatus === 'signedIn' ? () => setSettingsOpen(true) : undefined} />
      {authStatus !== 'signedIn' ? (
        authStatus === 'loading' ? (
          <div className="flex flex-1 items-center justify-center text-text/50">Đang kiểm tra đăng nhập…</div>
        ) : (
          <SignInScreen />
        )
      ) : (
        <>
          <UpdateBanner />
          {!hydrated ? <div className="flex flex-1 items-center justify-center text-text/50">Đang tải thư viện dự án…</div> : home ? <ProjectHome /> : (
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
                  <p className="mt-1.5 truncate text-[11px] font-medium text-emerald-300/70">{project.topic?.name ?? 'Chưa chọn chủ đề'}</p>
                </div>
                <div className="mb-2 px-3 text-[11px] font-semibold text-white/30">Quy trình sản xuất</div>
                <ul className="flex flex-1 flex-col gap-1">
                  {steps.map(({ id, label, icon: Icon }) => {
                    const active = project.currentStep === id;
                    return <li key={id}><button onClick={() => setStep(id)} className={`group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[13px] font-semibold transition ${active ? 'bg-white/10 text-white' : 'text-white/50 hover:bg-white/5 hover:text-white'}`}><Icon size={17} className={active ? 'text-emerald-400' : 'text-white/30'} />{label}</button></li>;
                  })}
                </ul>
                {authEmail && (
                  <div className="mt-4 flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-[11px] text-white/35">
                    <span className="truncate" title={authEmail}>{authEmail}</span>
                    <button onClick={signOut} title="Đăng xuất" className="shrink-0 rounded p-1 text-white/40 hover:bg-white/5 hover:text-white"><LogOut size={14} /></button>
                  </div>
                )}
              </nav>
              <main className="min-w-0 flex-1 overflow-y-auto bg-black/5">
                {project.currentStep === 'localize' && <LocalizeStudio onOpenSettings={() => setSettingsOpen(true)} />}
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
