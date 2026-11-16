/**
 * Where the registration progress (`progress.tsx`) is kept on a device: the platform secure store
 * (expo-secure-store), readable only while the device is unlocked and never restored to another
 * device (§4.13). The web preview build uses `progress-storage.web.ts` instead.
 */
import * as SecureStore from 'expo-secure-store';
import type { ProgressBackend } from './progress';

export const PROGRESS_STORAGE_KEY = 'sportspark.registration-progress';

const SECURE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export const secureProgressBackend: ProgressBackend = {
  read: () => SecureStore.getItemAsync(PROGRESS_STORAGE_KEY, SECURE_OPTIONS),
  write: (value) => SecureStore.setItemAsync(PROGRESS_STORAGE_KEY, value, SECURE_OPTIONS),
};
