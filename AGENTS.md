# GenSuite Desktop — Quy tắc phát triển

## Bảo mật công nghệ lõi (bắt buộc)

- Tuyệt đối không để lộ công nghệ lõi trong bất kỳ nội dung nào người dùng có thể nhìn thấy: giao diện, tooltip, thông báo tiến trình, thông báo lỗi, hộp thoại, ảnh chụp, tệp xuất, log hiển thị trong ứng dụng hoặc tài liệu hướng dẫn người dùng.
- Không hiển thị tên thư viện, binary, framework, runtime, codec implementation, engine nội bộ, model nội bộ, endpoint, cấu trúc thư mục, lệnh hệ thống hoặc chi tiết hạ tầng.
- Mọi nội dung hướng tới người dùng phải mô tả theo chức năng hoặc kết quả, ví dụ: “bộ tải video”, “nhận dạng lời thoại”, “xử lý media”, “dữ liệu nhận dạng”, “chất lượng nhận dạng”.
- Không đưa nguyên văn `stderr`, stack trace, mã lỗi nội bộ hoặc thông báo từ dependency ra giao diện. Phải ánh xạ thành thông báo tiếng Việt trung tính, dễ hành động và không tiết lộ cách triển khai.
- Tên một dịch vụ bên thứ ba chỉ được xuất hiện khi người dùng bắt buộc phải chủ động chọn, đăng nhập hoặc cấu hình khóa cho chính dịch vụ đó. Không dùng tên dịch vụ để giải thích công nghệ vận hành phía sau một tính năng.
- Tên định danh nội bộ vẫn được phép tồn tại trong mã nguồn, type, IPC và chú thích dành cho lập trình viên, miễn là không thể xuất hiện trong sản phẩm hoặc tài liệu người dùng.
- Khi thêm hoặc sửa UI, phải rà soát riêng các chuỗi hiển thị và đường truyền lỗi để bảo đảm tuân thủ quy tắc này trước khi hoàn tất.

