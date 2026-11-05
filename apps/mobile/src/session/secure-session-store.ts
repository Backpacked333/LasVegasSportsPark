/**
 * Session storage on the device's platform-backed secure store (Keychain on iOS, Keystore-backed
 * storage on Android) through expo-secure-store, behind the api-client `SessionStore` interface
 * (spec §4.13, SPK-UX-001 "Secure session storage"). Tests use `MemorySessionStore`.
 *
 * Lifecycle and recovery behaviour (reinstall, restore from backup, OS upgrade) must be tested on
 * physical devices (§4.13, §6.2); nothing here claims it.
 */
import { parseStoredSession, type Session, type SessionStore } from '@sportspark/api-client';
import * as SecureStore from 'expo-secure-store';

export const SESSION_STORAGE_KEY = 'sportspark.session';

const OPTIONS: SecureStore.SecureStoreOptions = {
  // Readable only while the device is unlocked, never migrated to another device by a backup.
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export class SecureSessionStore implements SessionStore {
  /** Keeps the last value read so each request does not wait on the keychain. */
  private cache: { value: Session | null } | null = null;

  async load(): Promise<Session | null> {
    if (this.cache) return this.cache.value;
    const value = parseStoredSession(await SecureStore.getItemAsync(SESSION_STORAGE_KEY, OPTIONS));
    this.cache = { value };
    return value;
  }

  async save(session: Session): Promise<void> {
    await SecureStore.setItemAsync(SESSION_STORAGE_KEY, JSON.stringify(session), OPTIONS);
    this.cache = { value: session };
  }

  async clear(): Promise<void> {
    this.cache = { value: null };
    await SecureStore.deleteItemAsync(SESSION_STORAGE_KEY, OPTIONS);
  }
}
