import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, ImagePlus, Images, Loader2, Play, Plus, Search, Sparkles, Video, X } from 'lucide-react';
import { useProjectStore } from '../store/projectStore';
import { useSettingsStore } from '../store/settingsStore';
import { getMediaProvider } from '../providers/media';
import { getImageProvider } from '../providers/image';
import { errorMessage, missingKeyService, serviceLabel } from '../providers/errors';
import { localFileUrl, localFileToDataUrl } from '../shared/localFile';
import { AudioPlayer } from '../components/AudioPlayer';
import type { ImageEngine } from '../providers/image';
import type { MediaEngine, MediaResult, Scene } from '../shared/types';
import { uid } from '../store/projectStore';

interface Props { onOpenSettings: () => void; }

type LibraryMode = 'stock' | 'ai';
type AiProvider = ImageEngine;

const STOCK_SOURCES: Array<{ id: MediaEngine; label: string }> = [
  { id: 'pexels', label: 'Pexels' },
  { id: 'pixabay', label: 'Pixabay' },
  { id: 'unsplash', label: 'Unsplash' },
];
const AI_SOURCES: Array<{ id: AiProvider; label: string }> = [
  { id: 'gemini', label: 'Gemini' },
  { id: 'chatgpt', label: 'ChatGPT' },
];

export function ArtDepartment({ onOpenSettings }: Props) {
  const project = useProjectStore((state) => state.project);
  const updateScene = useProjectStore((state) => state.updateScene);
  const setStep = useProjectStore((state) => state.setStep);
  const setMediaEngine = useProjectStore((state) => state.setMediaEngine);
  const addCharacterRef = useProjectStore((state) => state.addCharacterRef);
  const removeCharacterRef = useProjectStore((state) => state.removeCharacterRef);
  const keys = useSettingsStore((state) => state.keys);

  const [results, setResults] = useState<Record<string, MediaResult[]>>({});
  const [searching, setSearching] = useState<Record<string, boolean>>({});
  const [downloading, setDownloading] = useState<Record<string, boolean>>({});
  const [resultPages, setResultPages] = useState<Record<string, number>>({});
  const [hasMore, setHasMore] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [missingKey, setMissingKey] = useState<string | null>(null);
  const [librarySceneId, setLibrarySceneId] = useState<string | null>(null);
  const [libraryMode, setLibraryMode] = useState<LibraryMode>('stock');
  const [libraryEngine, setLibraryEngine] = useState<MediaEngine>(project.settings.mediaEngine);
  const [stockMediaType, setStockMediaType] = useState<'image' | 'video'>('image');
  const [aiProvider, setAiProvider] = useState<AiProvider>('gemini');
  const [aiResults, setAiResults] = useState<Record<string, string[]>>({});
  const [aiGenerating, setAiGenerating] = useState(false);
  const [importingCharacter, setImportingCharacter] = useState(false);
  const [hoveredVideoId, setHoveredVideoId] = useState<string | null>(null);
  const libraryScrollRef = useRef<HTMLDivElement | null>(null);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const searchRequestRef = useRef<Record<string, string>>({});

  const libraryScene = project.scenes.find((scene) => scene.id === librarySceneId) ?? null;

  const handleError = (error: unknown, sceneId: string) => {
    const service = missingKeyService(error);
    if (service) setMissingKey(service);
    else setErrors((current) => ({ ...current, [sceneId]: errorMessage(error) }));
  };

  const search = async (scene: Scene, page = 1, append = false, engine = libraryEngine, mediaType = stockMediaType) => {
    if (!scene.keyword.trim()) return;
    const requestId = `${engine}:${mediaType}:${page}:${Date.now()}:${Math.random()}`;
    searchRequestRef.current[scene.id] = requestId;
    setLibrarySceneId(scene.id);
    setLibraryMode('stock');
    setSearching((current) => ({ ...current, [scene.id]: true }));
    setErrors((current) => ({ ...current, [scene.id]: '' }));
    try {
      const perPage = 30;
      const found = await getMediaProvider(engine, keys).search({
        keyword: scene.keyword,
        ratio: project.settings.aspectRatio,
        mediaType,
        perPage,
        page,
      });
      if (searchRequestRef.current[scene.id] !== requestId) return;
      setMissingKey(null);
      setResults((current) => {
        const combined = append ? [...(current[scene.id] ?? []), ...found] : found;
        return { ...current, [scene.id]: Array.from(new Map(combined.map((item) => [item.id, item])).values()) };
      });
      setResultPages((current) => ({ ...current, [scene.id]: page }));
      setHasMore((current) => ({ ...current, [scene.id]: found.length === perPage }));
      if (!found.length && !append) setErrors((current) => ({ ...current, [scene.id]: 'Không tìm thấy ảnh phù hợp.' }));
    } catch (error) {
      if (searchRequestRef.current[scene.id] !== requestId) return;
      if (!append) {
        setResults((current) => ({ ...current, [scene.id]: [] }));
        setResultPages((current) => ({ ...current, [scene.id]: 0 }));
        setHasMore((current) => ({ ...current, [scene.id]: false }));
      }
      handleError(error, scene.id);
    } finally {
      if (searchRequestRef.current[scene.id] === requestId) {
        setSearching((current) => ({ ...current, [scene.id]: false }));
      }
    }
  };

  const openLibrary = (scene: Scene) => {
    const mediaType = scene.visualType === 'stock-video' ? 'video' : 'image';
    const engine = mediaType === 'video' && project.settings.mediaEngine === 'unsplash'
      ? 'pexels'
      : project.settings.mediaEngine;
    setLibrarySceneId(scene.id);
    setHoveredVideoId(null);
    setLibraryMode('stock');
    setStockMediaType(mediaType);
    setLibraryEngine(engine);
    setMissingKey(null);
    setResults((current) => ({ ...current, [scene.id]: [] }));
    void search(scene, 1, false, engine, mediaType);
  };

  const changeStockSource = (scene: Scene, engine: MediaEngine) => {
    setHoveredVideoId(null);
    setLibraryEngine(engine);
    setMediaEngine(engine);
    setMissingKey(null);
    setErrors((current) => ({ ...current, [scene.id]: '' }));
    setResults((current) => ({ ...current, [scene.id]: [] }));
    setResultPages((current) => ({ ...current, [scene.id]: 0 }));
    setHasMore((current) => ({ ...current, [scene.id]: false }));
    void search(scene, 1, false, engine, stockMediaType);
  };

  const changeStockMediaType = (scene: Scene, mediaType: 'image' | 'video') => {
    setHoveredVideoId(null);
    const engine = mediaType === 'video' && libraryEngine === 'unsplash' ? 'pexels' : libraryEngine;
    setStockMediaType(mediaType);
    setLibraryEngine(engine);
    setMediaEngine(engine);
    setMissingKey(null);
    setErrors((current) => ({ ...current, [scene.id]: '' }));
    setResults((current) => ({ ...current, [scene.id]: [] }));
    setResultPages((current) => ({ ...current, [scene.id]: 0 }));
    setHasMore((current) => ({ ...current, [scene.id]: false }));
    void search(scene, 1, false, engine, mediaType);
  };

  const choose = async (sceneId: string, media: MediaResult) => {
    setDownloading((current) => ({ ...current, [sceneId]: true }));
    try {
      const imagePath = await window.gensuite.media.download({ projectId: project.id, sceneId, url: media.fullUrl });
      updateScene(sceneId, { imagePath, visualType: media.mediaType === 'video' ? 'stock-video' : 'stock-image' });
      setHoveredVideoId(null);
      setLibrarySceneId(null);
    } catch (error) {
      handleError(error, sceneId);
    } finally {
      setDownloading((current) => ({ ...current, [sceneId]: false }));
    }
  };

  const generateAi = async (scene: Scene) => {
    if (!scene.imagePrompt.trim()) { setErrors((current) => ({ ...current, [scene.id]: 'Hãy nhập câu lệnh tạo ảnh.' })); return; }
    setAiGenerating(true);
    setMissingKey(null);
    setErrors((current) => ({ ...current, [scene.id]: '' }));
    try {
      // Send the project's character references so recurring characters stay
      // visually consistent across scenes. Reading the local files fails soft —
      // a missing reference just drops out rather than blocking generation.
      const refs = (await Promise.all(project.characterRefs.map((ref) => localFileToDataUrl(ref.imagePath).catch(() => null)))).filter((url): url is string => Boolean(url));
      const urls = await getImageProvider(aiProvider, keys).generate({
        prompt: scene.imagePrompt,
        ratio: project.settings.aspectRatio,
        count: 2,
        referenceImageDataUrls: refs,
      });
      setAiResults((current) => ({ ...current, [scene.id]: urls }));
    } catch (error) {
      handleError(error, scene.id);
    } finally {
      setAiGenerating(false);
    }
  };

  const importCharacter = async () => {
    setImportingCharacter(true);
    try {
      const result = await window.gensuite.characters.import(project.id);
      if (result) addCharacterRef({ id: uid('c_'), name: `Nhân vật ${project.characterRefs.length + 1}`, imagePath: result.imagePath });
    } catch (error) {
      if (librarySceneId) handleError(error, librarySceneId);
    } finally {
      setImportingCharacter(false);
    }
  };

  const chooseAi = async (sceneId: string, url: string) => {
    setDownloading((current) => ({ ...current, [sceneId]: true }));
    try {
      const imagePath = await window.gensuite.media.download({ projectId: project.id, sceneId, url, ext: 'png' });
      updateScene(sceneId, { imagePath, visualType: 'ai-image' });
      setLibrarySceneId(null);
    } catch (error) {
      handleError(error, sceneId);
    } finally {
      setDownloading((current) => ({ ...current, [sceneId]: false }));
    }
  };

  useEffect(() => {
    const sentinel = loadMoreRef.current;
    const scrollRoot = libraryScrollRef.current;
    if (!sentinel || !scrollRoot || !libraryScene || libraryMode !== 'stock') return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && hasMore[libraryScene.id] && !searching[libraryScene.id]) {
        void search(libraryScene, (resultPages[libraryScene.id] ?? 1) + 1, true, libraryEngine, stockMediaType);
      }
    }, { root: scrollRoot, rootMargin: '240px 0px', threshold: 0.01 });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [libraryScene?.id, libraryScene?.keyword, libraryMode, libraryEngine, stockMediaType, hasMore[libraryScene?.id ?? ''], searching[libraryScene?.id ?? ''], resultPages[libraryScene?.id ?? '']]);

  const allMediaChosen = project.scenes.length > 0 && project.scenes.every((scene) => scene.imagePath);
  const allAudioReady = project.scenes.length > 0 && project.scenes.every((scene) => scene.audioPath);

  if (!project.scenes.length) {
    return <div className="mx-auto flex h-full max-w-3xl flex-col items-center justify-center gap-4 p-12 text-center text-white/55"><Images size={30} className="text-emerald-400" /><p className="font-semibold text-white/75">Chưa có phân cảnh</p><p className="max-w-md text-xs leading-5 text-white/35">Hãy hoàn tất nội dung và tạo giọng đọc trước khi sắp xếp Storyboard.</p><button onClick={() => setStep('voice')} className="primary-action rounded-xl px-5 py-3 font-bold">Về Giọng đọc</button></div>;
  }

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-7 px-8 py-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.16em] text-emerald-400/80">Bước 04 · Storyboard</div>
          <h1 className="text-3xl font-bold tracking-[-0.04em]">Sắp xếp Storyboard</h1>
          <p className="mt-2 text-sm text-text/50">Mỗi hàng là một phân cảnh hoàn chỉnh: nội dung và audio ở bên trái, hình ảnh hoặc video ở bên phải.</p>
        </div>
        <button onClick={() => setStep('voice')} className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.035] px-4 py-2.5 text-sm font-semibold text-white/60 transition-colors hover:bg-white/[0.07] hover:text-white"><ArrowLeft size={16} /> Chỉnh giọng đọc</button>
      </header>

      {!allAudioReady && <div className="rounded-xl border border-amber-400/25 bg-amber-400/[0.07] p-4 text-sm text-amber-100/70">Một số phân cảnh chưa có audio. Bạn vẫn có thể chọn media, nhưng cần hoàn tất bước Giọng đọc trước khi xuất video.</div>}

      <ol className="flex flex-col gap-6">
        {project.scenes.map((scene, index) => (
          <li key={scene.id} className="rounded-2xl border border-white/[0.08] bg-white/[0.018] p-4 shadow-[0_18px_50px_rgba(0,0,0,0.12)]">
            <div className="mb-3 flex items-center justify-between px-1">
              <span className="text-xs font-bold text-emerald-300">Phân cảnh {String(index + 1).padStart(2, '0')}</span>
              <span className="text-[10px] text-white/30">{scene.audioDuration ? `${scene.audioDuration.toFixed(1)} giây` : 'Chưa có thời lượng'}</span>
            </div>
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(340px,.85fr)]">
              <article className="flex min-h-64 flex-col rounded-2xl border border-white/[0.08] bg-[#171718] p-5">
                <div className="mb-3 text-[10px] font-semibold text-white/35">Nội dung cảnh</div>
                <p className="flex-1 text-sm leading-7 text-white/80">{scene.narration}</p>
                <div className="mt-5 border-t border-white/[0.07] pt-4">
                  {scene.audioPath ? <AudioPlayer src={localFileUrl(scene.audioPath)!} onDuration={(audioDuration) => { if (Math.abs((scene.audioDuration ?? 0) - audioDuration) > 0.1) updateScene(scene.id, { audioDuration }); }} /> : <button onClick={() => setStep('voice')} className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-white/15 py-3 text-xs font-semibold text-white/40 hover:border-emerald-400/35 hover:text-emerald-300"><Plus size={15} /> Tạo audio cho cảnh này</button>}
                </div>
              </article>

              <article className="relative min-h-64 overflow-hidden rounded-2xl border border-white/[0.08] bg-[#171718]">
                {scene.imagePath ? <>{scene.visualType === 'stock-video' ? <video src={localFileUrl(scene.imagePath)} muted loop autoPlay playsInline className="absolute inset-0 h-full w-full object-cover" /> : <img src={localFileUrl(scene.imagePath)} alt={`Media phân cảnh ${index + 1}`} className="absolute inset-0 h-full w-full object-cover" />}<div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-black/10" /><div className="absolute inset-x-0 bottom-0 flex items-center justify-between p-4"><span className="flex items-center gap-1.5 text-xs font-semibold text-white"><Check size={14} className="text-emerald-300" /> Đã chọn {scene.visualType === 'stock-video' ? 'video' : 'ảnh'}</span><button onClick={() => openLibrary(scene)} className="rounded-lg border border-white/15 bg-black/50 px-3 py-2 text-xs font-semibold text-white backdrop-blur-md hover:bg-black/70">Thay đổi</button></div></> : <button onClick={() => openLibrary(scene)} className="flex h-full min-h-64 w-full flex-col items-center justify-center gap-3 border border-dashed border-transparent text-white/35 transition-all hover:border-emerald-400/30 hover:bg-emerald-400/[0.025] hover:text-emerald-300"><span className="grid h-14 w-14 place-items-center rounded-full border border-white/10 bg-white/[0.035]"><Plus size={24} /></span><span className="text-sm font-semibold">Thêm ảnh hoặc video</span><span className="text-[11px] text-white/25">Chọn stock hoặc tạo sinh bằng AI</span></button>}
                {errors[scene.id] && <div className="absolute inset-x-3 top-3 rounded-lg bg-red-950/90 px-3 py-2 text-xs text-red-200">{errors[scene.id]}</div>}
              </article>
            </div>
          </li>
        ))}
      </ol>

      <div className="flex justify-end"><button onClick={() => setStep('timeline')} disabled={!allMediaChosen || !allAudioReady} className="primary-action flex items-center gap-2 rounded-xl px-5 py-3 font-bold disabled:opacity-40">{allMediaChosen ? 'Sang bước Xuất video' : 'Chọn media cho tất cả cảnh'} <ArrowRight size={17} /></button></div>

      {libraryScene && <div className="fixed inset-0 z-[75] flex items-center justify-center bg-black/80 p-5 backdrop-blur-lg" onClick={() => { setHoveredVideoId(null); setLibrarySceneId(null); }}>
        <section className="flex h-[min(88vh,880px)] w-full max-w-6xl flex-col overflow-hidden rounded-3xl border border-white/10 bg-[#111112] shadow-[0_40px_120px_rgba(0,0,0,.72)]" onClick={(event) => event.stopPropagation()}>
          <header className="shrink-0 border-b border-white/[0.08] px-6 pt-5">
            <div className="flex items-start justify-between gap-5 pb-4"><div><div className="text-[11px] font-semibold text-emerald-300/70">Phân cảnh {String(project.scenes.findIndex((scene) => scene.id === libraryScene.id) + 1).padStart(2, '0')}</div><h2 className="mt-1 text-xl font-bold tracking-[-0.03em]">Chọn media</h2></div><button onClick={() => { setHoveredVideoId(null); setLibrarySceneId(null); }} aria-label="Đóng" className="rounded-full bg-white/5 p-2.5 text-white/40 hover:bg-white/10 hover:text-white"><X size={18} /></button></div>
            <div className="flex gap-6">
              <button onClick={() => setLibraryMode('stock')} className={`flex items-center gap-2 border-b-2 px-1 pb-3 text-sm font-semibold transition-colors ${libraryMode === 'stock' ? 'border-emerald-400 text-white' : 'border-transparent text-white/35 hover:text-white/65'}`}><Images size={16} /> Nguồn có sẵn</button>
              <button onClick={() => setLibraryMode('ai')} className={`flex items-center gap-2 border-b-2 px-1 pb-3 text-sm font-semibold transition-colors ${libraryMode === 'ai' ? 'border-emerald-400 text-white' : 'border-transparent text-white/35 hover:text-white/65'}`}><Sparkles size={16} /> Tạo sinh AI</button>
            </div>
          </header>

          <div className="shrink-0 border-b border-white/[0.07] bg-white/[0.012] px-6 py-4">
            <div className="flex flex-wrap items-center gap-2">{libraryMode === 'stock' ? <><div className="mr-2 inline-flex rounded-xl border border-white/10 bg-black/20 p-1"><button onClick={() => changeStockMediaType(libraryScene, 'image')} className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition-colors ${stockMediaType === 'image' ? 'bg-white/10 text-white' : 'text-white/35 hover:text-white/65'}`}><Images size={14} /> Ảnh</button><button onClick={() => changeStockMediaType(libraryScene, 'video')} className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition-colors ${stockMediaType === 'video' ? 'bg-white/10 text-white' : 'text-white/35 hover:text-white/65'}`}><Video size={14} /> Video</button></div>{STOCK_SOURCES.map((source) => { const disabled = stockMediaType === 'video' && source.id === 'unsplash'; return <button key={source.id} disabled={disabled} title={disabled ? 'Unsplash chỉ hỗ trợ ảnh' : undefined} onClick={() => changeStockSource(libraryScene, source.id)} className={`rounded-xl px-4 py-2 text-xs font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-25 ${libraryEngine === source.id ? 'bg-emerald-400 text-[#07120f]' : 'border border-white/10 bg-white/[0.035] text-white/50 hover:text-white'}`}>{source.label}</button>; })}</> : AI_SOURCES.map((source) => <button key={source.id} onClick={() => setAiProvider(source.id)} className={`rounded-xl px-4 py-2 text-xs font-bold transition-colors ${aiProvider === source.id ? 'bg-emerald-400 text-[#07120f]' : 'border border-white/10 bg-white/[0.035] text-white/50 hover:text-white'}`}>{source.label}</button>)}</div>
          </div>

          {libraryMode === 'stock' ? <>
            <div className="flex shrink-0 gap-2 border-b border-white/[0.07] px-6 py-4"><input value={libraryScene.keyword} onChange={(event) => updateScene(libraryScene.id, { keyword: event.target.value })} onKeyDown={(event) => event.key === 'Enter' && search(libraryScene, 1, false, libraryEngine, stockMediaType)} className="field-surface min-w-0 flex-1 rounded-xl px-4 py-2.5 text-sm outline-none" placeholder={`Từ khóa tìm ${stockMediaType === 'video' ? 'video' : 'ảnh'}`} /><button onClick={() => search(libraryScene, 1, false, libraryEngine, stockMediaType)} disabled={searching[libraryScene.id]} className="flex items-center gap-2 rounded-xl bg-emerald-400 px-5 py-2.5 text-sm font-bold text-[#07120f] disabled:opacity-45">{searching[libraryScene.id] ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />} Tìm</button></div>
            {missingKey && libraryMode === 'stock' && <div className="mx-6 mt-4 flex shrink-0 items-center justify-between gap-4 rounded-xl border border-amber-400/25 bg-amber-400/[0.08] px-4 py-3 text-sm text-amber-100/80"><span>Thiếu API key cho {serviceLabel(missingKey)} để tìm ảnh từ {STOCK_SOURCES.find((source) => source.id === libraryEngine)?.label}.</span><button onClick={() => { setLibrarySceneId(null); onOpenSettings(); }} className="shrink-0 rounded-lg bg-amber-300 px-3 py-2 text-xs font-bold text-black">Mở Cài đặt</button></div>}
            <div ref={libraryScrollRef} className="min-h-0 flex-1 overflow-y-auto p-6">{missingKey ? <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-white/35"><ImagePlus size={30} className="text-amber-300/60" /><span className="font-semibold text-white/55">Nguồn này chưa được cấu hình</span><span className="text-xs">Thêm API key để đồng bộ kết quả từ {STOCK_SOURCES.find((source) => source.id === libraryEngine)?.label}.</span></div> : searching[libraryScene.id] && !results[libraryScene.id]?.length ? <div className="flex h-full items-center justify-center gap-3 text-sm text-white/40"><Loader2 size={22} className="animate-spin text-emerald-400" /> Đang tải media…</div> : results[libraryScene.id]?.length ? <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">{results[libraryScene.id].map((media) => <button key={media.id} disabled={downloading[libraryScene.id]} onMouseEnter={() => media.mediaType === 'video' && setHoveredVideoId(media.id)} onMouseLeave={() => setHoveredVideoId((current) => current === media.id ? null : current)} onFocus={() => media.mediaType === 'video' && setHoveredVideoId(media.id)} onBlur={() => setHoveredVideoId((current) => current === media.id ? null : current)} onClick={() => choose(libraryScene.id, media)} className="group relative aspect-video overflow-hidden rounded-xl border border-white/10 bg-white/[0.03] transition hover:-translate-y-0.5 hover:border-emerald-400/60 disabled:opacity-50"><img src={media.thumbUrl} alt={media.author ? `${media.mediaType === 'video' ? 'Video' : 'Ảnh'} của ${media.author}` : `Kết quả ${media.mediaType === 'video' ? 'video' : 'ảnh'} stock`} className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" />{media.mediaType === 'video' && hoveredVideoId === media.id && <video key={media.fullUrl} src={media.fullUrl} poster={media.thumbUrl} autoPlay muted loop playsInline preload="metadata" className="pointer-events-none absolute inset-0 h-full w-full object-cover" />}{media.mediaType === 'video' && <span className={`pointer-events-none absolute inset-0 grid place-items-center bg-black/10 transition-opacity ${hoveredVideoId === media.id ? 'opacity-0' : 'opacity-100'}`}><span className="grid h-10 w-10 place-items-center rounded-full border border-white/25 bg-black/55 text-white shadow-lg backdrop-blur-sm"><Play size={17} fill="currentColor" /></span></span>}<span className="pointer-events-none absolute bottom-2 left-2 rounded-md bg-black/60 px-2 py-1 text-[9px] font-bold uppercase text-white/75 backdrop-blur-sm">{media.mediaType === 'video' ? 'Video' : 'Ảnh'}</span>{downloading[libraryScene.id] && <span className="absolute inset-0 grid place-items-center bg-black/50"><Loader2 size={20} className="animate-spin" /></span>}</button>)}</div> : <div className="flex h-full flex-col items-center justify-center gap-3 text-white/35"><ImagePlus size={30} /><span>Không tìm thấy {stockMediaType === 'video' ? 'video' : 'ảnh'} phù hợp</span></div>}{!missingKey && results[libraryScene.id]?.length > 0 && <div ref={loadMoreRef} className="flex h-16 items-end justify-center text-xs text-white/30">{searching[libraryScene.id] ? <span className="flex items-center gap-2"><Loader2 size={14} className="animate-spin text-emerald-400" /> Đang tải thêm…</span> : hasMore[libraryScene.id] ? 'Cuộn xuống để xem thêm' : 'Đã tải hết kết quả'}</div>}</div>
          </> : <div className="grid min-h-0 flex-1 gap-5 overflow-y-auto p-6 lg:grid-cols-[1fr_1fr]"><div><label className="text-xs font-semibold text-white/45">Prompt tạo ảnh</label><textarea value={libraryScene.imagePrompt} onChange={(event) => updateScene(libraryScene.id, { imagePrompt: event.target.value })} rows={10} className="field-surface mt-2 w-full resize-none rounded-2xl p-4 text-sm leading-6 outline-none" /><div className="mt-3 rounded-xl border border-white/[0.07] bg-white/[0.02] p-3 text-[11px] leading-5 text-white/35">Negative prompt: {libraryScene.negativePrompt || project.topic?.negativePrompt || 'Chưa thiết lập'}</div><div className="mt-4"><div className="mb-2 flex items-center justify-between"><span className="text-xs font-semibold text-white/45">Nhân vật đồng bộ ({project.characterRefs.length}/4)</span><button onClick={importCharacter} disabled={importingCharacter || project.characterRefs.length >= 4} className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[11px] font-semibold text-white/70 hover:border-emerald-400/30 hover:text-emerald-300 disabled:opacity-40">{importingCharacter ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Thêm ảnh</button></div><p className="mb-2 text-[10px] leading-4 text-white/30">Ảnh tham chiếu được gửi kèm mọi lần tạo để giữ nhân vật giống nhau giữa các cảnh.</p>{project.characterRefs.length ? <div className="flex flex-wrap gap-2">{project.characterRefs.map((ref) => <div key={ref.id} className="group relative h-16 w-16 overflow-hidden rounded-lg border border-white/10"><img src={localFileUrl(ref.imagePath)} alt={ref.name} className="h-full w-full object-cover" /><button onClick={() => removeCharacterRef(ref.id)} className="absolute right-0.5 top-0.5 grid h-5 w-5 place-items-center rounded-full bg-black/70 text-white/80 opacity-0 transition-opacity group-hover:opacity-100 hover:text-red-300"><X size={12} /></button></div>)}</div> : <div className="rounded-lg border border-dashed border-white/10 px-3 py-2.5 text-[11px] text-white/30">Chưa có nhân vật. Thêm ảnh để giữ nhân vật nhất quán (tuỳ chọn).</div>}</div>{missingKey && <div className="mt-4 flex items-center justify-between gap-4 rounded-xl border border-amber-400/25 bg-amber-400/[0.08] px-4 py-3 text-sm text-amber-100/80"><span>Cần GenSuite API key để tạo ảnh trả phí.</span><button onClick={() => { setLibrarySceneId(null); onOpenSettings(); }} className="shrink-0 rounded-lg bg-amber-300 px-3 py-2 text-xs font-bold text-black">Mở Cài đặt</button></div>}{errors[libraryScene.id] && <div className="mt-4 rounded-xl border border-red-400/25 bg-red-500/10 px-4 py-3 text-sm text-red-200">{errors[libraryScene.id]}</div>}<button onClick={() => generateAi(libraryScene)} disabled={aiGenerating} className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-400 px-5 py-3 text-sm font-bold text-[#07120f] disabled:opacity-45">{aiGenerating ? <><Loader2 size={16} className="animate-spin" /> Đang tạo ảnh…</> : <><Sparkles size={16} /> Tạo ảnh với {AI_SOURCES.find((source) => source.id === aiProvider)?.label}</>}</button></div><div className="flex min-h-72 flex-col rounded-2xl border border-dashed border-white/12 bg-white/[0.015] p-4">{aiGenerating ? <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-white/40"><Loader2 size={24} className="animate-spin text-emerald-400" /> Đang tạo ảnh, có thể mất một lát…</div> : aiResults[libraryScene.id]?.length ? <div className="grid grid-cols-2 gap-3">{aiResults[libraryScene.id].map((url, index) => <button key={url} disabled={downloading[libraryScene.id]} onClick={() => chooseAi(libraryScene.id, url)} className="group relative aspect-video overflow-hidden rounded-xl border border-white/10 bg-white/[0.03] transition hover:-translate-y-0.5 hover:border-emerald-400/60 disabled:opacity-50"><img src={url} alt={`Ảnh AI ${index + 1}`} className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" />{downloading[libraryScene.id] && <span className="absolute inset-0 grid place-items-center bg-black/50"><Loader2 size={20} className="animate-spin" /></span>}<span className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-2 text-[10px] font-semibold text-white opacity-0 transition-opacity group-hover:opacity-100">Chọn ảnh này</span></button>)}</div> : <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center"><span className="grid h-16 w-16 place-items-center rounded-2xl bg-emerald-400/10 text-emerald-300">{aiProvider === 'gemini' ? <Sparkles size={26} /> : <Images size={26} />}</span><h3 className="mt-1 font-bold text-white/80">Tạo sinh với {AI_SOURCES.find((source) => source.id === aiProvider)?.label}</h3><p className="max-w-sm text-xs leading-5 text-white/35">Nhập prompt bên trái rồi bấm tạo ảnh. Ảnh được tạo qua API trả phí GenSuite.</p></div>}</div></div>}
        </section>
      </div>}
    </div>
  );
}
