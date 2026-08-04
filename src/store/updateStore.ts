import { create } from 'zustand';
import type { UpdaterStatus } from '../shared/types';

interface UpdateStore {
  dialogOpen: boolean;
  initialized: boolean;
  status: UpdaterStatus;
  closeDialog: () => void;
  initialize: () => void;
  openChecker: () => void;
  startDownload: () => void;
  install: () => void;
}

const IDLE_STATUS: UpdaterStatus = { kind: 'not-available' };
const CHECK_TIMEOUT_MS = 25_000;
let checkWatchdog: number | null = null;

function clearCheckWatchdog(): void {
  if (checkWatchdog !== null) window.clearTimeout(checkWatchdog);
  checkWatchdog = null;
}

function armCheckWatchdog(set: (partial: Partial<UpdateStore>) => void, get: () => UpdateStore): void {
  clearCheckWatchdog();
  checkWatchdog = window.setTimeout(() => {
    checkWatchdog = null;
    if (get().status.kind !== 'checking') return;
    set({
      status: {
        kind: 'error',
        message: 'Kiểm tra cập nhật mất nhiều thời gian hơn dự kiến. Hãy kiểm tra kết nối rồi thử lại.',
      },
    });
  }, CHECK_TIMEOUT_MS);
}

export const useUpdateStore = create<UpdateStore>((set, get) => ({
  dialogOpen: false,
  initialized: false,
  status: IDLE_STATUS,
  closeDialog: () => set({ dialogOpen: false }),
  initialize: () => {
    if (get().initialized) return;
    set({ initialized: true });
    const updater = window.gensuite?.updater;
    if (!updater) return;

    let liveEventReceived = false;
    const applyStatus = (status: UpdaterStatus) => {
      liveEventReceived = true;
      if (status.kind === 'checking') armCheckWatchdog(set, get);
      else clearCheckWatchdog();
      set((state) => ({
        status,
        dialogOpen: status.kind === 'available' || status.kind === 'downloaded' ? true : state.dialogOpen,
      }));
    };
    updater.onStatus(applyStatus);
    void updater.getStatus().then((status) => {
      if (liveEventReceived) return;
      if (status.kind === 'checking') armCheckWatchdog(set, get);
      else clearCheckWatchdog();
      set({
        status,
        dialogOpen: status.kind === 'available' || status.kind === 'downloaded',
      });
    }).catch(() => undefined);
  },
  openChecker: () => {
    const updater = window.gensuite?.updater;
    const status = get().status;
    if (!updater) {
      set({ dialogOpen: true, status: { kind: 'error', message: 'Chưa thể kiểm tra bản cập nhật lúc này.' } });
      return;
    }
    if (status.kind === 'available' || status.kind === 'downloading' || status.kind === 'downloaded') {
      set({ dialogOpen: true });
      return;
    }
    set({ dialogOpen: true, status: { kind: 'checking' } });
    armCheckWatchdog(set, get);
    updater.check();
  },
  startDownload: () => window.gensuite?.updater?.download(),
  install: () => window.gensuite?.updater?.install(),
}));
