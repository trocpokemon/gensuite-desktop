import { useRef, useState } from 'react';
import { AudioLines, Copy, Download, FileText, Film, FolderOpen, HardDrive, ImagePlus, Languages, Mic, Plus, Search, Sparkles, Trash2 } from 'lucide-react';
import { useProjectStore } from '../store/projectStore';
import { localFileUrl } from '../shared/localFile';
import type { ProjectSummary } from '../shared/types';
import { QuickToolWorkspace, type QuickToolId } from './QuickToolWorkspace';

const STEP_LABEL: Record<string, string> = {
  topic: 'Chọn chủ đề', content: 'Viết nội dung', storyboard: 'Storyboard', voice: 'Giọng đọc', timeline: 'Xuất video', localize: 'Dịch & lồng tiếng', narrate: 'Thuyết minh video',
};

interface Props { onOpenSettings: () => void; }

const QUICK_TOOLS: Array<{ id: QuickToolId; title: string; description: string; icon: typeof Download; color: string }> = [
  { id: 'download', title: 'Tải video', description: 'Tải video từ liên kết', icon: Download, color: 'text-cyan-300 bg-cyan-400/10' },
  { id: 'voice', title: 'Tạo Voice AI', description: 'Chuyển văn bản thành giọng nói', icon: Mic, color: 'text-violet-300 bg-violet-400/10' },
  { id: 'srt', title: 'Xuất SRT', description: 'Tạo phụ đề từ video hoặc audio', icon: FileText, color: 'text-amber-300 bg-amber-400/10' },
  { id: 'translate', title: 'Dịch', description: 'Dịch văn bản hoặc tệp SRT', icon: Languages, color: 'text-emerald-300 bg-emerald-400/10' },
  { id: 'image', title: 'Tạo ảnh', description: 'Tạo ảnh từ mô tả', icon: ImagePlus, color: 'text-fuchsia-300 bg-fuchsia-400/10' },
];

function HeroBadges({ isNew = false }: { isNew?: boolean }) {
  return <span className="absolute right-4 top-4 flex items-center gap-1.5">
    {isNew && <span className="rounded-full border border-amber-300/25 bg-amber-300/10 px-2.5 py-1 text-[10px] font-bold text-amber-100">Mới</span>}
    <span className="rounded-full border border-emerald-400/25 bg-emerald-400/10 px-2.5 py-1 text-[10px] font-bold text-emerald-200">Miễn Phí</span>
  </span>;
}

function formatProjectSize(bytes?: number): string {
  if (!bytes) return '0 MB';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} GB`;
  return `${Math.max(0.1, bytes / 1024 ** 2).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} MB`;
}

function ProjectThumbnail({ project }: { project: ProjectSummary }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  const url = localFileUrl(project.thumbnailPath);
  if (!url || failed) {
    return <div className="flex h-full items-center justify-center bg-gradient-to-br from-emerald-400/15 via-teal-400/5 to-transparent"><FolderOpen size={30} className="text-emerald-300/80" /></div>;
  }
  if (project.thumbnailType === 'video') {
    return <video ref={videoRef} src={url} muted playsInline preload="metadata" onLoadedMetadata={() => {
      const video = videoRef.current;
      if (video && Number.isFinite(video.duration) && video.duration > 0) video.currentTime = Math.min(1, video.duration * 0.08);
    }} onError={() => setFailed(true)} className="h-full w-full object-cover" />;
  }
  return <img src={url} alt="" onError={() => setFailed(true)} className="h-full w-full object-cover" />;
}

export function ProjectHome({ onOpenSettings }: Props) {
  const projects = useProjectStore((state) => state.projects);
  const createProject = useProjectStore((state) => state.createProject);
  const createLocalizeProject = useProjectStore((state) => state.createLocalizeProject);
  const createNarrationProject = useProjectStore((state) => state.createNarrationProject);
  const openProject = useProjectStore((state) => state.openProject);
  const deleteProject = useProjectStore((state) => state.deleteProject);
  const duplicateProject = useProjectStore((state) => state.duplicateProject);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [quickTool, setQuickTool] = useState<QuickToolId | null>(null);

  const visible = projects.filter((project) =>
    `${project.name} ${project.topicName}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );

  const submit = async () => {
    await createProject(name);
    setName('');
    setCreating(false);
  };

  return (
    <main className="min-h-0 flex-1 overflow-y-auto px-10 py-10">
      <div className="mx-auto max-w-6xl">
        <header className="mb-8">
          <div>
            <div className="mb-2 text-xs font-bold uppercase tracking-[0.18em] text-emerald-400">GenSuite Studio</div>
            <h1 className="text-4xl font-bold tracking-[-0.05em]">Bạn muốn làm gì hôm nay?</h1>
            <p className="mt-3 text-sm text-text/50">Chọn một quy trình để bắt đầu, hoặc mở lại một dự án bên dưới.</p>
          </div>
        </header>

        <div className="mb-7 grid grid-cols-1 gap-4 md:grid-cols-3">
          <button onClick={() => void createNarrationProject()} className="hero-tool group relative overflow-hidden rounded-2xl border border-amber-300/20 bg-gradient-to-br from-amber-300/[0.13] via-orange-400/[0.04] to-transparent p-6 text-left transition hover:-translate-y-0.5 hover:border-amber-300/45">
            <HeroBadges isNew />
            <div className="mb-4 inline-flex rounded-xl bg-amber-300/15 p-3 text-amber-200"><AudioLines size={24} /></div>
            <h2 className="text-lg font-bold text-white">Thuyết minh video</h2>
            <p className="mt-1.5 text-sm leading-5 text-white/50">Đưa video có sẵn vào, tự hiểu diễn biến, viết lời và tạo giọng khớp với từng cảnh.</p>
            <span className="mt-4 inline-flex items-center gap-1.5 text-xs font-bold text-amber-200">
              <Film size={14} /> Chọn video cần thuyết minh
            </span>
          </button>

          <button onClick={() => void createLocalizeProject()} className="hero-tool group relative overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-sky-400/[0.12] via-indigo-400/[0.04] to-transparent p-6 text-left transition hover:-translate-y-0.5 hover:border-sky-400/40">
            <HeroBadges />
            <div className="mb-4 inline-flex rounded-xl bg-sky-400/15 p-3 text-sky-300"><Languages size={24} /></div>
            <h2 className="text-lg font-bold text-white">Dịch & lồng tiếng video</h2>
            <p className="mt-1.5 text-sm leading-5 text-white/50">Đưa video có sẵn vào, tự nhận dạng lời thoại, dịch và lồng lại giọng sang ngôn ngữ khác.</p>
            <span className="mt-4 inline-flex items-center gap-1.5 text-xs font-bold text-sky-300">
              <Film size={14} /> Chọn video cần dịch
            </span>
          </button>

          <button onClick={() => setCreating(true)} className="hero-tool group relative overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-emerald-400/[0.12] via-teal-400/[0.04] to-transparent p-6 text-left transition hover:-translate-y-0.5 hover:border-emerald-400/40">
            <HeroBadges isNew />
            <div className="mb-4 inline-flex rounded-xl bg-emerald-400/15 p-3 text-emerald-300"><Sparkles size={24} /></div>
            <h2 className="text-lg font-bold text-white">Tạo dự án nội dung</h2>
            <p className="mt-1.5 text-sm leading-5 text-white/50">Từ chủ đề đến video hoàn chỉnh: viết kịch bản, storyboard, lồng giọng và xuất video.</p>
            <span className="mt-4 inline-flex items-center gap-1.5 text-xs font-bold text-emerald-300">
              <Plus size={14} /> Bắt đầu từ chủ đề
            </span>
          </button>
        </div>

        <section className="mb-10" aria-labelledby="quick-tools-title">
          <div className="mb-3 flex items-center gap-3">
            <h2 id="quick-tools-title" className="text-xs font-bold uppercase tracking-[0.16em] text-white/35">Công cụ nhanh</h2>
            <div className="h-px flex-1 bg-white/[0.07]" />
          </div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            {QUICK_TOOLS.map(({ id, title, description, icon: Icon, color }) => (
              <button key={id} onClick={() => setQuickTool(id)} className="group flex items-center gap-3 rounded-xl border border-white/[0.08] bg-white/[0.025] p-3.5 text-left transition hover:-translate-y-0.5 hover:border-white/[0.16] hover:bg-white/[0.045]">
                <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${color}`}><Icon size={19} /></span>
                <span className="min-w-0"><span className="block text-sm font-bold text-white/85">{title}</span><span className="mt-1 block truncate text-[11px] text-white/35">{description}</span></span>
              </button>
            ))}
          </div>
        </section>

        <div className="mb-6 flex items-center justify-between gap-4">
          <h2 className="text-sm font-bold uppercase tracking-[0.14em] text-white/40">Dự án của bạn</h2>
          {projects.length > 0 && (
            <div className="field-surface flex w-full max-w-xs items-center gap-3 rounded-xl px-4 py-2.5">
              <Search size={16} className="text-white/35" />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Tìm theo tên hoặc chủ đề…" className="min-w-0 flex-1 bg-transparent text-sm outline-none" />
            </div>
          )}
        </div>

        {projects.length === 0 ? (
          <div className="workspace-panel flex min-h-40 flex-col items-center justify-center gap-2 rounded-2xl text-center text-text/45">
            <FolderOpen size={26} className="text-white/25" />
            <span className="text-sm">Chưa có dự án nào. Chọn một luồng phía trên để bắt đầu.</span>
          </div>
        ) : visible.length === 0 ? (
          <div className="workspace-panel flex min-h-40 flex-col items-center justify-center gap-2 rounded-2xl text-center text-text/45">
            <Search size={22} className="text-white/25" />
            <span className="text-sm">Không tìm thấy dự án khớp “{query}”.</span>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {visible.map((project) => (
              <article key={project.id} className="workspace-panel group rounded-2xl p-5 transition hover:-translate-y-0.5 hover:border-emerald-400/30">
                <button onClick={() => openProject(project.id)} className="w-full text-left">
                  <div className="relative mb-5 h-28 overflow-hidden rounded-xl bg-white/[0.03]">
                    <ProjectThumbnail project={project} />
                    <span className="absolute bottom-2 right-2 flex items-center gap-1 rounded-md bg-black/65 px-2 py-1 text-[10px] font-semibold text-white/75 backdrop-blur-sm"><HardDrive size={11} /> {formatProjectSize(project.sizeBytes)}</span>
                  </div>
                  <div className="mb-2 flex items-start justify-between gap-3">
                    <h2 className="line-clamp-2 font-bold text-white">{project.name}</h2>
                    <span className="shrink-0 rounded-full bg-white/5 px-2 py-1 text-[10px] text-white/45">{STEP_LABEL[project.currentStep]}</span>
                  </div>
                  <p className="text-xs font-medium text-emerald-300/80">{project.topicName}</p>
                  <p className="mt-3 text-xs text-white/35">{project.wordCount.toLocaleString('vi-VN')} từ · {project.sceneCount} cảnh · {new Date(project.updatedAt).toLocaleDateString('vi-VN')}</p>
                </button>
                <div className="mt-4 flex justify-end gap-1 border-t border-white/5 pt-3">
                  <button title="Mở thư mục dự án" onClick={() => window.gensuite.project.openDir(project.id)} className="rounded-lg p-2 text-white/35 hover:bg-emerald-400/10 hover:text-emerald-300"><FolderOpen size={15} /></button>
                  <button title="Nhân bản" onClick={() => duplicateProject(project.id)} className="rounded-lg p-2 text-white/35 hover:bg-white/5 hover:text-white"><Copy size={15} /></button>
                  <button title="Xóa" onClick={() => confirm(`Xóa dự án “${project.name}”?`) && deleteProject(project.id)} className="rounded-lg p-2 text-white/35 hover:bg-red-500/10 hover:text-red-300"><Trash2 size={15} /></button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      {creating && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-5 backdrop-blur-sm" onMouseDown={() => setCreating(false)}>
          <div className="workspace-panel w-full max-w-md rounded-2xl bg-[#181819] p-6" onMouseDown={(event) => event.stopPropagation()}>
            <h2 className="text-xl font-bold">Tạo dự án mới</h2>
            <p className="mt-2 text-sm text-white/45">Bạn có thể đổi tên bất cứ lúc nào.</p>
            <input autoFocus value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && submit()} placeholder="Ví dụ: Series chuyện nhân quả" className="field-surface mt-5 w-full rounded-xl px-4 py-3 text-sm outline-none" />
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setCreating(false)} className="rounded-lg px-4 py-2 text-sm text-white/55 hover:bg-white/5">Hủy</button>
              <button onClick={submit} className="primary-action rounded-lg px-4 py-2 text-sm font-bold">Tạo và tiếp tục</button>
            </div>
          </div>
        </div>
      )}
      {quickTool && <QuickToolWorkspace tool={quickTool} onClose={() => setQuickTool(null)} onOpenSettings={onOpenSettings} />}
    </main>
  );
}
