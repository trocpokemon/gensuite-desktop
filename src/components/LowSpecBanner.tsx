import { useEffect, useState } from 'react';
import { Cpu, X, Zap } from 'lucide-react';
import type { HardwareInfo } from '../shared/types';

// Shown on top of the workspace when VRAM < 6GB. Nudges the user toward Cloud
// mode instead of slow local media generation.
export function LowSpecBanner({ onGoCloud }: { onGoCloud?: () => void }) {
  const [hw, setHw] = useState<HardwareInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    window.gensuite?.hardware.scan().then(setHw).catch(() => setHw(null));
  }, []);

  if (!hw?.lowSpec || dismissed) return null;

  return (
    <div className="no-drag flex items-center gap-md border-b border-amber-400/15 bg-amber-400/[0.07] px-lg py-2 text-[13px] text-white/70 backdrop-blur">
      <Cpu size={16} className="shrink-0 text-amber-400" />
      <span className="flex-1">
        Phát hiện phần cứng giới hạn
        {hw.vramMB > 0 ? ` (VRAM ~${(hw.vramMB / 1024).toFixed(1)}GB)` : ''}. Chạy Local cho
        Media/Voice sẽ rất chậm. Hãy thử Cloud Mode để xử lý tức thì.
      </span>
      {onGoCloud && (
        <button
          onClick={onGoCloud}
          className="no-drag inline-flex cursor-pointer items-center gap-xs rounded-lg bg-amber-400 px-md py-1.5 font-bold text-black transition-all duration-200 hover:bg-amber-300"
        >
          <Zap size={14} /> Bật Cloud Mode
        </button>
      )}
      <button
        onClick={() => setDismissed(true)}
        aria-label="Đóng"
        className="no-drag cursor-pointer rounded p-xs text-text/60 transition-colors duration-200 hover:text-text"
      >
        <X size={16} />
      </button>
    </div>
  );
}
