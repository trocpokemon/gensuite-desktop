import type { AspectRatio } from '../../shared/types';

// AI image generation providers exposed in the Storyboard "Tạo sinh AI" tab.
// Both run through the GenSuite paid Developer API; only the model id differs.
export type ImageEngine = 'gemini' | 'chatgpt';

export interface ImageGenRequest {
  prompt: string;
  ratio: AspectRatio;
  /** How many candidates to generate (1–4). */
  count?: number;
  /** Character reference images as data URLs (max 4), sent to keep recurring
   * characters visually consistent across scenes. */
  referenceImageDataUrls?: string[];
}

// Abstraction the UI depends on. `generate` resolves only once the async job
// finishes, returning signed image URLs ready to download into the project.
export interface IImageProvider {
  readonly engine: ImageEngine;
  generate(req: ImageGenRequest): Promise<string[]>;
}
