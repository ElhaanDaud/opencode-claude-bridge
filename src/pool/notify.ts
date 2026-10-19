import { POOL_TOAST_DURATION_MS } from "../constants.js";
import type { Clock } from "./types.js";

export type ToastVariant = "info" | "success" | "warning" | "error";

export interface ToastClient {
  tui?: {
    showToast?: (args: {
      body: { title?: string; message: string; variant: ToastVariant; duration?: number };
    }) => Promise<unknown>;
  };
}

/** Identical toasts inside this window are shown once, so concurrent requests don't stack them. */
export const TOAST_REPEAT_MS = 60_000;

/** `dedupeKey` names the condition when its text changes over time, e.g. a countdown. */
export type Toaster = (variant: ToastVariant, message: string, dedupeKey?: string) => void;

export function createToaster(client: ToastClient, clock: Clock = () => Date.now()): Toaster {
  const lastShown = new Map<string, number>();

  return (variant, message, dedupeKey = message) => {
    const now = clock();
    for (const [key, at] of lastShown) {
      if (now - at >= TOAST_REPEAT_MS) lastShown.delete(key);
    }
    const key = `${variant}:${dedupeKey}`;
    if (lastShown.has(key)) return;
    lastShown.set(key, now);

    // Fire-and-forget: a slow or absent TUI must never delay or fail a request.
    void Promise.resolve()
      .then(() =>
        client.tui?.showToast?.({
          body: { title: "Claude pool", message, variant, duration: POOL_TOAST_DURATION_MS },
        }),
      )
      .catch(() => {});
  };
}
