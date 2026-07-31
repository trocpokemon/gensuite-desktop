import type { AspectRatio } from '../../shared/types';
import type { IImageProvider, ImageEngine, ImageGenRequest } from './types';
import { gensuiteFetch } from '../../lib/gensuiteAuth';

// GenSuite paid image flow. Desktop authenticates with the signed-in account.
// Generation is asynchronous:
// POST /v1/images submits a job, then we poll GET /v1/images/{jobId} until it is
// done and returns signed image URLs. See supabase/functions/api-v1 +
// supabase/functions/image-studio in the Gensuite-Audio repo.
const BASE_URL = 'https://api.gensuite.site/v1';

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

    const jobId = await this.submit(prompt, req);
    return await this.poll(jobId);
  }

  private async fail(resp: Response): Promise<never> {
    const data = await resp.json().catch(() => null as any);
    const code = String(data?.error ?? '');
    const message = String(data?.message ?? '');
    if (resp.status === 401 || code === 'INVALID_API_KEY' || code === 'AUTH_REQUIRED') throw new Error('AUTH_REQUIRED:gensuite');
    if (code === 'FEATURE_UPGRADE_REQUIRED') throw new Error('UPGRADE_REQUIRED:basic');
    if (resp.status === 402 || code === 'INSUFFICIENT_CREDITS') throw new Error('Tài khoản GenSuite không đủ credits để tạo ảnh.');
    throw new Error(String(message || code || 'Không thể tạo ảnh. Vui lòng thử lại.').slice(0, 300));
  }

  private async submit(prompt: string, req: ImageGenRequest): Promise<string> {
    const count = Math.max(1, Math.min(4, req.count ?? 1));
    const refs = (req.referenceImageDataUrls ?? []).filter((url) => url.startsWith('data:image/')).slice(0, 4);
    const resp = await gensuiteFetch(`${BASE_URL}/images`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL_BY_ENGINE[this.engine],
        prompt,
        aspectRatio: ratioFor(this.engine, req.ratio),
        imageCount: count,
        idempotencyKey: crypto.randomUUID(),
        ...(refs.length ? { referenceImageDataUrls: refs } : {}),
      }),
    });
    if (!resp.ok) await this.fail(resp);
    const data = await resp.json().catch(() => null as any);
    const jobId = String(data?.jobId ?? '').trim();
    if (!jobId) throw new Error('GenSuite không trả về mã tác vụ tạo ảnh.');
    return jobId;
  }

  private async poll(jobId: string): Promise<string[]> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      const resp = await gensuiteFetch(`${BASE_URL}/images/${encodeURIComponent(jobId)}`);
      if (!resp.ok) await this.fail(resp);
      const data = await resp.json().catch(() => null as any);
      const status = String(data?.status ?? '');
      if (status === 'done') {
        const urls = (data?.generation?.imageUrls ?? []).map((url: unknown) => String(url)).filter(Boolean);
        if (!urls.length) throw new Error('GenSuite không trả về ảnh nào.');
        return urls;
      }
      if (status === 'failed' || status === 'cancelled') {
        throw new Error(String(data?.error || 'Tạo ảnh thất bại. Hãy thử lại.'));
      }
    }
    throw new Error('Tạo ảnh quá thời gian chờ. Hãy thử lại.');
  }
}
