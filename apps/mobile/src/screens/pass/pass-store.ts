/**
 * Where the facility pass reference lives on the device (SCR-C-05, SPK-ENTRY-002, §4.13).
 *
 * The API returns a pass's opaque reference exactly once, when it is issued (`POST /v1/passes`;
 * only its hash is stored server side), and offers the holder no way to read it again. So the app
 * keeps it in the platform secure store, readable only while the device is unlocked and never
 * restored to another device, under the signed-in account's id so another account on the same
 * device never sees it. Keeping it locally is also what lets the pass show offline (§4.15).
 *
 * The stored value holds the pass id, reference, issue time and revision only: no name, no
 * household, no child detail (SPK-ENTRY-002, §4.14). Device lifecycle (reinstall, restore) needs
 * physical devices to verify (§6.2); after a reinstall the person gets a new pass.
 */
import { createContext, useContext } from 'react';
import { passSecureStorage } from './pass-secure-storage';

export interface StoredPass {
  passId: string;
  reference: string;
  issuedAt: string;
  revision: number;
  /**
   * The replaced pass while its revoke is not confirmed (no answer, or a retryable code): kept so
   * "Try again" resends the same revoke, also after a restart (§4.9).
   */
  pendingRevoke?: { passId: string; revision: number } | null;
}

export interface PassStore {
  load(accountKey: string): Promise<StoredPass | null>;
  save(accountKey: string, pass: StoredPass): Promise<void>;
  clear(accountKey: string): Promise<void>;
}

export const PASS_STORAGE_PREFIX = 'sportspark.pass.';

/** Secure-store keys allow letters, digits, ".", "-" and "_" only. */
export function passStorageKey(accountKey: string): string {
  return `${PASS_STORAGE_PREFIX}${accountKey.replace(/[^A-Za-z0-9._-]/g, '_')}`;
}

export function parseStoredPass(raw: string | null): StoredPass | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<StoredPass>;
    if (
      typeof v.passId !== 'string' ||
      typeof v.reference !== 'string' ||
      v.reference.length === 0 ||
      typeof v.issuedAt !== 'string' ||
      typeof v.revision !== 'number'
    ) {
      return null;
    }
    const pending = v.pendingRevoke;
    const pendingRevoke =
      pending &&
      typeof pending === 'object' &&
      typeof pending.passId === 'string' &&
      typeof pending.revision === 'number'
        ? { passId: pending.passId, revision: pending.revision }
        : null;
    return {
      passId: v.passId,
      reference: v.reference,
      issuedAt: v.issuedAt,
      revision: v.revision,
      pendingRevoke,
    };
  } catch {
    return null;
  }
}

/** The pass in the platform secure store (`pass-secure-storage.ts`; a browser stand-in on the web). */
export class SecurePassStore implements PassStore {
  async load(accountKey: string): Promise<StoredPass | null> {
    return parseStoredPass(await passSecureStorage.getItem(passStorageKey(accountKey)));
  }

  async save(accountKey: string, pass: StoredPass): Promise<void> {
    await passSecureStorage.setItem(passStorageKey(accountKey), JSON.stringify(pass));
  }

  async clear(accountKey: string): Promise<void> {
    await passSecureStorage.removeItem(passStorageKey(accountKey));
  }
}

/** Test double. */
export class MemoryPassStore implements PassStore {
  readonly values = new Map<string, StoredPass>();

  async load(accountKey: string): Promise<StoredPass | null> {
    return this.values.get(accountKey) ?? null;
  }

  async save(accountKey: string, pass: StoredPass): Promise<void> {
    this.values.set(accountKey, pass);
  }

  async clear(accountKey: string): Promise<void> {
    this.values.delete(accountKey);
  }
}

let deviceStore: PassStore | null = null;

/** Tests provide a MemoryPassStore; the app uses the secure store. */
export const PassStoreContext = createContext<PassStore | null>(null);

export function usePassStore(): PassStore {
  const provided = useContext(PassStoreContext);
  if (provided) return provided;
  deviceStore ??= new SecurePassStore();
  return deviceStore;
}
