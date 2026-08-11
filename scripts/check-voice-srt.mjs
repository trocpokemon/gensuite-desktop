import { buildSrtContent, parseSrt, formatSrtPreviewTime } from '../src/shared/srt.ts';

const violations = [];
const entries = parseSrt(`\uFEFF1\r\n00:00:01,250 --> 00:00:03,500\r\nXin <b>chào</b>\r\n\r\n2\r\n00:00:05.000 --> 00:00:07.125\r\nDòng thứ hai\r\nđược nối lại\r\n`);

if (entries.length !== 2) violations.push('Không đọc đủ các câu SRT hợp lệ.');
if (entries[0]?.startTime !== 1.25 || entries[0]?.endTime !== 3.5) violations.push('Mốc thời gian dấu phẩy chưa được đọc đúng.');
if (entries[0]?.text !== 'Xin chào') violations.push('Thẻ định dạng SRT chưa được làm sạch.');
if (entries[1]?.text !== 'Dòng thứ hai được nối lại') violations.push('Phụ đề nhiều dòng chưa được nối đúng.');
if (formatSrtPreviewTime(3661) !== '01:01:01') violations.push('Thời lượng xem trước dài chưa được định dạng đúng.');
if (parseSrt('1\n00:00:02,000 --> 00:00:01,000\nSai').length !== 0) violations.push('Khoảng thời gian ngược chưa bị loại bỏ.');
const rebuilt = buildSrtContent(entries);
if (!rebuilt.includes('00:00:01,250 --> 00:00:03,500')) violations.push('SRT dựng lại làm sai mốc thời gian.');
if (!rebuilt.endsWith('\n')) violations.push('SRT dựng lại thiếu dòng kết thúc chuẩn.');

const adapterSource = await import('node:fs').then(({ readFileSync }) => readFileSync(new URL('../src/providers/voice/GenSuiteVoiceAdapter.ts', import.meta.url), 'utf8'));
if (!adapterSource.includes("engine === 'elevenlabs' || engine === 'minimax'")) violations.push('Chưa tách tuyến SRT riêng cho ElevenLabs/MiniMax.');
if (!adapterSource.includes('_srt_full: true') || !adapterSource.includes('_srt_content: req.srt.content')) violations.push('Tuyến SRT native chưa gửi đủ dữ liệu timeline.');
if (!adapterSource.includes('const chunks = nativeSrt ? [req.text.trim()]')) violations.push('SRT native vẫn có nguy cơ bị chia nhỏ và mất timeline.');

const workspaceSource = await import('node:fs').then(({ readFileSync }) => readFileSync(new URL('../src/components/QuickToolWorkspace.tsx', import.meta.url), 'utf8'));
if (!workspaceSource.includes("engine === 'elevenlabs' || engine === 'minimax'")) violations.push('UI chưa định tuyến ElevenLabs/MiniMax qua một job SRT.');
if (!workspaceSource.includes('assembleTimeline')) violations.push('Tuyến GenVoice chưa giữ bước ghép từng cue theo timeline.');

if (violations.length) {
  console.error(`Kiểm tra nhập SRT thất bại:\n${violations.map((item) => `- ${item}`).join('\n')}`);
  process.exit(1);
}
console.log('Kiểm tra nhập SRT: đạt (định dạng, timeline, nhiều dòng và dữ liệu sai).');
