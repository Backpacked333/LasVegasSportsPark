/**
 * Link secrets in memory only (§4.13, §4.14). An invitation or claim token arrives in a link and
 * is the recipient's proof; the link landing moves it here and navigates to the target screen with
 * opaque ids only, so the secret is not kept in navigation state or a route URL, never written to
 * storage and never logged. Restarting the app forgets it: the person opens the link again.
 *
 * A held secret belongs to whoever was signed in when its link arrived (§4.13 session expiry and
 * recovery; R3-SECURITY-07). `AppProviders` reports every session change through
 * `linkSecretsFollowSession` before any screen sees the new session:
 *
 * - ending the session (sign out, or the API rejecting it) drops every secret held for the account,
 *   as the query cache is dropped;
 * - signing in as another account drops the previous account's secrets;
 * - a link opened while nobody is signed in (or before the stored session has loaded) is kept for
 *   the account that signs in next, which is how "open the link, then sign in" works.
 *
 * So the next person to sign in on a shared device is never offered the previous person's claim or
 * invitation code. Reads return only the secrets of the account signed in now (or, while nobody
 * is, the ones opened since), and `useLinkSecret` reads again when that changes.
 */
export type LinkSecretKind = 'invitation' | 'team-invitation' | 'claim';

/** Whom the held secrets belong to: an account, or `null` while nobody is signed in. */
export type LinkSecretOwner = string | null;

interface HeldSecret {
  token: string;
  owner: LinkSecretOwner;
}

const secrets = new Map<string, HeldSecret>();
const listeners = new Set<() => void>();
let currentOwner: LinkSecretOwner = null;
let unnamedSessions = 0;

function keyOf(kind: LinkSecretKind, id?: string): string {
  return id ? `${kind}:${id}` : kind;
}

function setOwner(next: LinkSecretOwner): void {
  if (next === currentOwner) return;
  currentOwner = next;
  for (const listener of listeners) listener();
}

export function holdLinkSecret(kind: LinkSecretKind, token: string, id?: string): void {
  secrets.set(keyOf(kind, id), { token, owner: currentOwner });
}

export function readLinkSecret(kind: LinkSecretKind, id?: string): string | null {
  const held = secrets.get(keyOf(kind, id));
  return held && held.owner === currentOwner ? held.token : null;
}

/** Called once the API confirmed the outcome; a used token is not kept. */
export function forgetLinkSecret(kind: LinkSecretKind, id?: string): void {
  secrets.delete(keyOf(kind, id));
}

/**
 * The session changed: `null` when nobody is signed in now, otherwise the signed-in session.
 * Secrets of any other account are dropped; secrets opened while nobody was signed in pass to the
 * account signing in.
 */
export function linkSecretsFollowSession(session: { accountId: string | null } | null): void {
  // A session that does not name its account cannot be told apart from another one: it gets an
  // owner of its own, so nothing held before it carries over (fail closed).
  const next: LinkSecretOwner =
    session === null ? null : (session.accountId ?? `unnamed-session-${++unnamedSessions}`);
  for (const [key, held] of secrets) {
    if (held.owner === null) {
      if (next !== null) held.owner = next;
    } else if (held.owner !== next) {
      secrets.delete(key);
    }
  }
  setOwner(next);
}

/** The owner reads are answered for now (for `useLinkSecret`). */
export function linkSecretOwner(): LinkSecretOwner {
  return currentOwner;
}

/** Notifies `listener` whenever the owner changes; returns the unsubscribe. */
export function subscribeLinkSecretOwner(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test isolation: nothing held, nobody signed in. */
export function clearLinkSecrets(): void {
  secrets.clear();
  setOwner(null);
}
