/**
 * Browser preview storage: the web build's stand-in for `secure-theme-store.ts` (Metro picks this
 * file on the web only; the app's iOS and Android bundles never contain it, and
 * scripts/check-release-bundle.mjs fails if they do). The web build is a development preview for
 * screenshots, not a product surface (§2.2: the customer app is native iOS and Android).
 *
 * The Legends mode choice lives in the browser's localStorage under the same key, so the screenshot
 * harness can seed a theme before the page loads. Unavailable storage leaves the classic theme.
 */
import type { ThemeName } from './theme';
import { parseThemeName, type ThemePreferenceStore } from './theme-preference';

/** Marks this stand-in in a bundle for scripts/check-release-bundle.mjs (code, not a comment). */
export const STORAGE_KIND = 'Browser preview storage';

export const THEME_STORAGE_KEY = 'sportspark.theme';

export class SecureThemeStore implements ThemePreferenceStore {
  readonly kind = STORAGE_KIND;

  read(): ThemeName | null {
    try {
      return parseThemeName(globalThis.localStorage?.getItem(THEME_STORAGE_KEY) ?? null);
    } catch {
      return null;
    }
  }

  write(name: ThemeName): void {
    try {
      globalThis.localStorage?.setItem(THEME_STORAGE_KEY, name);
    } catch {
      // The choice applies until the page closes.
    }
  }
}
