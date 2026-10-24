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
import * as SecureStore from 'expo-secure-store';
import { createContext, useContext } from 'react';

export interface StoredPass {
  passId: string;
  reference: string;
  issuedAt: string;
  revision: number;
}

export interface PassStore {
  load(accountKey: string): Promise<StoredPass | null>;
  save(accountKey: string, pass: StoredPass): Promise<void>;
  clear(accountKey: string): Promise<void>;
}

export const PASS_STORAGE_PREFIX = 'sportspark.pass.';

const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

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
    return { passId: v.passId, reference: v.reference, issuedAt: v.issuedAt, revision: v.revision };
  } catch {
    return null;
  }
}

export class SecurePassStore implements PassStore {
  async load(accountKey: string): Promise<StoredPass | null> {
    return parseStoredPass(await SecureStore.getItemAsync(passStorageKey(accountKey), OPTIONS));
  }

  async save(accountKey: string, pass: StoredPass): Promise<void> {
    await SecureStore.setItemAsync(passStorageKey(accountKey), JSON.stringify(pass), OPTIONS);
  }

  async clear(accountKey: string): Promise<void> {
    await SecureStore.deleteItemAsync(passStorageKey(accountKey), OPTIONS);
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
