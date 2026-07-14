import { useEffect, useState } from 'react';
import { X, Eye, EyeOff, Save, Loader2, ExternalLink } from 'lucide-react';
import { useSettingsStore } from '../store/settingsStore';
import type { AppSettings } from '../shared/types';

interface Props {
  onClose: () => void;
}

// Each row edits one API key. Values are masked by default; the eye toggle reveals
// a single field. Keys are persisted to <userData>/GenSuite/settings.json via IPC.
const FIELDS: Array<{ key: keyof AppSettings; label: string; hint: string; free: boolean; url: string }> = [
  { key: 'googleApiKey', label: 'Google AI Studio', hint: 'Viết nội dung (Bước 2), sửa vùng chọn và tạo storyboard (Bước 4) — Gemini', free: true, url: 'https://aistudio.google.com/app/apikey' },
  { key: 'pexelsApiKey', label: 'Pexels', hint: 'Bước 4 — tìm ảnh stock cho storyboard (miễn phí)', free: true, url: 'https://www.pexels.com/api/new/' },
  { key: 'pixabayApiKey', label: 'Pixabay', hint: 'Bước 4 — tìm ảnh stock cho storyboard (miễn phí)', free: true, url: 'https://pixabay.com/api/docs/' },
  { key: 'unsplashApiKey', label: 'Unsplash', hint: 'Bước 4 — tìm ảnh stock cho storyboard (miễn phí)', free: true, url: 'https://unsplash.com/oauth/applications' },
  { key: 'gensuiteApiKey', label: 'GenSuite API', hint: 'Giọng đọc (GenVoice, ElevenLabs, MiniMax), nhận dạng lời thoại và dịch video', free: false, url: 'https://gensuite.site' },
];

export function SettingsPanel({ onClose }: Props) {
  const keys = useSettingsStore((s) => s.keys);
  const save = useSettingsStore((s) => s.save);

  const [draft, setDraft] = useState<AppSettings>(keys);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

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
            <h2 className="text-lg font-bold">Cài đặt API</h2>
            <p className="text-xs text-text/50">Khóa được lưu cục bộ trên máy bạn.</p>
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
