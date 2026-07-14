import { useMemo, useState } from 'react';
import { BookOpen, ImagePlus, Pencil, Plus, Save, Trash2, X } from 'lucide-react';
import { useProjectStore, uid } from '../store/projectStore';
import { useTopicStore } from '../store/topicStore';
import type { TopicConfig } from '../shared/types';

function blankTopic(): TopicConfig {
  return {
    id: uid('topic_'), name: 'Chủ đề mới', description: '', masterPrompt: '', defaultTone: 'Kể chuyện truyền cảm',
    targetAudience: 'Khán giả YouTube', defaultWordCount: 1500, visualStyle: 'Cinematic, realistic, consistent visual style',
    negativePrompt: 'text, watermark, low quality, inconsistent characters', source: 'user',
  };
}

async function prepareThumbnail(file: File): Promise<string> {
  const source = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('Không thể đọc ảnh này.'));
      element.src = source;
    });
    const canvas = document.createElement('canvas');
    canvas.width = 960;
    canvas.height = 540;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Không thể xử lý thumbnail.');
    const targetRatio = canvas.width / canvas.height;
    const sourceRatio = image.naturalWidth / image.naturalHeight;
    let sx = 0; let sy = 0; let sw = image.naturalWidth; let sh = image.naturalHeight;
    if (sourceRatio > targetRatio) {
      sw = image.naturalHeight * targetRatio;
      sx = (image.naturalWidth - sw) / 2;
    } else {
      sh = image.naturalWidth / targetRatio;
      sy = (image.naturalHeight - sh) / 2;
    }
    context.drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.82);
  } finally {
    URL.revokeObjectURL(source);
  }
}

export function TopicStudio() {
  const project = useProjectStore((state) => state.project);
  const setTopic = useProjectStore((state) => state.setTopic);
  const saveTopicCustomization = useProjectStore((state) => state.saveTopicCustomization);
  const setStep = useProjectStore((state) => state.setStep);
  const topics = useTopicStore((state) => state.topics);
  const saveTopic = useTopicStore((state) => state.saveTopic);
  const removeTopic = useTopicStore((state) => state.removeTopic);
  const [editing, setEditing] = useState<TopicConfig | null>(null);
  const [promptEditing, setPromptEditing] = useState<TopicConfig | null>(null);

  const selected = useMemo(() => project.topic, [project.topic]);
  const choose = (topic: TopicConfig) => {
    const chosen = selected?.id === topic.id ? selected : topic;
    setTopic({ ...chosen });
    setStep('content');
  };
  const openPrompt = (topic: TopicConfig) => {
    const draft = selected?.id === topic.id
      ? { ...topic, ...selected, thumbnail: selected.thumbnail ?? topic.thumbnail }
      : topic;
    setPromptEditing({ ...draft });
  };

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-7 px-10 py-10">
      <header>
        <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.16em] text-emerald-400/80">Bước 01 · Chủ đề</div>
        <h1 className="text-3xl font-bold tracking-[-0.04em]">Chọn công thức nội dung</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-text/50">Mỗi chủ đề mang theo Master Prompt, khán giả mục tiêu và phong cách hình ảnh. Dự án sẽ giữ một bản riêng để bạn tùy chỉnh an toàn.</p>
      </header>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {topics.map((topic) => {
          const active = selected?.id === topic.id;
          const customizedTopic = project.topicCustomizations[topic.id];
          const cardTopic = customizedTopic ?? (active ? selected : null) ?? topic;
          const thumbnail = cardTopic.thumbnail;
          return (
            <article key={topic.id} className={`workspace-panel group relative min-h-64 overflow-hidden rounded-2xl transition ${active ? 'border-emerald-400/60 ring-2 ring-emerald-400/10' : 'hover:border-white/20'}`}>
              <div className="absolute right-4 top-4 z-10 flex translate-y-1 items-center gap-1 opacity-0 transition-all duration-150 group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100">
                <button
                  onClick={() => openPrompt(cardTopic)}
                  className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-[#242425] px-2.5 py-1.5 text-[11px] font-semibold text-white/70 shadow-lg hover:border-emerald-400/40 hover:text-emerald-300"
                >
                  <Pencil size={12} /> Tùy chỉnh
                </button>
                {topic.source === 'user' && (
                  <button onClick={() => confirm(`Xóa chủ đề “${topic.name}”?`) && removeTopic(topic.id)} title="Xóa chủ đề" className="rounded-lg border border-white/10 bg-[#242425] p-2 text-white/40 hover:border-red-400/30 hover:text-red-300">
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
              <button onClick={() => choose(cardTopic)} className="h-full w-full text-left">
                <div className="relative h-32 overflow-hidden bg-gradient-to-br from-emerald-400/15 to-teal-900/10">
                  {thumbnail ? <img src={thumbnail} alt="" className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.03]" /> : <div className="flex h-full items-center justify-center text-emerald-300/60"><BookOpen size={28} /></div>}
                  <div className="absolute inset-0 bg-gradient-to-t from-[#181819] via-transparent to-black/10" />
                  <span className="absolute bottom-3 left-4 rounded-lg bg-black/45 px-2 py-1 text-[9px] uppercase tracking-wider text-white/60 backdrop-blur-sm">{topic.source === 'system' ? 'Mặc định' : 'Của bạn'}</span>
                </div>
                <div className="p-5">
                  <h2 className="font-bold">{topic.name}</h2>
                  <p className="mt-2 min-h-10 text-xs leading-5 text-white/45">{topic.description || 'Chủ đề tùy chỉnh của bạn.'}</p>
                  <p className="mt-4 text-xs text-emerald-300/70">~{topic.defaultWordCount.toLocaleString('vi-VN')} từ · {topic.defaultTone}</p>
                </div>
              </button>
            </article>
          );
        })}
        <button onClick={() => setEditing(blankTopic())} className="flex min-h-56 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-white/15 text-white/40 hover:border-emerald-400/40 hover:text-emerald-300">
          <Plus size={24} /> <span className="text-sm font-semibold">Thêm chủ đề riêng</span>
        </button>
      </div>

      {promptEditing && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/75 p-5 backdrop-blur-sm" onMouseDown={() => setPromptEditing(null)}>
          <div className="workspace-panel w-full max-w-2xl rounded-2xl bg-[#181819] p-6 shadow-2xl" onMouseDown={(event) => event.stopPropagation()}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-emerald-300">Master Prompt cho dự án</p>
                <h2 className="mt-2 text-xl font-bold">{promptEditing.name}</h2>
                <p className="mt-2 text-xs leading-5 text-white/40">Thay đổi chỉ áp dụng cho dự án hiện tại, không làm thay đổi chủ đề gốc.</p>
              </div>
              <button onClick={() => setPromptEditing(null)} title="Đóng" className="rounded-lg p-2 text-white/35 hover:bg-white/5 hover:text-white"><X size={17} /></button>
            </div>
            <label className="mt-6 block text-xs font-semibold uppercase tracking-wide text-white/45">Master Prompt
              <textarea autoFocus rows={12} value={promptEditing.masterPrompt} onChange={(event) => setPromptEditing({ ...promptEditing, masterPrompt: event.target.value })} className="field-surface mt-2 w-full resize-y rounded-xl p-4 text-sm normal-case leading-7 tracking-normal text-white outline-none" />
            </label>
            <div className="mt-5">
              <p className="text-xs font-semibold uppercase tracking-wide text-white/45">Thumbnail</p>
              <div className="mt-2 flex items-center gap-4">
                <div className="flex h-24 w-40 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-white/10 bg-white/[0.03]">
                  {promptEditing.thumbnail ? <img src={promptEditing.thumbnail} alt="Thumbnail" className="h-full w-full object-cover" /> : <ImagePlus size={22} className="text-white/25" />}
                </div>
                <div className="flex flex-wrap gap-2">
                  <label className="cursor-pointer rounded-lg border border-white/10 px-3 py-2 text-xs font-semibold text-white/65 hover:border-emerald-400/35 hover:text-emerald-300">
                    {promptEditing.thumbnail ? 'Đổi ảnh' : 'Chọn ảnh'}
                    <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={async (event) => {
                      const file = event.target.files?.[0];
                      if (!file) return;
                      try { setPromptEditing({ ...promptEditing, thumbnail: await prepareThumbnail(file) }); }
                      catch (error) { alert(error instanceof Error ? error.message : 'Không thể xử lý ảnh.'); }
                      event.target.value = '';
                    }} />
                  </label>
                  {promptEditing.thumbnail && <button onClick={() => {
                    const original = topics.find((topic) => topic.id === promptEditing.id);
                    setPromptEditing({ ...promptEditing, thumbnail: promptEditing.source === 'system' ? original?.thumbnail : undefined });
                  }} className="rounded-lg px-3 py-2 text-xs text-white/40 hover:bg-red-500/10 hover:text-red-300">{promptEditing.source === 'system' ? 'Khôi phục mặc định' : 'Xóa ảnh'}</button>}
                </div>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setPromptEditing(null)} className="rounded-lg px-4 py-2 text-sm text-white/50 hover:bg-white/5">Hủy</button>
              <button onClick={() => { saveTopicCustomization(promptEditing); setPromptEditing(null); }} disabled={!promptEditing.masterPrompt.trim()} className="primary-action flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-bold disabled:opacity-40"><Save size={15} /> Lưu thay đổi</button>
            </div>
          </div>
        </div>
      )}

      {editing && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/75 p-5 backdrop-blur-sm" onMouseDown={() => setEditing(null)}>
          <div className="workspace-panel max-h-[88vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-[#181819] p-6" onMouseDown={(event) => event.stopPropagation()}>
            <h2 className="text-xl font-bold">Cấu hình chủ đề</h2>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <label className="text-xs text-white/45">Tên chủ đề<input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} className="field-surface mt-2 w-full rounded-lg px-3 py-2 text-sm text-white outline-none" /></label>
              <label className="text-xs text-white/45">Số từ mặc định<input type="number" min={300} value={editing.defaultWordCount} onChange={(e) => setEditing({ ...editing, defaultWordCount: Number(e.target.value) })} className="field-surface mt-2 w-full rounded-lg px-3 py-2 text-sm text-white outline-none" /></label>
              <label className="text-xs text-white/45 sm:col-span-2">Mô tả<input value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} className="field-surface mt-2 w-full rounded-lg px-3 py-2 text-sm text-white outline-none" /></label>
              <label className="text-xs text-white/45">Tông giọng<input value={editing.defaultTone} onChange={(e) => setEditing({ ...editing, defaultTone: e.target.value })} className="field-surface mt-2 w-full rounded-lg px-3 py-2 text-sm text-white outline-none" /></label>
              <label className="text-xs text-white/45">Khán giả mục tiêu<input value={editing.targetAudience} onChange={(e) => setEditing({ ...editing, targetAudience: e.target.value })} className="field-surface mt-2 w-full rounded-lg px-3 py-2 text-sm text-white outline-none" /></label>
              <label className="text-xs text-white/45 sm:col-span-2">Master Prompt<textarea rows={7} value={editing.masterPrompt} onChange={(e) => setEditing({ ...editing, masterPrompt: e.target.value })} className="field-surface mt-2 w-full rounded-lg p-3 text-sm leading-6 text-white outline-none" /></label>
              <label className="text-xs text-white/45 sm:col-span-2">Phong cách hình ảnh<textarea rows={2} value={editing.visualStyle} onChange={(e) => setEditing({ ...editing, visualStyle: e.target.value })} className="field-surface mt-2 w-full rounded-lg p-3 text-sm text-white outline-none" /></label>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setEditing(null)} className="rounded-lg px-4 py-2 text-sm text-white/50 hover:bg-white/5">Hủy</button>
              <button onClick={async () => { await saveTopic(editing); setTopic(editing); setEditing(null); }} className="primary-action flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-bold"><Save size={15} /> Lưu và sử dụng</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
