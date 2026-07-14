import type { ContentRequest, RewriteRequest, StoryboardRequest, ScriptScene, TranslateRequest } from './types';
import type { TranscriptSegment } from '../../shared/types';

export function buildContentPrompt(req: ContentRequest): string {
  return [
    req.masterPrompt,
    '',
    `Ý tưởng video: ${req.idea}`,
    `Đối tượng khán giả: ${req.targetAudience}`,
    `Tông giọng: ${req.tone}`,
    `Độ dài mục tiêu: khoảng ${req.wordCount} từ.`,
    '',
    'YÊU CẦU BẮT BUỘC:',
    '- Viết một nội dung liên tục, giàu nhịp điệu, sẵn sàng để đọc thành tiếng như sách hoặc truyện.',
    '- Không liệt kê phân cảnh, không ghi thời gian, không chèn chỉ dẫn quay dựng hay nhãn người dẫn chuyện.',
    '- Có mở đầu giữ chân, chuyển ý tự nhiên và kết thúc trọn vẹn.',
    '- Chỉ trả về JSON hợp lệ dạng {"content":"toàn bộ nội dung"}.',
  ].join('\n');
}

export function buildRewritePrompt(req: RewriteRequest): string {
  const index = req.fullContent.indexOf(req.selectedText);
  const before = index >= 0 ? req.fullContent.slice(Math.max(0, index - 700), index) : '';
  const after = index >= 0 ? req.fullContent.slice(index + req.selectedText.length, index + req.selectedText.length + 700) : '';
  return [
    'Bạn là biên tập viên tiếng Việt. Hãy sửa đúng phần văn bản được chọn theo yêu cầu, đồng thời giữ mạch văn với ngữ cảnh hai bên.',
    `Yêu cầu sửa: ${req.instruction}`,
    `Ngữ cảnh trước: ${before}`,
    `Văn bản được chọn: ${req.selectedText}`,
    `Ngữ cảnh sau: ${after}`,
    'Chỉ trả về JSON hợp lệ dạng {"content":"phần văn bản thay thế"}. Không trả lại ngữ cảnh.',
  ].join('\n\n');
}

export function buildStoryboardPrompt(req: StoryboardRequest): string {
  return [
    'Bạn là đạo diễn hình ảnh. Hãy chia bài đọc dưới đây thành các cảnh trực quan theo đúng thứ tự nội dung.',
    'Mỗi narration phải là một đoạn nguyên văn, liên tục trong bài; không viết lại và không bỏ sót nội dung.',
    'Mỗi cảnh cần imagePrompt tiếng Anh chi tiết và keyword gồm 1-3 từ tiếng Anh để tìm stock media.',
    `Phong cách hình ảnh chung: ${req.visualStyle}`,
    `Điều cần tránh: ${req.negativePrompt}`,
    'Nếu có nhân vật lặp lại, mô tả ngoại hình, trang phục và phong cách giống hệt nhau trong mọi prompt.',
    'Trả về duy nhất JSON dạng {"scenes":[{"narration":"...","imagePrompt":"...","keyword":"..."}]}.',
    '',
    'NỘI DUNG:',
    req.content,
  ].join('\n');
}

function jsonObject(raw: string): Record<string, unknown> {
  const cleaned = raw.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  const body = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    throw new Error('AI không trả về JSON hợp lệ. Hãy thử lại.');
  }
}

export function parseContentJson(raw: string): string {
  const content = String(jsonObject(raw).content ?? '').trim();
  if (!content) throw new Error('AI không trả về nội dung.');
  return content;
}

export function parseStoryboardJson(raw: string): ScriptScene[] {
  const rows = jsonObject(raw).scenes;
  if (!Array.isArray(rows) || !rows.length) throw new Error('Storyboard trống. Hãy thử lại.');
  return rows.map((row) => {
    const item = (row ?? {}) as Record<string, unknown>;
    const imagePrompt = String(item.imagePrompt ?? '').trim();
    return {
      narration: String(item.narration ?? '').trim(),
      imagePrompt,
      keyword: String(item.keyword ?? '').trim() || imagePrompt.split(/[\s,]+/).filter(Boolean).slice(0, 3).join(' ') || 'cinematic',
    };
  }).filter((scene) => scene.narration);
}

// Segments are sent as an indexed array so the model can preserve order and count
// exactly. We ask for a JSON object keyed by index to survive reordering, then
// realign to the original segments by index below.
export function buildTranslatePrompt(req: TranslateRequest): string {
  const source = req.sourceLanguage && req.sourceLanguage !== 'auto' ? `từ ${req.sourceLanguage} ` : '';
  const lines = req.segments.map((seg, index) => `${index}. ${seg.text.replace(/\s+/g, ' ').trim()}`);
  return [
    `Bạn là dịch giả phụ đề chuyên nghiệp. Hãy dịch ${source}sang ${req.targetLanguage} từng câu thoại dưới đây.`,
    'YÊU CẦU BẮT BUỘC:',
    '- Dịch tự nhiên, đúng nghĩa, giữ giọng điệu của lời thoại gốc.',
    '- Giữ NGUYÊN số dòng và số thứ tự; mỗi dòng gốc phải có đúng một bản dịch tương ứng.',
    '- Không gộp, không tách, không bỏ dòng nào kể cả khi trùng lặp.',
    '- Chỉ trả về JSON hợp lệ dạng {"translations":{"0":"...","1":"..."}} với khóa là số thứ tự dòng.',
    '',
    'CÁC DÒNG CẦN DỊCH:',
    ...lines,
  ].join('\n');
}

export function parseTranslationJson(raw: string, original: TranscriptSegment[]): TranscriptSegment[] {
  const map = jsonObject(raw).translations;
  if (!map || typeof map !== 'object') throw new Error('AI không trả về bản dịch hợp lệ. Hãy thử lại.');
  const table = map as Record<string, unknown>;
  return original.map((seg, index) => {
    const translated = String(table[String(index)] ?? '').trim();
    return { ...seg, text: translated || seg.text };
  });
}
