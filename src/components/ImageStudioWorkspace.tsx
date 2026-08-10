import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle, ArrowLeft, ArrowUp, Bot, Brush, ChevronDown, Download, FolderPlus,
  Heart, Image as ImageIcon, Loader2, Paperclip, Plus, Settings2, Sparkles, Trash2,
  UserRound, Users, X,
} from 'lucide-react';
import { useEntitlementStore } from '../store/entitlementStore';
import { useProjectStore, uid } from '../store/projectStore';
import { errorMessage } from '../providers/errors';
import { imageJobFailure } from '../lib/imageStudioErrors';
import {
  createImageCharacter, createImageProject, deleteImageCharacter, deleteImageGeneration,
  deleteImageProject, getImageJob, listImageCharacters, listImageProjects, listProjectImages,
  submitImageJob, updateImageCharacter,
  type ImageAspectRatio, type ImageCharacter, type ImageGeneration, type ImageProject,
  type ImageStudioModel,
} from '../services/imageStudioService';

const MODELS: Array<{ id: ImageStudioModel; label: string; provider: string }> = [
  { id: 'google-ai-studio/gemini-3.1-flash-image-preview', label: 'Nano Banana 2', provider: 'Google' },
  { id: 'gpt-image-2', label: 'GPT Image 2', provider: 'OpenAI' },
];
const RATIOS_A: ImageAspectRatio[] = ['16:9', '4:3', '1:1', '3:4', '9:16'];
const RATIOS_B: ImageAspectRatio[] = ['3:2', '1:1', '2:3'];
const SUGGESTIONS = [
  { image: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?auto=format&fit=crop&w=500&q=80', text: 'Một thành phố tương lai nổi trên mây, ánh hoàng hôn điện ảnh, siêu chi tiết' },
  { image: 'https://images.unsplash.com/photo-1534447677768-be436bb09401?auto=format&fit=crop&w=500&q=80', text: 'Khu rừng phát sáng huyền bí với dòng suối pha lê, phong cách fantasy' },
  { image: 'https://images.unsplash.com/photo-1534796636912-3b95b3ab5986?auto=format&fit=crop&w=500&q=80', text: 'Phi hành gia đứng trước hành tinh khổng lồ, không gian sâu thẳm, chi tiết cao' },
];

type ReferenceImage = { dataUrl: string; name: string };
type Inflight = { prompt: string; count: number; progress: number };
type Toast = { message: string; tone: 'success' | 'error' } | null;

let projectsCache: ImageProject[] | null = null;
const imagesCache = new Map<string, ImageGeneration[]>();
const charactersCache = new Map<string, ImageCharacter[]>();
const inflightCache = new Map<string, Inflight>();
let activeProjectIdCache: string | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

const errorText = (error: unknown, fallback: string) => {
  const message = errorMessage(error);
  return message === 'Đã xảy ra lỗi khi xử lý. Vui lòng thử lại.' ? fallback : message;
};

const fileToReference = (file: File): Promise<ReferenceImage> => new Promise((resolve, reject) => {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 20 * 1024 * 1024) {
    reject(new Error('Chỉ hỗ trợ PNG, JPG hoặc WebP tối đa 20 MB.'));
    return;
  }
  const reader = new FileReader();
  reader.onerror = () => reject(new Error('Không thể đọc ảnh đã chọn.'));
  reader.onload = () => resolve({ dataUrl: String(reader.result || ''), name: file.name });
  reader.readAsDataURL(file);
});

const projectDraftKey = (projectId: string) => `gensuite:image-studio-draft:${projectId}`;
const readDraft = (projectId: string): string => {
  try { return localStorage.getItem(projectDraftKey(projectId)) || ''; } catch { return ''; }
};
const writeDraft = (projectId: string, prompt: string) => {
  try { prompt ? localStorage.setItem(projectDraftKey(projectId), prompt) : localStorage.removeItem(projectDraftKey(projectId)); } catch { /* Ignore storage restrictions. */ }
};

function StudioModal({ children, onClose, wide = false }: { children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  return createPortal(
    <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/75 p-5 backdrop-blur-sm" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className={`max-h-[90vh] w-full overflow-y-auto rounded-3xl border border-white/10 bg-[#17181b] shadow-2xl ${wide ? 'max-w-3xl' : 'max-w-md'}`}>{children}</div>
    </div>,
    document.body,
  );
}

async function runGeneration(
  projectId: string,
  params: { prompt: string; modelId: ImageStudioModel; aspectRatio: ImageAspectRatio; imageCount: number; characterIds?: string[]; referenceImageDataUrls?: string[]; sourceGenerationId?: string; sourceImageIndex?: number },
  onResult?: (result: ImageGeneration) => void,
) {
  if (inflightCache.has(projectId) && !params.sourceGenerationId) return;
  if (!params.sourceGenerationId) { inflightCache.set(projectId, { prompt: params.prompt, count: params.imageCount, progress: 4 }); notify(); }
  try {
    const submitted = await submitImageJob({ projectId, ...params });
    let job = await getImageJob(submitted.jobId);
    const deadline = Date.now() + 20 * 60 * 1000;
    while (!['done', 'failed', 'cancelled'].includes(job.status) && Date.now() < deadline) {
      const active = inflightCache.get(projectId);
      if (active) { active.progress = Math.max(active.progress, job.progress || 0); notify(); }
      await new Promise((resolve) => window.setTimeout(resolve, 2000));
      try { job = await getImageJob(submitted.jobId); } catch { /* Retry transient polling errors. */ }
    }
    const failure = imageJobFailure(job, !['done', 'failed', 'cancelled'].includes(job.status));
    if (failure) throw failure;
    const result = job.generation!;
    imagesCache.set(projectId, [result, ...(imagesCache.get(projectId) || [])]);
    projectsCache = (projectsCache || []).map((project) => project.id === projectId
      ? { ...project, imageCount: project.imageCount + result.imageCount, coverUrl: project.coverUrl || result.imageUrls[0] || null }
      : project);
    onResult?.(result);
    return result;
  } finally {
    if (!params.sourceGenerationId) inflightCache.delete(projectId);
    notify();
  }
}

export function ImageStudioWorkspace() {
  const localProject = useProjectStore((state) => state.project);
  const credits = useEntitlementStore((state) => state.credits);
  const refreshCredits = useEntitlementStore((state) => state.load);
  const [, render] = useState(0);
  const [activeProjectId, setActiveProjectId] = useState(activeProjectIdCache);
  const [loadingProjects, setLoadingProjects] = useState(projectsCache === null);
  const [loadingImages, setLoadingImages] = useState(false);
  const [projectModal, setProjectModal] = useState(false);
  const [projectName, setProjectName] = useState('');
  const [busyProject, setBusyProject] = useState(false);
  const [deleteProjectTarget, setDeleteProjectTarget] = useState<ImageProject | null>(null);
  const [prompt, setPrompt] = useState(() => activeProjectIdCache ? readDraft(activeProjectIdCache) : '');
  const [modelId, setModelId] = useState<ImageStudioModel>(MODELS[0].id);
  const [ratio, setRatio] = useState<ImageAspectRatio>('1:1');
  const [count, setCount] = useState(1);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editSettingsOpen, setEditSettingsOpen] = useState(false);
  const [references, setReferences] = useState<ReferenceImage[]>([]);
  const [dragging, setDragging] = useState(false);
  const [selectedCharacters, setSelectedCharacters] = useState<ImageCharacter[]>([]);
  const [charactersOpen, setCharactersOpen] = useState(false);
  const [characterEditor, setCharacterEditor] = useState<ImageCharacter | 'new' | null>(null);
  const [characterName, setCharacterName] = useState('');
  const [characterDescription, setCharacterDescription] = useState('');
  const [characterImage, setCharacterImage] = useState<ReferenceImage | null>(null);
  const [characterSource, setCharacterSource] = useState<{ generationId: string; imageIndex: number; url: string } | null>(null);
  const [savingCharacter, setSavingCharacter] = useState(false);
  const [selected, setSelected] = useState<ImageGeneration | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(() => { try { return new Set(JSON.parse(localStorage.getItem('gensuite:image-favorites') || '[]')); } catch { return new Set(); } });
  const [deleteImageTarget, setDeleteImageTarget] = useState<ImageGeneration | null>(null);
  const [editPrompt, setEditPrompt] = useState('');
  const [editReferences, setEditReferences] = useState<ReferenceImage[]>([]);
  const [editing, setEditing] = useState(false);
  const [editProgress, setEditProgress] = useState(0);
  const [toast, setToast] = useState<Toast>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const editImageInput = useRef<HTMLInputElement>(null);

  const projects = projectsCache || [];
  const activeProject = projects.find((project) => project.id === activeProjectId) || null;
  const history = activeProject ? imagesCache.get(activeProject.id) || [] : [];
  const characters = activeProject ? charactersCache.get(activeProject.id) || [] : [];
  const inflight = activeProject ? inflightCache.get(activeProject.id) || null : null;
  const availableRatios = modelId === 'gpt-image-2' ? RATIOS_B : RATIOS_A;

  const flash = (message: string, tone: NonNullable<Toast>['tone']) => {
    setToast({ message, tone });
    window.setTimeout(() => setToast(null), 4200);
  };

  useEffect(() => { const listener = () => render((value) => value + 1); listeners.add(listener); return () => { listeners.delete(listener); }; }, []);
  useEffect(() => {
    setLoadingProjects(projectsCache === null);
    listImageProjects().then((items) => { projectsCache = items; notify(); }).catch((error) => flash(errorText(error, 'Không thể tải dự án ảnh.'), 'error')).finally(() => setLoadingProjects(false));
  }, []);
  useEffect(() => { if (activeProject) writeDraft(activeProject.id, prompt); }, [activeProject?.id, prompt]);
  useEffect(() => { if (!selected) return; const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setSelected(null); }; document.addEventListener('keydown', close); return () => document.removeEventListener('keydown', close); }, [selected]);

  const selectModel = (next: ImageStudioModel) => {
    setModelId(next);
    const supported = next === 'gpt-image-2' ? RATIOS_B : RATIOS_A;
    if (!supported.includes(ratio)) setRatio(ratio === '1:1' ? '1:1' : ratio.includes('9') || ratio.startsWith('2:') || ratio.startsWith('3:4') ? supported[supported.length - 1] : supported[0]);
  };

  const openProject = async (project: ImageProject) => {
    activeProjectIdCache = project.id;
    setActiveProjectId(project.id);
    setPrompt(readDraft(project.id));
    setSelectedCharacters([]);
    setLoadingImages(!imagesCache.has(project.id));
    try {
      const [items, projectCharacters] = await Promise.all([listProjectImages(project.id), listImageCharacters(project.id)]);
      imagesCache.set(project.id, items);
      charactersCache.set(project.id, projectCharacters);
      notify();
    } catch (error) { flash(errorText(error, 'Không thể tải dữ liệu dự án ảnh.'), 'error'); }
    finally { setLoadingImages(false); }
  };

  const createProject = async () => {
    const name = projectName.trim();
    if (!name || busyProject) return;
    setBusyProject(true);
    try {
      const created = await createImageProject(name);
      projectsCache = [created, ...(projectsCache || [])];
      setProjectName(''); setProjectModal(false); notify();
      await openProject(created);
    } catch (error) { flash(errorText(error, 'Không thể tạo dự án ảnh.'), 'error'); }
    finally { setBusyProject(false); }
  };

  const removeProject = async () => {
    if (!deleteProjectTarget || busyProject) return;
    setBusyProject(true);
    try {
      await deleteImageProject(deleteProjectTarget.id);
      projectsCache = projects.filter((project) => project.id !== deleteProjectTarget.id);
      imagesCache.delete(deleteProjectTarget.id); charactersCache.delete(deleteProjectTarget.id);
      if (activeProjectId === deleteProjectTarget.id) { activeProjectIdCache = null; setActiveProjectId(null); }
      setDeleteProjectTarget(null); notify(); flash('Đã xóa dự án ảnh.', 'success');
    } catch (error) { flash(errorText(error, 'Không thể xóa dự án ảnh.'), 'error'); }
    finally { setBusyProject(false); }
  };

  const addReferences = async (files: File[] | FileList | null, edit = false) => {
    const current = edit ? editReferences : references;
    try {
      const additions = await Promise.all(Array.from(files || []).slice(0, Math.max(0, 4 - current.length)).map(fileToReference));
      edit ? setEditReferences([...current, ...additions]) : setReferences([...current, ...additions]);
    } catch (error) { flash(errorText(error, 'Không thể thêm ảnh tham chiếu.'), 'error'); }
  };

  const generate = async () => {
    if (!activeProject || inflight || (!prompt.trim() && !selectedCharacters.length)) return;
    const composedPrompt = `${selectedCharacters.map((character) => `@[${character.name}]`).join(' ')} ${prompt.trim()}`.trim();
    setPrompt(''); setReferences([]); setSelectedCharacters([]); writeDraft(activeProject.id, '');
    try {
      const result = await runGeneration(activeProject.id, { prompt: composedPrompt, modelId, aspectRatio: ratio, imageCount: count, characterIds: selectedCharacters.map((item) => item.id), referenceImageDataUrls: references.map((item) => item.dataUrl) });
      if (result) flash(`Đã tạo ${result.imageCount} ảnh.`, 'success');
      void refreshCredits();
    } catch (error) { flash(errorText(error, 'Không thể tạo ảnh.'), 'error'); }
  };

  const saveImage = async (item: ImageGeneration, index: number) => {
    const url = item.imageUrls[index];
    if (!url) return;
    try {
      const sourcePath = await window.gensuite.media.download({ projectId: localProject.id, sceneId: uid('image_studio_'), url, ext: 'png' });
      const saved = await window.gensuite.files.saveCopy({ sourcePath, defaultName: `gensuite-${item.id}-${index + 1}.png` });
      if (saved) flash('Đã lưu ảnh về máy.', 'success');
    } catch { flash('Không thể lưu ảnh này. Vui lòng thử lại.', 'error'); }
  };

  const removeImage = async () => {
    if (!deleteImageTarget || !activeProject) return;
    try {
      const root = lineageRoot(deleteImageTarget, history);
      const ids = new Set(history.filter((item) => lineageRoot(item, history).id === root.id).map((item) => item.id));
      await deleteImageGeneration(root.id, true);
      imagesCache.set(activeProject.id, history.filter((item) => !ids.has(item.id)));
      projectsCache = projects.map((project) => project.id === activeProject.id ? { ...project, imageCount: Math.max(0, project.imageCount - ids.size) } : project);
      if (selected && ids.has(selected.id)) setSelected(null);
      setDeleteImageTarget(null); notify(); flash('Đã xóa ảnh và các phiên bản liên quan.', 'success');
    } catch (error) { flash(errorText(error, 'Không thể xóa ảnh.'), 'error'); }
  };

  const openCharacterEditor = (character: ImageCharacter | 'new') => {
    setCharacterEditor(character); setCharacterName(character === 'new' ? '' : character.name); setCharacterDescription(character === 'new' ? '' : character.description); setCharacterImage(null); setCharacterSource(null);
  };
  const saveCharacter = async () => {
    if (!activeProject || !characterEditor || !characterName.trim() || savingCharacter) return;
    setSavingCharacter(true);
    try {
      const saved = characterEditor === 'new'
        ? await createImageCharacter({ projectId: activeProject.id, name: characterName.trim(), description: characterDescription.trim(), imageDataUrl: characterImage?.dataUrl, generationId: characterSource?.generationId, imageIndex: characterSource?.imageIndex })
        : await updateImageCharacter({ id: characterEditor.id, name: characterName.trim(), description: characterDescription.trim(), imageDataUrl: characterImage?.dataUrl });
      charactersCache.set(activeProject.id, characterEditor === 'new' ? [saved, ...characters] : characters.map((item) => item.id === saved.id ? saved : item));
      setCharacterEditor(null); notify(); flash('Đã lưu nhân vật.', 'success');
    } catch (error) { flash(errorText(error, 'Không thể lưu nhân vật.'), 'error'); }
    finally { setSavingCharacter(false); }
  };

  const removeCharacter = async (character: ImageCharacter) => {
    if (!activeProject) return;
    try {
      await deleteImageCharacter(character.id);
      charactersCache.set(activeProject.id, characters.filter((item) => item.id !== character.id));
      setSelectedCharacters((items) => items.filter((item) => item.id !== character.id));
      setCharacterEditor(null); notify(); flash('Đã xóa nhân vật.', 'success');
    } catch (error) { flash(errorText(error, 'Không thể xóa nhân vật.'), 'error'); }
  };

  const editSelected = async () => {
    if (!activeProject || !selected || !editPrompt.trim() || editing) return;
    setEditing(true); setEditProgress(5);
    try {
      const result = await runGeneration(activeProject.id, { prompt: editPrompt.trim(), modelId, aspectRatio: ratio, imageCount: 1, sourceGenerationId: selected.id, sourceImageIndex: selectedIndex, referenceImageDataUrls: editReferences.map((item) => item.dataUrl) }, (item) => { setSelected(item); setSelectedIndex(0); });
      if (result) { setEditPrompt(''); setEditReferences([]); flash('Đã tạo phiên bản chỉnh sửa.', 'success'); }
      void refreshCredits();
    } catch (error) { flash(errorText(error, 'Không thể chỉnh sửa ảnh.'), 'error'); }
    finally { setEditing(false); setEditProgress(0); }
  };

  const tiles = useMemo(() => history.filter((item) => !item.parentGenerationId).flatMap((item) => item.imageUrls.map((url, imageIndex) => ({ item, url, imageIndex }))), [history]);
  const versions = selected ? history.filter((item) => lineageRoot(item, history).id === lineageRoot(selected, history).id).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)) : [];

  if (!activeProject) return <div className="min-h-0 flex-1 overflow-y-auto bg-[#101112] px-8 py-9">
    <div className="mx-auto max-w-6xl">
      <div className="mb-7 flex items-end justify-between gap-4"><div><div className="text-xs font-bold uppercase tracking-[0.18em] text-fuchsia-300">Sáng tạo hình ảnh</div><h1 className="mt-2 text-3xl font-bold tracking-tight">Dự án hình ảnh</h1><p className="mt-2 text-sm text-white/40">Tổ chức ý tưởng, nhân vật và mọi phiên bản ảnh theo từng dự án.</p></div><button onClick={() => setProjectModal(true)} className="primary-action flex items-center gap-2 rounded-xl px-4 py-3 text-sm font-bold"><FolderPlus size={17} />Dự án mới</button></div>
      {loadingProjects && !projects.length ? <Loading label="Đang tải dự án ảnh…" /> : !projects.length ? <EmptyProjects onCreate={() => setProjectModal(true)} /> : <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">{projects.map((project) => <button key={project.id} onClick={() => void openProject(project)} className="group overflow-hidden rounded-2xl border border-white/10 bg-[#18191b] text-left transition hover:-translate-y-1 hover:border-fuchsia-300/35 hover:shadow-2xl"><div className="relative aspect-square bg-white/[0.03]">{project.coverUrl ? <img src={project.coverUrl} alt="" className="h-full w-full object-cover" /> : <div className="grid h-full place-items-center text-white/20"><ImageIcon size={38} /></div>}{inflightCache.has(project.id) && <span className="absolute left-3 top-3 flex items-center gap-1.5 rounded-full bg-black/75 px-2.5 py-1 text-[10px] font-bold"><Loader2 size={12} className="animate-spin" />Đang tạo</span>}<span onClick={(event) => { event.stopPropagation(); setDeleteProjectTarget(project); }} className="absolute right-2 top-2 rounded-lg bg-black/55 p-2 text-white/70 opacity-0 transition group-hover:opacity-100"><Trash2 size={15} /></span></div><div className="p-4"><h2 className="truncate text-sm font-bold">{project.name}</h2><p className="mt-1 text-xs text-white/35">{project.imageCount} ảnh</p></div></button>)}</div>}
    </div>
    {projectModal && <StudioModal onClose={() => setProjectModal(false)}><div className="p-6"><h2 className="flex items-center gap-2 font-bold"><FolderPlus size={18} />Dự án mới</h2><input autoFocus value={projectName} onChange={(event) => setProjectName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void createProject(); }} maxLength={120} placeholder="Tên dự án" className="field-surface mt-5 w-full rounded-xl px-4 py-3 text-sm outline-none" /><div className="mt-5 grid grid-cols-2 gap-3"><button onClick={() => setProjectModal(false)} className="rounded-xl bg-white/7 py-3 text-sm font-bold">Hủy</button><button disabled={!projectName.trim() || busyProject} onClick={() => void createProject()} className="primary-action flex items-center justify-center gap-2 rounded-xl py-3 text-sm font-bold disabled:opacity-40">{busyProject && <Loader2 size={15} className="animate-spin" />}Tạo</button></div></div></StudioModal>}
    {deleteProjectTarget && <Confirm title="Xóa dự án này?" description={`Toàn bộ ${deleteProjectTarget.imageCount} ảnh bên trong sẽ bị xóa vĩnh viễn.`} busy={busyProject} onCancel={() => setDeleteProjectTarget(null)} onConfirm={() => void removeProject()} />}
    <ToastView toast={toast} />
  </div>;

  return <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-[#101112]">
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-white/[0.06] px-6"><button onClick={() => { activeProjectIdCache = null; setActiveProjectId(null); setSelected(null); }} className="flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-bold text-white/65 hover:bg-white/5 hover:text-white"><ArrowLeft size={17} />Dự án</button><span className="text-white/20">/</span><span className="truncate text-sm font-bold">{activeProject.name}</span><span className="ml-auto text-xs font-bold text-emerald-300">{credits.toLocaleString('vi-VN')} credits</span></header>
    <main className="min-h-0 flex-1 overflow-y-auto px-6 pb-44 pt-7">
      {loadingImages && !tiles.length && !inflight ? <Loading label="Đang tải hình ảnh…" /> : tiles.length || inflight ? <div className="mx-auto grid max-w-6xl grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">{inflight && Array.from({ length: inflight.count }, (_, index) => <div key={index} className="relative h-64 overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-white/[0.03] via-white/[0.09] to-white/[0.03]"><div className="absolute inset-0 animate-pulse" /><ImageIcon className="absolute left-4 top-4 text-white/25" size={20} /><span className="absolute right-4 top-4 text-xs font-bold text-white/45">{inflight.progress}%</span><p className="absolute inset-x-0 bottom-0 line-clamp-2 bg-gradient-to-t from-black/90 to-transparent px-4 pb-4 pt-14 text-xs font-semibold">{inflight.prompt}</p></div>)}{tiles.map(({ item, url, imageIndex }) => <button key={`${item.id}-${imageIndex}`} onClick={() => { setSelected(item); setSelectedIndex(imageIndex); setModelId(item.modelId); setRatio(item.aspectRatio); }} className="group relative h-64 overflow-hidden rounded-2xl border border-white/10 bg-[#18191b] text-left"><img src={url} alt={item.prompt} className="h-full w-full object-cover transition duration-500 group-hover:scale-[1.025]" /><span onClick={(event) => { event.stopPropagation(); setDeleteImageTarget(item); }} className="absolute right-2 top-2 rounded-lg bg-black/55 p-2 opacity-0 transition group-hover:opacity-100"><Trash2 size={15} /></span><div className="absolute inset-x-0 bottom-0 translate-y-3 bg-gradient-to-t from-black/95 via-black/65 to-transparent px-4 pb-4 pt-16 opacity-0 transition group-hover:translate-y-0 group-hover:opacity-100"><p className="line-clamp-2 text-xs font-bold leading-5">{item.prompt}</p><div className="mt-2 flex justify-between text-[10px] text-white/50"><span>{MODELS.find((model) => model.id === item.modelId)?.label}</span><span>{item.creditsCharged.toLocaleString('vi-VN')} credits</span></div></div></button>)}</div> : <div className="flex min-h-full flex-col items-center justify-center pb-10 text-center"><div className="relative grid size-16 place-items-center rounded-2xl bg-white text-black"><Bot size={30} /><Brush className="absolute -bottom-1 -right-1 rounded-full bg-black p-1 text-white" size={23} /></div><h2 className="mt-5 max-w-2xl text-2xl font-bold">Bắt đầu bằng câu lệnh mẫu hoặc nhập ý tưởng của bạn bên dưới</h2><div className="mt-8 grid w-full max-w-4xl gap-4 sm:grid-cols-3">{SUGGESTIONS.map((suggestion) => <button key={suggestion.text} onClick={() => setPrompt(suggestion.text)} className="overflow-hidden rounded-2xl border border-white/10 bg-[#18191b] text-left transition hover:-translate-y-1 hover:border-fuchsia-300/30"><img src={suggestion.image} alt="" className="h-32 w-full object-cover" /><p className="line-clamp-3 p-3 text-xs font-semibold leading-5">{suggestion.text}</p></button>)}</div></div>}
    </main>
    <div className="absolute inset-x-0 bottom-0 z-20 px-5 pb-6"><div className={`relative mx-auto max-w-3xl rounded-3xl border bg-[#191a1d]/95 p-3 shadow-2xl backdrop-blur-xl ${dragging ? 'border-dashed border-fuchsia-300' : 'border-white/10'}`} onDragEnter={(event) => { event.preventDefault(); setDragging(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }} onDrop={(event) => { event.preventDefault(); setDragging(false); void addReferences(Array.from(event.dataTransfer.files)); }}>
      {dragging && <div className="pointer-events-none absolute inset-0 z-30 grid place-items-center rounded-3xl bg-black/90"><div className="text-center"><Paperclip className="mx-auto" /><b className="mt-2 block text-sm">Thả ảnh tham chiếu tại đây</b><span className="text-[10px] text-white/45">PNG · JPG · WebP · tối đa 4 ảnh</span></div></div>}
      {references.length > 0 && <div className="flex gap-2 overflow-x-auto px-2 pb-2">{references.map((image, index) => <div key={`${image.name}-${index}`} className="relative shrink-0"><img src={image.dataUrl} alt={image.name} className="size-16 rounded-xl object-cover" /><button onClick={() => setReferences((items) => items.filter((_, itemIndex) => itemIndex !== index))} className="absolute -right-1 -top-1 rounded-full bg-black p-1"><X size={12} /></button></div>)}</div>}
      {selectedCharacters.length > 0 && <div className="flex flex-wrap gap-2 px-2 pb-2">{selectedCharacters.map((character) => <span key={character.id} className="flex items-center gap-2 rounded-full bg-fuchsia-300/10 py-1 pl-1 pr-2 text-xs text-fuchsia-200"><img src={character.referenceUrl} alt="" className="size-6 rounded-full object-cover" />@{character.name}<button onClick={() => setSelectedCharacters((items) => items.filter((item) => item.id !== character.id))}><X size={12} /></button></span>)}</div>}
      <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void generate(); } }} rows={2} maxLength={4000} disabled={Boolean(inflight)} placeholder="Mô tả hình ảnh bạn muốn tạo…" className="w-full resize-none bg-transparent px-3 py-2 text-sm leading-6 outline-none placeholder:text-white/25 disabled:opacity-50" />
      <div className="flex items-center justify-between gap-2"><div className="flex items-center gap-2"><input ref={imageInput} type="file" multiple accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(event) => { void addReferences(event.target.files); event.currentTarget.value = ''; }} /><button disabled={references.length >= 4 || Boolean(inflight)} onClick={() => imageInput.current?.click()} className="grid size-10 place-items-center rounded-xl bg-white/[0.06] text-white/65 hover:bg-white/10 disabled:opacity-30" title="Thêm ảnh tham chiếu"><Paperclip size={17} /></button><button onClick={() => setCharactersOpen(true)} className="flex h-10 items-center gap-2 rounded-xl bg-white/[0.06] px-3 text-xs font-bold text-white/65 hover:bg-white/10"><Users size={16} />Nhân vật</button><div className="relative"><button onClick={() => setSettingsOpen((value) => !value)} className="flex h-10 items-center gap-2 rounded-xl bg-white/[0.06] px-3 text-xs font-bold text-white/65 hover:bg-white/10"><Settings2 size={16} />{ratio} · {count} ảnh<ChevronDown size={13} /></button>{settingsOpen && <SettingsPopover modelId={modelId} ratio={ratio} count={count} ratios={availableRatios} onModel={selectModel} onRatio={setRatio} onCount={setCount} onClose={() => setSettingsOpen(false)} />}</div></div><button disabled={Boolean(inflight) || (!prompt.trim() && !selectedCharacters.length)} onClick={() => void generate()} className="grid size-10 place-items-center rounded-full bg-emerald-300 text-black disabled:opacity-30">{inflight ? <Loader2 size={17} className="animate-spin" /> : <ArrowUp size={18} />}</button></div>
    </div></div>
    {charactersOpen && <CharactersModal characters={characters} tiles={tiles} selected={selectedCharacters} onToggle={(character) => setSelectedCharacters((items) => items.some((item) => item.id === character.id) ? items.filter((item) => item.id !== character.id) : [...items, character])} onEdit={openCharacterEditor} onClose={() => setCharactersOpen(false)} />}
    {characterEditor && <StudioModal wide onClose={() => setCharacterEditor(null)}><div className="p-6"><div className="mb-5 flex items-center justify-between"><h2 className="font-bold">{characterEditor === 'new' ? 'Nhân vật mới' : 'Cài đặt nhân vật'}</h2><button onClick={() => setCharacterEditor(null)}><X size={19} /></button></div><div className="grid gap-5 sm:grid-cols-[220px_1fr]"><div><div className="aspect-square overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03]">{characterImage?.dataUrl || characterSource?.url || (characterEditor !== 'new' && characterEditor.referenceUrl) ? <img src={characterImage?.dataUrl || characterSource?.url || (characterEditor !== 'new' ? characterEditor.referenceUrl : '')} alt="" className="h-full w-full object-cover" /> : <div className="grid h-full place-items-center text-white/25"><UserRound size={38} /></div>}</div><label className="mt-2 flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-white/10 py-2.5 text-xs font-bold"><Download size={15} className="rotate-180" />Tải ảnh lên<input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={async (event) => { try { const file = event.target.files?.[0]; if (file) { setCharacterImage(await fileToReference(file)); setCharacterSource(null); } } catch (error) { flash(errorText(error, 'Không thể đọc ảnh.'), 'error'); } }} /></label></div><div className="space-y-4"><label className="block text-xs font-bold">Tên nhân vật<input autoFocus maxLength={60} value={characterName} onChange={(event) => setCharacterName(event.target.value)} className="field-surface mt-2 w-full rounded-xl px-3 py-3 text-sm outline-none" placeholder="Ví dụ: Linh" /></label><label className="block text-xs font-bold">Thông tin nhân vật<textarea maxLength={2000} rows={6} value={characterDescription} onChange={(event) => setCharacterDescription(event.target.value)} className="field-surface mt-2 w-full resize-none rounded-xl px-3 py-3 text-sm outline-none" placeholder="Ngoại hình, tóc, trang phục, độ tuổi và nét đặc trưng…" /></label></div></div>{characterEditor === 'new' && tiles.length > 0 && <div className="mt-5"><p className="mb-2 text-xs font-bold text-white/40">Hoặc lấy từ ảnh đã tạo trong dự án</p><div className="flex gap-2 overflow-x-auto">{tiles.slice(0, 12).map(({ item, url, imageIndex }) => <button key={`${item.id}-${imageIndex}`} onClick={() => { setCharacterSource({ generationId: item.id, imageIndex, url }); setCharacterImage(null); }} className={`size-20 shrink-0 overflow-hidden rounded-xl border-2 ${characterSource?.generationId === item.id && characterSource.imageIndex === imageIndex ? 'border-fuchsia-300' : 'border-transparent'}`}><img src={url} alt="" className="h-full w-full object-cover" /></button>)}</div></div>}<div className="mt-6 flex justify-between"><div>{characterEditor !== 'new' && <button onClick={() => void removeCharacter(characterEditor)} className="rounded-xl bg-red-500/15 px-4 py-2.5 text-xs font-bold text-red-300"><Trash2 size={14} className="mr-1 inline" />Xóa</button>}</div><div className="flex gap-2"><button onClick={() => setCharacterEditor(null)} className="rounded-xl bg-white/7 px-4 py-2.5 text-xs font-bold">Hủy</button><button disabled={savingCharacter || !characterName.trim() || (characterEditor === 'new' && !characterImage && !characterSource)} onClick={() => void saveCharacter()} className="primary-action flex items-center gap-2 rounded-xl px-4 py-2.5 text-xs font-bold disabled:opacity-40">{savingCharacter && <Loader2 size={14} className="animate-spin" />}Lưu nhân vật</button></div></div></div></StudioModal>}
    {deleteImageTarget && <Confirm title="Xóa ảnh này và toàn bộ phiên bản?" description="Các phiên bản chỉnh sửa liên quan cũng sẽ bị xóa vĩnh viễn." onCancel={() => setDeleteImageTarget(null)} onConfirm={() => void removeImage()} />}
    {selected && selected.imageUrls[selectedIndex] && <div className="fixed inset-0 z-[1000] flex flex-col bg-black" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelected(null); }}><header className="flex h-16 shrink-0 items-center border-b border-white/10 px-5"><button onClick={() => setSelected(null)} className="flex min-w-0 items-center gap-2 rounded-xl px-3 py-2 text-sm font-bold hover:bg-white/10"><ArrowLeft size={19} /><span className="max-w-80 truncate">{selected.prompt}</span></button><div className="ml-auto flex gap-1"><button onClick={() => { const next = new Set(favoriteIds); next.has(selected.id) ? next.delete(selected.id) : next.add(selected.id); setFavoriteIds(next); try { localStorage.setItem('gensuite:image-favorites', JSON.stringify([...next])); } catch {} }} className="rounded-xl p-2.5 hover:bg-white/10"><Heart size={19} className={favoriteIds.has(selected.id) ? 'fill-current text-fuchsia-300' : ''} /></button><button onClick={() => void saveImage(selected, selectedIndex)} className="rounded-xl p-2.5 hover:bg-white/10"><Download size={19} /></button><button onClick={() => setDeleteImageTarget(selected)} className="rounded-xl p-2.5 text-red-300 hover:bg-red-500/10"><Trash2 size={19} /></button></div></header><div className="relative flex min-h-0 flex-1 gap-5 p-5"><div className="flex min-w-0 flex-1 items-center justify-center pb-36"><img src={selected.imageUrls[selectedIndex]} alt={selected.prompt} className="max-h-full max-w-full rounded-2xl object-contain" /></div><aside className="hidden w-72 shrink-0 overflow-y-auto rounded-2xl border border-white/10 bg-[#17181b] p-3 lg:block"><div className="space-y-2">{versions.flatMap((version, versionIndex) => version.imageUrls.map((url, imageIndex) => <button key={`${version.id}-${imageIndex}`} onClick={() => { setSelected(version); setSelectedIndex(imageIndex); }} className={`flex w-full gap-3 rounded-xl border p-2 text-left ${selected.id === version.id && selectedIndex === imageIndex ? 'border-fuchsia-300/50 bg-fuchsia-300/10' : 'border-transparent hover:bg-white/5'}`}><img src={url} alt="" className="size-20 shrink-0 rounded-lg object-cover" /><span><b className="text-xs">{versionIndex === 0 ? 'Ảnh gốc' : `Phiên bản ${versionIndex}`}</b><small className="mt-1 line-clamp-3 block text-[10px] leading-4 text-white/40">{version.prompt}</small></span></button>))}</div></aside><div className="absolute bottom-5 left-5 right-5 lg:right-[308px]"><div className="mx-auto max-w-2xl rounded-3xl border border-white/10 bg-[#191a1d]/95 p-3 shadow-2xl backdrop-blur-xl">{editReferences.length > 0 && <div className="flex gap-2 overflow-x-auto pb-2">{editReferences.map((image, index) => <div key={`${image.name}-${index}`} className="relative"><img src={image.dataUrl} alt="" className="size-16 rounded-xl object-cover" /><button onClick={() => setEditReferences((items) => items.filter((_, itemIndex) => itemIndex !== index))} className="absolute -right-1 -top-1 rounded-full bg-black p-1"><X size={12} /></button></div>)}</div>}{editing && <p className="mb-2 flex items-center gap-2 text-xs text-white/45"><Loader2 size={14} className="animate-spin" />Đang tạo phiên bản mới{editProgress ? ` · ${editProgress}%` : ''}</p>}<textarea value={editPrompt} onChange={(event) => setEditPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void editSelected(); } }} rows={2} placeholder="Bạn muốn thay đổi điều gì?" className="w-full resize-none bg-transparent px-2 py-1 text-sm outline-none placeholder:text-white/25" /><div className="mt-2 flex justify-between"><div className="flex gap-2"><input ref={editImageInput} type="file" multiple accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(event) => { void addReferences(event.target.files, true); event.currentTarget.value = ''; }} /><button disabled={editReferences.length >= 4} onClick={() => editImageInput.current?.click()} className="grid size-10 place-items-center rounded-xl bg-white/7"><Plus size={17} /></button><div className="relative"><button onClick={() => setEditSettingsOpen((value) => !value)} className="flex h-10 items-center gap-2 rounded-xl bg-white/7 px-3 text-xs font-bold"><Settings2 size={15} />{ratio}</button>{editSettingsOpen && <SettingsPopover modelId={modelId} ratio={ratio} count={1} ratios={availableRatios} onModel={selectModel} onRatio={setRatio} onCount={() => undefined} onClose={() => setEditSettingsOpen(false)} hideCount />}</div></div><button disabled={!editPrompt.trim() || editing} onClick={() => void editSelected()} className="grid size-10 place-items-center rounded-full bg-white text-black disabled:opacity-30">{editing ? <Loader2 size={16} className="animate-spin" /> : <ArrowUp size={17} />}</button></div></div></div></div></div>}
    <ToastView toast={toast} />
  </div>;
}

function lineageRoot(item: ImageGeneration, history: ImageGeneration[]): ImageGeneration {
  let current = item;
  const visited = new Set<string>();
  while (current.parentGenerationId && !visited.has(current.id)) {
    visited.add(current.id);
    const parent = history.find((candidate) => candidate.id === current.parentGenerationId);
    if (!parent) break;
    current = parent;
  }
  return current;
}

function Loading({ label }: { label: string }) { return <div className="flex min-h-96 flex-col items-center justify-center gap-3 text-sm text-white/35"><Loader2 size={25} className="animate-spin text-fuchsia-300" />{label}</div>; }
function EmptyProjects({ onCreate }: { onCreate: () => void }) { return <div className="flex min-h-96 flex-col items-center justify-center text-center"><div className="relative grid size-16 place-items-center rounded-2xl bg-white text-black"><Bot size={30} /><Brush className="absolute -bottom-1 -right-1 rounded-full bg-black p-1 text-white" size={23} /></div><h2 className="mt-5 text-xl font-bold">Chưa có dự án hình ảnh</h2><p className="mt-2 max-w-sm text-sm text-white/40">Tạo dự án đầu tiên để sáng tạo và quản lý hình ảnh gọn gàng.</p><button onClick={onCreate} className="primary-action mt-6 flex items-center gap-2 rounded-xl px-4 py-3 text-sm font-bold"><Plus size={16} />Tạo dự án</button></div>; }

function SettingsPopover({ modelId, ratio, count, ratios, onModel, onRatio, onCount, onClose, hideCount = false }: { modelId: ImageStudioModel; ratio: ImageAspectRatio; count: number; ratios: ImageAspectRatio[]; onModel: (value: ImageStudioModel) => void; onRatio: (value: ImageAspectRatio) => void; onCount: (value: number) => void; onClose: () => void; hideCount?: boolean }) {
  return <div className="absolute bottom-full left-0 z-50 mb-3 w-80 rounded-2xl border border-white/10 bg-[#1d1e21] p-4 shadow-2xl"><div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-white/35">Mô hình tạo ảnh</div><div className="space-y-1">{MODELS.map((model) => <button key={model.id} onClick={() => onModel(model.id)} className={`flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-xs ${modelId === model.id ? 'bg-white text-black' : 'hover:bg-white/5'}`}><span><b>{model.label}</b><small className="ml-2 opacity-55">{model.provider}</small></span>{modelId === model.id && <Sparkles size={14} />}</button>)}</div><div className="mb-2 mt-4 text-[10px] font-bold uppercase tracking-wider text-white/35">Tỷ lệ</div><div className={`grid gap-1 ${ratios.length === 3 ? 'grid-cols-3' : 'grid-cols-5'}`}>{ratios.map((value) => <button key={value} onClick={() => onRatio(value)} className={`rounded-lg py-2 text-[11px] font-bold ${ratio === value ? 'bg-fuchsia-300 text-black' : 'bg-white/5'}`}>{value}</button>)}</div>{!hideCount && <><div className="mb-2 mt-4 text-[10px] font-bold uppercase tracking-wider text-white/35">Số lượng ảnh</div><div className="grid grid-cols-4 gap-1">{[1, 2, 3, 4].map((value) => <button key={value} onClick={() => onCount(value)} className={`rounded-lg py-2 text-xs font-bold ${count === value ? 'bg-fuchsia-300 text-black' : 'bg-white/5'}`}>{value}</button>)}</div></>}<button onClick={onClose} className="mt-4 w-full rounded-xl bg-white/7 py-2 text-xs font-bold">Xong</button></div>;
}

function CharactersModal({ characters, tiles, selected, onToggle, onEdit, onClose }: { characters: ImageCharacter[]; tiles: Array<{ item: ImageGeneration; url: string; imageIndex: number }>; selected: ImageCharacter[]; onToggle: (character: ImageCharacter) => void; onEdit: (character: ImageCharacter | 'new') => void; onClose: () => void }) {
  void tiles;
  return <StudioModal wide onClose={onClose}><div className="flex items-center justify-between border-b border-white/10 p-5"><div><h2 className="font-bold">Nhân vật của dự án</h2><p className="mt-1 text-xs text-white/40">Giữ diện mạo nhân vật nhất quán giữa các ảnh.</p></div><div className="flex gap-2"><button onClick={() => onEdit('new')} className="primary-action flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-bold"><Plus size={14} />Nhân vật mới</button><button onClick={onClose} className="rounded-xl p-2 hover:bg-white/5"><X size={18} /></button></div></div><div className="grid min-h-64 grid-cols-2 gap-4 p-5 sm:grid-cols-3">{characters.length ? characters.map((character) => <article key={character.id} className={`overflow-hidden rounded-2xl border bg-white/[0.02] ${selected.some((item) => item.id === character.id) ? 'border-fuchsia-300/60' : 'border-white/10'}`}><button onClick={() => onToggle(character)} className="block w-full text-left"><img src={character.referenceUrl} alt={character.name} className="aspect-square w-full object-cover" /><div className="p-3"><b className="block truncate text-sm">{character.name}</b><p className="mt-1 line-clamp-2 text-xs text-white/40">{character.description || 'Chưa có mô tả'}</p></div></button><button onClick={() => onEdit(character)} className="w-full border-t border-white/10 py-2 text-[11px] font-bold text-white/50 hover:text-white">Chỉnh sửa</button></article>) : <div className="col-span-full grid place-items-center py-16 text-center text-sm text-white/35"><div><UserRound className="mx-auto mb-3" size={35} />Chưa có nhân vật trong dự án.</div></div>}</div></StudioModal>;
}

function Confirm({ title, description, busy = false, onCancel, onConfirm }: { title: string; description: string; busy?: boolean; onCancel: () => void; onConfirm: () => void }) { return <StudioModal onClose={onCancel}><div className="p-6 text-center"><AlertTriangle className="mx-auto text-red-300" size={28} /><h2 className="mt-4 font-bold">{title}</h2><p className="mt-2 text-xs leading-5 text-white/40">{description}</p><div className="mt-6 grid grid-cols-2 gap-3"><button disabled={busy} onClick={onCancel} className="rounded-xl bg-white/7 py-3 text-sm font-bold">Hủy</button><button disabled={busy} onClick={onConfirm} className="flex items-center justify-center gap-2 rounded-xl bg-red-500 py-3 text-sm font-bold text-white disabled:opacity-50">{busy && <Loader2 size={15} className="animate-spin" />}Xóa</button></div></div></StudioModal>; }
function ToastView({ toast }: { toast: Toast }) { return toast ? createPortal(<div className={`fixed bottom-6 left-1/2 z-[2000] -translate-x-1/2 rounded-xl border px-4 py-3 text-sm font-bold shadow-2xl ${toast.tone === 'success' ? 'border-emerald-300/25 bg-[#123027] text-emerald-200' : 'border-red-300/25 bg-[#351a1c] text-red-200'}`}>{toast.message}</div>, document.body) : null; }
