/**
 * Where the Legends mode choice is kept between launches. The read is synchronous so the first
 * frame is already drawn in the chosen theme (no flash of the other one); the write may fail
 * without consequence for the running app (the choice still applies until the app closes).
 * Tests use `MemoryThemeStore`; the device uses `SecureThemeStore`.
 */
import type { ThemeName } from './theme';

export interface ThemePreferenceStore {
  /** The stored choice, or `null` when none was made (or it cannot be read). */
  read(): ThemeName | null;
  write(name: ThemeName): void;
}

export function parseThemeName(value: string | null | undefined): ThemeName | null {
  return value === 'classic' || value === 'legends' ? value : null;
}

export class MemoryThemeStore implements ThemePreferenceStore {
  constructor(private value: ThemeName | null = null) {}

  read(): ThemeName | null {
    return this.value;
  }

  write(name: ThemeName): void {
    this.value = name;
  }
}
