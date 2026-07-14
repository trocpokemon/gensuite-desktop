import { useState } from 'react';
import { Copy, Film, FolderOpen, Languages, Plus, Search, Sparkles, Trash2 } from 'lucide-react';
import { useProjectStore } from '../store/projectStore';

const STEP_LABEL: Record<string, string> = {
  topic: 'Chọn chủ đề', content: 'Viết nội dung', storyboard: 'Storyboard', voice: 'Giọng đọc', timeline: 'Xuất video', localize: 'Dịch & lồng tiếng',
};

export function ProjectHome() {
  const projects = useProjectStore((state) => state.projects);
  const createProject = useProjectStore((state) => state.createProject);
  const createLocalizeProject = useProjectStore((state) => state.createLocalizeProject);
  const openProject = useProjectStore((state) => state.openProject);
  const deleteProject = useProjectStore((state) => state.deleteProject);
  const duplicateProject = useProjectStore((state) => state.duplicateProject);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');

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
          <div className="mb-2 text-xs font-bold uppercase tracking-[0.18em] text-emerald-400">GenSuite Studio</div>
          <h1 className="text-4xl font-bold tracking-[-0.05em]">Bạn muốn làm gì hôm nay?</h1>
          <p className="mt-3 text-sm text-text/50">Chọn một trong hai luồng để bắt đầu, hoặc mở lại một dự án bên dưới.</p>
        </header>

        <div className="mb-10 grid grid-cols-1 gap-4 md:grid-cols-2">
          <button onClick={() => createLocalizeProject()} className="hero-tool group relative overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-sky-400/[0.12] via-indigo-400/[0.04] to-transparent p-6 text-left transition hover:-translate-y-0.5 hover:border-sky-400/40">
            <div className="mb-4 inline-flex rounded-xl bg-sky-400/15 p-3 text-sky-300"><Languages size={24} /></div>
            <h2 className="text-lg font-bold text-white">Dịch & lồng tiếng video</h2>
            <p className="mt-1.5 text-sm leading-5 text-white/50">Đưa video có sẵn vào, tự nhận dạng lời thoại, dịch và lồng lại giọng sang ngôn ngữ khác.</p>
            <span className="mt-4 inline-flex items-center gap-1.5 text-xs font-bold text-sky-300">
              <Film size={14} /> Chọn video cần dịch
            </span>
          </button>

          <button onClick={() => setCreating(true)} className="hero-tool group relative overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-emerald-400/[0.12] via-teal-400/[0.04] to-transparent p-6 text-left transition hover:-translate-y-0.5 hover:border-emerald-400/40">
            <div className="mb-4 inline-flex rounded-xl bg-emerald-400/15 p-3 text-emerald-300"><Sparkles size={24} /></div>
            <h2 className="text-lg font-bold text-white">Tạo dự án nội dung</h2>
            <p className="mt-1.5 text-sm leading-5 text-white/50">Từ chủ đề đến video hoàn chỉnh: viết kịch bản, storyboard, lồng giọng và xuất video.</p>
            <span className="mt-4 inline-flex items-center gap-1.5 text-xs font-bold text-emerald-300">
              <Plus size={14} /> Bắt đầu từ chủ đề
            </span>
          </button>
        </div>

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
                  <div className="mb-5 flex h-28 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-400/15 via-teal-400/5 to-transparent">
                    <FolderOpen size={30} className="text-emerald-300/80" />
                  </div>
                  <div className="mb-2 flex items-start justify-between gap-3">
                    <h2 className="line-clamp-2 font-bold text-white">{project.name}</h2>
                    <span className="shrink-0 rounded-full bg-white/5 px-2 py-1 text-[10px] text-white/45">{STEP_LABEL[project.currentStep]}</span>
                  </div>
                  <p className="text-xs font-medium text-emerald-300/80">{project.topicName}</p>
                  <p className="mt-3 text-xs text-white/35">{project.wordCount.toLocaleString('vi-VN')} từ · {project.sceneCount} cảnh · {new Date(project.updatedAt).toLocaleDateString('vi-VN')}</p>
                </button>
                <div className="mt-4 flex justify-end gap-1 border-t border-white/5 pt-3">
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
    </main>
  );
}
