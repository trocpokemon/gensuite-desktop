import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const clean = (v: unknown): string | undefined => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s || undefined;
};

const env = import.meta.env;

export const isSupabaseConfigured = (): boolean =>
  Boolean(clean(env.VITE_SUPABASE_URL) && clean(env.VITE_SUPABASE_ANON_KEY));

export const getMissingSupabaseEnvKeys = (): string[] => {
  const missing: string[] = [];
  if (!clean(env.VITE_SUPABASE_URL)) missing.push('VITE_SUPABASE_URL');
  if (!clean(env.VITE_SUPABASE_ANON_KEY)) missing.push('VITE_SUPABASE_ANON_KEY');
  return missing;
};

/** Base URL for authenticated app functions used by first-party features. */
export const getSupabaseFunctionsBaseUrl = (): string | null => {
  const baseUrl = clean(env.VITE_SUPABASE_URL);
  return baseUrl ? `${baseUrl.replace(/\/$/, '')}/functions/v1` : null;
};

let cached: SupabaseClient | null = null;

// detectSessionInUrl is false because desktop never receives the OAuth hash on a
// page URL — the deep-link handler parses tokens and calls setSession() directly.
export const getSupabase = (): SupabaseClient | null => {
  if (cached) return cached;
  if (!isSupabaseConfigured()) return null;

  cached = createClient(clean(env.VITE_SUPABASE_URL)!, clean(env.VITE_SUPABASE_ANON_KEY)!, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
  return cached;
};
