// Adapters throw `MISSING_KEY:<service>` when a required API key is absent or
// rejected. The UI catches these to show a "go to Settings" prompt instead of a
// raw error. Any other Error is shown as-is.

const PREFIX = 'MISSING_KEY:';
const AUTH_REQUIRED = 'AUTH_REQUIRED:gensuite';
const UPGRADE_REQUIRED = 'UPGRADE_REQUIRED:basic';
const DOUYIN_LOGIN_REQUIRED = 'DOUYIN_LOGIN_REQUIRED';
const TIKTOK_LOGIN_REQUIRED = 'TIKTOK_LOGIN_REQUIRED';

export type VideoLoginPlatform = 'douyin' | 'tiktok';

export function loginRequiredPlatform(err: unknown): VideoLoginPlatform | null {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes(DOUYIN_LOGIN_REQUIRED)) return 'douyin';
  if (msg.includes(TIKTOK_LOGIN_REQUIRED)) return 'tiktok';
  return null;
}

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
  if (msg.includes(AUTH_REQUIRED)) {
    return 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại để tiếp tục.';
  }
  if (msg.includes(UPGRADE_REQUIRED)) {
    return 'Tính năng này cần gói Basic trở lên. Vui lòng nâng cấp hoặc kiểm tra lại gói tài khoản.';
  }
  if (msg.includes(DOUYIN_LOGIN_REQUIRED)) {
    return 'Douyin cần xác nhận lại phiên truy cập. Không bắt buộc đăng nhập tài khoản.';
  }
  if (msg.includes(TIKTOK_LOGIN_REQUIRED)) {
    return 'TikTok cần đăng nhập để mở nội dung này.';
  }
  if (isNetworkError(msg)) {
    return 'Không kết nối được tới máy chủ. Hãy kiểm tra mạng (hoặc tường lửa/VPN) rồi thử lại.';
  }
  if (msg.includes('NARRATION_SOURCE_INVALID')) {
    return 'Video nguồn không còn khả dụng. Hãy chọn lại video rồi thử lại.';
  }
  if (msg.includes('NARRATION_ANALYSIS_FAILED')) {
    return 'Chưa thể phân tích video này. Hãy kiểm tra kết nối và thử lại.';
  }
  // Dependency errors can cross the IPC boundary. Never expose implementation
  // names, internal paths, raw command output, or stack-like diagnostics in UI.
  if (/yt-?dlp|resources[\\/]ytdlp|source-%\(id\)/i.test(msg)) {
    return 'Không thể tải video từ liên kết này. Hãy kiểm tra liên kết hoặc thử lại sau.';
  }
  if (/whisper(?:\.cpp)?|ggml|resources[\\/]whisper/i.test(msg)) {
    return 'Không thể nhận dạng lời thoại. Hãy kiểm tra tệp nguồn hoặc thử lại với chất lượng khác.';
  }
  if (/ffmpeg|ffprobe|codec|encoder|decoder/i.test(msg)) {
    return 'Không thể xử lý tệp media. Hãy kiểm tra định dạng tệp và thử lại.';
  }
  if (/\b(?:stderr|stdout|stack trace)\b|(?:[A-Z]:\\|\/)(?:[^\s]+[\\/]){2,}/i.test(msg)) {
    return 'Đã xảy ra lỗi khi xử lý. Vui lòng thử lại.';
  }
  return msg;
}
