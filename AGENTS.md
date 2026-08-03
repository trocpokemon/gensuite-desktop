# GenSuite Desktop — Quy tắc phát triển

## Dự án nguồn tham chiếu GenSuite (bắt buộc)

- Source chính thức của `gensuite.site` nằm tại `C:\Users\Admin\Desktop\Tools\Gensuite-Audio`.
- Khi bổ sung hoặc sửa một chức năng đã tồn tại trên `gensuite.site`, bắt buộc đối chiếu source này về luồng dữ liệu, trạng thái, tính năng, nội dung, UI và UX; không tự làm phiên bản rút gọn nếu người dùng không yêu cầu rõ.
- Với Image Studio, nguồn chuẩn là `features/imageStudio/ImageStudioPanel.tsx` và `services/imageStudioService.ts` trong dự án tham chiếu. Desktop phải giữ đủ các luồng dự án, lịch sử ảnh, ảnh tham chiếu, nhân vật, chỉnh sửa/phiên bản, tải và xóa.
- Chỉ được điều chỉnh cách trình bày để phù hợp hệ thống thiết kế desktop; không được âm thầm loại bỏ hành vi hoặc trạng thái quan trọng của bản web.

## Bảo mật công nghệ lõi (bắt buộc)

- Tuyệt đối không để lộ công nghệ lõi trong bất kỳ nội dung nào người dùng có thể nhìn thấy: giao diện, tooltip, thông báo tiến trình, thông báo lỗi, hộp thoại, ảnh chụp, tệp xuất, log hiển thị trong ứng dụng hoặc tài liệu hướng dẫn người dùng.
- Không hiển thị tên thư viện, binary, framework, runtime, codec implementation, engine nội bộ, model nội bộ, endpoint, cấu trúc thư mục, lệnh hệ thống hoặc chi tiết hạ tầng.
- Mọi nội dung hướng tới người dùng phải mô tả theo chức năng hoặc kết quả, ví dụ: “bộ tải video”, “nhận dạng lời thoại”, “xử lý media”, “dữ liệu nhận dạng”, “chất lượng nhận dạng”.
- Không đưa nguyên văn `stderr`, stack trace, mã lỗi nội bộ hoặc thông báo từ dependency ra giao diện. Phải ánh xạ thành thông báo tiếng Việt trung tính, dễ hành động và không tiết lộ cách triển khai.
- Tên một dịch vụ bên thứ ba chỉ được xuất hiện khi người dùng bắt buộc phải chủ động chọn, đăng nhập hoặc cấu hình khóa cho chính dịch vụ đó. Không dùng tên dịch vụ để giải thích công nghệ vận hành phía sau một tính năng.
- Tên định danh nội bộ vẫn được phép tồn tại trong mã nguồn, type, IPC và chú thích dành cho lập trình viên, miễn là không thể xuất hiện trong sản phẩm hoặc tài liệu người dùng.
- Khi thêm hoặc sửa UI, phải rà soát riêng các chuỗi hiển thị và đường truyền lỗi để bảo đảm tuân thủ quy tắc này trước khi hoàn tất.

## Hợp đồng lỗi và chẩn đoán (bắt buộc)

- Lỗi từ main process/IPC phải trả về payload có cấu trúc theo `PublicAppError`/`IpcResult`; không dựa vào nội dung chuỗi hoặc tên IPC channel để đoán nguyên nhân.
- Mỗi pipeline nền phải phân biệt tối thiểu giai đoạn lỗi, nguyên nhân, khả năng thử lại và mã chẩn đoán. Phải tách riêng lỗi thiếu đầu vào, đầu vào không đọc được, mạng/xác thực, giới hạn, quyền ghi, dung lượng, thành phần không khả dụng, không khởi động được và xử lý thất bại khi các nguyên nhân này có thể nhận biết.
- Payload gửi sang renderer chỉ được chứa code, stage, cause, retryable, diagnosticId và context số đã whitelist. Tuyệt đối không gửi path, nội dung người dùng, URL, endpoint, lệnh, raw output, stack hoặc mã hạ tầng.
- Log nội bộ phải gắn cùng `diagnosticId` và chỉ ghi metadata an toàn cần thiết để tái hiện như stage, số lượng, số thứ tự nhóm/câu và code đã chuẩn hóa; không ghi nội dung hoặc đường dẫn khách hàng.
- Renderer phải ánh xạ code sang thông báo tiếng Việt cụ thể, có hành động tiếp theo. Lỗi không biết phải fail-closed bằng thông báo trung tính; tuyệt đối không `return` nguyên văn lỗi lạ.
- Khi thêm mã lỗi hoặc pipeline mới, phải kiểm thử cả payload trực tiếp và lỗi bị Electron bọc, đồng thời xác nhận UI không hiển thị tên công nghệ lõi hay chi tiết nội bộ.
- Timeout phải bao phủ toàn bộ thao tác, gồm cả lúc đọc nội dung phản hồi hoặc tải dữ liệu sau khi đã nhận phần đầu. Tiến trình nền dài phải có inactivity watchdog; khi timeout/hủy phải dừng và chờ tiến trình con kết thúc trước khi dọn tệp.
- Mọi thao tác thay thế tệp kết quả phải dùng partial/backup theo giao dịch. Không được báo hủy hoặc lỗi chung nếu rollback/khôi phục thất bại; phải giữ bản có thể phục hồi và trả mã lỗi phục hồi riêng.

## Hệ thống thiết kế và tính đồng bộ UI (bắt buộc)

- Mọi màn hình phải tái sử dụng component dùng chung và token hiện có trước khi tạo kiểu riêng. Field dùng `field-surface`, hành động chính dùng `primary-action`; màu, khoảng cách, bo góc và trạng thái focus phải theo cùng ngôn ngữ thị giác của ứng dụng.
- Tuyệt đối không dùng thẻ `select`/`option` mặc định trong mã giao diện. Mọi dropdown phải dùng `AppSelect` để bảo đảm nền tối, lớp nổi, trạng thái chọn, hover, focus, disabled và bàn phím đồng nhất trên mọi máy.
- Dropdown, popover và menu phải hiển thị qua lớp nổi cấp ứng dụng, không bị cắt bởi `overflow`, tự mở lên trên khi thiếu chỗ, không tràn khỏi viewport và xử lý được nội dung dài.
- Component tương tác bắt buộc có đủ trạng thái: mặc định, hover, focus-visible, active/open, disabled, loading và lỗi khi có liên quan. Không dùng màu mặc định của hệ điều hành cho bất kỳ trạng thái nào người dùng nhìn thấy.
- Không sao chép một control để đổi vài class tại từng màn hình. Nếu một mẫu xuất hiện từ hai nơi trở lên, phải đưa về component dùng chung; thay đổi thiết kế phải sửa ở component hoặc token chung.
- Khi sửa UI phải kiểm tra ít nhất ở kích thước cửa sổ 1366×768 và 1920×1080, với nội dung dài, dropdown ở sát cạnh dưới/phải, trạng thái disabled và thao tác bàn phím.
- Trước khi hoàn tất mọi thay đổi UI, bắt buộc chạy `npm run ui:check`, `npm run typecheck` và `npm run build`. Không được bỏ qua lỗi hoặc cảnh báo về control không đồng bộ.
