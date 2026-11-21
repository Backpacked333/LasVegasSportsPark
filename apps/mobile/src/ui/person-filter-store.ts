/**
 * Where the household "who" filter (`src/ui/PersonFilter.tsx`) is remembered on the device: one
 * key in the key-value store the app already ships (expo-secure-store). It is a display preference,
 * per device (handoff INTERACTIONS Shell row 5: "The choice is remembered per device"); it holds a
 * person id or nothing, never a name. A store that cannot be read or written leaves "Everyone".
 */
import * as SecureStore from 'expo-secure-store';

export const PERSON_FILTER_STORAGE_KEY = 'sportspark.person-filter';

export interface PersonFilterStore {
  /** The remembered person id, or null for "Everyone" (or when it cannot be read). */
  read(): string | null;
  write(personId: string | null): void;
}

const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

export class SecurePersonFilterStore implements PersonFilterStore {
  read(): string | null {
    try {
      return SecureStore.getItem(PERSON_FILTER_STORAGE_KEY, OPTIONS) || null;
    } catch {
      return null;
    }
  }

  write(personId: string | null): void {
    try {
      SecureStore.setItem(PERSON_FILTER_STORAGE_KEY, personId ?? '', OPTIONS);
    } catch {
      // The choice applies until the app closes.
    }
  }
}

/** Tests and providers without a device store. */
export class MemoryPersonFilterStore implements PersonFilterStore {
  constructor(private value: string | null = null) {}

  read(): string | null {
    return this.value;
  }

  write(personId: string | null): void {
    this.value = personId;
  }
}
