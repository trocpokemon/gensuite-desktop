import { Minus, Square, X } from 'lucide-react';

// Custom frameless title bar. The draggable region is marked via the
// app-region CSS (see index.css); buttons opt out so they stay clickable.
export function TitleBar() {
  const w = window.gensuite?.window;
  return (
    <div className="titlebar drag flex h-10 shrink-0 items-center justify-between border-b border-white/[0.07] bg-[#171718]/95 px-4 backdrop-blur-xl">
      <div className="flex select-none items-baseline font-sans text-white">
        <span className="text-[15px] font-extrabold tracking-[-0.04em]">GENSUITE</span>
        <span className="ml-1.5 text-[9px] font-bold uppercase tracking-[0.14em] text-teal-300/75">Desktop</span>
        <span className="ml-2 text-[10px] font-medium tabular-nums text-white/30">v{__APP_VERSION__}</span>
      </div>
      <div className="titlebar-controls no-drag flex items-center gap-xs">
        <button
          onClick={() => w?.minimize()}
          className="grid h-7 w-9 place-items-center rounded-md text-white/45 transition-colors hover:bg-white/10 hover:text-white"
          aria-label="Thu nhỏ"
        >
          <Minus size={15} />
        </button>
        <button
          onClick={() => w?.toggleMaximize()}
          className="grid h-7 w-9 place-items-center rounded-md text-white/45 transition-colors hover:bg-white/10 hover:text-white"
          aria-label="Phóng to"
        >
          <Square size={13} />
        </button>
        <button
          onClick={() => w?.close()}
          className="grid h-7 w-9 place-items-center rounded-md text-white/45 transition-colors hover:bg-red-500/80 hover:text-white"
          aria-label="Đóng"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}
