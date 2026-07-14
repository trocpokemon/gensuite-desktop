import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, CheckCircle2, Cloud, KeyRound, Loader2, RotateCcw, Sparkles, WandSparkles } from 'lucide-react';
import { EngineToggle } from '../components/EngineToggle';
import { useProjectStore } from '../store/projectStore';
import { useSettingsStore } from '../store/settingsStore';
import { getScriptProvider, listScriptModels, type ScriptModel } from '../providers/script';
import { missingKeyService, serviceLabel, errorMessage } from '../providers/errors';
import type { ScriptEngine } from '../shared/types';

interface Props { onOpenSettings: () => void; }

const ACTIONS = [
  ['Viết hay hơn', 'Viết lại trau chuốt, tự nhiên và cuốn hút hơn'],
  ['Cảm xúc hơn', 'Tăng chiều sâu cảm xúc nhưng không sáo rỗng'],
  ['Ngắn gọn', 'Rút gọn, loại bỏ ý lặp nhưng giữ đầy đủ thông tin quan trọng'],
  ['Mở rộng', 'Viết chi tiết hơn, thêm hình ảnh và kết nối ý tự nhiên'],
];

export function DirectorRoom({ onOpenSettings }: Props) {
  const project = useProjectStore((state) => state.project);
  const setIdea = useProjectStore((state) => state.setIdea);
  const setScriptContent = useProjectStore((state) => state.setScriptContent);
  const restoreScriptVersion = useProjectStore((state) => state.restoreScriptVersion);
  const approveScript = useProjectStore((state) => state.approveScript);
  const setStep = useProjectStore((state) => state.setStep);
  const patchSettings = useProjectStore((state) => state.patchSettings);
  const setScriptEngine = useProjectStore((state) => state.setScriptEngine);
  const setScriptModel = useProjectStore((state) => state.setScriptModel);
  const keys = useSettingsStore((state) => state.keys);
  const editor = useRef<HTMLTextAreaElement>(null);
  const selectionMenuRef = useRef<HTMLDivElement>(null);
  const selection = useRef({ start: 0, end: 0 });
  const [wordTarget, setWordTarget] = useState(project.topic?.defaultWordCount ?? 1500);
  const [busy, setBusy] = useState<'generate' | 'rewrite' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missingKey, setMissingKey] = useState<string | null>(null);
  const [instruction, setInstruction] = useState('');
  const [selectionMenu, setSelectionMenu] = useState<{ left: number; top: number } | null>(null);
  const [selectedRange, setSelectedRange] = useState({ start: 0, end: 0 });
  const [editorScroll, setEditorScroll] = useState(0);
  const [editorFocused, setEditorFocused] = useState(false);
  const [models, setModels] = useState<ScriptModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);

  const scriptEngine = project.settings.scriptEngine;
  const scriptModel = project.settings.scriptModel;

  const content = project.script.content;
  const words = useMemo(() => content.trim().split(/\s+/).filter(Boolean).length, [content]);
  const minutes = Math.max(0, words / 145);

  const autoGrow = () => {
    const el = editor.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  };

  useEffect(() => { autoGrow(); }, [content]);

  useEffect(() => {
    if (!selectionMenu) return;
    const closeWhenClickingOutside = (event: MouseEvent) => {
      if (!selectionMenuRef.current?.contains(event.target as Node)) setSelectionMenu(null);
    };
    document.addEventListener('mousedown', closeWhenClickingOutside);
    return () => document.removeEventListener('mousedown', closeWhenClickingOutside);
  }, [selectionMenu]);

  // Load the GenSuite model catalog once the cloud engine is selected and a key
  // exists. The picker only appears for the paid GenSuite engine.
  useEffect(() => {
    if (scriptEngine !== 'gensuite' || !keys.gensuiteApiKey?.trim()) return;
    let cancelled = false;
    setModelsLoading(true);
    setModelsError(null);
    listScriptModels(keys.gensuiteApiKey)
      .then((rows) => {
        if (cancelled) return;
        setModels(rows);
        // Default to the first model if none chosen yet or the saved one vanished.
        if (rows.length && !rows.some((m) => m.id === scriptModel)) {
          setScriptModel(rows[0].id);
        }
      })
      .catch((err) => { if (!cancelled) setModelsError(missingKeyService(err) ? 'MISSING_KEY:gensuite' : errorMessage(err)); })
      .finally(() => { if (!cancelled) setModelsLoading(false); });
    return () => { cancelled = true; };
  }, [scriptEngine, keys.gensuiteApiKey]);

  const run = async <T,>(work: () => Promise<T>): Promise<T | null> => {
    setError(null); setMissingKey(null);
    try { return await work(); }
    catch (err) {
      const service = missingKeyService(err);
      if (service) setMissingKey(service); else setError(errorMessage(err));
      return null;
    }
  };

  const generate = async () => {
    if (!project.topic) { setError('Hãy chọn chủ đề trước.'); return; }
    if (!project.idea.trim()) { setError('Hãy mô tả nội dung video bạn muốn viết.'); return; }
    setBusy('generate');
    const result = await run(() => getScriptProvider(project.settings.scriptEngine, keys, scriptModel).generateContent({
      idea: project.idea,
      tone: project.settings.tone,
      masterPrompt: project.topic!.masterPrompt,
      targetAudience: project.topic!.targetAudience,
      wordCount: wordTarget,
    }));
    if (result) setScriptContent(result, 'Trước khi AI tạo lại toàn bộ');
    setBusy(null);
  };

  const rewrite = async (request: string) => {
    const { start, end } = selection.current;
    const selectedText = content.slice(start, end);
    if (!selectedText.trim()) { setError('Hãy bôi đen một câu hoặc đoạn trong bài trước.'); return; }
    const savedEditorScroll = editor.current?.scrollTop ?? 0;
    const workspace = editor.current?.closest('main') as HTMLElement | null;
    const savedWorkspaceScroll = workspace?.scrollTop ?? 0;
    setBusy('rewrite');
    const replacement = await run(() => getScriptProvider(project.settings.scriptEngine, keys, scriptModel).rewriteSelection({
      fullContent: content, selectedText, instruction: request,
    }));
    if (replacement) {
      const next = content.slice(0, start) + replacement + content.slice(end);
      setScriptContent(next, `Trước khi AI sửa: ${request}`);
      setSelectionMenu(null);
      requestAnimationFrame(() => {
        const target = editor.current;
        target?.focus({ preventScroll: true });
        target?.setSelectionRange(start, start + replacement.length);
        if (target) target.scrollTop = savedEditorScroll;
        if (workspace) workspace.scrollTop = savedWorkspaceScroll;
        selection.current = { start, end: start + replacement.length };
        setSelectedRange({ start, end: start + replacement.length });
        setEditorScroll(savedEditorScroll);
        // Chromium may perform one more automatic caret scroll after selection.
        requestAnimationFrame(() => {
          if (target) target.scrollTop = savedEditorScroll;
          if (workspace) workspace.scrollTop = savedWorkspaceScroll;
        });
      });
    }
    setBusy(null);
  };

  if (!project.topic) {
    return <div className="mx-auto flex max-w-3xl flex-col items-center gap-4 p-12 text-center text-white/55"><p>Chưa có chủ đề cho dự án.</p><button onClick={() => setStep('topic')} className="primary-action rounded-xl px-5 py-3 font-bold">Chọn chủ đề</button></div>;
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-10 py-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.16em] text-emerald-400/80">Bước 02 · Nội dung</div>
          <h1 className="text-3xl font-bold tracking-[-0.04em]">Bàn biên tập</h1>
          <p className="mt-2 text-sm text-text/50">Viết một bài đọc liền mạch, chỉnh trực tiếp hoặc bôi đen để nhờ AI sửa đúng phần đó.</p>
        </div>
        <div className="rounded-xl border border-emerald-400/20 bg-emerald-400/5 px-4 py-2 text-right">
          <p className="text-xs font-bold text-emerald-300">{words.toLocaleString('vi-VN')} từ</p>
          <p className="text-[11px] text-white/35">Khoảng {minutes.toFixed(1)} phút đọc</p>
        </div>
      </header>

      <section className="workspace-panel grid gap-4 rounded-2xl p-5 lg:grid-cols-[1fr_280px]">
        <label className="text-xs font-semibold uppercase tracking-wide text-text/45">Ý tưởng video
          <textarea value={project.idea} onChange={(event) => setIdea(event.target.value)} rows={3} placeholder="Ví dụ: Một người phụ nữ phát hiện chồng mình âm thầm trả nợ cho mối tình đầu…" className="field-surface mt-2 w-full resize-y rounded-xl p-4 text-sm normal-case leading-6 tracking-normal text-white outline-none" />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="text-xs font-semibold uppercase tracking-wide text-text/45">Mục tiêu từ<input type="number" min={300} step={100} value={wordTarget} onChange={(e) => setWordTarget(Number(e.target.value))} className="field-surface mt-2 w-full rounded-xl px-3 py-3 text-sm normal-case text-white outline-none" /></label>
          <label className="text-xs font-semibold uppercase tracking-wide text-text/45">Tông giọng<input value={project.settings.tone} onChange={(e) => patchSettings({ tone: e.target.value })} className="field-surface mt-2 w-full rounded-xl px-3 py-3 text-sm normal-case text-white outline-none" /></label>
          <div className="col-span-2"><EngineToggle<ScriptEngine> label="Nguồn AI" value={project.settings.scriptEngine} onChange={setScriptEngine} options={[{ value: 'gemini', label: 'Gemini' }, { value: 'gensuite', label: 'GenSuite', premium: true, icon: <Cloud size={14} /> }]} /></div>
          {scriptEngine === 'gensuite' && (
            <label className="col-span-2 text-xs font-semibold uppercase tracking-wide text-text/45">Mô hình LLM
              <select
                value={scriptModel}
                onChange={(e) => setScriptModel(e.target.value)}
                disabled={modelsLoading || !models.length}
                className="field-surface mt-2 w-full rounded-xl px-3 py-3 text-sm normal-case text-white outline-none disabled:opacity-50"
              >
                {modelsLoading && <option className="bg-[#181819]">Đang tải danh sách model…</option>}
                {!modelsLoading && !models.length && <option className="bg-[#181819]">Chưa có model — kiểm tra API key</option>}
                {models.map((m) => (
                  <option key={m.id} value={m.id} className="bg-[#181819]">
                    {m.name} · {m.outputCreditsPerK} credits/1K
                  </option>
                ))}
              </select>
              {modelsError && !missingKeyService(modelsError) && <span className="mt-1 block text-[11px] normal-case text-red-300/80">{modelsError}</span>}
            </label>
          )}
        </div>
        <button onClick={generate} disabled={Boolean(busy)} className="primary-action flex items-center justify-center gap-2 rounded-xl px-5 py-3 font-bold lg:col-span-2 disabled:opacity-45">
          {busy === 'generate' ? <Loader2 size={18} className="animate-spin" /> : <Sparkles size={18} />}{content ? 'Tạo lại toàn bộ nội dung' : 'Viết nội dung'}
        </button>
      </section>

      {missingKey && <div className="flex items-center justify-between rounded-xl border border-amber-400/30 bg-amber-400/10 p-4 text-sm"><span className="flex items-center gap-2"><KeyRound size={16} /> Thiếu API key cho {serviceLabel(missingKey)}.</span><button onClick={onOpenSettings} className="rounded-lg bg-amber-300 px-3 py-2 text-xs font-bold text-black">Mở Cài đặt</button></div>}
      {error && <div className="rounded-xl border border-red-400/30 bg-red-500/10 p-4 text-sm text-red-200">{error}</div>}

      {content && (
        <section className="workspace-panel overflow-hidden rounded-2xl">
          <div className="relative">
            {selectionMenu && !editorFocused && selectedRange.end > selectedRange.start && (
              <div aria-hidden className="pointer-events-none absolute inset-0 z-0 overflow-hidden p-7 text-[15px] leading-8 text-transparent">
                <div className="whitespace-pre-wrap break-words" style={{ transform: `translateY(-${editorScroll}px)` }}>
                  {content.slice(0, selectedRange.start)}
                  <span className="rounded-sm bg-emerald-400/30 text-transparent">{content.slice(selectedRange.start, selectedRange.end)}</span>
                  {content.slice(selectedRange.end)}
                </div>
              </div>
            )}
            <textarea
              ref={editor} value={content} onChange={(event) => {
                const target = event.currentTarget;
                setScriptContent(target.value);
                setSelectionMenu(null);
                setSelectedRange({ start: target.selectionStart, end: target.selectionEnd });
              }}
              onSelect={(event) => {
                const target = event.currentTarget;
                const range = { start: target.selectionStart, end: target.selectionEnd };
                selection.current = range;
                setSelectedRange(range);
                if (range.start === range.end) setSelectionMenu(null);
              }}
              onMouseUp={(event) => {
                const target = event.currentTarget;
                const range = { start: target.selectionStart, end: target.selectionEnd };
                selection.current = range;
                setSelectedRange(range);
                if (range.start === range.end) { setSelectionMenu(null); return; }
                const width = Math.min(720, window.innerWidth - 32);
                const left = Math.max(16, Math.min(event.clientX - width / 2, window.innerWidth - width - 16));
                setSelectionMenu({ left, top: Math.max(100, event.clientY - 12) });
              }}
              onScroll={(event) => setEditorScroll(event.currentTarget.scrollTop)}
              onInput={autoGrow}
              onFocus={() => setEditorFocused(true)}
              onBlur={() => setEditorFocused(false)}
              spellCheck={false} rows={1} className="relative z-10 w-full resize-none overflow-hidden bg-transparent p-7 text-[15px] leading-8 text-white/90 outline-none"
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/8 px-5 py-3">
            <div className="flex items-center gap-2">
              <RotateCcw size={14} className="text-white/35" />
              <select defaultValue="" onChange={(event) => { if (event.target.value) restoreScriptVersion(event.target.value); event.target.value = ''; }} className="bg-transparent text-xs text-white/45 outline-none">
                <option value="" className="bg-[#181819]">Lịch sử phiên bản ({project.script.versions.length})</option>
                {[...project.script.versions].reverse().map((version) => <option key={version.id} value={version.id} className="bg-[#181819]">{version.label} · {new Date(version.createdAt).toLocaleTimeString('vi-VN')}</option>)}
              </select>
            </div>
            <span className={`flex items-center gap-1 text-xs ${project.script.status === 'approved' ? 'text-emerald-300' : 'text-white/35'}`}><CheckCircle2 size={14} /> {project.script.status === 'approved' ? 'Nội dung đã chốt' : 'Bản nháp đang tự lưu'}</span>
          </div>
        </section>
      )}

      {selectionMenu && (
        <div
          ref={selectionMenuRef}
          style={{ left: selectionMenu.left, top: selectionMenu.top, width: 'min(720px, calc(100vw - 32px))', transform: 'translateY(-100%)' }}
          className="fixed z-50 flex flex-wrap items-center gap-2 rounded-xl border border-emerald-400/25 bg-[#202021]/95 p-2.5 shadow-2xl backdrop-blur-xl"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <span className="mr-1 flex items-center gap-1 text-xs font-semibold text-white/45"><WandSparkles size={14} /> Sửa vùng chọn</span>
          {ACTIONS.map(([label, request]) => (
            <button key={label} disabled={Boolean(busy)} onMouseDown={(event) => event.preventDefault()} onClick={() => rewrite(request)} className="rounded-lg border border-white/10 px-3 py-1.5 text-xs hover:border-emerald-400/30 hover:bg-emerald-400/5 disabled:opacity-40">{label}</button>
          ))}
          <div className="flex min-w-[240px] flex-1 gap-2">
            <input value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="Yêu cầu riêng…" className="field-surface min-w-0 flex-1 rounded-lg px-3 py-1.5 text-xs outline-none" />
            <button disabled={!instruction.trim() || Boolean(busy)} onMouseDown={(event) => event.preventDefault()} onClick={() => rewrite(instruction)} className="rounded-lg bg-emerald-400/15 px-3 py-1.5 text-xs font-bold text-emerald-300 disabled:opacity-40">{busy === 'rewrite' ? 'Đang sửa…' : 'Áp dụng'}</button>
          </div>
        </div>
      )}

      {content && <div className="flex justify-end"><button onClick={approveScript} className="primary-action flex items-center gap-2 rounded-xl px-5 py-3 font-bold">Chốt nội dung và tạo Storyboard <ArrowRight size={17} /></button></div>}
    </div>
  );
}
