import type { AspectRatio, MediaEngine, MediaResult } from '../../shared/types';

export interface MediaSearchRequest {
  keyword: string;
  ratio: AspectRatio;
  mediaType?: 'image' | 'video';
  perPage?: number;
  page?: number;
}

// Abstraction the UI depends on. Concrete adapters (Pexels/Pixabay/Unsplash) are
// swapped at runtime based on the media engine toggle.
export interface IMediaProvider {
  readonly engine: MediaEngine;
  search(req: MediaSearchRequest): Promise<MediaResult[]>;
}

// Orientation param derived from aspect ratio, shared by all stock adapters.
export function orientation(ratio: AspectRatio): 'landscape' | 'portrait' {
  return ratio === '9:16' ? 'portrait' : 'landscape';
}
