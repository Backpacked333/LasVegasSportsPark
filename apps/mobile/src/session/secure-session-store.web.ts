/**
 * Browser preview storage: the web build's stand-in for `secure-session-store.ts` (Metro picks
 * this file on the web only; the app's iOS and Android bundles never contain it, and
 * scripts/check-release-bundle.mjs fails if they do). The web build is a development preview for
 * screenshots against the local demo API, not a product surface (§2.2, §4.13): a browser has no
 * platform secure store, so this keeps the session in sessionStorage, which lasts while the tab is
 * open (page loads included) and is not secure storage.
 */
import { parseStoredSession, type Session, type SessionStore } from '@sportspark/api-client';

/** Marks this stand-in in a bundle for scripts/check-release-bundle.mjs (code, not a comment). */
export const STORAGE_KIND = 'Browser preview storage';

export const SESSION_STORAGE_KEY = 'sportspark.session';

function storage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export class SecureSessionStore implements SessionStore {
  readonly kind = STORAGE_KIND;

  async load(): Promise<Session | null> {
    return parseStoredSession(storage()?.getItem(SESSION_STORAGE_KEY) ?? null);
  }

  async save(session: Session): Promise<void> {
    storage()?.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  }

  async clear(): Promise<void> {
    storage()?.removeItem(SESSION_STORAGE_KEY);
  }
}
