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

if (violations.length) {
  console.error(`Kiểm tra tính đồng bộ giao diện thất bại:\n${violations.map((item) => `- ${item}`).join('\n')}`);
  process.exit(1);
}

console.log('Kiểm tra tính đồng bộ giao diện: đạt.');
