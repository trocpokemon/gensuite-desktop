import { Loader2, Minus, RefreshCw, Settings as SettingsIcon, Square, X } from 'lucide-react';
import { useEntitlementStore, type AccountTier } from '../store/entitlementStore';
import { useUpdateStore } from '../store/updateStore';

const TIER_LABELS: Record<AccountTier, string> = {
  free: 'Free', starter: 'Starter', basic: 'Basic', standard: 'Standard', pro: 'Pro',
};

// Custom frameless title bar. The draggable region is marked via the
// app-region CSS (see index.css); buttons opt out so they stay clickable.
export function TitleBar({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const w = window.gensuite?.window;
  const entitlementStatus = useEntitlementStore((state) => state.status);
  const tier = useEntitlementStore((state) => state.tier);
  const credits = useEntitlementStore((state) => state.credits);
  const updateStatus = useUpdateStore((state) => state.status);
  const openUpdateChecker = useUpdateStore((state) => state.openChecker);

  return (
    <div className="titlebar drag flex h-10 shrink-0 items-center justify-between border-b border-white/[0.07] bg-[#171718]/95 px-4 backdrop-blur-xl">
      <div className="flex select-none items-baseline font-sans text-white">
        <span className="text-[15px] font-extrabold tracking-[-0.04em]">GENSUITE</span>
        <span className="ml-1.5 text-[9px] font-bold uppercase tracking-[0.14em] text-teal-300/75">Desktop</span>
        <span className="ml-2 text-[10px] font-medium tabular-nums text-white/30">v{__APP_VERSION__}</span>
      </div>
      <div className="titlebar-controls no-drag flex min-w-0 items-center gap-xs">
        {entitlementStatus === 'ready' && (
          <div className="mr-2 flex h-7 items-center gap-1.5 rounded-lg border border-emerald-300/[0.12] bg-emerald-300/[0.045] px-2.5 text-[9px] font-semibold shadow-[inset_0_1px_0_rgba(255,255,255,0.025)]">
            <span className="text-emerald-300/90">{TIER_LABELS[tier]}</span>
            <span className="text-white/15">•</span>
            <span className="tabular-nums text-white/40">{credits.toLocaleString('vi-VN')} credits</span>
          </div>
        )}
        <button
          type="button"
          onClick={openUpdateChecker}
          disabled={updateStatus.kind === 'checking'}
          className="grid h-7 w-9 place-items-center rounded-md text-white/45 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 disabled:cursor-wait disabled:opacity-60"
          aria-label={updateStatus.kind === 'checking' ? 'Đang kiểm tra cập nhật' : 'Kiểm tra cập nhật'}
          title={updateStatus.kind === 'checking' ? 'Đang kiểm tra cập nhật…' : 'Kiểm tra cập nhật'}
        >
          {updateStatus.kind === 'checking' ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
        </button>
        {onOpenSettings && (
          <button
            onClick={onOpenSettings}
            className="mr-1 grid h-7 w-9 place-items-center rounded-md text-white/45 transition-colors hover:bg-white/10 hover:text-white"
            aria-label="Cài đặt"
            title="Cài đặt"
          >
            <SettingsIcon size={15} />
          </button>
        )}
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
