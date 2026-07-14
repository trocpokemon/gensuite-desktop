import type { AppSettings, MediaEngine } from '../../shared/types';
import type { IMediaProvider } from './types';
import { PexelsAdapter } from './PexelsAdapter';
import { PixabayAdapter } from './PixabayAdapter';
import { UnsplashAdapter } from './UnsplashAdapter';

export type { IMediaProvider, MediaSearchRequest } from './types';

// Swap the concrete stock adapter at runtime based on the media engine toggle.
// The UI only ever calls this factory, never a concrete adapter.
export function getMediaProvider(engine: MediaEngine, keys: AppSettings): IMediaProvider {
  switch (engine) {
    case 'pexels':
      return new PexelsAdapter(keys.pexelsApiKey);
    case 'pixabay':
      return new PixabayAdapter(keys.pixabayApiKey);
    case 'unsplash':
      return new UnsplashAdapter(keys.unsplashApiKey);
    default:
      return new PexelsAdapter(keys.pexelsApiKey);
  }
}
