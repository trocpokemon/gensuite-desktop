import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const sourceRoot = path.resolve('src');
const violations = [];

async function visit(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return visit(fullPath);
    if (!entry.name.endsWith('.tsx')) return;
    const source = await readFile(fullPath, 'utf8');
    const checks = [
      { pattern: /<select\b/gi, message: 'Không dùng select mặc định; hãy dùng AppSelect.' },
      { pattern: /<option\b/gi, message: 'Khai báo lựa chọn qua options của AppSelect.' },
    ];
    for (const check of checks) {
      for (const match of source.matchAll(check.pattern)) {
        const line = source.slice(0, match.index).split(/\r?\n/).length;
        violations.push(`${path.relative(process.cwd(), fullPath)}:${line} ${check.message}`);
      }
    }
  }));
}

await visit(sourceRoot);

const appSource = await readFile(path.join(sourceRoot, 'App.tsx'), 'utf8');
const titleBarSource = await readFile(path.join(sourceRoot, 'components', 'TitleBar.tsx'), 'utf8');
const dialogsSource = await readFile(path.join(sourceRoot, 'components', 'GlobalDialogs.tsx'), 'utf8');
if (!appSource.includes('<GlobalDialogs />')) {
  violations.push('App.tsx phải gắn lớp popup dùng chung ở cấp ứng dụng.');
}
if (!titleBarSource.includes('Kiểm tra cập nhật')) {
  violations.push('Thanh tiêu đề phải có hành động kiểm tra cập nhật cạnh cài đặt.');
}
if (!dialogsSource.includes('https://gensuite.site/app/pricing')) {
  violations.push('Thông báo thiếu credits phải dẫn tới trang chọn gói chính thức.');
}
if (!dialogsSource.includes('role=') && !(await readFile(path.join(sourceRoot, 'components', 'AppModal.tsx'), 'utf8')).includes('role="dialog"')) {
  violations.push('Popup dùng chung phải khai báo vai trò dialog hỗ trợ trợ năng.');
}

if (violations.length) {
  console.error(`Kiểm tra tính đồng bộ giao diện thất bại:\n${violations.map((item) => `- ${item}`).join('\n')}`);
  process.exit(1);
}

console.log('Kiểm tra tính đồng bộ giao diện: đạt.');
