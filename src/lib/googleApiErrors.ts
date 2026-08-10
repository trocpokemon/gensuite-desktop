export type GoogleApiFailureKind =
  | 'api-key-invalid'
  | 'access-denied'
  | 'quota-exhausted'
  | 'rate-limited'
  | 'model-unavailable'
  | 'content-blocked'
  | 'request-rejected'
  | 'service-unavailable';

const searchablePayload = (payload: unknown): string => {
  try { return JSON.stringify(payload).toLowerCase().slice(0, 20_000); } catch { return ''; }
};

/** Classifies provider responses without returning raw provider text to the UI. */
export function classifyGoogleApiFailure(status: number, payload: unknown): GoogleApiFailureKind {
  const signal = searchablePayload(payload);
  if (/api[_ ]?key[^\r\n]{0,80}(?:invalid|not valid|expired|revoked)|api_key_invalid|keyinvalid/.test(signal)) return 'api-key-invalid';
  if (status === 401) return 'api-key-invalid';
  if (status === 429) {
    if (/quota exceeded|exceeded your current quota|billing/.test(signal)) return 'quota-exhausted';
    return 'rate-limited';
  }
  if (status === 403) return 'access-denied';
  if (status === 404 || /model[^\r\n]{0,100}(?:not found|not available|unsupported)|model_not_found/.test(signal)) return 'model-unavailable';
  if (/safety|prohibited|policy|blocked|block_reason/.test(signal)) return 'content-blocked';
  if (status === 400 || status === 413 || status === 422) return 'request-rejected';
  return 'service-unavailable';
}

export function googleResponseWasBlocked(payload: unknown): boolean {
  const signal = searchablePayload(payload);
  return /"blockreason"\s*:\s*"(?!block_reason_unspecified|unspecified)[^"]+"|"finishreason"\s*:\s*"(?:safety|prohibited_content|recitation)"/.test(signal);
}
