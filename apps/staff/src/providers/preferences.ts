/**
 * Display preferences of this browser (the theme, the collapsed sidebar, recently opened
 * screens): small strings kept in `localStorage`. They are conveniences, never records: nothing
 * here is sent to the API, holds personal data, or decides what the viewer may do, and losing
 * them (a private window, a blocked store) only resets the dashboard to its defaults.
 */
export interface PreferenceStore {
  get(key: string): string | null;
  /** `null` removes the key. */
  set(key: string, value: string | null): void;
}

/** `localStorage`, tolerant of a browser that blocks it. */
export function browserPreferences(): PreferenceStore {
  return {
    get(key) {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        if (value === null) window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, value);
      } catch {
        // Not stored: the preference lasts for this page only.
      }
    },
  };
}

/** In memory: tests, and the fallback when no store is provided. */
export function memoryPreferences(initial: Record<string, string> = {}): PreferenceStore {
  const values = new Map(Object.entries(initial));
  return {
    get: (key) => values.get(key) ?? null,
    set(key, value) {
      if (value === null) values.delete(key);
      else values.set(key, value);
    },
  };
}
