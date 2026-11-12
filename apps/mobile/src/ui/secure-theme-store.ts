/**
 * The Legends mode choice on the device, in the key-value store the app already ships
 * (expo-secure-store; no other storage module is installed). It is a display preference, not a
 * secret: it is kept per device, is not tied to the signed-in account and survives sign-out.
 * A store that cannot be read or written (device locked at first read, storage unavailable) leaves
 * the classic theme and never stops the app.
 *
 * Not verified on physical devices here (reinstall, restore from backup, OS upgrade: §6.2).
 */
import * as SecureStore from 'expo-secure-store';
import type { ThemeName } from './theme';
import { parseThemeName, type ThemePreferenceStore } from './theme-preference';

export const THEME_STORAGE_KEY = 'sportspark.theme';

const OPTIONS: SecureStore.SecureStoreOptions = {
  // Readable when the app starts in the background after the first unlock; never synced.
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

export class SecureThemeStore implements ThemePreferenceStore {
  read(): ThemeName | null {
    try {
      return parseThemeName(SecureStore.getItem(THEME_STORAGE_KEY, OPTIONS));
    } catch {
      return null;
    }
  }

  write(name: ThemeName): void {
    try {
      SecureStore.setItem(THEME_STORAGE_KEY, name, OPTIONS);
    } catch {
      // The choice applies until the app closes; nothing else depends on it.
    }
  }
}
