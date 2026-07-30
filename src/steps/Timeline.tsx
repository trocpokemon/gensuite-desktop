import { useEffect, useRef, useState } from 'react';
import { Film, Loader2, FolderOpen, AlertTriangle, Captions, Music, X } from 'lucide-react';
import { useProjectStore } from '../store/projectStore';
import { errorMessage } from '../providers/errors';
import type { ExportScene, SubtitleConfig, MusicConfig } from '../shared/types';
import { SubtitleDesigner } from '../components/SubtitleDesigner';
import { localFileUrl } from '../shared/localFile';
import { alignSceneSubtitle, hasFreshSubtitleTiming } from '../shared/subtitleAlignment';

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
  const [error, setError] = useState<string | null>(null);
  const [outputPath, setOutputPath] = useState<string | null>(null);
  const [progressSec, setProgressSec] = useState(0);
  const [progressTotalSec, setProgressTotalSec] = useState(0);
  const [exportPhase, setExportPhase] = useState<'preparing' | 'encoding' | 'complete'>('preparing');
  const [alignmentProgress, setAlignmentProgress] = useState({ done: 0, total: 0 });
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
      const voiceLanguage = project.settings.voiceConfigs[project.settings.voiceEngine]?.language;
      setAlignmentProgress({ done: 0, total: sub.enabled ? project.scenes.length : 0 });
      const scenes: ExportScene[] = [];
      for (let index = 0; index < project.scenes.length; index += 1) {
        const scene = project.scenes[index];
        const wordTimings = sub.enabled
          ? await alignSceneSubtitle(scene, project.id, voiceLanguage)
          : undefined;
        if (sub.enabled && !hasFreshSubtitleTiming(scene)) {
          useProjectStore.getState().updateScene(scene.id, {
            subtitleWords: wordTimings,
            subtitleTimingText: scene.narration,
            subtitleTimingAudioPath: scene.audioPath,
          });
        }
        scenes.push({
          id: scene.id,
          imagePath: scene.imagePath!,
          visualType: scene.visualType,
          audioPath: scene.audioPath!,
          durationSec: scene.audioDuration && scene.audioDuration > 0 ? scene.audioDuration : 0,
          narration: scene.narration,
          wordTimings,
        });
        if (sub.enabled) setAlignmentProgress({ done: index + 1, total: project.scenes.length });
      }

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
          <span className="text-xs text-text/50">{alignmentProgress.total > 0 && alignmentProgress.done < alignmentProgress.total ? `Đang căn phụ đề với lời đọc ${alignmentProgress.done}/${alignmentProgress.total}…` : exportPhase === 'preparing' ? 'Đang phân tích thời lượng media và audio…' : progressSec <= 0 ? 'Đang chuẩn bị video…' : `Đang dựng… ${pct}%`}</span>
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
            <span>Chèn phụ đề theo nhịp lời đọc</span>
          </label>
        </div>

        {sub.enabled && (
          <div className="border-t border-white/10 p-md">
            <SubtitleDesigner config={sub} onChange={(next) => patchSettings({ subtitle: next })} ratio={project.settings.aspectRatio} backgroundPath={previewBg} backgroundIsVideo={previewIsVideo} />
            <p className="mt-3 text-xs leading-5 text-white/40">Mỗi màn hình chỉ giữ một cụm ngắn; từ đang được đọc sẽ đổi màu để người xem bắt nhịp nhanh hơn.</p>
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
