# Capture Studio

Tạo test case bằng cách ghi lại thao tác trên giao diện, quản lý test case con và ghép nhiều
test case con thành test case tổng hợp. Giao diện theo SooBinZHongSon Design System.

## Chạy

```bash
npm run studio          # http://localhost:4700
```

## Luồng làm việc

1. **Ghi test case mới** — nhập URL, Chromium mở ra, thao tác trên trang. Mỗi thao tác
   (bấm, nhập, chọn, tích) thành một bước, hiện live trong studio.
2. **Chế độ kiểm tra** — chuyển bằng thanh công cụ nổi trong cửa sổ ghi. Bấm vào phần tử
   để mở menu đọc trạng thái thực và chọn bước kiểm tra: hiển thị / đã ẩn, đang bật /
   bị vô hiệu (bấm được cả nút disabled), đã tích / chưa tích, văn bản (chứa / không chứa),
   giá trị ô nhập, **lựa chọn đang hiển thị của dropdown** (so nhãn, không so value ẩn),
   thuộc tính bất kỳ, số phần tử khớp selector, URL trang, tiêu đề trang,
   và cấu trúc cả vùng bằng ARIA snapshot. Ngoài các giá trị đang có sẵn trên trang,
   mục **"Tự nhập giá trị kiểm tra"** cho gõ tay giá trị mong đợi (ví dụ `ABC`) rồi chọn
   kiểu so khớp — hỗ trợ cả tham số `{{...}}`. Ghi cả thao tác trong iframe (same-origin
   dùng chuỗi frame, cross-origin theo URL); bấm đúp được gộp tự động.
   Bổ sung: mỗi test case có **tham số** — dùng `{{ten}}` trong giá trị nhập / văn bản /
   URL và khai báo giá trị mặc định trong ngăn chi tiết; có thể **thêm bước thủ công**
   (chờ, tải lại trang, quay lại, nhấn phím bất kỳ, mọi loại kiểm tra) không cần ghi.
3. **Dừng và lưu** — đặt tên, test case con được lưu vào `data/testcases/*.json`.
4. **Sửa bước** — trong ngăn chi tiết, mỗi bước sửa được selector và giá trị mong đợi,
   đổi thứ tự hoặc xoá.
5. **Ghép test case** — tick chọn nhiều dòng trong bảng → "Tạo test case tổng hợp".
   Các con chạy nối tiếp theo thứ tự, trong cùng một phiên trình duyệt; test case
   tổng hợp có thể chứa cả test case tổng hợp khác.
6. **Chạy** — chạy có cửa sổ hoặc chạy ẩn; kết quả từng bước hiện live. Evidence được
   chụp **sau mỗi bước, cả đạt lẫn lỗi**, lưu cùng `run.json` trong `data/runs/<runId>/`.
   Tick nhiều test case → "Chạy các mục đã chọn" để chạy cả đợt.
7. **Kiểm thử** — lịch sử mọi lượt chạy: lọc theo test case, xem chi tiết từng bước kèm
   ảnh evidence, chạy lại hoặc xoá lượt chạy. Bản ghi độc lập với test case — sửa hay
   xoá test case sau đó không mất evidence.
8. **Xuất mã** — sinh Playwright spec vào `tests/generated/`, chạy được bằng
   `npx playwright test` như test thường.

## Selector

Khi ghi, selector được chọn theo thứ tự ưu tiên: `data-testid` / `data-test` /
`data-qa` → `#id` (nếu duy nhất) → `[name]` → đường dẫn CSS ngắn nhất còn duy nhất.
Giá trị nhập vào ô mật khẩu được đánh dấu `secret` và ẩn trên giao diện.

## Cấu trúc

| Đường dẫn | Vai trò |
| --- | --- |
| `server.js` | Express + WebSocket, API REST |
| `lib/recorder.js` | Phiên ghi — mở Chromium, nhận bước từ trang |
| `lib/page-recorder.js` | Script inject vào trang: bắt sự kiện, sinh selector, chế độ kiểm tra |
| `lib/runner.js` | Chạy test case (đơn / tổng hợp), stream kết quả |
| `lib/codegen.js` | Xuất Playwright spec |
| `lib/store.js` | Lưu test case dạng JSON |
| `public/` | Giao diện — tokens design system trong `public/ds/` |
| `data/testcases/` | Test case (commit được) |
| `data/runs/` | Ảnh chụp khi chạy lỗi (bỏ qua git) |
