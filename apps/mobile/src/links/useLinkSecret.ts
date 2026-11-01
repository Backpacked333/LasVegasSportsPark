/**
 * A held link secret as a screen reads it (§4.13, §4.14; R3-SECURITY-07). The screen keeps what
 * it read, so a token forgotten after a confirmed answer still backs the outcome on screen, and
 * reads again whenever the session changes hands: a route left mounted across a sign-out never
 * offers the previous account's claim or invitation code to the next one.
 */
import { useState, useSyncExternalStore } from 'react';
import {
  linkSecretOwner,
  readLinkSecret,
  subscribeLinkSecretOwner,
  type LinkSecretKind,
} from './link-secrets';

export function useLinkSecret(kind: LinkSecretKind, id?: string): string | null {
  const owner = useSyncExternalStore(subscribeLinkSecretOwner, linkSecretOwner, linkSecretOwner);
  const key = JSON.stringify([owner, kind, id ?? null]);
  const [read, setRead] = useState(() => ({ key, token: readLinkSecret(kind, id) }));
  if (read.key !== key) {
    const next = { key, token: readLinkSecret(kind, id) };
    setRead(next);
    return next.token;
  }
  return read.token;
}
