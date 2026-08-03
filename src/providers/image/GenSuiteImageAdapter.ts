import type { AspectRatio } from '../../shared/types';
import type { IImageProvider, ImageEngine, ImageGenRequest } from './types';
import { gensuiteFetch } from '../../lib/gensuiteAuth';
import { getSupabase, getSupabaseFunctionsBaseUrl } from '../../lib/supabase';

// Desktop uses the same first-party image workspace flow as the web app. Each
// account gets one persisted quick-image project, then generation is submitted
// asynchronously and polled until signed result URLs are ready.
const IMAGE_PROJECT_NAME = 'Ảnh tạo nhanh trên Desktop';
const PROJECT_KEY_PREFIX = 'gensuite:image-project:';

// Provider-neutral model ids the API accepts. Gemini = Google image model,
// ChatGPT = OpenAI image model. Must match MODELS in the image-studio function.
const MODEL_BY_ENGINE: Record<ImageEngine, string> = {
  gemini: 'google-ai-studio/gemini-3.1-flash-image-preview',
  chatgpt: 'gpt-image-2',
};

// The app only offers 16:9 / 9:16. Gemini accepts those directly; OpenAI's
// gpt-image-2 only supports 3:2 / 1:1 / 2:3, so map to the nearest orientation.
const ratioFor = (engine: ImageEngine, ratio: AspectRatio): string => {
  if (engine === 'chatgpt') return ratio === '9:16' ? '2:3' : '3:2';
  return ratio;
};

const POLL_INTERVAL_MS = 2500;
const POLL_TIMEOUT_MS = 180_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class GenSuiteImageAdapter implements IImageProvider {
  constructor(readonly engine: ImageEngine) {}

  async generate(req: ImageGenRequest): Promise<string[]> {
    const prompt = req.prompt.trim();
    if (!prompt) throw new Error('Hãy nhập câu lệnh tạo ảnh.');

    let projectId = await this.ensureProject();
    let jobId: string;
    try {
      jobId = await this.submit(projectId, prompt, req);
    } catch (error) {
      if (!(error instanceof StaleImageProjectError)) throw error;
      await this.forgetProject();
      projectId = await this.ensureProject();
      try {
        jobId = await this.submit(projectId, prompt, req);
      } catch (retryError) {
        if (retryError instanceof StaleImageProjectError) {
          throw new Error('Không thể chuẩn bị nơi lưu ảnh. Vui lòng thử lại.');
        }
        throw retryError;
      }
    }
    return await this.poll(jobId);
  }

  private endpoint(query = ''): string {
    const baseUrl = getSupabaseFunctionsBaseUrl();
    if (!baseUrl) throw new Error('AUTH_REQUIRED:gensuite');
    return `${baseUrl}/image-studio${query}`;
  }

  private async projectStorageKey(): Promise<string> {
    const client = getSupabase();
    if (!client) throw new Error('AUTH_REQUIRED:gensuite');
    const { data, error } = await client.auth.getSession();
    const userId = data.session?.user?.id;
    if (error || !userId) throw new Error('AUTH_REQUIRED:gensuite');
    return `${PROJECT_KEY_PREFIX}${userId}`;
  }

  private async ensureProject(): Promise<string> {
    const storageKey = await this.projectStorageKey();
    const savedProjectId = localStorage.getItem(storageKey)?.trim();
    if (savedProjectId) return savedProjectId;

    const resp = await gensuiteFetch(this.endpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept-Language': 'vi' },
      body: JSON.stringify({ action: 'create-project', name: IMAGE_PROJECT_NAME }),
    });
    if (!resp.ok) await this.fail(resp);
    const data = await resp.json().catch(() => null as any);
    const projectId = String(data?.id ?? '').trim();
    if (!projectId) throw new Error('Không thể chuẩn bị nơi lưu ảnh. Vui lòng thử lại.');
    localStorage.setItem(storageKey, projectId);
    return projectId;
  }

  private async forgetProject(): Promise<void> {
    localStorage.removeItem(await this.projectStorageKey());
  }

  private async fail(resp: Response): Promise<never> {
    const data = await resp.json().catch(() => null as any);
    const code = String(data?.error ?? '');
    if (resp.status === 401 || code === 'INVALID_API_KEY' || code === 'AUTH_REQUIRED') throw new Error('AUTH_REQUIRED:gensuite');
    if (code === 'FEATURE_UPGRADE_REQUIRED') throw new Error('UPGRADE_REQUIRED:basic');
    if (resp.status === 402 || code === 'INSUFFICIENT_CREDITS') throw new Error('Tài khoản GenSuite không đủ credits để tạo ảnh.');
    throw new Error('Không thể tạo ảnh lúc này. Vui lòng thử lại sau.');
  }

  private async submit(projectId: string, prompt: string, req: ImageGenRequest): Promise<string> {
    const count = Math.max(1, Math.min(4, req.count ?? 1));
    const refs = (req.referenceImageDataUrls ?? []).filter((url) => url.startsWith('data:image/')).slice(0, 4);
    const resp = await gensuiteFetch(this.endpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept-Language': 'vi' },
      body: JSON.stringify({
        action: 'submit-job',
        projectId,
        modelId: MODEL_BY_ENGINE[this.engine],
        prompt,
        aspectRatio: ratioFor(this.engine, req.ratio),
        imageCount: count,
        idempotencyKey: crypto.randomUUID(),
        ...(refs.length ? { referenceImageDataUrls: refs } : {}),
      }),
    });
    if (resp.status === 404) throw new StaleImageProjectError();
    if (!resp.ok) await this.fail(resp);
    const data = await resp.json().catch(() => null as any);
    const jobId = String(data?.jobId ?? '').trim();
    if (!jobId) throw new Error('Không thể bắt đầu tạo ảnh. Vui lòng thử lại.');
    return jobId;
  }

  private async poll(jobId: string): Promise<string[]> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      const resp = await gensuiteFetch(this.endpoint(`?jobId=${encodeURIComponent(jobId)}`), {
        headers: { 'Accept-Language': 'vi' },
      });
      if (!resp.ok) await this.fail(resp);
      const data = await resp.json().catch(() => null as any);
      const status = String(data?.status ?? '');
      if (status === 'done') {
        const urls = (data?.generation?.imageUrls ?? []).map((url: unknown) => String(url)).filter(Boolean);
        if (!urls.length) throw new Error('Không nhận được ảnh kết quả. Vui lòng thử lại.');
        return urls;
      }
      if (status === 'failed' || status === 'cancelled') {
        throw new Error('Tạo ảnh không thành công. Hãy điều chỉnh mô tả và thử lại.');
      }
    }
    throw new Error('Tạo ảnh quá thời gian chờ. Hãy thử lại.');
  }
}

class StaleImageProjectError extends Error {}
