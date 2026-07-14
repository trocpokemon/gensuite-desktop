/** Convert an absolute project file path into the private Electron media URL. */
export function localFileUrl(filePath?: string): string | undefined {
  if (!filePath) return undefined;
  const normalized = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const encoded = normalized.split('/').map((part, index) => index === 0 ? part : encodeURIComponent(part)).join('/');
  return `gensuite-file:///${encoded}`;
}

/** Read a local project image into a base64 data URL, for sending to the GenSuite
 * image API as a reference. The gensuite-file scheme supports fetch in the
 * renderer, so we fetch the private URL and encode the blob. */
export async function localFileToDataUrl(filePath: string): Promise<string> {
  const url = localFileUrl(filePath);
  if (!url) throw new Error('Đường dẫn ảnh không hợp lệ.');
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('Không đọc được ảnh nhân vật.');
  const blob = await resp.blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Không đọc được ảnh nhân vật.'));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}
