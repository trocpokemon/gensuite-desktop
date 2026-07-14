import { useEffect, useRef, useState } from 'react';
import { Film, Loader2, FolderOpen, AlertTriangle, Captions, ChevronDown, Music, X } from 'lucide-react';
import { useProjectStore } from '../store/projectStore';
import { errorMessage } from '../providers/errors';
import type { ExportScene, SubtitleConfig, SubtitlePosition, MusicConfig } from '../shared/types';
import { localFileUrl } from '../shared/localFile';

// A curated set of families that ship with Windows and render Vietnamese well.
const FONT_CHOICES = ['Arial', 'Segoe UI', 'Tahoma', 'Verdana', 'Times New Roman', 'Georgia', 'Calibri', 'Roboto'];
// CJK-capable families for Chinese/Japanese/Korean captions. Names match CJK_FONTS
// in electron/ipc/ffmpeg.ts.
const CJK_FONT_CHOICES = ['Microsoft YaHei', 'SimHei', 'SimSun', 'PingFang SC', 'Noto Sans CJK SC', 'Malgun Gothic', 'Yu Gothic', 'Meiryo'];
const POSITION_LABELS: Record<SubtitlePosition, string> = { top: 'Trên', middle: 'Giữa', bottom: 'Dưới' };
const SAMPLE_CAPTION = 'Phụ đề mẫu — chữ hiển thị đúng như thế này khi xuất video.';

// Mirror the main-process wrapCaption so the preview breaks lines the same way
// the burned-in subtitle will.
function wrapPreview(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) return text;
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (!current) current = word;
    else if (current.length + 1 + word.length <= maxChars) current += ` ${word}`;
    else { lines.push(current); current = word; }
  }
  if (current) lines.push(current);
  return lines.join('\n');
}

// A live approximation of the burned-in caption so tweaking the options has an
// immediate visual reference. It is not pixel-exact with libass (outline is
// faked with layered text-shadows) but tracks font, size, colour, outline,
// shadow, weight, position and line-wrap faithfully enough to judge by.
function SubtitlePreview({ sub, ratio, bgImage, bgIsVideo }: { sub: SubtitleConfig; ratio: '16:9' | '9:16'; bgImage?: string; bgIsVideo?: boolean }) {
  const portrait = ratio === '9:16';
  // Fixed preview stage height; width follows the aspect ratio.
  const stageH = portrait ? 260 : 190;
  const stageW = portrait ? (stageH * 9) / 16 : (stageH * 16) / 9;
  // Font size is authored as a % of video height; mirror that against the stage.
  const fontPx = Math.max(8, (stageH * sub.fontSizePct) / 100);
  // Outline/shadow are authored at 1080p; scale to the stage the same way export does.
  const scale = stageH / 1080;
  const outlinePx = sub.outlineWidth * scale;
  const shadowPx = sub.shadow * scale;

  const o = sub.outlineColor;
  const step = Math.max(0.5, outlinePx);
  const outlineShadow = outlinePx > 0
    ? [
        `-${step}px 0 ${o}`, `${step}px 0 ${o}`, `0 -${step}px ${o}`, `0 ${step}px ${o}`,
        `-${step}px -${step}px ${o}`, `${step}px -${step}px ${o}`, `-${step}px ${step}px ${o}`, `${step}px ${step}px ${o}`,
      ].join(', ')
    : '';
  const dropShadow = shadowPx > 0 ? `${shadowPx}px ${shadowPx}px ${shadowPx}px rgba(0,0,0,0.9)` : '';
  const textShadow = [outlineShadow, dropShadow].filter(Boolean).join(', ') || 'none';

  const justify = sub.position === 'top' ? 'flex-start' : sub.position === 'middle' ? 'center' : 'flex-end';
  const marginV = stageH * 0.07;

  const bgUrl = localFileUrl(bgImage);

  return (
    <div className="col-span-2 flex flex-col gap-xs">
      <span className="text-text/50">Xem trước</span>
      <div className="flex justify-center rounded-lg border border-white/10 bg-black/40 p-sm">
        <div
          className="relative overflow-hidden rounded-md"
          style={{
            width: stageW,
            height: stageH,
            background: 'linear-gradient(135deg, #2a2a35, #14141c)',
          }}
        >
          {bgUrl && (bgIsVideo ? (
            <video
              src={bgUrl}
              muted
              playsInline
              preload="metadata"
              onLoadedMetadata={(event) => {
                const video = event.currentTarget;
                const duration = Number.isFinite(video.duration) ? video.duration : 0;
                video.currentTime = duration > 0
                  ? Math.min(Math.max(duration * 0.12, 0.5), Math.max(duration - 0.1, 0))
                  : 0.5;
              }}
              className="absolute inset-0 h-full w-full object-cover"
            />
          ) : (
            <img src={bgUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
          ))}
          <div
            className="absolute inset-0 flex px-[6%]"
            style={{ alignItems: justify, justifyContent: 'center', paddingTop: marginV, paddingBottom: marginV }}
          >
            <span
              style={{
                fontFamily: `"${sub.fontFamily}", sans-serif`,
                fontSize: fontPx,
                lineHeight: 1.2,
                fontWeight: sub.bold ? 700 : 400,
                color: sub.primaryColor,
                textShadow,
                textAlign: 'center',
                whiteSpace: 'pre-line',
                textWrap: 'balance',
              }}
            >
              {wrapPreview(SAMPLE_CAPTION, sub.maxCharsPerLine)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

// Final step: line up each scene's image with its audio, then mux to MP4 via the
// bundled FFmpeg (main process). On success the drafts are cleaned and the file
// is revealed in the OS file manager.
export function Timeline() {
  const project = useProjectStore((s) => s.project);
  const setStep = useProjectStore((s) => s.setStep);
  const patchSettings = useProjectStore((s) => s.patchSettings);
  const sub = project.settings.subtitle;
  const patchSub = (patch: Partial<SubtitleConfig>) =>
    patchSettings({ subtitle: { ...sub, ...patch } });
  const music = project.settings.music;
  const patchMusic = (patch: Partial<MusicConfig>) =>
    patchSettings({ music: { ...music, ...patch } });

  const [exporting, setExporting] = useState(false);
  const [importingMusic, setImportingMusic] = useState(false);
  const [showSubOptions, setShowSubOptions] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outputPath, setOutputPath] = useState<string | null>(null);
  const [progressSec, setProgressSec] = useState(0);
  const [progressTotalSec, setProgressTotalSec] = useState(0);
  const [exportPhase, setExportPhase] = useState<'preparing' | 'encoding' | 'complete'>('preparing');
  const unsub = useRef<(() => void) | null>(null);

  const totalDuration = project.scenes.reduce((sum, s) => sum + (s.audioDuration ?? 0), 0);
  const previewScene = project.scenes.find((s) => s.imagePath && s.visualType !== 'stock-video' && s.visualType !== 'ai-video')
    ?? project.scenes.find((s) => s.imagePath);
  const previewBg = previewScene?.imagePath;
  const previewIsVideo = previewScene?.visualType === 'stock-video' || previewScene?.visualType === 'ai-video';

  const ready =
    project.scenes.length > 0 &&
    project.scenes.every((s) => s.imagePath && s.audioPath);

  useEffect(() => {
    unsub.current = window.gensuite.ffmpeg.onProgress((p) => {
      if (p.projectId !== project.id) return;
      setProgressSec(p.timeSec);
      if (p.totalSec && p.totalSec > 0) setProgressTotalSec(p.totalSec);
      if (p.phase) setExportPhase(p.phase);
    });
    return () => unsub.current?.();
  }, [project.id]);

  const doExport = async () => {
    if (!ready) return;
    setExporting(true);
    setError(null);
    setOutputPath(null);
    setProgressSec(0);
    setProgressTotalSec(0);
    setExportPhase('preparing');
    try {
      const scenes: ExportScene[] = project.scenes.map((s) => ({
        id: s.id,
        imagePath: s.imagePath!,
        visualType: s.visualType,
        audioPath: s.audioPath!,
        durationSec: s.audioDuration && s.audioDuration > 0 ? s.audioDuration : 0,
        narration: s.narration,
      }));

      const out = await window.gensuite.ffmpeg.export({
        projectId: project.id,
        scenes,
        ratio: project.settings.aspectRatio,
        subtitles: sub.enabled,
        subtitleConfig: sub,
        musicPath: music.enabled ? music.audioPath : undefined,
        musicVolume: music.volume,
      });

      if (!out) {
        // User cancelled the save dialog.
        setExporting(false);
        return;
      }

      setOutputPath(out);
      // Keep source media/audio so the project remains editable and previewable
      // after export. Cleanup must only happen through an explicit user action.
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setExporting(false);
    }
  };

  const importMusic = async () => {
    setImportingMusic(true);
    setError(null);
    try {
      const result = await window.gensuite.music.import(project.id);
      if (result) patchMusic({ enabled: true, audioPath: result.audioPath, fileName: result.fileName });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setImportingMusic(false);
    }
  };

  const removeMusic = () =>
    patchMusic({ enabled: false, audioPath: undefined, fileName: undefined });

  if (project.scenes.length === 0) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col items-center gap-md p-2xl text-center text-text/60">
        <p>Chưa có phân cảnh nào. Hãy hoàn tất các bước trước.</p>
        <button
          onClick={() => setStep('content')}
          className="cursor-pointer rounded-lg bg-cta px-lg py-sm font-semibold text-white transition-opacity hover:opacity-90"
        >
          Về Nội dung
        </button>
      </div>
    );
  }

  const measuredTotalDuration = progressTotalSec > 0 ? progressTotalSec : totalDuration;
  const pct = measuredTotalDuration > 0 ? Math.min(100, Math.round((progressSec / measuredTotalDuration) * 100)) : 0;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-10 py-12">
      <header className="flex flex-col gap-xs">
        <div className="mb-1 text-[11px] font-bold uppercase tracking-[0.16em] text-emerald-400/80">Bước 05 · Xuất video</div>
        <h1 className="text-3xl font-bold tracking-[-0.04em]">Dựng video</h1>
        <p className="text-sm text-text/60">
          Media và giọng đọc được khớp theo dòng thời gian. Bấm xuất để ghép thành file MP4.
        </p>
      </header>

      {/* Timeline preview: one row per scene, width ∝ audio duration. */}
      <div className="workspace-panel flex flex-col gap-sm rounded-2xl p-lg">
        <div className="flex items-center justify-between text-xs text-text/50">
          <span>Dòng thời gian ({project.scenes.length} phân cảnh)</span>
          <span>{(measuredTotalDuration || totalDuration).toFixed(1)}s · {project.settings.aspectRatio}</span>
        </div>
        <div className="flex gap-1 overflow-hidden rounded-lg">
          {project.scenes.map((s, i) => {
            const w = totalDuration > 0 ? ((s.audioDuration ?? 0) / totalDuration) * 100 : 100 / project.scenes.length;
            const missing = !s.imagePath || !s.audioPath;
            return (
              <div
                key={s.id}
                style={{ width: `${w}%` }}
                title={`Phân cảnh ${i + 1}${missing ? ' (thiếu tài nguyên)' : ''}`}
                className={`relative h-16 min-w-[24px] overflow-hidden rounded-md border ${
                  missing ? 'border-red-400/60 bg-red-500/20' : 'border-white/10'
                }`}
              >
                {s.imagePath && (s.visualType === 'stock-video' || s.visualType === 'ai-video' ?
                  <video
                    src={localFileUrl(s.imagePath)}
                    muted
                    playsInline
                    preload="metadata"
                    onLoadedMetadata={(event) => {
                      const video = event.currentTarget;
                      const duration = Number.isFinite(video.duration) ? video.duration : 0;
                      // Stock videos frequently begin with a black transition.
                      // Seek once to a representative frame without autoplaying
                      // every clip in the timeline.
                      video.currentTime = duration > 0
                        ? Math.min(Math.max(duration * 0.12, 0.5), Math.max(duration - 0.1, 0))
                        : 0.5;
                    }}
                    className="h-full w-full object-cover opacity-80"
                  /> :
                  <img src={localFileUrl(s.imagePath)} alt={`scene ${i + 1}`} className="h-full w-full object-cover opacity-80" />
                )}
                <span className="absolute bottom-0 left-0 bg-black/50 px-1 text-[10px]">{i + 1}</span>
              </div>
            );
          })}
        </div>
      </div>

      {!ready && (
        <div className="flex items-center gap-sm rounded-lg border border-amber-400/40 bg-amber-500/10 p-md text-sm text-amber-200">
          <AlertTriangle size={16} /> Một số phân cảnh còn thiếu media hoặc giọng đọc. Hãy hoàn tất Storyboard và Giọng đọc.
        </div>
      )}

      {exporting && (
        <div className="flex flex-col gap-xs">
          <div className="h-2 overflow-hidden rounded-full bg-white/10">
            {exportPhase === 'preparing' || measuredTotalDuration <= 0 ?
              <div className="h-full w-1/3 animate-pulse rounded-full bg-gradient-to-r from-transparent via-cta to-transparent" /> :
              <div className="h-full bg-cta transition-all duration-300" style={{ width: `${pct}%` }} />}
          </div>
          <span className="text-xs text-text/50">{exportPhase === 'preparing' ? 'Đang phân tích thời lượng media và audio…' : progressSec <= 0 ? 'Đang khởi tạo bộ mã hóa…' : `Đang dựng… ${pct}%`}</span>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-400/40 bg-red-500/10 p-md text-sm text-red-200">{error}</div>
      )}

      {outputPath && (
        <div className="flex items-center gap-sm rounded-lg border border-emerald-400/40 bg-emerald-500/10 p-md text-sm text-emerald-200">
          <FolderOpen size={16} className="shrink-0" />
          <span className="truncate">Đã xuất &amp; mở thư mục: {outputPath}</span>
        </div>
      )}

      <div className="flex flex-col rounded-lg border border-white/10 bg-white/[0.03]">
        <div className="flex items-center gap-sm p-md text-sm text-text/80">
          <label className="flex flex-1 cursor-pointer items-center gap-sm">
            <input
              type="checkbox"
              checked={sub.enabled}
              onChange={(event) => patchSub({ enabled: event.target.checked })}
              disabled={exporting}
              className="size-4 cursor-pointer accent-cta"
            />
            <Captions size={16} className="text-text/60" />
            <span>Chèn phụ đề (ghi cứng lời đọc vào video)</span>
          </label>
          <button
            type="button"
            onClick={() => setShowSubOptions((v) => !v)}
            disabled={!sub.enabled}
            className="flex items-center gap-xs rounded-md px-sm py-xs text-xs text-text/60 transition-colors hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
          >
            Tùy chỉnh
            <ChevronDown size={14} className={`transition-transform ${showSubOptions ? 'rotate-180' : ''}`} />
          </button>
        </div>

        {sub.enabled && showSubOptions && (
          <div className="grid grid-cols-2 gap-md border-t border-white/10 p-md text-xs">
            <SubtitlePreview sub={sub} ratio={project.settings.aspectRatio} bgImage={previewBg} bgIsVideo={previewIsVideo} />

            <label className="flex flex-col gap-xs">
              <span className="text-text/50">Phông chữ</span>
              <select
                value={sub.fontFamily}
                onChange={(event) => patchSub({ fontFamily: event.target.value })}
                className="rounded-md border border-white/10 bg-white/5 px-sm py-xs text-text"
              >
                <optgroup label="Latin / Tiếng Việt" className="bg-[#1a1a1a] text-white">
                  {FONT_CHOICES.map((f) => <option key={f} value={f} className="bg-[#1a1a1a] text-white">{f}</option>)}
                </optgroup>
                <optgroup label="CJK (Trung / Nhật / Hàn)" className="bg-[#1a1a1a] text-white">
                  {CJK_FONT_CHOICES.map((f) => <option key={f} value={f} className="bg-[#1a1a1a] text-white">{f}</option>)}
                </optgroup>
              </select>
            </label>

            <label className="flex flex-col gap-xs">
              <span className="text-text/50">Vị trí</span>
              <select
                value={sub.position}
                onChange={(event) => patchSub({ position: event.target.value as SubtitlePosition })}
                className="rounded-md border border-white/10 bg-white/5 px-sm py-xs text-text"
              >
                {(Object.keys(POSITION_LABELS) as SubtitlePosition[]).map((p) =>
                  <option key={p} value={p} className="bg-[#1a1a1a] text-white">{POSITION_LABELS[p]}</option>)}
              </select>
            </label>

            <label className="flex flex-col gap-xs">
              <span className="text-text/50">Cỡ chữ ({sub.fontSizePct}% chiều cao)</span>
              <input
                type="range" min={2} max={12} step={0.5}
                value={sub.fontSizePct}
                onChange={(event) => patchSub({ fontSizePct: Number(event.target.value) })}
                className="accent-cta"
              />
            </label>

            <label className="flex flex-col gap-xs">
              <span className="text-text/50">Độ dày viền ({sub.outlineWidth}px)</span>
              <input
                type="range" min={0} max={8} step={1}
                value={sub.outlineWidth}
                onChange={(event) => patchSub({ outlineWidth: Number(event.target.value) })}
                className="accent-cta"
              />
            </label>

            <label className="flex flex-col gap-xs">
              <span className="text-text/50">Đổ bóng ({sub.shadow}px)</span>
              <input
                type="range" min={0} max={6} step={1}
                value={sub.shadow}
                onChange={(event) => patchSub({ shadow: Number(event.target.value) })}
                className="accent-cta"
              />
            </label>

            <label className="flex flex-col gap-xs">
              <span className="text-text/50">Độ rộng tối đa / dòng ({sub.maxCharsPerLine || 'không giới hạn'} · chữ CJK tính gấp đôi)</span>
              <input
                type="range" min={0} max={80} step={1}
                value={sub.maxCharsPerLine}
                onChange={(event) => patchSub({ maxCharsPerLine: Number(event.target.value) })}
                className="accent-cta"
              />
            </label>

            <label className="flex items-center gap-sm">
              <span className="text-text/50">Màu chữ</span>
              <input
                type="color"
                value={sub.primaryColor}
                onChange={(event) => patchSub({ primaryColor: event.target.value })}
                className="h-7 w-10 cursor-pointer rounded border border-white/10 bg-transparent"
              />
            </label>

            <label className="flex items-center gap-sm">
              <span className="text-text/50">Màu viền</span>
              <input
                type="color"
                value={sub.outlineColor}
                onChange={(event) => patchSub({ outlineColor: event.target.value })}
                className="h-7 w-10 cursor-pointer rounded border border-white/10 bg-transparent"
              />
            </label>

            <label className="col-span-2 flex cursor-pointer items-center gap-sm">
              <input
                type="checkbox"
                checked={sub.bold}
                onChange={(event) => patchSub({ bold: event.target.checked })}
                className="size-4 cursor-pointer accent-cta"
              />
              <span className="text-text/70">In đậm</span>
            </label>
          </div>
        )}
      </div>

      <div className="flex flex-col rounded-lg border border-white/10 bg-white/[0.03]">
        <div className="flex items-center gap-sm p-md text-sm text-text/80">
          <Music size={16} className="text-text/60" />
          <span className="flex-1">Nhạc nền</span>
          {music.audioPath ? (
            <div className="flex items-center gap-sm">
              <span className="max-w-[220px] truncate text-xs text-text/50" title={music.fileName}>{music.fileName}</span>
              <button
                type="button"
                onClick={removeMusic}
                disabled={exporting}
                className="rounded-md p-xs text-text/50 transition-colors hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-40"
                title="Gỡ nhạc"
              >
                <X size={16} />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={importMusic}
              disabled={exporting || importingMusic}
              className="flex items-center gap-xs rounded-md border border-white/10 px-sm py-xs text-xs text-text/70 transition-colors hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
            >
              {importingMusic ? <Loader2 size={14} className="animate-spin" /> : <FolderOpen size={14} />}
              Chọn file nhạc
            </button>
          )}
        </div>

        {music.audioPath && (
          <div className="flex flex-col gap-xs border-t border-white/10 p-md text-xs">
            <label className="flex cursor-pointer items-center gap-sm">
              <input
                type="checkbox"
                checked={music.enabled}
                onChange={(event) => patchMusic({ enabled: event.target.checked })}
                disabled={exporting}
                className="size-4 cursor-pointer accent-cta"
              />
              <span className="text-text/70">Trộn nhạc nền vào video (lặp và nhỏ dần ở cuối)</span>
            </label>
            <label className="flex flex-col gap-xs">
              <span className="text-text/50">Âm lượng nhạc ({music.volume}%)</span>
              <input
                type="range" min={0} max={100} step={1}
                value={music.volume}
                onChange={(event) => patchMusic({ volume: Number(event.target.value) })}
                disabled={!music.enabled}
                className="accent-cta disabled:opacity-40"
              />
            </label>
          </div>
        )}
      </div>

      <button
        onClick={doExport}
        disabled={!ready || exporting}
        className="primary-action flex items-center justify-center gap-sm rounded-xl px-lg py-md font-bold transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {exporting ? <Loader2 size={18} className="animate-spin" /> : <Film size={18} />}
        {exporting ? 'Đang xuất video…' : 'Xuất video hoàn chỉnh'}
      </button>
    </div>
  );
}
