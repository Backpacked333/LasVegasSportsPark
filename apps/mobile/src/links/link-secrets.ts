/**
 * Link secrets in memory only (§4.13, §4.14). An invitation or claim token arrives in a link and
 * is the recipient's proof; the link landing moves it here and navigates to the target screen with
 * opaque ids only, so the secret is not kept in navigation state or a route URL, never written to
 * storage and never logged. Restarting the app forgets it: the person opens the link again.
 */
export type LinkSecretKind = 'invitation' | 'team-invitation' | 'claim';

const secrets = new Map<string, string>();

function keyOf(kind: LinkSecretKind, id?: string): string {
  return id ? `${kind}:${id}` : kind;
}

export function holdLinkSecret(kind: LinkSecretKind, token: string, id?: string): void {
  secrets.set(keyOf(kind, id), token);
}

export function readLinkSecret(kind: LinkSecretKind, id?: string): string | null {
  return secrets.get(keyOf(kind, id)) ?? null;
}

/** Called once the API confirmed the outcome; a used token is not kept. */
export function forgetLinkSecret(kind: LinkSecretKind, id?: string): void {
  secrets.delete(keyOf(kind, id));
}

/** Test isolation. */
export function clearLinkSecrets(): void {
  secrets.clear();
}
