/**
 * Session storage port (spec §4.13: "Store session secrets using appropriate platform-backed
 * secure storage"). The client reads the bearer token from an injected store on every request; it
 * never keeps its own copy. The mobile app implements this with expo-secure-store, the staff
 * dashboard with session-scoped browser storage, and tests with `MemorySessionStore`.
 */

export interface Session {
  /** Bearer token. Never logged, never put in a URL. */
  token: string;
  /** ISO timestamp when the token stops being accepted, when the issuer states it. */
  expiresAt: string | null;
  /** The login account the token belongs to (an id, never a name). */
  accountId: string | null;
}

export interface SessionStore {
  load(): Promise<Session | null>;
  save(session: Session): Promise<void>;
  clear(): Promise<void>;
}

export class MemorySessionStore implements SessionStore {
  private session: Session | null;

  constructor(initial: Session | null = null) {
    this.session = initial;
  }

  async load(): Promise<Session | null> {
    return this.session;
  }

  async save(session: Session): Promise<void> {
    this.session = session;
  }

  async clear(): Promise<void> {
    this.session = null;
  }
}

/** Validates a stored value read back from storage; corrupt values count as no session. */
export function parseStoredSession(raw: string | null): Session | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Session>;
    if (typeof value.token !== 'string' || value.token.length === 0) return null;
    return {
      token: value.token,
      expiresAt: typeof value.expiresAt === 'string' ? value.expiresAt : null,
      accountId: typeof value.accountId === 'string' ? value.accountId : null,
    };
  } catch {
    return null;
  }
}
