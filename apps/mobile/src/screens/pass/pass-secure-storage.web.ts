/**
 * Browser preview storage: the web build's stand-in for `pass-secure-storage.ts` (Metro picks this
 * file on the web only; the app's iOS and Android bundles never contain it, and
 * scripts/check-release-bundle.mjs fails if they do). The web build is a development preview for
 * screenshots against the local demo API, not a product surface (§2.2). A browser has no platform
 * secure store: the pass reference lives in localStorage, which is not secure storage.
 */
import type { PassSecureStorage } from './pass-secure-storage';

/** Marks this stand-in in a bundle for scripts/check-release-bundle.mjs (code, not a comment). */
export const STORAGE_KIND = 'Browser preview storage';

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export const passSecureStorage: PassSecureStorage & { kind: string } = {
  kind: STORAGE_KIND,
  getItem: async (key) => storage()?.getItem(key) ?? null,
  setItem: async (key, value) => {
    storage()?.setItem(key, value);
  },
  removeItem: async (key) => {
    storage()?.removeItem(key);
  },
};
