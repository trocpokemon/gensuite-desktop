import type { MediaResult } from '../../shared/types';
import type { IMediaProvider, MediaSearchRequest } from './types';
import { orientation } from './types';

// Free stock via the user's Pixabay API key. Docs: https://pixabay.com/api/docs/
export class PixabayAdapter implements IMediaProvider {
  readonly engine = 'pixabay' as const;

  constructor(private apiKey: string) {}

  async search(req: MediaSearchRequest): Promise<MediaResult[]> {
    if (!this.apiKey?.trim()) throw new Error('MISSING_KEY:pixabay');

    const mediaType = req.mediaType ?? 'image';
    const url = new URL(mediaType === 'video' ? 'https://pixabay.com/api/videos/' : 'https://pixabay.com/api/');
    url.searchParams.set('key', this.apiKey.trim());
    url.searchParams.set('q', req.keyword);
    url.searchParams.set('per_page', String(req.perPage ?? 12));
    url.searchParams.set('page', String(req.page ?? 1));
    if (mediaType === 'image') {
      url.searchParams.set('image_type', 'photo');
      url.searchParams.set('orientation', orientation(req.ratio) === 'portrait' ? 'vertical' : 'horizontal');
    }

    const resp = await fetch(url.toString());
    if (resp.status === 400 || resp.status === 401) throw new Error('MISSING_KEY:pixabay');
    if (!resp.ok) throw new Error(`Pixabay lỗi ${resp.status}`);

    const data = await resp.json().catch(() => null);
    const hits = Array.isArray((data as any)?.hits) ? (data as any).hits : [];
    if (mediaType === 'video') {
      return hits.flatMap((hit: any): MediaResult[] => {
        const rendition = hit.videos?.large?.url ? hit.videos.large
          : hit.videos?.medium?.url ? hit.videos.medium
            : hit.videos?.small?.url ? hit.videos.small : hit.videos?.tiny;
        if (!rendition?.url) return [];
        return [{
          id: `pixabay_video_${hit.id}`,
          mediaType: 'video',
          thumbUrl: rendition.thumbnail,
          fullUrl: rendition.url,
          width: Number(rendition.width) || 0,
          height: Number(rendition.height) || 0,
          author: hit.user,
          source: 'pixabay',
        }];
      });
    }

    return hits.map((h: any): MediaResult => ({
      id: `pixabay_${h.id}`,
      mediaType: 'image',
      thumbUrl: h.webformatURL ?? h.previewURL,
      fullUrl: h.largeImageURL ?? h.fullHDURL ?? h.webformatURL,
      width: Number(h.imageWidth) || 0,
      height: Number(h.imageHeight) || 0,
      author: h.user,
      source: 'pixabay',
    }));
  }
}
