import { create } from 'zustand';

interface CreditPromptStore {
  open: boolean;
  close: () => void;
  show: () => void;
}

export const useCreditPromptStore = create<CreditPromptStore>((set) => ({
  open: false,
  close: () => set({ open: false }),
  show: () => set({ open: true }),
}));

function rawMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const value = error as { code?: unknown; message?: unknown; status?: unknown };
    return `${String(value.code ?? '')} ${String(value.message ?? '')} ${String(value.status ?? '')}`;
  }
  return '';
}

export function isInsufficientCreditsError(error: unknown): boolean {
  const message = rawMessage(error);
  return /INSUFFICIENT_CREDITS|CREDITS_INSUFFICIENT|not enough credits|insufficient credits|không đủ credits|hết credits/i.test(message);
}

export function notifyIfInsufficientCredits(error: unknown): boolean {
  if (!isInsufficientCreditsError(error)) return false;
  useCreditPromptStore.getState().show();
  return true;
}
