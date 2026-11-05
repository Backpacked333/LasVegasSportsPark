/**
 * Staff session storage behind the api-client `SessionStore` (§4.13, §4.14 protected secret
 * storage). The token lives in `sessionStorage`: it ends with the browser tab, is never written to
 * long-lived storage and never put in a URL. How a production staff session is held (for example a
 * server-set cookie) depends on the managed identity provider, DEC-018 (pending).
 */
import { parseStoredSession, type Session, type SessionStore } from '@sportspark/api-client';

export const SESSION_STORAGE_KEY = 'sportspark.staff.session';

export class BrowserSessionStore implements SessionStore {
  constructor(private readonly storage: Storage = window.sessionStorage) {}

  async load(): Promise<Session | null> {
    return parseStoredSession(this.storage.getItem(SESSION_STORAGE_KEY));
  }

  async save(session: Session): Promise<void> {
    this.storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  }

  async clear(): Promise<void> {
    this.storage.removeItem(SESSION_STORAGE_KEY);
  }
}
