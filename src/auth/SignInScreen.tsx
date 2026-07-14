import { useState } from 'react';
import { Eye, EyeOff, Loader2, Lock, Mail, Sparkles } from 'lucide-react';
import { useAuthStore } from '../store/authStore';

type Mode = 'signin' | 'signup';

export function SignInScreen() {
  const configured = useAuthStore((s) => s.configured);
  const signInWithPassword = useAuthStore((s) => s.signInWithPassword);
  const signUp = useAuthStore((s) => s.signUp);
  const signInWithGoogle = useAuthStore((s) => s.signInWithGoogle);

  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  const isSignUp = mode === 'signup';

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setInfo('');
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const submit = () =>
    run(async () => {
      const cleanEmail = email.trim();
      if (!cleanEmail) throw new Error('Vui lòng nhập email.');
      if (!password) throw new Error('Vui lòng nhập mật khẩu.');
      if (isSignUp) {
        const { needsConfirm } = await signUp(cleanEmail, password);
        if (needsConfirm) setInfo('Kiểm tra email để xác nhận tài khoản của bạn.');
      } else {
        await signInWithPassword(cleanEmail, password);
      }
    });

  return (
    <main className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 py-10">
      <div className="w-full max-w-[400px]">
        <div className="mb-8 text-center">
          <div className="mb-4 inline-flex rounded-2xl bg-emerald-400/15 p-3 text-emerald-300">
            <Sparkles size={26} />
          </div>
          <h1 className="text-3xl font-bold tracking-[-0.04em]">{isSignUp ? 'Tạo tài khoản' : 'Chào mừng quay lại'}</h1>
          <p className="mt-2 text-sm text-text/50">Đăng nhập bằng tài khoản GenSuite của bạn để tiếp tục.</p>
        </div>

        {!configured && (
          <div className="mb-4 rounded-xl border border-amber-400/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
            App chưa được cấu hình Supabase. Thiếu VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY.
          </div>
        )}

        {error && (
          <div className="mb-4 rounded-xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</div>
        )}
        {info && (
          <div className="mb-4 rounded-xl border border-emerald-400/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100/90">{info}</div>
        )}

        <button
          disabled={busy || !configured}
          onClick={() => run(signInWithGoogle)}
          className="mb-5 flex w-full items-center justify-center gap-3 rounded-xl border border-white/10 bg-[#131314] py-3.5 text-sm font-medium text-[#e3e3e3] transition-colors hover:bg-[#1e1e1e] disabled:opacity-50"
        >
          {busy ? (
            <Loader2 size={20} className="animate-spin text-white/50" />
          ) : (
            <svg viewBox="0 0 24 24" className="h-5 w-5">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
            </svg>
          )}
          {isSignUp ? 'Đăng ký với Google' : 'Đăng nhập với Google'}
        </button>

        <div className="mb-5 flex items-center gap-4">
          <div className="h-px flex-1 bg-white/10" />
          <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-white/30">Hoặc</span>
          <div className="h-px flex-1 bg-white/10" />
        </div>

        <label className="mb-4 block">
          <span className="mb-2 block text-sm font-medium text-text/70">Email</span>
          <div className="relative">
            <Mail size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-white/30" />
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              placeholder="you@example.com"
              autoComplete="email"
              className="field-surface w-full rounded-xl py-3 pl-10 pr-4 text-sm outline-none"
            />
          </div>
        </label>

        <label className="mb-5 block">
          <span className="mb-2 block text-sm font-medium text-text/70">Mật khẩu</span>
          <div className="relative">
            <Lock size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-white/30" />
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              placeholder="••••••••"
              autoComplete={isSignUp ? 'new-password' : 'current-password'}
              className="field-surface w-full rounded-xl py-3 pl-10 pr-11 text-sm outline-none"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-white/40 transition-colors hover:text-white"
              aria-label={showPassword ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </label>

        <button
          disabled={busy || !configured}
          onClick={submit}
          className="primary-action flex w-full items-center justify-center gap-2 rounded-xl py-3 text-sm font-bold disabled:opacity-50"
        >
          {busy && <Loader2 size={16} className="animate-spin" />}
          {isSignUp ? 'Tạo tài khoản' : 'Đăng nhập'}
        </button>

        <div className="mt-5 text-center text-sm text-text/50">
          {isSignUp ? 'Đã có tài khoản?' : 'Chưa có tài khoản?'}{' '}
          <button
            type="button"
            onClick={() => {
              setMode(isSignUp ? 'signin' : 'signup');
              setError('');
              setInfo('');
            }}
            className="font-semibold text-emerald-300 underline underline-offset-4 transition-colors hover:text-emerald-200"
          >
            {isSignUp ? 'Đăng nhập' : 'Đăng ký'}
          </button>
        </div>
      </div>
    </main>
  );
}
