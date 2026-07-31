import { create } from 'zustand';
import type { AppSettings } from '../shared/types';
import { DEFAULT_SUBTITLE_PRESET_ID } from '../shared/subtitlePresets';

// Optional third-party keys and user preferences are persisted through IPC.
// GenSuite account access comes from the signed-in session and is not stored here.

const EMPTY: AppSettings = {
  googleApiKey: '',
  pexelsApiKey: '',
  pixabayApiKey: '',
  unsplashApiKey: '',
  subtitlePresets: [],
  defaultSubtitlePresetId: DEFAULT_SUBTITLE_PRESET_ID,
};

interface SettingsStore {
  keys: AppSettings;
  loaded: boolean;
  load: () => Promise<void>;
  save: (next: AppSettings) => Promise<void>;
}

export const useSettingsStore = create<SettingsStore>((set) => ({
  keys: { ...EMPTY },
  loaded: false,
  load: async () => {
    try {
      const keys = await window.gensuite?.settings.load();
      set({ keys: keys ? { ...EMPTY, ...keys, subtitlePresets: keys.subtitlePresets ?? [] } : { ...EMPTY }, loaded: true });
    } catch (err) {
      console.error('settings load failed', err);
      set({ loaded: true });
    }
  },
  save: async (next) => {
    await window.gensuite.settings.save(next);
    set({ keys: next });
  },
}));
