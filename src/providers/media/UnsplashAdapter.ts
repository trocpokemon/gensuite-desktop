import type { MediaResult } from '../../shared/types';
import type { IMediaProvider, MediaSearchRequest } from './types';
import { orientation } from './types';

// Free stock via the user's Unsplash Access Key. Docs: https://unsplash.com/documentation
export class UnsplashAdapter implements IMediaProvider {
  readonly engine = 'unsplash' as const;

  constructor(private apiKey: string) {}

  async search(req: MediaSearchRequest): Promise<MediaResult[]> {
    if (!this.apiKey?.trim()) throw new Error('MISSING_KEY:unsplash');
    if (req.mediaType === 'video') throw new Error('Unsplash không hỗ trợ tìm video.');

    const url = new URL('https://api.unsplash.com/search/photos');
    url.searchParams.set('query', req.keyword);
    url.searchParams.set('per_page', String(req.perPage ?? 12));
    url.searchParams.set('page', String(req.page ?? 1));
    url.searchParams.set('orientation', orientation(req.ratio));

    const resp = await fetch(url.toString(), {
      headers: { Authorization: `Client-ID ${this.apiKey.trim()}` },
    });
    if (resp.status === 401) throw new Error('MISSING_KEY:unsplash');
    if (!resp.ok) throw new Error(`Unsplash lỗi ${resp.status}`);

    const data = await resp.json().catch(() => null);
    const results = Array.isArray((data as any)?.results) ? (data as any).results : [];
    return results.map((r: any): MediaResult => ({
      id: `unsplash_${r.id}`,
      mediaType: 'image',
      thumbUrl: r.urls?.small ?? r.urls?.thumb,
      fullUrl: r.urls?.full ?? r.urls?.regular,
      width: Number(r.width) || 0,
      height: Number(r.height) || 0,
      author: r.user?.name,
      source: 'unsplash',
    }));
  }
}
