/**
 * The shared-desk PIN (redesign handoff S 3h; Proposed, see the staff README "Locked shared
 * tablet"). A staff member chooses a 4-digit PIN for this device when they turn on "Lock this
 * tablet when idle"; only a salted PBKDF2-SHA-256 hash of it is kept, in this browser's storage,
 * per account. It never leaves the device and is not an API credential: the lock is a screen
 * guard over a session that stays signed in (so check-ins keep working while locked), and every
 * request still goes through the API's authentication and authorization unchanged.
 *
 * Attempts are counted in storage too, so reloading the page neither unlocks it nor resets the
 * count: five wrong tries block the keypad for a minute; the third block in a row signs the
 * session out (the token is removed and the API session must be started again).
 */
import type { PreferenceStore } from '../../providers/preferences';

export const PIN_LENGTH = 4;
export const MAX_TRIES = 5;
export const BLOCK_MS = 60_000;
/** Blocks in a row before the lock signs the session out. */
export const MAX_BLOCKS = 3;
export const IDLE_LOCK_MS = 10 * 60_000;
const ITERATIONS = 150_000;

export const SHARED_DEVICE_KEY = 'sportspark.lock.shared-device';
export const DEVICE_NAME_KEY = 'sportspark.lock.device-name';
const pinKey = (accountId: string) => `sportspark.lock.pin.${accountId}`;
const stateKey = (accountId: string) => `sportspark.lock.state.${accountId}`;

export interface StoredPin {
  salt: string;
  hash: string;
  iterations: number;
}

export interface LockState {
  locked: boolean;
  /** When it locked (ISO), for "Locked at 9:14". */
  lockedAt: string | null;
  /** Wrong tries since the last block or unlock. */
  failures: number;
  /** The keypad is blocked until this instant (ISO). */
  blockedUntil: string | null;
  /** Blocks in a row since the last unlock. */
  blocks: number;
}

export const UNLOCKED: LockState = {
  locked: false,
  lockedAt: null,
  failures: 0,
  blockedUntil: null,
  blocks: 0,
};

export function isPin(value: string): boolean {
  return new RegExp(`^\\d{${PIN_LENGTH}}$`).test(value);
}

function toHex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function derive(pin: string, salt: Uint8Array, iterations: number): Promise<string> {
  const subtle = globalThis.crypto.subtle;
  const key = await subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    key,
    256,
  );
  return toHex(bits);
}

/** Constant-time comparison of two hex strings of the same length. */
function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function hashPin(pin: string): Promise<StoredPin> {
  if (!isPin(pin)) throw new Error('A PIN is four digits.');
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return { salt: toHex(salt), hash: await derive(pin, salt, ITERATIONS), iterations: ITERATIONS };
}

export async function verifyPin(pin: string, stored: StoredPin): Promise<boolean> {
  if (!isPin(pin)) return false;
  return sameHex(await derive(pin, fromHex(stored.salt), stored.iterations), stored.hash);
}

export function readPin(store: PreferenceStore, accountId: string): StoredPin | null {
  const raw = store.get(pinKey(accountId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredPin>;
    if (
      typeof parsed.salt === 'string' &&
      typeof parsed.hash === 'string' &&
      typeof parsed.iterations === 'number'
    ) {
      return { salt: parsed.salt, hash: parsed.hash, iterations: parsed.iterations };
    }
  } catch {
    // A damaged entry is no PIN.
  }
  return null;
}

export function writePin(store: PreferenceStore, accountId: string, pin: StoredPin | null): void {
  store.set(pinKey(accountId), pin ? JSON.stringify(pin) : null);
}

export function readLockState(store: PreferenceStore, accountId: string): LockState {
  const raw = store.get(stateKey(accountId));
  if (!raw) return UNLOCKED;
  try {
    return { ...UNLOCKED, ...(JSON.parse(raw) as Partial<LockState>) };
  } catch {
    // A damaged entry is read as locked: never unlock by corrupting storage.
    return { ...UNLOCKED, locked: true };
  }
}

export function writeLockState(store: PreferenceStore, accountId: string, state: LockState): void {
  store.set(stateKey(accountId), state.locked || state.blocks > 0 ? JSON.stringify(state) : null);
}

/** The state after a wrong PIN at `now`: counted, blocked at the fifth, signed out at the third block. */
export function afterWrongPin(state: LockState, now: Date): { state: LockState; signOut: boolean } {
  const failures = state.failures + 1;
  if (failures < MAX_TRIES) return { state: { ...state, failures }, signOut: false };
  const blocks = state.blocks + 1;
  return {
    state: {
      ...state,
      failures: 0,
      blocks,
      blockedUntil: new Date(now.getTime() + BLOCK_MS).toISOString(),
    },
    signOut: blocks >= MAX_BLOCKS,
  };
}
