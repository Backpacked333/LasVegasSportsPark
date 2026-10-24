/**
 * Team entries opened in this app session (SCR-C-21 fallback). The API has no list of the teams a
 * person belongs to (reported), so the Teams destination lists the entries the person opened from
 * an invitation, a link or a notification, or created, since the app started. Only opaque entry
 * ids are kept, in memory, per account (§4.14); every row is re-read from the API, which decides
 * whether it is still visible (§4.10).
 */
import { useCallback, useSyncExternalStore } from 'react';
import { useApp } from '../../providers/AppProviders';

const byAccount = new Map<string, readonly string[]>();
const listeners = new Set<() => void>();
const EMPTY: readonly string[] = [];

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** The entries opened for one account, most recent first. */
export function openedTeamEntries(accountId: string): readonly string[] {
  return byAccount.get(accountId) ?? EMPTY;
}

export function rememberTeamEntry(accountId: string, entryId: string): void {
  const current = byAccount.get(accountId) ?? EMPTY;
  if (current[0] === entryId) return;
  byAccount.set(accountId, [entryId, ...current.filter((id) => id !== entryId)]);
  emit();
}

export function forgetTeamEntry(accountId: string, entryId: string): void {
  const current = byAccount.get(accountId) ?? EMPTY;
  if (!current.includes(entryId)) return;
  byAccount.set(
    accountId,
    current.filter((id) => id !== entryId),
  );
  emit();
}

/** Test helper: forget every account's list. */
export function resetOpenedTeamEntries(): void {
  byAccount.clear();
  emit();
}

/** The signed-in account's opened entries, most recent first, with remember and forget. */
export function useOpenedTeamEntries() {
  const accountId = useApp().session.session?.accountId ?? null;
  const ids = useSyncExternalStore(subscribe, () =>
    accountId ? openedTeamEntries(accountId) : EMPTY,
  );
  const remember = useCallback(
    (entryId: string) => {
      if (accountId) rememberTeamEntry(accountId, entryId);
    },
    [accountId],
  );
  const forget = useCallback(
    (entryId: string) => {
      if (accountId) forgetTeamEntry(accountId, entryId);
    },
    [accountId],
  );
  return { ids, remember, forget };
}
