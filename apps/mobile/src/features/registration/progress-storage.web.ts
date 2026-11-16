/**
 * Browser preview storage: the web build's stand-in for `progress-storage.ts` (Metro picks this
 * file on the web only; the app's iOS and Android bundles never contain it, and
 * scripts/check-release-bundle.mjs fails if they do). The web build is a development preview for
 * screenshots, not a product surface (§2.2). The progress lives in the browser's localStorage under
 * the same key; unavailable storage reads as no progress.
 */
import type { ProgressBackend } from './progress';

/** Marks this stand-in in a bundle for scripts/check-release-bundle.mjs (code, not a comment). */
export const STORAGE_KIND = 'Browser preview storage';

export const PROGRESS_STORAGE_KEY = 'sportspark.registration-progress';

export const secureProgressBackend: ProgressBackend & { kind: string } = {
  kind: STORAGE_KIND,
  read: async () => {
    try {
      return globalThis.localStorage?.getItem(PROGRESS_STORAGE_KEY) ?? null;
    } catch {
      return null;
    }
  },
  write: async (value) => {
    globalThis.localStorage?.setItem(PROGRESS_STORAGE_KEY, value);
  },
};
