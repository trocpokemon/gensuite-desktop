// Adapters throw `MISSING_KEY:<service>` when a required API key is absent or
// rejected. The UI catches these to show a "go to Settings" prompt instead of a
// raw error. Any other Error is shown as-is.

const PREFIX = 'MISSING_KEY:';

export function missingKeyService(err: unknown): string | null {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.startsWith(PREFIX) ? msg.slice(PREFIX.length) : null;
}

const SERVICE_LABELS: Record<string, string> = {
  google: 'Google AI Studio',
  gensuite: 'GenSuite Cloud',
  pexels: 'Pexels',
  pixabay: 'Pixabay',
  unsplash: 'Unsplash',
  genvoice: 'GenVoice',
  elevenlabs: 'ElevenLabs',
  openai: 'OpenAI',
};

export function serviceLabel(service: string): string {
  return SERVICE_LABELS[service] ?? service;
}

// `fetch()` throws a bare "Failed to fetch" TypeError when the request never
// reaches the server (offline, DNS failure, blocked by a firewall/proxy, or the
// host is unreachable). The raw English is meaningless to users, so translate it.
function isNetworkError(msg: string): boolean {
  return /failed to fetch|network ?error|networkerror|load failed|fetch failed|err_internet_disconnected/i.test(msg);
}

export function errorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (isNetworkError(msg)) {
    return 'Không kết nối được tới máy chủ. Hãy kiểm tra mạng (hoặc tường lửa/VPN) rồi thử lại.';
  }
  return msg;
}
