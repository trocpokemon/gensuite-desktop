export type ImageJobResult = {
  status: 'pending' | 'processing' | 'done' | 'failed' | 'cancelled';
  error: string | null;
  generation: unknown | null;
};

const isImageCreditFailure = (message: string): boolean => {
  const normalized = message.trim();
  return /^(?:IMAGE_CREDITS_(?:ESTIMATE|RESERVE)|INSUFFICIENT_CREDITS)(?::|$)/i.test(normalized)
    || /(?:không đủ|hết) credits|(?:not enough|insufficient) credits/i.test(normalized)
    || /cần tạm giữ\s+[\d.,]+\s*credits[^\r\n]*hiện còn\s+[\d.,]+/i.test(normalized);
};

/** Convert an asynchronous image job result into a safe, user-facing failure. */
export const imageJobFailure = (job: ImageJobResult, timedOut = false): Error | null => {
  if (job.status === 'done' && job.generation) return null;
  if (isImageCreditFailure(String(job.error || ''))) return new Error('INSUFFICIENT_CREDITS');
  if (job.status === 'cancelled') return new Error('Tạo ảnh đã được hủy.');
  if (timedOut) return new Error('Tạo ảnh quá thời gian chờ. Hãy thử lại.');
  return new Error('Tạo ảnh không thành công. Hãy điều chỉnh mô tả và thử lại.');
};
