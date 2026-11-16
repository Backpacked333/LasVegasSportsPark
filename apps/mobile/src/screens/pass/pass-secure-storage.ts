/**
 * The platform secure store behind `SecurePassStore` (pass-store.ts): expo-secure-store, readable
 * only while the device is unlocked and never restored to another device (§4.13, SPK-ENTRY-002).
 * The web preview build uses `pass-secure-storage.web.ts` instead.
 */
import * as SecureStore from 'expo-secure-store';

export interface PassSecureStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export const passSecureStorage: PassSecureStorage = {
  getItem: (key) => SecureStore.getItemAsync(key, OPTIONS),
  setItem: (key, value) => SecureStore.setItemAsync(key, value, OPTIONS),
  removeItem: (key) => SecureStore.deleteItemAsync(key, OPTIONS),
};
