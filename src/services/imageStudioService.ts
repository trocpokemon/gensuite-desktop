import { gensuiteFetch } from '../lib/gensuiteAuth';
import { getSupabaseFunctionsBaseUrl } from '../lib/supabase';

export type ImageStudioModel = 'google-ai-studio/gemini-3.1-flash-image-preview' | 'gpt-image-2';
export type ImageAspectRatio = '16:9' | '4:3' | '3:2' | '1:1' | '2:3' | '3:4' | '9:16';
export type ImageGeneration = {
  id: string;
  projectId: string;
  prompt: string;
  modelId: ImageStudioModel;
  aspectRatio: ImageAspectRatio;
  imageCount: number;
  quality: string;
  creditsCharged: number;
  createdAt: string;
  imageUrls: string[];
  parentGenerationId: string | null;
  sourceImageIndex: number | null;
};
export type ImageJob = {
  id: string;
  status: 'pending' | 'processing' | 'done' | 'failed' | 'cancelled';
  progress: number;
  error: string | null;
  generation: ImageGeneration | null;
};
export type ImageProject = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  imageCount: number;
  coverUrl: string | null;
};
export type ImageCharacter = {
  id: string;
  projectId: string;
  name: string;
  description: string;
  referenceUrl: string;
  createdAt: string;
  updatedAt: string;
};

const endpoint = (query = ''): string => {
  const baseUrl = getSupabaseFunctionsBaseUrl();
  if (!baseUrl) throw new Error('AUTH_REQUIRED:gensuite');
  return `${baseUrl}/image-studio${query}`;
};

const safeFailure = async (response: Response): Promise<never> => {
  const payload = await response.json().catch(() => null as any);
  const raw = String(payload?.error || payload?.message || '').toLocaleLowerCase();
  if (response.status === 401) throw new Error('AUTH_REQUIRED:gensuite');
  if (response.status === 402 || raw.includes('credits')) throw new Error('Tài khoản không đủ credits để thực hiện thao tác này.');
  if (response.status === 404) throw new Error('Không tìm thấy dữ liệu ảnh. Hãy tải lại và thử lại.');
  if (response.status === 546) throw new Error('Hệ thống đang bận xử lý ảnh. Vui lòng thử lại sau.');
  if (raw.includes('4.000') || raw.includes('4000')) throw new Error('Mô tả ảnh quá dài. Vui lòng rút gọn còn tối đa 4.000 ký tự.');
  if (raw.includes('tỉ lệ') || raw.includes('aspect ratio')) throw new Error('Tỷ lệ ảnh này chưa phù hợp với lựa chọn hiện tại.');
  if (raw.includes('số lượng') || raw.includes('imagecount')) throw new Error('Mỗi lần có thể tạo từ 1 đến 4 ảnh.');
  if (raw.includes('tham chiếu') || raw.includes('reference image')) throw new Error('Ảnh tham chiếu không hợp lệ hoặc có dung lượng quá lớn.');
  throw new Error('Không thể xử lý yêu cầu ảnh lúc này. Vui lòng thử lại sau.');
};

const request = async <T>(method: 'GET' | 'POST' | 'DELETE', body?: unknown, query = ''): Promise<T> => {
  const response = await gensuiteFetch(endpoint(query), {
    method,
    headers: { 'Content-Type': 'application/json', 'Accept-Language': 'vi' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) await safeFailure(response);
  return await response.json() as T;
};

export const listImageProjects = () =>
  request<{ projects: ImageProject[] }>('GET').then((result) => result.projects || []);

export const createImageProject = (name: string) =>
  request<ImageProject>('POST', { action: 'create-project', name });

export const deleteImageProject = (projectId: string) =>
  request<{ success: boolean }>('DELETE', { projectId });

export const listProjectImages = (projectId: string) =>
  request<{ items: ImageGeneration[] }>('GET', undefined, `?projectId=${encodeURIComponent(projectId)}`)
    .then((result) => result.items || []);

export const listImageCharacters = (projectId: string) =>
  request<{ characters: ImageCharacter[] }>('GET', undefined, `?projectId=${encodeURIComponent(projectId)}&resource=characters`)
    .then((result) => result.characters || []);

export const createImageCharacter = (params: { projectId: string; name: string; description: string; imageDataUrl?: string; generationId?: string; imageIndex?: number }) =>
  request<ImageCharacter>('POST', { action: 'create-character', ...params });

export const updateImageCharacter = (params: { id: string; name: string; description: string; imageDataUrl?: string }) =>
  request<ImageCharacter>('POST', { action: 'update-character', ...params });

export const deleteImageCharacter = (characterId: string) =>
  request<{ success: boolean }>('DELETE', { characterId });

export const submitImageJob = (params: {
  projectId: string;
  prompt: string;
  modelId: ImageStudioModel;
  aspectRatio: ImageAspectRatio;
  imageCount: number;
  characterIds?: string[];
  sourceGenerationId?: string;
  sourceImageIndex?: number;
  referenceImageDataUrls?: string[];
}) => request<{ jobId: string; status: string }>('POST', {
  ...params,
  action: 'submit-job',
  idempotencyKey: crypto.randomUUID(),
});

export const getImageJob = (jobId: string) =>
  request<ImageJob>('GET', undefined, `?jobId=${encodeURIComponent(jobId)}`);

export const deleteImageGeneration = (id: string, deleteLineage = false) =>
  request<{ success: boolean; deletedCount?: number }>('DELETE', { id, deleteLineage });
