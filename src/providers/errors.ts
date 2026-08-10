import { isPublicAppError } from '../shared/appErrors';
import type { AppErrorCode, PublicAppError } from '../shared/appErrors';
import { notifyIfInsufficientCredits } from '../store/creditPromptStore';
import { rememberDiagnostic } from '../shared/diagnosticSummary';

const PREFIX = 'MISSING_KEY:';
const AUTH_REQUIRED = 'AUTH_REQUIRED:gensuite';
const UPGRADE_REQUIRED = 'UPGRADE_REQUIRED:basic';
const DOUYIN_LOGIN_REQUIRED = 'DOUYIN_LOGIN_REQUIRED';
const TIKTOK_LOGIN_REQUIRED = 'TIKTOK_LOGIN_REQUIRED';

export type VideoLoginPlatform = 'douyin' | 'tiktok';

function rawErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isCancellationError(err: unknown): boolean {
  if (isPublicAppError(err) && (err.code === 'VOICE_CANCELLED' || err.code === 'TRANSCRIPTION_CANCELLED')) return true;
  const message = rawErrorMessage(err);
  return message.includes('voice:cancelled')
    || message.includes('edgetts:killed')
    || message.includes('gensuite:cancelled');
}

export function loginRequiredPlatform(err: unknown): VideoLoginPlatform | null {
  const msg = rawErrorMessage(err);
  if (msg.includes(DOUYIN_LOGIN_REQUIRED)) return 'douyin';
  if (msg.includes(TIKTOK_LOGIN_REQUIRED)) return 'tiktok';
  return null;
}

export function missingKeyService(err: unknown): string | null {
  const msg = rawErrorMessage(err);
  if (!msg.startsWith(PREFIX)) return null;
  const service = msg.slice(PREFIX.length);
  return Object.prototype.hasOwnProperty.call(SERVICE_LABELS, service) ? service : null;
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
  return SERVICE_LABELS[service] ?? 'dịch vụ đã chọn';
}

function isNetworkError(msg: string): boolean {
  return /failed to fetch|network ?error|networkerror|load failed|fetch failed|err_internet_disconnected/i.test(msg);
}

function diagnosticSuffix(error: PublicAppError): string {
  return ` Mã chẩn đoán: ${error.diagnosticId}.`;
}

function segmentLabel(error: PublicAppError): string {
  const number = error.context?.segmentNumber;
  const total = error.context?.segmentCount;
  return number && total ? ` ở câu ${number}/${total}` : '';
}

function groupLabel(error: PublicAppError): string {
  const number = error.context?.groupNumber;
  const total = error.context?.groupCount;
  return number && total ? ` ở nhóm ${number}/${total}` : '';
}

function chunkLabel(error: PublicAppError): string {
  const number = error.context?.chunkNumber;
  const total = error.context?.chunkCount;
  return number && total ? ` ở phần ${number}/${total}` : '';
}

const STRUCTURED_ERROR_MESSAGES: Record<AppErrorCode, (error: PublicAppError) => string> = {
  TRANSCRIPTION_INPUT_REQUIRED: () => 'Cần chọn tệp có âm thanh trước khi nhận dạng lời thoại.',
  TRANSCRIPTION_SOURCE_UNAVAILABLE: () => 'Tệp nguồn không còn khả dụng. Hãy chọn lại video.',
  TRANSCRIPTION_SOURCE_PERMISSION_DENIED: () => 'Ứng dụng không có quyền đọc tệp nguồn. Hãy cấp quyền hoặc chọn lại video.',
  TRANSCRIPTION_SOURCE_UNREADABLE: () => 'Không đọc được âm thanh trong tệp nguồn. Hãy kiểm tra tệp rồi thử lại.',
  TRANSCRIPTION_AUDIO_PREPARATION_FAILED: () => 'Không thể chuẩn bị âm thanh để nhận dạng. Hãy kiểm tra tệp nguồn rồi thử lại.',
  TRANSCRIPTION_AUDIO_PREPARATION_TIMEOUT: () => 'Chuẩn bị âm thanh mất nhiều thời gian hơn dự kiến. Hãy sao chép video về ổ cục bộ rồi thử lại.',
  TRANSCRIPTION_AUDIO_RECOVERY_FAILED: () => 'Không thể khôi phục an toàn dữ liệu nhận dạng trước đó. Hãy giữ nguyên dự án và gửi mã chẩn đoán để được hỗ trợ.',
  TRANSCRIPTION_COMPONENT_UNAVAILABLE: () => 'Thành phần nhận dạng lời thoại không khả dụng. Hãy cập nhật hoặc cài đặt lại ứng dụng.',
  TRANSCRIPTION_MODEL_UNAVAILABLE: () => 'Dữ liệu nhận dạng chưa sẵn sàng. Hãy kiểm tra mạng rồi thử lại.',
  TRANSCRIPTION_MODEL_DOWNLOAD_FAILED: () => 'Không thể tải dữ liệu nhận dạng. Hãy kiểm tra kết nối rồi thử lại.',
  TRANSCRIPTION_MODEL_INVALID: () => 'Dữ liệu nhận dạng trên máy chưa đầy đủ hoặc bị hỏng. Ứng dụng sẽ chuẩn bị lại ở lần thử tiếp theo.',
  TRANSCRIPTION_MODEL_PERMISSION_DENIED: () => 'Ứng dụng không có quyền lưu dữ liệu nhận dạng. Hãy kiểm tra quyền thư mục ứng dụng rồi thử lại.',
  TRANSCRIPTION_MODEL_STORAGE_FULL: () => 'Không đủ dung lượng để chuẩn bị dữ liệu nhận dạng. Hãy giải phóng dung lượng rồi thử lại.',
  TRANSCRIPTION_CANCELLED: () => 'Đã dừng nhận dạng lời thoại. Những phần hoàn thành vẫn được giữ để tiếp tục sau.',
  TRANSCRIPTION_JOB_CONFLICT: () => 'Dự án này đang có một lượt nhận dạng chạy. Hãy chờ hoàn tất hoặc dừng lượt hiện tại.',
  TRANSCRIPTION_JOB_EXPIRED: () => 'Tác vụ nhận dạng trước đã hết hạn. Ứng dụng sẽ tạo lại tác vụ khi bạn thử tiếp.',
  TRANSCRIPTION_SERVICE_UNAVAILABLE: () => 'Nguồn nhận dạng trực tuyến hiện chưa phản hồi. Hãy kiểm tra mạng rồi thử lại.',
  TRANSCRIPTION_REQUEST_TIMEOUT: () => 'Nhận dạng trực tuyến mất nhiều thời gian hơn dự kiến. Tác vụ đã được giữ để tiếp tục ở lần thử sau.',
  TRANSCRIPTION_RATE_LIMITED: () => 'Nguồn nhận dạng đang bận. Hãy chờ ít phút rồi tiếp tục tác vụ.',
  TRANSCRIPTION_ACCESS_DENIED: () => 'Tài khoản hiện chưa được phép dùng nguồn nhận dạng này. Hãy kiểm tra gói tài khoản.',
  TRANSCRIPTION_PROCESS_START_DENIED: (error) => `Ứng dụng chưa được phép bắt đầu nhận dạng${chunkLabel(error)}. Hãy kiểm tra quyền bảo mật của máy rồi thử lại.`,
  TRANSCRIPTION_PROCESS_START_FAILED: (error) => `Không thể bắt đầu nhận dạng${chunkLabel(error)}. Hãy khởi động lại ứng dụng rồi thử lại.`,
  TRANSCRIPTION_MEMORY_LIMIT: (error) => `Máy không đủ bộ nhớ để nhận dạng${chunkLabel(error)}. Hãy đóng bớt ứng dụng hoặc chọn mức độ chính xác thấp hơn.`,
  TRANSCRIPTION_CHUNK_FAILED: (error) => `Nhận dạng lời thoại bị dừng${chunkLabel(error)}. Hãy thử lại hoặc chọn mức độ chính xác thấp hơn.`,
  TRANSCRIPTION_CHUNK_TIMEOUT: (error) => `Nhận dạng${chunkLabel(error)} không có tiến triển trong thời gian dài nên đã được dừng an toàn. Hãy thử lại.`,
  TRANSCRIPTION_RESULT_INVALID: (error) => `Kết quả nhận dạng${chunkLabel(error)} chưa đầy đủ hoặc không đọc được. Hãy thử lại.`,
  TRANSCRIPTION_REPETITION_DETECTED: () => 'Kết quả nhận dạng có câu bị lặp bất thường nên ứng dụng đã dừng trước khi tạo giọng. Hãy kiểm tra đúng ngôn ngữ gốc rồi thử lại.',
  TRANSCRIPTION_NO_SPEECH: () => 'Không phát hiện lời thoại rõ ràng trong video. Hãy kiểm tra âm thanh hoặc chọn mức độ chính xác cao hơn.',
  TRANSCRIPTION_TEMP_PERMISSION_DENIED: () => 'Ứng dụng không có quyền tạo dữ liệu tạm để nhận dạng. Hãy kiểm tra quyền thư mục tạm rồi thử lại.',
  TRANSCRIPTION_TEMP_STORAGE_FULL: () => 'Vùng lưu tạm không đủ dung lượng để nhận dạng. Hãy giải phóng dung lượng trên ổ hệ thống rồi thử lại.',
  TRANSCRIPTION_TEMP_UNAVAILABLE: () => 'Không thể tạo dữ liệu tạm để nhận dạng. Hãy khởi động lại ứng dụng rồi thử lại.',
  TRANSCRIPTION_UNEXPECTED: () => 'Nhận dạng lời thoại dừng ngoài dự kiến. Hãy thử lại hoặc gửi mã chẩn đoán để được hỗ trợ.',
  TRANSLATION_INPUT_REQUIRED: () => 'Không có lời thoại để dịch. Hãy nhận dạng lại video rồi thử lại.',
  TRANSLATION_API_KEY_INVALID: () => 'Khóa Google AI Studio không hợp lệ, đã hết hạn hoặc bị thu hồi. Hãy kiểm tra lại khóa.',
  TRANSLATION_QUOTA_EXHAUSTED: () => 'Khóa Google AI Studio đã hết hạn mức sử dụng. Hãy kiểm tra quota hoặc thanh toán trong tài khoản Google.',
  TRANSLATION_MODEL_UNAVAILABLE: () => 'Mô hình đã chọn hiện không khả dụng với khóa Google AI Studio này. Hãy kiểm tra quyền truy cập hoặc chọn mô hình khác.',
  TRANSLATION_CONTENT_BLOCKED: () => 'Google AI Studio đã từ chối nội dung dịch do chính sách an toàn. Hãy điều chỉnh nội dung rồi thử lại.',
  TRANSLATION_REQUEST_REJECTED: () => 'Google AI Studio đã từ chối yêu cầu dịch. Hãy kiểm tra nội dung và cấu hình rồi thử lại.',
  TRANSLATION_INPUT_TOO_LARGE: () => 'Nội dung cần dịch vượt giới hạn của một lần xử lý. Tiến độ đã được giữ; hãy thử lại để tiếp tục.',
  TRANSLATION_ACCESS_DENIED: () => 'Chưa có quyền sử dụng nguồn dịch đã chọn. Hãy kiểm tra tài khoản hoặc cấu hình rồi thử lại.',
  TRANSLATION_AUTH_REQUIRED: () => 'Phiên đăng nhập đã hết hạn trong khi dịch. Hãy đăng nhập lại rồi tiếp tục.',
  TRANSLATION_UPGRADE_REQUIRED: () => 'Gói tài khoản hiện tại chưa hỗ trợ nguồn dịch đã chọn. Hãy nâng cấp hoặc đổi cách dịch.',
  TRANSLATION_CREDITS_INSUFFICIENT: () => 'Tài khoản không đủ credits để dịch nội dung này.',
  TRANSLATION_RATE_LIMITED: () => 'Nguồn dịch đang giới hạn số yêu cầu. Tiến độ đã được giữ; hãy chờ một lúc rồi thử lại.',
  TRANSLATION_SERVICE_UNAVAILABLE: () => 'Nguồn dịch hiện không phản hồi ổn định. Tiến độ đã được giữ; hãy kiểm tra mạng rồi thử lại.',
  TRANSLATION_REQUEST_TIMEOUT: () => 'Dịch lời thoại không có phản hồi trong thời gian cho phép. Tiến độ đã được giữ; hãy thử lại.',
  TRANSLATION_RESULT_INVALID: () => 'Kết quả dịch không đúng định dạng cần thiết nên ứng dụng đã dừng an toàn. Hãy thử lại.',
  TRANSLATION_RESULT_INCOMPLETE: () => 'Bản dịch chưa trả về đủ các câu nên ứng dụng đã dừng trước khi tạo giọng. Hãy thử lại.',
  TRANSLATION_REPETITION_DETECTED: () => 'Bản dịch có nhiều câu bị lặp bất thường nên ứng dụng đã dừng trước khi tạo giọng. Hãy thử lại.',
  TRANSLATION_UNEXPECTED: () => 'Dịch lời thoại dừng ngoài dự kiến. Tiến độ trước đó vẫn được giữ; hãy thử lại.',
  CONTENT_API_KEY_INVALID: () => 'Khóa Google AI Studio không hợp lệ, đã hết hạn hoặc bị thu hồi. Hãy kiểm tra lại khóa.',
  CONTENT_ACCESS_DENIED: () => 'Khóa Google AI Studio không có quyền thực hiện yêu cầu này. Hãy kiểm tra quyền API và dự án Google.',
  CONTENT_QUOTA_EXHAUSTED: () => 'Khóa Google AI Studio đã hết hạn mức sử dụng. Hãy kiểm tra quota hoặc thanh toán trong tài khoản Google.',
  CONTENT_RATE_LIMITED: () => 'Google AI Studio đang giới hạn tần suất yêu cầu. Hãy chờ một lúc rồi thử lại.',
  CONTENT_MODEL_UNAVAILABLE: () => 'Mô hình đã chọn hiện không khả dụng với khóa Google AI Studio này. Hãy kiểm tra quyền truy cập hoặc chọn mô hình khác.',
  CONTENT_BLOCKED: () => 'Google AI Studio đã từ chối nội dung do chính sách an toàn. Hãy điều chỉnh nội dung rồi thử lại.',
  CONTENT_REQUEST_REJECTED: () => 'Google AI Studio đã từ chối yêu cầu. Hãy kiểm tra nội dung và cấu hình rồi thử lại.',
  CONTENT_SERVICE_UNAVAILABLE: () => 'Không kết nối được Google AI Studio hoặc dịch vụ đang gián đoạn. Hãy kiểm tra mạng rồi thử lại.',
  CONTENT_RESPONSE_INVALID: () => 'Google AI Studio không trả về nội dung hợp lệ. Hãy thử lại hoặc đổi mô hình.',
  SUBTITLE_ALIGNMENT_INPUT_INVALID: () => 'Thiếu dữ liệu để đồng bộ phụ đề với giọng đọc.',
  SUBTITLE_ALIGNMENT_AUDIO_UNAVAILABLE: (error) => `Không tìm thấy âm thanh${segmentLabel(error)} để đồng bộ phụ đề. Hãy tạo lại giọng cho câu này.`,
  SUBTITLE_ALIGNMENT_TIMEOUT: (error) => `Đồng bộ phụ đề${segmentLabel(error)} mất nhiều thời gian hơn dự kiến. Ứng dụng có thể dùng thời gian ước lượng để tiếp tục.`,
  SUBTITLE_ALIGNMENT_FAILED: (error) => `Chưa thể đồng bộ chính xác phụ đề${segmentLabel(error)}. Ứng dụng có thể dùng thời gian ước lượng để tiếp tục.`,
  SUBTITLE_ALIGNMENT_RESULT_INVALID: (error) => `Không xác định được nhịp lời đọc${segmentLabel(error)}. Ứng dụng có thể dùng thời gian ước lượng để tiếp tục.`,
  SUBTITLE_ALIGNMENT_UNEXPECTED: (error) => `Căn phụ đề${segmentLabel(error)} dừng ngoài dự kiến. Ứng dụng có thể dùng thời gian ước lượng để tiếp tục.`,
  VIDEO_SOURCE_REQUIRED: () => 'Cần chọn video nguồn trước khi hoàn thiện.',
  VIDEO_SEGMENTS_EMPTY: () => 'Không có đoạn lời thoại nào để hoàn thiện video.',
  VIDEO_SOURCE_UNAVAILABLE: () => 'Video nguồn không còn khả dụng. Hãy chọn lại video nguồn.',
  VIDEO_SOURCE_PERMISSION_DENIED: () => 'Ứng dụng không có quyền đọc video nguồn. Hãy cấp quyền cho tệp hoặc chọn lại video.',
  VIDEO_SOURCE_UNREADABLE: () => 'Không đọc được video nguồn. Tệp có thể bị hỏng, chỉ có âm thanh hoặc chưa tải hoàn tất; hãy chọn lại video.',
  VIDEO_SOURCE_VALIDATION_TIMEOUT: () => 'Kiểm tra video nguồn mất nhiều thời gian hơn dự kiến. Hãy sao chép video về ổ cục bộ hoặc chọn lại tệp rồi thử lại.',
  VIDEO_SEGMENT_AUDIO_UNAVAILABLE: (error) => `Thiếu âm thanh${segmentLabel(error)}. Hãy tạo lại giọng cho câu này rồi thử lại.`,
  VIDEO_SEGMENT_AUDIO_PERMISSION_DENIED: (error) => `Ứng dụng không có quyền đọc âm thanh${segmentLabel(error)}. Hãy cấp quyền cho tệp hoặc tạo lại giọng.`,
  VIDEO_SEGMENT_AUDIO_UNREADABLE: (error) => `Không đọc được âm thanh${segmentLabel(error)}. Hãy tạo lại giọng cho câu này rồi thử lại.`,
  VIDEO_SEGMENT_AUDIO_VALIDATION_TIMEOUT: (error) => `Kiểm tra âm thanh${segmentLabel(error)} mất nhiều thời gian hơn dự kiến. Hãy tạo lại giọng cho câu này rồi thử lại.`,
  VIDEO_SEGMENT_TIMING_INVALID: (error) => `Mốc thời gian${segmentLabel(error)} không hợp lệ. Hãy nhận dạng lại lời thoại rồi thử lại.`,
  BACKGROUND_AUDIO_UNAVAILABLE: () => 'Nhạc nền đã chọn không còn khả dụng. Hãy chọn lại nhạc hoặc tắt nhạc nền.',
  BACKGROUND_AUDIO_PERMISSION_DENIED: () => 'Ứng dụng không có quyền đọc nhạc nền đã chọn. Hãy cấp quyền, chọn tệp khác hoặc tắt nhạc nền.',
  BACKGROUND_AUDIO_UNREADABLE: () => 'Không đọc được nhạc nền đã chọn. Hãy chọn một tệp nhạc khác hoặc tắt nhạc nền.',
  BACKGROUND_AUDIO_VALIDATION_TIMEOUT: () => 'Kiểm tra nhạc nền mất nhiều thời gian hơn dự kiến. Hãy chọn lại tệp nhạc hoặc tắt nhạc nền.',
  VIDEO_COMPONENT_UNAVAILABLE: () => 'Thành phần hoàn thiện video của ứng dụng không khả dụng. Hãy cập nhật hoặc cài đặt lại ứng dụng.',
  VIDEO_TOO_MANY_SEGMENTS: () => 'Dự án vượt giới hạn dữ liệu mà phiên bản ứng dụng này có thể xử lý. Hãy cập nhật ứng dụng hoặc gửi mã chẩn đoán để được hỗ trợ.',
  VIDEO_PROCESS_START_DENIED: () => 'Ứng dụng chưa được phép bắt đầu bước hoàn thiện video. Hãy kiểm tra quyền bảo mật của máy rồi thử lại.',
  VIDEO_PROCESS_START_FAILED: () => 'Không thể bắt đầu bước hoàn thiện video. Hãy khởi động lại ứng dụng rồi thử lại.',
  VIDEO_AUDIO_PREPARATION_FAILED: (error) => `Không thể chuẩn bị các đoạn giọng${groupLabel(error)}. Các đoạn đã tạo vẫn được giữ; hãy thử lại.`,
  VIDEO_AUDIO_PREPARATION_TIMEOUT: (error) => `Chuẩn bị các đoạn giọng${groupLabel(error)} không có tiến triển trong thời gian dài. Các đoạn đã tạo vẫn được giữ; hãy thử lại.`,
  VIDEO_PROCESS_FAILED: () => 'Bước ghép video dừng ngoài dự kiến. Dữ liệu đã tạo vẫn được giữ; hãy thử lại.',
  VIDEO_COMPLETION_TIMEOUT: () => 'Bước hoàn thiện video không có tiến triển trong thời gian dài nên đã được dừng an toàn. Dữ liệu đã tạo vẫn được giữ; hãy thử lại.',
  VIDEO_OUTPUT_VALIDATION_TIMEOUT: () => 'Kiểm tra video kết quả mất nhiều thời gian hơn dự kiến. Tệp cũ vẫn được giữ; hãy thử lưu lại hoặc chọn nơi lưu khác.',
  VIDEO_OUTPUT_INVALID: () => 'Video kết quả chưa đầy đủ hoặc không đọc được nên chưa được thay thế tệp cũ. Hãy thử lại.',
  OUTPUT_DIRECTORY_UNAVAILABLE: () => 'Thư mục lưu không còn khả dụng. Hãy chọn một thư mục khác.',
  OUTPUT_PERMISSION_DENIED: () => 'Không có quyền ghi video vào thư mục đã chọn. Hãy chọn thư mục khác hoặc cấp quyền ghi.',
  OUTPUT_STORAGE_FULL: () => 'Nơi lưu video không đủ dung lượng trống. Hãy giải phóng dung lượng hoặc chọn nơi lưu khác.',
  OUTPUT_WRITE_FAILED: () => 'Không thể ghi video vào nơi lưu đã chọn. Hãy chọn thư mục khác rồi thử lại.',
  OUTPUT_RECOVERY_FAILED: () => 'Không thể khôi phục an toàn video cũ sau khi thao tác lưu bị gián đoạn. Hãy giữ nguyên thư mục lưu và gửi mã chẩn đoán để được hỗ trợ.',
  CAPCUT_EXPORT_INPUT_INVALID: () => 'Dự án chưa đủ video, giọng đọc hoặc mốc thời gian để tạo bản chỉnh sửa. Hãy hoàn tất các bước trước rồi thử lại.',
  CAPCUT_SOURCE_UNAVAILABLE: () => 'Video nguồn của dự án không còn khả dụng. Ứng dụng sẽ tải lại video nếu còn liên kết; nếu không, hãy chọn lại video.',
  CAPCUT_SOURCE_UNREADABLE: () => 'Video nguồn chưa hoàn chỉnh hoặc không có dữ liệu hình ảnh hợp lệ. Hãy tải hoặc chọn lại video.',
  CAPCUT_VOICE_UNAVAILABLE: (error) => `Thiếu giọng đọc${segmentLabel(error)}. Ứng dụng sẽ chỉ tạo lại câu này khi bạn thử tiếp tục.`,
  CAPCUT_VOICE_UNREADABLE: (error) => `Giọng đọc${segmentLabel(error)} chưa hoàn chỉnh hoặc không đọc được. Ứng dụng sẽ chỉ tạo lại câu này khi bạn thử tiếp tục.`,
  CAPCUT_TIMELINE_INVALID: (error) => `Mốc thời gian${segmentLabel(error)} không hợp lệ. Hãy nhận dạng lại lời thoại rồi thử lại.`,
  CAPCUT_SEGMENT_LIMIT: () => 'Dự án có quá nhiều câu để tạo trong một lượt. Hãy chia video thành các phần ngắn hơn.',
  CAPCUT_DRAFT_DIRECTORY_UNAVAILABLE: () => 'Chưa tìm thấy thư mục dự án CapCut. Hãy mở CapCut ít nhất một lần hoặc chọn đúng thư mục dự án rồi thử lại.',
  CAPCUT_APP_UNAVAILABLE: () => 'Chưa tìm thấy CapCut trên máy. Hãy cài đặt hoặc mở CapCut thủ công, sau đó thử lại.',
  CAPCUT_APP_LAUNCH_FAILED: () => 'Chưa thể mở CapCut lúc này. Hãy thử lại hoặc mở CapCut thủ công.',
  CAPCUT_EDITOR_BUSY: () => 'CapCut đang mở nên chưa thể ghi dự án an toàn. Hãy đóng CapCut rồi thử lại.',
  CAPCUT_EXPORT_PERMISSION_DENIED: () => 'Ứng dụng không có quyền tạo dự án tại thư mục đã chọn. Hãy cấp quyền hoặc chọn thư mục khác.',
  CAPCUT_EXPORT_STORAGE_FULL: () => 'Không đủ dung lượng để tạo dự án chỉnh sửa. Hãy giải phóng dung lượng rồi thử lại.',
  CAPCUT_EXPORT_COMPONENT_UNAVAILABLE: () => 'Thành phần tạo dự án chỉnh sửa không khả dụng. Hãy cập nhật hoặc cài đặt lại ứng dụng.',
  CAPCUT_COMPATIBILITY_TEMPLATE_UNAVAILABLE: () => 'Chưa thể chuẩn bị dự án chỉnh sửa tự động trên máy này. Hãy chọn một dự án mẫu hoặc xuất ra thư mục riêng rồi thử lại.',
  CAPCUT_EXPORT_COMPATIBILITY_FAILED: () => 'Dự án tạo ra chưa đạt kiểm tra tương thích nên chưa được lưu. Hãy mở CapCut, tạo một dự án trống, đóng CapCut rồi thử lại.',
  CAPCUT_EXPORT_TIMEOUT: () => 'Tạo dự án chỉnh sửa không có tiến triển trong thời gian dài nên đã được dừng an toàn. Hãy kiểm tra dung lượng rồi thử lại.',
  CAPCUT_EXPORT_FAILED: () => 'Chưa thể tạo dự án chỉnh sửa từ dữ liệu hiện tại. Dữ liệu gốc vẫn được giữ; hãy thử lại.',
  CAPCUT_EXPORT_RECOVERY_FAILED: () => 'Không thể dọn hoặc khôi phục an toàn dữ liệu dự án sau khi thao tác bị gián đoạn. Hãy giữ nguyên thư mục và gửi mã chẩn đoán để được hỗ trợ.',
  LOCALIZE_JOB_INPUT_INVALID: () => 'Thông tin tác vụ chưa đầy đủ. Hãy quay lại bước thiết lập và kiểm tra các lựa chọn.',
  LOCALIZE_JOB_NOT_FOUND: () => 'Không tìm thấy trạng thái xử lý trước đó. Dữ liệu đã tạo vẫn được giữ; hãy tiếp tục từ phần đã lưu.',
  LOCALIZE_JOB_OWNERSHIP_CONFLICT: () => 'Dự án đang được một lượt xử lý khác cập nhật. Hãy mở lại dự án để theo dõi đúng lượt hiện tại.',
  LOCALIZE_CHECKPOINT_INVALID: () => 'Dữ liệu tiếp tục của tác vụ chưa hợp lệ. Các tệp đã hoàn tất vẫn được giữ để kiểm tra lại.',
  LOCALIZE_CHECKPOINT_UNAVAILABLE: () => 'Chưa thể lưu hoặc đọc điểm tiếp tục của tác vụ. Hãy kiểm tra dung lượng và thử lại.',
  LOCALIZE_JOB_UNEXPECTED: () => 'Trạng thái xử lý bị gián đoạn ngoài dự kiến. Hãy mở lại dự án để tiếp tục từ phần đã lưu.',
  TEMP_STORAGE_PERMISSION_DENIED: () => 'Ứng dụng không có quyền tạo dữ liệu tạm để hoàn thiện video. Hãy kiểm tra quyền thư mục tạm rồi thử lại.',
  TEMP_STORAGE_FULL: () => 'Vùng lưu tạm không đủ dung lượng để hoàn thiện video. Hãy giải phóng dung lượng trên ổ hệ thống rồi thử lại.',
  TEMP_STORAGE_UNAVAILABLE: () => 'Không thể tạo dữ liệu tạm để hoàn thiện video. Hãy khởi động lại ứng dụng rồi thử lại.',
  VOICE_INPUT_INVALID: () => 'Nội dung hoặc giọng đã chọn chưa hợp lệ. Hãy kiểm tra lại rồi tạo giọng.',
  VOICE_TEXT_TOO_LONG: () => 'Nội dung vượt giới hạn cho một lượt tạo giọng. Hãy chia thành các đoạn ngắn hơn.',
  VOICE_AUTH_REQUIRED: () => 'Phiên đăng nhập đã hết hạn trong khi tạo voice. Hãy đăng nhập lại rồi tiếp tục.',
  VOICE_UPGRADE_REQUIRED: () => 'Gói tài khoản hiện tại chưa hỗ trợ nguồn voice đã chọn. Hãy nâng cấp hoặc chọn nguồn khác.',
  VOICE_CREDITS_INSUFFICIENT: () => 'Tài khoản không đủ credits để tạo giọng cho nội dung này.',
  VOICE_CANCELLED: () => 'Đã hủy tạo giọng.',
  VOICE_JOB_CONFLICT: () => 'Một lượt tạo giọng cho nội dung này đang chạy. Hãy chờ hoàn tất hoặc hủy lượt trước rồi thử lại.',
  VOICE_SERVICE_UNAVAILABLE: (error) => `Nguồn tạo giọng hiện không phản hồi${chunkLabel(error)}. Hãy kiểm tra mạng và thử lại sau.`,
  VOICE_SERVICE_ACCESS_DENIED: (error) => `Nguồn tạo giọng từ chối quyền xử lý${chunkLabel(error)}. Hãy chờ ít phút rồi thử lại.`,
  VOICE_RATE_LIMITED: (error) => `Nguồn tạo giọng đang giới hạn số lượt yêu cầu${chunkLabel(error)}. Hãy chờ ít phút rồi thử lại.`,
  VOICE_REQUEST_REJECTED: (error) => `Nguồn tạo giọng không thể xử lý nội dung hoặc giọng đã chọn${chunkLabel(error)}. Hãy đổi lựa chọn rồi thử lại.`,
  VOICE_REQUEST_TIMEOUT: (error) => `Tạo giọng${chunkLabel(error)} mất nhiều thời gian hơn dự kiến. Hãy thử lại sau ít phút.`,
  VOICE_RESPONSE_INVALID: (error) => `Dữ liệu phản hồi khi tạo giọng${chunkLabel(error)} không hợp lệ. Hãy thử lại sau.`,
  VOICE_AUDIO_RESULT_UNAVAILABLE: (error) => `Tác vụ tạo giọng${chunkLabel(error)} đã hoàn tất nhưng chưa có tệp âm thanh kết quả. Hãy thử lại.`,
  VOICE_AUDIO_DOWNLOAD_FAILED: (error) => `Đã tạo giọng${chunkLabel(error)} nhưng kết nối tải âm thanh bị gián đoạn. Hãy kiểm tra mạng rồi thử lại.`,
  VOICE_AUDIO_DOWNLOAD_TIMEOUT: (error) => `Tải âm thanh${chunkLabel(error)} mất nhiều thời gian hơn dự kiến. Hãy thử lại.`,
  VOICE_AUDIO_INVALID: (error) => `Âm thanh nhận được${chunkLabel(error)} không hợp lệ hoặc chưa đầy đủ. Hãy tạo lại phần này.`,
  VOICE_COMPONENT_UNAVAILABLE: () => 'Thành phần ghép các đoạn giọng của ứng dụng không khả dụng. Hãy cập nhật hoặc cài đặt lại ứng dụng.',
  VOICE_PROCESS_START_DENIED: () => 'Ứng dụng chưa được phép bắt đầu ghép các đoạn giọng. Hãy kiểm tra quyền bảo mật của máy rồi thử lại.',
  VOICE_PROCESS_START_FAILED: () => 'Không thể bắt đầu ghép các đoạn giọng. Hãy khởi động lại ứng dụng rồi thử lại.',
  VOICE_AUDIO_ASSEMBLY_FAILED: () => 'Đã tạo được các phần giọng nhưng không thể ghép thành một tệp hoàn chỉnh. Hãy thử lại.',
  VOICE_AUDIO_ASSEMBLY_TIMEOUT: () => 'Ghép các phần giọng mất nhiều thời gian hơn dự kiến. Hãy thử lại.',
  VOICE_AUDIO_VALIDATION_TIMEOUT: () => 'Kiểm tra tệp giọng mất nhiều thời gian hơn dự kiến. Hãy thử lại.',
  VOICE_OUTPUT_PERMISSION_DENIED: () => 'Ứng dụng không có quyền lưu tệp giọng vào dự án. Hãy kiểm tra quyền thư mục rồi thử lại.',
  VOICE_OUTPUT_STORAGE_FULL: () => 'Không đủ dung lượng để lưu tệp giọng. Hãy giải phóng dung lượng rồi thử lại.',
  VOICE_OUTPUT_UNAVAILABLE: () => 'Không thể lưu tệp giọng vào dự án lúc này. Hãy khởi động lại ứng dụng rồi thử lại.',
  VOICE_OUTPUT_RECOVERY_FAILED: () => 'Không thể khôi phục an toàn tệp giọng trước đó sau khi thao tác lưu bị gián đoạn. Hãy giữ nguyên dự án và gửi mã chẩn đoán để được hỗ trợ.',
  VOICE_UNEXPECTED: () => 'Tạo giọng dừng ngoài dự kiến. Hãy thử lại hoặc gửi mã chẩn đoán để được hỗ trợ.',
  DESKTOP_BRIDGE_UNAVAILABLE: () => 'Kết nối nội bộ của ứng dụng bị gián đoạn. Hãy khởi động lại ứng dụng rồi thử lại.',
  UNEXPECTED: () => 'Đã xảy ra lỗi ngoài dự kiến khi hoàn thiện video. Dữ liệu đã tạo vẫn được giữ; hãy thử lại.',
};

export function publicErrorMessage(error: PublicAppError): string {
  return `${STRUCTURED_ERROR_MESSAGES[error.code](error)}${diagnosticSuffix(error)}`;
}

function unwrapIpcMessage(message: string): string {
  const match = message.match(/Error invoking remote method '[^']+':\s*(?:Error:\s*)?([\s\S]+)$/i);
  return (match?.[1] ?? message).replace(/^Error:\s*/i, '').trim();
}

// Legacy channels still throw strings. Only messages audited below may be
// shown verbatim; everything else fails closed instead of relying on language
// heuristics that can accidentally expose paths, keys or internal details.
const SAFE_LEGACY_USER_MESSAGES = new Set([
  'Tài khoản không đủ credits để thực hiện thao tác này.',
  'Không tìm thấy dữ liệu ảnh. Hãy tải lại và thử lại.',
  'Hệ thống đang bận xử lý ảnh. Vui lòng thử lại sau.',
  'Mô tả ảnh quá dài. Vui lòng rút gọn còn tối đa 4.000 ký tự.',
  'Tỷ lệ ảnh này chưa phù hợp với lựa chọn hiện tại.',
  'Mỗi lần có thể tạo từ 1 đến 4 ảnh.',
  'Ảnh tham chiếu không hợp lệ hoặc có dung lượng quá lớn.',
  'Không thể xử lý yêu cầu ảnh lúc này. Vui lòng thử lại sau.',
  'Hãy nhập câu lệnh tạo ảnh.',
  'Không thể chuẩn bị nơi lưu ảnh. Vui lòng thử lại.',
  'Tài khoản GenSuite không đủ credits để tạo ảnh.',
  'Không thể tạo ảnh lúc này. Vui lòng thử lại sau.',
  'Không thể bắt đầu tạo ảnh. Vui lòng thử lại.',
  'Không nhận được ảnh kết quả. Vui lòng thử lại.',
  'Tạo ảnh không thành công. Hãy điều chỉnh mô tả và thử lại.',
  'Tạo ảnh quá thời gian chờ. Hãy thử lại.',
  'Tạo ảnh đã được hủy.',
  'Chỉ hỗ trợ PNG, JPG hoặc WebP tối đa 20 MB.',
  'Không thể đọc ảnh đã chọn.',
  'Tạo ảnh chưa hoàn tất. Vui lòng thử lại.',
  'Tài khoản GenSuite không đủ credits để tạo nội dung.',
  'Không thể tạo nội dung. Vui lòng thử lại.',
  'Đoạn văn trống.',
  'Giọng đã chọn không còn khả dụng. Hãy chọn lại giọng.',
  'Đoạn văn quá dài. Hãy chia thành các đoạn ngắn hơn rồi thử lại.',
  'Tạo giọng mất nhiều thời gian hơn dự kiến. Hãy thử lại sau ít phút.',
  'Chưa thể tạo giọng lúc này. Hãy kiểm tra kết nối mạng hoặc thử lại sau.',
  'Kết nối tạo giọng bị gián đoạn. Hãy chờ vài giây rồi thử lại.',
  'Không thể bắt đầu tạo giọng. Vui lòng thử lại.',
  'Tạo giọng quá thời gian chờ. Vui lòng thử lại.',
  'Không thể tạo bản nghe thử cho giọng này.',
  'Bản nghe thử mất nhiều thời gian hơn dự kiến. Hãy thử lại sau.',
  'Chưa thể phát bản nghe thử lúc này. Hãy thử lại sau.',
  'Tài khoản GenSuite không đủ credits để nhận dạng.',
  'Không thể bắt đầu nhận dạng lời thoại. Vui lòng thử lại.',
  'Không nhận dạng được lời thoại nào trong tệp nguồn.',
  'Không thể nhận dạng lời thoại. Vui lòng kiểm tra tệp nguồn và thử lại.',
  'Nhận dạng lời thoại quá thời gian chờ. Vui lòng thử lại.',
  'Không thể tải video từ liên kết này. Hãy kiểm tra liên kết hoặc thử lại sau.',
  'Không thể khởi tạo bộ tải video. Vui lòng cài lại ứng dụng.',
  'Đã tải xong nhưng không thể hoàn thiện tệp video. Vui lòng thử lại.',
  'Không thể chuẩn bị dữ liệu nhận dạng. Hãy kiểm tra kết nối và thử lại.',
  'Dữ liệu nhận dạng tải xuống chưa đầy đủ. Vui lòng thử lại.',
  'Không thể chuẩn bị âm thanh từ tệp nguồn.',
  'Không thể khởi động bộ nhận dạng. Vui lòng thử lại.',
  'Quá trình nhận dạng không phản hồi. Hãy thử lại hoặc chọn mức độ chính xác thấp hơn.',
  'Không thể nhận dạng lời thoại từ tệp này. Hãy thử mức độ chính xác thấp hơn.',
  'Không thể đọc kết quả nhận dạng. Vui lòng thử lại.',
  'Không thể chuẩn bị giọng đọc để căn phụ đề.',
  'Không thể căn phụ đề với lời đọc. Vui lòng thử lại.',
  'Không xác định được nhịp lời đọc cho phụ đề. Vui lòng thử lại.',
  'Cần ít nhất một phân cảnh để xuất video.',
  'Không thể xuất video vì một số tệp media hoặc audio không khả dụng.',
  'Không thể khởi động quá trình xuất video.',
  'Quá trình xuất video không hoàn tất. Hãy kiểm tra các tệp đầu vào và thử lại.',
  'Video nguồn không còn khả dụng. Hãy chọn lại video rồi thử lại.',
  'Video nguồn không còn khả dụng. Hãy chọn lại video.',
  'Không tìm thấy video nguồn để xử lý.',
  'Kết quả nhận dạng bị lặp bất thường. Hãy chọn đúng ngôn ngữ gốc hoặc tăng chất lượng nhận dạng rồi thử lại.',
  'Video chưa được lưu thành công.',
  'Không có câu thoại nào để lồng tiếng.',
  'Một số đoạn chưa đủ dữ liệu để hoàn thiện video.',
  'Chưa thể tạo giọng cho đoạn này.',
]);

function containsUnsafeInternalDetail(message: string): boolean {
  if (!message || message.length > 400 || /[\r\n]/.test(message)) return true;
  if (/\b(?:stderr|stdout|stack trace|api[_ -]?key|access[_ -]?token|authorization|bearer|password|secret|endpoint|hostname)\b/i.test(message)) return true;
  if (/https?:\/\/|file:\/\/|\\\\[^\\\s]+[\\/]|\b[A-Z]:[\\/]|(?:^|\s)\/(?:[^\s/]+\/)+/i.test(message)) return true;
  if (/\b(?:sk|pk|api)[-_][A-Za-z0-9_-]{6,}\b|\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]+/i.test(message)) return true;
  if (/\b(?:[a-z0-9-]+\.)+(?:local|internal|com|net|org|io|site)\b/i.test(message)) return true;
  return /yt-?dlp|ffmpeg|ffprobe|whisper(?:\.cpp)?|ggml|codec|encoder|decoder|edge-?tts|edgetts|resources[\\/]/i.test(message);
}

function isSafeLegacyUserMessage(message: string): boolean {
  if (containsUnsafeInternalDetail(message)) return false;
  if (SAFE_LEGACY_USER_MESSAGES.has(message)) return true;
  return /^Đoạn \d+ chưa có lời thuyết minh\.$/.test(message);
}

export function errorMessage(err: unknown): string {
  if (isPublicAppError(err)) {
    rememberDiagnostic(err);
    notifyIfInsufficientCredits(err);
    return publicErrorMessage(err);
  }
  if (notifyIfInsufficientCredits(err)) return 'Tài khoản không đủ credits để thực hiện thao tác này.';
  const msg = unwrapIpcMessage(rawErrorMessage(err));
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
  if (/yt-?dlp|resources[\\/]ytdlp|source-%\(id\)/i.test(msg)) {
    return 'Không thể tải video từ liên kết này. Hãy kiểm tra liên kết hoặc thử lại sau.';
  }
  if (/whisper(?:\.cpp)?|ggml|resources[\\/]whisper/i.test(msg)) {
    return 'Không thể nhận dạng lời thoại. Hãy kiểm tra tệp nguồn hoặc thử lại với chất lượng khác.';
  }
  if (/ffmpeg|ffprobe|codec|encoder|decoder/i.test(msg)) {
    return 'Không thể xử lý tệp media. Hãy kiểm tra định dạng tệp và thử lại.';
  }
  if (isSafeLegacyUserMessage(msg)) return msg;
  return 'Đã xảy ra lỗi khi xử lý. Vui lòng thử lại.';
}
