/**
 * Browser preview storage: the web build's stand-in for `person-filter-store.ts` (Metro picks this
 * file on the web only; the app's iOS and Android bundles never contain it, and
 * scripts/check-release-bundle.mjs fails if they do). The "who" filter lives in the browser's
 * localStorage under the same key. Unavailable storage leaves "Everyone".
 */

/** Marks this stand-in in a bundle for scripts/check-release-bundle.mjs (code, not a comment). */
export const STORAGE_KIND = 'Browser preview storage';

export const PERSON_FILTER_STORAGE_KEY = 'sportspark.person-filter';

export interface PersonFilterStore {
  read(): string | null;
  write(personId: string | null): void;
}

export class SecurePersonFilterStore implements PersonFilterStore {
  readonly kind = STORAGE_KIND;

  read(): string | null {
    try {
      return globalThis.localStorage?.getItem(PERSON_FILTER_STORAGE_KEY) || null;
    } catch {
      return null;
    }
  }

  write(personId: string | null): void {
    try {
      globalThis.localStorage?.setItem(PERSON_FILTER_STORAGE_KEY, personId ?? '');
    } catch {
      // The choice applies until the page closes.
    }
  }
}

export class MemoryPersonFilterStore implements PersonFilterStore {
  constructor(private value: string | null = null) {}

  read(): string | null {
    return this.value;
  }

  write(personId: string | null): void {
    this.value = personId;
  }
}
