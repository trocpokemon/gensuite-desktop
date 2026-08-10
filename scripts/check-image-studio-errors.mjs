import assert from 'node:assert/strict';
import { imageJobFailure } from '../src/lib/imageStudioErrors.ts';

const failed = (error) => ({ status: 'failed', error, generation: null });

for (const marker of [
  'IMAGE_CREDITS_ESTIMATE:500:0',
  'IMAGE_CREDITS_RESERVE:500:0',
  'Cần tạm giữ 500 credits, hiện còn 0. Chưa gọi nhà cung cấp và chưa trừ credit.',
  'insufficient credits',
]) {
  assert.equal(imageJobFailure(failed(marker))?.message, 'INSUFFICIENT_CREDITS');
}

const privateDetail = 'provider failed at C:\\private\\customer-file.png';
const safeFailure = imageJobFailure(failed(privateDetail));
assert.equal(safeFailure?.message, 'Tạo ảnh không thành công. Hãy điều chỉnh mô tả và thử lại.');
assert.equal(safeFailure?.message.includes(privateDetail), false);

assert.equal(
  imageJobFailure({ status: 'processing', error: null, generation: null }, true)?.message,
  'Tạo ảnh quá thời gian chờ. Hãy thử lại.',
);
assert.equal(
  imageJobFailure({ status: 'cancelled', error: null, generation: null })?.message,
  'Tạo ảnh đã được hủy.',
);
assert.equal(
  imageJobFailure({ status: 'done', error: null, generation: { id: 'ready' } }, false),
  null,
);

console.log('Image Studio error classification checks passed.');
