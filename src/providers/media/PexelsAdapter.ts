import type { MediaResult } from '../../shared/types';
import type { IMediaProvider, MediaSearchRequest } from './types';
import { orientation } from './types';

// Free stock via the user's Pexels API key. Docs: https://www.pexels.com/api/
export class PexelsAdapter implements IMediaProvider {
  readonly engine = 'pexels' as const;

  constructor(private apiKey: string) {}

  async search(req: MediaSearchRequest): Promise<MediaResult[]> {
    if (!this.apiKey?.trim()) throw new Error('MISSING_KEY:pexels');

    const mediaType = req.mediaType ?? 'image';
    const url = new URL(mediaType === 'video'
      ? 'https://api.pexels.com/v1/videos/search'
      : 'https://api.pexels.com/v1/search');
    url.searchParams.set('query', req.keyword);
    url.searchParams.set('per_page', String(req.perPage ?? 12));
    url.searchParams.set('page', String(req.page ?? 1));
    url.searchParams.set('orientation', orientation(req.ratio));

    const resp = await fetch(url.toString(), {
      headers: { Authorization: this.apiKey.trim() },
    });
    if (resp.status === 401) throw new Error('MISSING_KEY:pexels');
    if (!resp.ok) throw new Error(`Pexels lỗi ${resp.status}`);

    const data = await resp.json().catch(() => null);
    if (mediaType === 'video') {
      const videos = Array.isArray((data as any)?.videos) ? (data as any).videos : [];
      return videos.flatMap((video: any): MediaResult[] => {
        const files = (Array.isArray(video.video_files) ? video.video_files : [])
          .filter((file: any) => file?.link && (!file.file_type || file.file_type === 'video/mp4'))
          .sort((a: any, b: any) => (Number(a.width) || 0) - (Number(b.width) || 0));
        const file = files.find((item: any) => Number(item.width) >= 1920) ?? files.at(-1);
        if (!file?.link) return [];
        return [{
          id: `pexels_video_${video.id}`,
          mediaType: 'video',
          thumbUrl: video.image,
          fullUrl: file.link,
          width: Number(file.width ?? video.width) || 0,
          height: Number(file.height ?? video.height) || 0,
          author: video.user?.name,
          source: 'pexels',
        }];
      });
    }

    const photos = Array.isArray((data as any)?.photos) ? (data as any).photos : [];
    return photos.map((p: any): MediaResult => ({
      id: `pexels_${p.id}`,
      mediaType: 'image',
      thumbUrl: p.src?.medium ?? p.src?.small ?? p.src?.original,
      fullUrl: p.src?.large2x ?? p.src?.large ?? p.src?.original,
      width: Number(p.width) || 0,
      height: Number(p.height) || 0,
      author: p.photographer,
      source: 'pexels',
    }));
  }
}
