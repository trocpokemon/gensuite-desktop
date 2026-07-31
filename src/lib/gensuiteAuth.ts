import { getSupabase } from './supabase';
import type { SupabaseClient } from '@supabase/supabase-js';

const REFRESH_WINDOW_SECONDS = 90;
const AUTH_REQUIRED = 'AUTH_REQUIRED:gensuite';
let refreshPromise: Promise<string> | null = null;
export type GenSuiteFeature = 'localize-cloud';

function refreshAccessToken(client: SupabaseClient): Promise<string> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const { data, error } = await client.auth.refreshSession();
    if (error || !data.session?.access_token) {
      await client.auth.signOut().catch(() => undefined);
      throw new Error(AUTH_REQUIRED);
    }
    return data.session.access_token;
  })().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

async function accessToken(forceRefresh = false): Promise<string> {
  const client = getSupabase();
  if (!client) throw new Error(AUTH_REQUIRED);

  const { data, error } = await client.auth.getSession();
  if (error || !data.session?.access_token) throw new Error(AUTH_REQUIRED);

  const session = data.session;
  const expiresSoon = Number(session.expires_at || 0) <= Math.floor(Date.now() / 1000) + REFRESH_WINDOW_SECONDS;
  if (forceRefresh || expiresSoon) {
    return refreshAccessToken(client);
  }

  return session.access_token;
}

async function authenticatedFetch(input: RequestInfo | URL, init: RequestInit, forceRefresh = false): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${await accessToken(forceRefresh)}`);
  return fetch(input, { ...init, headers });
}

/** Uses the signed-in account and retries once when its short-lived session expires. */
export async function gensuiteFetch(input: RequestInfo | URL, init: RequestInit = {}, feature?: GenSuiteFeature): Promise<Response> {
  const headers = new Headers(init.headers);
  if (feature) headers.set('x-gensuite-feature', feature);
  const requestInit = { ...init, headers };
  const response = await authenticatedFetch(input, requestInit);
  if (response.status !== 401) return response;

  const retried = await authenticatedFetch(input, requestInit, true);
  if (retried.status === 401) {
    await getSupabase()?.auth.signOut().catch(() => undefined);
    throw new Error(AUTH_REQUIRED);
  }
  return retried;
}
