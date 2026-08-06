import { useEffect, useState } from 'react';
import { X, Eye, EyeOff, Save, Loader2, ExternalLink, ShieldCheck, Trash2, ClipboardCopy } from 'lucide-react';
import { useSettingsStore } from '../store/settingsStore';
import type { AppSettings } from '../shared/types';
import { diagnosticSummary } from '../shared/diagnosticSummary';

interface Props {
  onClose: () => void;
}

// Each row edits one API key. Values are masked by default; the eye toggle reveals
// a single field. Keys are persisted to <userData>/GenSuite/settings.json via IPC.
type ApiKeyField = 'googleApiKey' | 'pexelsApiKey' | 'pixabayApiKey' | 'unsplashApiKey';
const FIELDS: Array<{ key: ApiKeyField; label: string; hint: string; free: boolean; url: string }> = [
  { key: 'googleApiKey', label: 'Google AI Studio', hint: 'Viết nội dung, chỉnh sửa văn bản, tạo storyboard và dịch', free: true, url: 'https://aistudio.google.com/app/apikey' },
  { key: 'pexelsApiKey', label: 'Pexels', hint: 'Bước 4 — tìm ảnh stock cho storyboard (miễn phí)', free: true, url: 'https://www.pexels.com/api/new/' },
  { key: 'pixabayApiKey', label: 'Pixabay', hint: 'Bước 4 — tìm ảnh stock cho storyboard (miễn phí)', free: true, url: 'https://pixabay.com/api/docs/' },
  { key: 'unsplashApiKey', label: 'Unsplash', hint: 'Bước 4 — tìm ảnh stock cho storyboard (miễn phí)', free: true, url: 'https://unsplash.com/oauth/applications' },
];

export function SettingsPanel({ onClose }: Props) {
  const keys = useSettingsStore((s) => s.keys);
  const save = useSettingsStore((s) => s.save);

  const [draft, setDraft] = useState<AppSettings>(keys);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [clearingSession, setClearingSession] = useState<'tiktok' | 'douyin' | null>(null);
  const [sessionMessage, setSessionMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [diagnosticMessage, setDiagnosticMessage] = useState('');

  // Sync the draft when the store finishes loading after mount.
  useEffect(() => {
    setDraft(keys);
  }, [keys]);

  const onSave = async () => {
    setSaving(true);
    setSaved(false);
    try {
      await save(draft);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } finally {
      setSaving(false);
    }
  };

  const clearVideoSession = async (platform: 'tiktok' | 'douyin') => {
    if (clearingSession) return;
    const platformName = platform === 'tiktok' ? 'TikTok' : 'Douyin';
    setClearingSession(platform);
    setSessionMessage(null);
    try {
      if (platform === 'tiktok') await window.gensuite.ytdlp.clearTikTokSession();
      else await window.gensuite.ytdlp.clearDouyinSession();
      setSessionMessage({ kind: 'success', text: `Đã xóa phiên ${platformName}.` });
    } catch {
      setSessionMessage({ kind: 'error', text: `Không thể xóa phiên ${platformName}. Vui lòng thử lại.` });
    } finally {
      setClearingSession(null);
    }
  };

  const copyDiagnostics = async () => {
    try {
      await navigator.clipboard.writeText(await diagnosticSummary());
      setDiagnosticMessage('Đã sao chép thông tin chẩn đoán an toàn.');
    } catch {
      setDiagnosticMessage('Chưa thể sao chép. Vui lòng thử lại.');
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-lg backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#1c1c1d] shadow-[0_28px_90px_rgba(0,0,0,0.55)]"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-white/10 p-lg">
          <div>
            <h2 className="text-lg font-bold">Cài đặt</h2>
            <p className="text-xs text-text/50">Khóa và dữ liệu phiên được quản lý trên thiết bị này.</p>
          </div>
          <button
            onClick={onClose}
            className="cursor-pointer rounded-lg p-1 text-text/60 transition-colors hover:bg-white/10 hover:text-text"
            aria-label="Đóng"
          >
            <X size={20} />
          </button>
        </header>

        <div className="flex flex-col gap-md overflow-y-auto p-lg">
          {FIELDS.map(({ key, label, hint, free, url }) => (
            <label key={key} className="flex flex-col gap-xs">
              <span className="flex items-center gap-sm text-sm font-medium">
                {label}
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                    free ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-400/15 text-amber-300'
                  }`}
                >
                  {free ? 'Free' : 'Cloud'}
                </span>
              </span>
              <span className="text-xs text-text/50">{hint}</span>
              <div className="relative">
                <input
                  type={revealed[key] ? 'text' : 'password'}
                  value={draft[key]}
                  onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                  placeholder="••••••••"
                  autoComplete="off"
                  spellCheck={false}
                  className="field-surface w-full rounded-xl px-md py-sm pr-10 text-sm outline-none transition-all"
                />
                <button
                  type="button"
                  onClick={() => setRevealed((r) => ({ ...r, [key]: !r[key] }))}
                  className="absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer p-1 text-text/50 transition-colors hover:text-text"
                  aria-label={revealed[key] ? 'Ẩn' : 'Hiện'}
                >
                  {revealed[key] ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              <button
                type="button"
                onClick={() => window.gensuite.shell.openExternal(url)}
                className="inline-flex w-fit items-center gap-1 text-xs text-emerald-300/80 transition-colors hover:text-emerald-200"
              >
                <ExternalLink size={12} />
                Lấy API key
              </button>
            </label>
          ))}

          <section className="mt-sm border-t border-white/10 pt-lg">
            <div className="flex items-start gap-3">
              <span className="rounded-xl bg-emerald-400/10 p-2.5 text-emerald-300"><ShieldCheck size={19} /></span>
              <div>
                <h3 className="text-sm font-semibold text-white">Dữ liệu phiên tải video</h3>
                <p className="mt-1 text-xs leading-5 text-text/50">Xóa phiên đăng nhập được lưu riêng trong ứng dụng. Dữ liệu trong trình duyệt chính không bị ảnh hưởng.</p>
              </div>
            </div>

            <div className="mt-md grid gap-sm sm:grid-cols-2">
              {(['tiktok', 'douyin'] as const).map((platform) => {
                const platformName = platform === 'tiktok' ? 'TikTok' : 'Douyin';
                const clearing = clearingSession === platform;
                return (
                  <button
                    key={platform}
                    type="button"
                    onClick={() => void clearVideoSession(platform)}
                    disabled={Boolean(clearingSession)}
                    className="flex items-center justify-center gap-2 rounded-xl border border-red-400/20 bg-red-400/[0.06] px-3 py-3 text-xs font-semibold text-red-200/80 transition-colors hover:border-red-300/35 hover:bg-red-400/10 disabled:opacity-45"
                  >
                    {clearing ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
                    Xóa phiên {platformName}
                  </button>
                );
              })}
            </div>

            {sessionMessage && (
              <p className={`mt-sm text-xs ${sessionMessage.kind === 'success' ? 'text-emerald-300' : 'text-red-300'}`}>
                {sessionMessage.text}
              </p>
            )}
          </section>

          <section className="mt-sm border-t border-white/10 pt-lg">
            <div className="flex items-start gap-3">
              <span className="rounded-xl bg-sky-400/10 p-2.5 text-sky-300"><ClipboardCopy size={19} /></span>
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold text-white">Hỗ trợ chẩn đoán</h3>
                <p className="mt-1 text-xs leading-5 text-text/50">Sao chép mã lỗi và thông tin vận hành an toàn. Không bao gồm nội dung, đường dẫn hay khóa tài khoản.</p>
              </div>
            </div>
            <button type="button" onClick={() => void copyDiagnostics()} className="mt-md flex w-full items-center justify-center gap-2 rounded-xl border border-sky-300/20 bg-sky-300/[0.06] px-3 py-3 text-xs font-semibold text-sky-200 transition-colors hover:bg-sky-300/10">
              <ClipboardCopy size={15} /> Sao chép thông tin chẩn đoán
            </button>
            {diagnosticMessage && <p className="mt-sm text-xs text-white/55">{diagnosticMessage}</p>}
          </section>
        </div>

        <footer className="flex items-center justify-end gap-sm border-t border-white/10 p-lg">
          {saved && <span className="text-sm text-emerald-300">Đã lưu</span>}
          <button
            onClick={onSave}
            disabled={saving}
            className="primary-action flex cursor-pointer items-center gap-sm rounded-xl px-lg py-sm font-bold transition-all disabled:opacity-50"
          >
            {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
            Lưu
          </button>
        </footer>
      </div>
    </div>
  );
}
