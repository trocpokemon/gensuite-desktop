import { useEffect, useState } from 'react';
import { Download, Loader2, RefreshCw, X } from 'lucide-react';
import type { UpdaterStatus } from '../shared/types';

// Subscribes to the auto-updater lifecycle and surfaces a slim banner when an
// update is available, downloading, or ready to install. Silent otherwise —
// checking / not-available / error never block the app.
export function UpdateBanner() {
  const [status, setStatus] = useState<UpdaterStatus>({ kind: 'not-available' });
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    return window.gensuite?.updater?.onStatus((next) => {
      setStatus(next);
      // A fresh available/downloaded event should reappear even after dismissal.
      if (next.kind === 'available' || next.kind === 'downloaded') setDismissed(false);
    });
  }, []);

  if (dismissed) return null;
  if (status.kind !== 'available' && status.kind !== 'downloading' && status.kind !== 'downloaded') return null;

  return (
    <div className="no-drag flex items-center gap-md border-b border-emerald-400/15 bg-emerald-400/[0.07] px-lg py-2 text-[13px] text-white/75 backdrop-blur">
      {status.kind === 'available' && (
        <>
          <Download size={16} className="shrink-0 text-emerald-400" />
          <span className="flex-1">Có bản cập nhật mới (v{status.version}). Tải về để cập nhật.</span>
          <button
            onClick={() => window.gensuite.updater.download()}
            className="no-drag inline-flex cursor-pointer items-center gap-xs rounded-lg bg-emerald-400 px-md py-1.5 font-bold text-black transition-all duration-200 hover:bg-emerald-300"
          >
            <Download size={14} /> Tải về
          </button>
        </>
      )}

      {status.kind === 'downloading' && (
        <>
          <Loader2 size={16} className="shrink-0 animate-spin text-emerald-400" />
          <span className="flex-1">Đang tải bản cập nhật… {status.percent}%</span>
          <div className="h-1.5 w-40 overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full bg-emerald-400 transition-all" style={{ width: `${status.percent}%` }} />
          </div>
        </>
      )}

      {status.kind === 'downloaded' && (
        <>
          <RefreshCw size={16} className="shrink-0 text-emerald-400" />
          <span className="flex-1">Bản cập nhật (v{status.version}) đã sẵn sàng.</span>
          <button
            onClick={() => window.gensuite.updater.install()}
            className="no-drag inline-flex cursor-pointer items-center gap-xs rounded-lg bg-emerald-400 px-md py-1.5 font-bold text-black transition-all duration-200 hover:bg-emerald-300"
          >
            <RefreshCw size={14} /> Khởi động lại & cập nhật
          </button>
        </>
      )}

      {status.kind !== 'downloading' && (
        <button
          onClick={() => setDismissed(true)}
          aria-label="Đóng"
          className="no-drag cursor-pointer rounded p-xs text-text/60 transition-colors duration-200 hover:text-text"
        >
          <X size={16} />
        </button>
      )}
    </div>
  );
}
