/**
 * Idempotency keys per user intent (spec §4.9: "A replay with the same key and payload returns
 * the same operation. The same key with different contents returns a conflict.").
 *
 * One intent is one thing the user decided to do (accept this assignment, pay this basket). Every
 * attempt of that intent, including a retry after a timeout or a lost connection, sends the same
 * key, so a double tap or a retry never duplicates an effect. A new decision, or the same action
 * with different input, is a new intent with a new key; reusing a key with a changed payload is
 * answered with IDEMPOTENCY_CONFLICT.
 */

/** The API accepts keys of 8 to 128 characters (`IdempotencyKey` in packages/contracts). */
export const IDEMPOTENCY_KEY_MIN_LENGTH = 8;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

export type KeyGenerator = () => string;

export interface CommandIntent {
  /** Sent as the `Idempotency-Key` header on every attempt of this intent. */
  readonly key: string;
}

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/**
 * Default key generator: `crypto.randomUUID()` where the runtime has it (browsers, Node), else
 * random bytes from `crypto.getRandomValues`. React Native has neither by default, so the mobile
 * app injects `expo-crypto`'s `randomUUID`. There is deliberately no `Math.random` fallback.
 */
export const defaultKeyGenerator: KeyGenerator = () => {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  if (c && typeof c.getRandomValues === 'function') {
    return hex(c.getRandomValues(new Uint8Array(16)));
  }
  throw new Error(
    'No secure random source for idempotency keys: pass generateKey to createApiClient.',
  );
};

export function assertValidKey(key: string): string {
  if (key.length < IDEMPOTENCY_KEY_MIN_LENGTH || key.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw new Error(
      `Idempotency key must be ${IDEMPOTENCY_KEY_MIN_LENGTH} to ${IDEMPOTENCY_KEY_MAX_LENGTH} characters.`,
    );
  }
  return key;
}

export function createCommandIntent(
  generateKey: KeyGenerator = defaultKeyGenerator,
): CommandIntent {
  return Object.freeze({ key: assertValidKey(generateKey()) });
}

/**
 * Tracks the intent behind one form or button. `current(input)` returns the same intent while the
 * input is unchanged and the previous attempt did not complete, so a retry reuses the key; a
 * changed input, or `complete()` after success, starts a new intent.
 *
 * The fingerprint is a stable JSON rendering of the input; it is kept in memory only and never
 * logged (it may contain personal data).
 */
export class CommandIntentTracker {
  private intent: CommandIntent | null = null;
  private fingerprint: string | null = null;

  constructor(private readonly generateKey: KeyGenerator = defaultKeyGenerator) {}

  current(input?: unknown): CommandIntent {
    const fingerprint = stableStringify(input ?? null);
    if (!this.intent || this.fingerprint !== fingerprint) {
      this.intent = createCommandIntent(this.generateKey);
      this.fingerprint = fingerprint;
    }
    return this.intent;
  }

  /** Call after the API confirmed the outcome; the next attempt is a new intent. */
  complete(): void {
    this.intent = null;
    this.fingerprint = null;
  }

  /** Abandon the intent (the user cancelled or changed their mind). */
  reset(): void {
    this.complete();
  }

  /**
   * Call after an attempt failed. The intent, and so the key, is kept while the outcome is unknown
   * or the API asked for a retry with the same key; after a definitive answer (one the API stores
   * and would replay for this key, such as MISSING_ACKNOWLEDGMENT or STALE_REVISION) the intent
   * ends, so the next attempt, once the user has fixed the cause, is a new intent (§4.9).
   */
  failed(error: unknown): void {
    if (!keepsIntentAfter(error)) this.complete();
  }
}

/**
 * Whether a failed attempt's intent must survive for the retry. Anything that is not the typed
 * client error (a programming error) keeps it: the request may still have been sent.
 */
export function keepsIntentAfter(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('keepsIntent' in error)) return true;
  return (error as { keepsIntent: unknown }).keepsIntent !== false;
}

/** JSON with object keys sorted, so `{a,b}` and `{b,a}` are the same input. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
}
