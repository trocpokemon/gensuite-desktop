import { LogOut, Minus, Settings as SettingsIcon, Square, X } from 'lucide-react';
import { useAuthStore } from '../store/authStore';
import { useEntitlementStore, type AccountTier } from '../store/entitlementStore';

const TIER_LABELS: Record<AccountTier, string> = {
  free: 'Free', starter: 'Starter', basic: 'Basic', standard: 'Standard', pro: 'Pro',
};

// Custom frameless title bar. The draggable region is marked via the
// app-region CSS (see index.css); buttons opt out so they stay clickable.
export function TitleBar({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const w = window.gensuite?.window;
  const authEmail = useAuthStore((state) => state.email);
  const signOut = useAuthStore((state) => state.signOut);
  const entitlementStatus = useEntitlementStore((state) => state.status);
  const tier = useEntitlementStore((state) => state.tier);
  const credits = useEntitlementStore((state) => state.credits);

  return (
    <div className="titlebar drag flex h-10 shrink-0 items-center justify-between border-b border-white/[0.07] bg-[#171718]/95 px-4 backdrop-blur-xl">
      <div className="flex select-none items-baseline font-sans text-white">
        <span className="text-[15px] font-extrabold tracking-[-0.04em]">GENSUITE</span>
        <span className="ml-1.5 text-[9px] font-bold uppercase tracking-[0.14em] text-teal-300/75">Desktop</span>
        <span className="ml-2 text-[10px] font-medium tabular-nums text-white/30">v{__APP_VERSION__}</span>
      </div>
      <div className="titlebar-controls no-drag flex min-w-0 items-center gap-xs">
        {authEmail && (
          <div className="mr-2 flex min-w-0 max-w-[400px] items-center gap-2 rounded-lg border border-white/10 bg-white/[0.035] px-2 py-1 text-[11px] text-white/55">
            <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-emerald-400/15 text-[9px] font-bold uppercase text-emerald-300">{authEmail.charAt(0)}</span>
            <span className="max-w-[160px] truncate" title={authEmail}>{authEmail}</span>
            {entitlementStatus === 'ready' && (
              <span className="shrink-0 rounded-md bg-emerald-400/10 px-1.5 py-0.5 font-bold text-emerald-300">
                {TIER_LABELS[tier]} · {credits.toLocaleString('vi-VN')} credits
              </span>
            )}
            <button onClick={signOut} title="Đăng xuất" aria-label="Đăng xuất" className="shrink-0 rounded p-0.5 text-white/35 transition-colors hover:bg-white/5 hover:text-white">
              <LogOut size={13} />
            </button>
          </div>
        )}
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
