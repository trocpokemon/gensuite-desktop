import { useEffect } from 'react';
import { AlertTriangle, CheckCircle2, Download, ExternalLink, Loader2, RefreshCw, Sparkles, X } from 'lucide-react';
import { AppModal } from './AppModal';
import { useUpdateStore } from '../store/updateStore';
import { useCreditPromptStore } from '../store/creditPromptStore';
import { useEntitlementStore } from '../store/entitlementStore';

const PRICING_URL = 'https://gensuite.site/app/pricing';

function UpdateDialog() {
  const open = useUpdateStore((state) => state.dialogOpen);
  const status = useUpdateStore((state) => state.status);
  const close = useUpdateStore((state) => state.closeDialog);
  const check = useUpdateStore((state) => state.openChecker);
  const download = useUpdateStore((state) => state.startDownload);
  const install = useUpdateStore((state) => state.install);
  if (!open) return null;

  const checking = status.kind === 'checking';
  const downloading = status.kind === 'downloading';
  const downloadUpdate = () => {
    if (status.kind === 'available' && status.manualDownload) {
      window.gensuite?.shell?.openExternal('https://github.com/trocpokemon/gensuite-desktop/releases/latest');
      close();
      return;
    }
    download();
  };
  return <AppModal ariaLabel="Cập nhật GenSuite" onClose={close} closeOnBackdrop={!downloading}>
    <div className="relative p-7 sm:p-8">
      {!downloading && <button type="button" onClick={close} aria-label="Đóng thông báo cập nhật" className="absolute right-5 top-5 grid size-9 place-items-center rounded-xl text-white/40 transition hover:bg-white/[0.07] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300"><X size={18} /></button>}
      <div className={`grid size-14 place-items-center rounded-2xl ${status.kind === 'error' ? 'bg-red-400/10 text-red-300' : 'bg-emerald-400/12 text-emerald-300'}`}>
        {checking || downloading ? <Loader2 size={27} className="animate-spin" /> : status.kind === 'downloaded' ? <CheckCircle2 size={27} /> : status.kind === 'error' ? <AlertTriangle size={27} /> : status.kind === 'available' ? <Download size={27} /> : <RefreshCw size={27} />}
      </div>
      <h2 className="mt-5 pr-8 text-xl font-black tracking-[-0.02em]">
        {checking ? 'Đang kiểm tra cập nhật…' : downloading ? 'Đang tải bản cập nhật…' : status.kind === 'available' ? `Đã có phiên bản v${status.version}` : status.kind === 'downloaded' ? `Phiên bản v${status.version} đã sẵn sàng` : status.kind === 'error' ? 'Chưa thể kiểm tra cập nhật' : 'Bạn đang dùng phiên bản mới nhất'}
      </h2>
      <p className="mt-2 text-sm leading-6 text-white/48">
        {checking ? 'Ứng dụng đang tìm phiên bản mới nhất.' : downloading ? 'Bạn có thể tiếp tục làm việc trong lúc tải xuống.' : status.kind === 'available' ? 'Tải phiên bản mới để nhận các cải tiến và sửa lỗi mới nhất.' : status.kind === 'downloaded' ? 'Khởi động lại ứng dụng để hoàn tất cập nhật.' : status.kind === 'error' ? status.message : `GenSuite Desktop v${__APP_VERSION__} hiện đã được cập nhật.`}
      </p>
      {downloading && <div className="mt-6"><div className="mb-2 flex justify-between text-xs font-bold text-white/55"><span>Tiến trình tải</span><span>{status.percent}%</span></div><div className="h-2 overflow-hidden rounded-full bg-white/[0.08]"><div className="h-full rounded-full bg-emerald-400 transition-[width] duration-300" style={{ width: `${status.percent}%` }} /></div></div>}
      <div className="mt-7 flex flex-wrap justify-end gap-2">
        {status.kind === 'available' && <><button type="button" onClick={close} className="rounded-xl border border-white/10 px-4 py-2.5 text-sm font-bold text-white/65 transition hover:bg-white/[0.05] hover:text-white">Để sau</button><button type="button" onClick={downloadUpdate} className="primary-action inline-flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-black"><Download size={16} />{status.manualDownload ? 'Mở trang tải xuống' : 'Tải cập nhật'}</button></>}
        {status.kind === 'downloaded' && <button type="button" onClick={install} className="primary-action inline-flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-black"><RefreshCw size={16} />Khởi động lại và cập nhật</button>}
        {(status.kind === 'not-available' || status.kind === 'error') && <><button type="button" onClick={close} className="rounded-xl border border-white/10 px-4 py-2.5 text-sm font-bold text-white/65 transition hover:bg-white/[0.05] hover:text-white">Đóng</button>{status.kind === 'error' && <button type="button" onClick={check} className="primary-action inline-flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-black"><RefreshCw size={16} />Thử lại</button>}</>}
      </div>
    </div>
  </AppModal>;
}

function CreditsRequiredDialog() {
  const open = useCreditPromptStore((state) => state.open);
  const close = useCreditPromptStore((state) => state.close);
  const credits = useEntitlementStore((state) => state.credits);
  const refreshCredits = useEntitlementStore((state) => state.load);
  useEffect(() => {
    if (open) void refreshCredits();
  }, [open, refreshCredits]);
  if (!open) return null;
  const openPricing = () => {
    window.gensuite?.shell?.openExternal(PRICING_URL);
    close();
  };
  return <AppModal ariaLabel="Cần bổ sung credits" onClose={close}>
    <div className="relative p-7 sm:p-8">
      <button type="button" onClick={close} aria-label="Đóng thông báo credits" className="absolute right-5 top-5 grid size-9 place-items-center rounded-xl text-white/40 transition hover:bg-white/[0.07] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300"><X size={18} /></button>
      <div className="grid size-14 place-items-center rounded-2xl bg-amber-300/12 text-amber-200"><Sparkles size={27} /></div>
      <h2 className="mt-5 pr-8 text-xl font-black tracking-[-0.02em]">Bạn cần bổ sung credits</h2>
      <p className="mt-2 text-sm leading-6 text-white/48">Tính năng này cần credits để xử lý. Hãy chọn gói phù hợp rồi quay lại thử lại thao tác.</p>
      <div className="mt-5 flex items-center justify-between rounded-2xl border border-white/[0.08] bg-white/[0.025] px-4 py-3"><span className="text-xs font-bold text-white/40">Số dư hiện tại</span><span className="text-sm font-black text-amber-200">{credits.toLocaleString('vi-VN')} credits</span></div>
      <div className="mt-7 flex flex-wrap justify-end gap-2"><button type="button" onClick={close} className="rounded-xl border border-white/10 px-4 py-2.5 text-sm font-bold text-white/65 transition hover:bg-white/[0.05] hover:text-white">Để sau</button><button type="button" onClick={openPricing} className="primary-action inline-flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-black">Xem các gói credits<ExternalLink size={16} /></button></div>
    </div>
  </AppModal>;
}

export function GlobalDialogs() {
  return <><UpdateDialog /><CreditsRequiredDialog /></>;
}
