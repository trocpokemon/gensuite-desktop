import { create } from 'zustand';
import type { AppSettings } from '../shared/types';

// API keys, persisted to <userData>/GenSuite/settings.json via IPC. Values are
// masked in the UI; only the SettingsPanel reveals/edits raw values.

const EMPTY: AppSettings = {
  googleApiKey: '',
  pexelsApiKey: '',
  pixabayApiKey: '',
  unsplashApiKey: '',
  gensuiteApiKey: '',
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
      set({ keys: keys ?? { ...EMPTY }, loaded: true });
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
