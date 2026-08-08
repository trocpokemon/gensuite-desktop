import { isPublicAppError } from '../../shared/appErrors';
import { clientAppError } from '../clientAppError';

const TRANSLATION_REQUEST_TIMEOUT_MS = 90_000;

function isLegacyAccessSignal(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return message.includes('MISSING_KEY:')
    || message.includes('AUTH_REQUIRED:gensuite')
    || message.includes('UPGRADE_REQUIRED:basic');
}

/** Every translation request has a full-body deadline. Unknown transport
 * failures are normalized before they can reach the UI. */
export async function runTranslationRequest<T>(
  request: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TRANSLATION_REQUEST_TIMEOUT_MS);
  try {
    return await request(controller.signal);
  } catch (error) {
    if (isPublicAppError(error) || isLegacyAccessSignal(error)) throw error;
    if (timedOut || (error instanceof DOMException && error.name === 'AbortError')) {
      throw clientAppError('TRANSLATION_REQUEST_TIMEOUT');
    }
    throw clientAppError('TRANSLATION_SERVICE_UNAVAILABLE');
  } finally {
    window.clearTimeout(timer);
  }
}

