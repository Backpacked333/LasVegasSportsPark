/**
 * Small shared pieces of the competition screens: the success line that names the resulting
 * record state in the machine's words (SPK-UX-008 success), a reload helper for the stale-version
 * state, and a pending-decision note (SPK-UX-008 pending decision, §6.6).
 */
import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import type { PendingDecision } from './pending';

export function SuccessNote({ children }: { children: string }) {
  return (
    <p role="status" data-testid="command-success">
      <StatusBadge tone="success" label={children} />
    </p>
  );
}

export function PendingNote({ decision }: { decision: PendingDecision }) {
  return (
    <StateView
      variant="pending-decision"
      subject={decision.subject}
      decisions={decision.decisions}
      owner={decision.owner}
    />
  );
}

/** Refetches every query under the given path templates (e.g. `'/seasons/{id}'`). */
export function useRefetch(paths: readonly string[]) {
  const queryClient = useQueryClient();
  const key = paths.join('|');
  return useCallback(() => {
    for (const path of key.split('|')) {
      void queryClient.invalidateQueries({ queryKey: ['api', path] });
    }
  }, [queryClient, key]);
}

/** Query-key prefixes for `useApiCommand({ invalidate })`. */
export function keys(...paths: string[]): (readonly unknown[])[] {
  return paths.map((path) => ['api', path]);
}
