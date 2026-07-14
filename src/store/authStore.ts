import { create } from 'zustand';
import type { Session, User } from '@supabase/supabase-js';
import { getSupabase } from '../lib/supabase';

// Mirrors the web app's auth bootstrap: getSession() → getUser(accessToken) to
// verify the token against the server on every launch, plus onAuthStateChange to
// stay in sync. Session persists in the renderer's localStorage across launches.

type AuthStatus = 'loading' | 'signedOut' | 'signedIn';

const friendlyAuthError = (error: unknown): string => {
  const message = String(
    (error as any)?.message || (error as any)?.error_description || (error as any)?.error || error || 'Lỗi không xác định',
  );
  const lower = message.toLowerCase();
  if (lower.includes('unsupported provider') || lower.includes('provider not enabled')) {
    return 'Đăng nhập Google chưa được bật. Hãy bật Google provider trong Supabase.';
  }
  if (lower.includes('invalid login credentials')) return 'Email hoặc mật khẩu không đúng.';
  if (lower.includes('email not confirmed')) return 'Vui lòng xác nhận email trước (kiểm tra hộp thư).';
  if (lower.includes('user already registered')) return 'Tài khoản đã tồn tại.';
  if (lower.includes('supabase')) return 'App chưa được cấu hình Supabase (thiếu URL/anon key).';
  return message;
};

interface AuthStore {
  status: AuthStatus;
  user: User | null;
  email: string | null;
  configured: boolean;
  init: () => Promise<void>;
  signInWithPassword: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<{ needsConfirm: boolean }>;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
}

let subscribed = false;

export const useAuthStore = create<AuthStore>((set) => ({
  status: 'loading',
  user: null,
  email: null,
  configured: Boolean(getSupabase()),

  init: async () => {
    const sb = getSupabase();
    if (!sb) {
      set({ status: 'signedOut', configured: false });
      return;
    }

    const applyUser = (user: User | null) =>
      set(user ? { status: 'signedIn', user, email: user.email ?? null } : { status: 'signedOut', user: null, email: null });

    // Verify the persisted token against the server; sign out on any failure.
    const verify = async (session: Session | null): Promise<User | null> => {
      const token = String(session?.access_token || '').trim();
      if (!token) return null;
      try {
        const { data, error } = await sb.auth.getUser(token);
        if (error || !data?.user) {
          await sb.auth.signOut().catch(() => {});
          return null;
        }
        return data.user;
      } catch {
        await sb.auth.signOut().catch(() => {});
        return null;
      }
    };

    if (!subscribed) {
      subscribed = true;
      sb.auth.onAuthStateChange((event, session) => {
        if (!session?.access_token || event === 'SIGNED_OUT') {
          applyUser(null);
          return;
        }
        verify(session).then(applyUser);
      });

      // Deep-link OAuth callback: main forwards the tokens, we hydrate the session.
      window.gensuite?.auth?.onCallback(async ({ accessToken, refreshToken }) => {
        const client = getSupabase();
        if (!client || !accessToken || !refreshToken) return;
        await client.auth.setSession({ access_token: accessToken, refresh_token: refreshToken }).catch(() => {});
      });
    }

    try {
      const { data, error } = await sb.auth.getSession();
      if (error) throw error;
      applyUser(await verify(data.session));
    } catch {
      applyUser(null);
    }
  },

  signInWithPassword: async (email, password) => {
    const sb = getSupabase();
    if (!sb) throw new Error(friendlyAuthError('supabase'));
    const { error } = await sb.auth.signInWithPassword({ email: email.trim(), password });
    if (error) throw new Error(friendlyAuthError(error));
  },

  signUp: async (email, password) => {
    const sb = getSupabase();
    if (!sb) throw new Error(friendlyAuthError('supabase'));
    const { data, error } = await sb.auth.signUp({ email: email.trim(), password });
    if (error) throw new Error(friendlyAuthError(error));
    // When email confirmation is on, there is no active session yet.
    return { needsConfirm: !data.session };
  },

  signInWithGoogle: async () => {
    const sb = getSupabase();
    if (!sb) throw new Error(friendlyAuthError('supabase'));
    const { data, error } = await sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: 'gensuite://auth-callback', skipBrowserRedirect: true },
    });
    if (error) throw new Error(friendlyAuthError(error));
    if (data?.url) window.gensuite.shell.openExternal(data.url);
  },

  signOut: async () => {
    const sb = getSupabase();
    await sb?.auth.signOut().catch(() => {});
    set({ status: 'signedOut', user: null, email: null });
  },
}));
