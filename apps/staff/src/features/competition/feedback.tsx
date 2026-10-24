/**
 * Small shared pieces of the competition screens: the success line that names the resulting
 * record state in the machine's words (SPK-UX-008 success), a reload helper for the stale-version
 * state, and a pending-decision note (SPK-UX-008 pending decision, §6.6).
 */
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { Button } from '../../ui/Button';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { CommandButton } from './CommandButton';
import { TextAreaField } from './fields';
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

/**
 * The confirm step of an irreversible lifecycle move (archive, complete): names the consequence
 * and takes an optional reason for the audit record (SPK-UX-008, §4.9 command meta).
 */
export function ConfirmMove({
  label,
  consequence,
  reason,
  onReason,
  busy,
  onConfirm,
  onCancel,
}: {
  label: string;
  consequence: string;
  reason: string;
  onReason: (value: string) => void;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="form" role="group" aria-label={`Confirm: ${label}`}>
      <p>
        <StatusBadge tone="warning" label="Cannot be undone" /> {consequence}
      </p>
      <TextAreaField label="Reason (kept in the audit record)" value={reason} onChange={onReason} />
      <div className="actions">
        <CommandButton busy={busy} onClick={onConfirm}>
          {`Confirm: ${label}`}
        </CommandButton>
        <Button variant="secondary" onClick={onCancel}>
          Keep it as it is
        </Button>
      </div>
    </div>
  );
}

/** A stack of API cursors (§4.5): the last one is the page shown; empty is the first page. */
export function useCursorStack() {
  const [cursors, setCursors] = useState<string[]>([]);
  return {
    cursor: cursors[cursors.length - 1],
    depth: cursors.length,
    next: (cursor: string) => setCursors((list) => [...list, cursor]),
    previous: () => setCursors((list) => list.slice(0, -1)),
    reset: () => setCursors([]),
  };
}

/** Previous and next page buttons over an API cursor, named for what they page. */
export function PageButtons({
  what,
  depth,
  nextCursor,
  onNext,
  onPrevious,
}: {
  what: string;
  depth: number;
  nextCursor: string | null;
  onNext: (cursor: string) => void;
  onPrevious: () => void;
}) {
  if (depth === 0 && !nextCursor) return null;
  return (
    <div className="actions" role="group" aria-label={`Pages of ${what}`}>
      {depth > 0 ? (
        <Button variant="secondary" onClick={onPrevious}>
          Previous page
        </Button>
      ) : null}
      {nextCursor ? (
        <Button variant="secondary" onClick={() => onNext(nextCursor)}>
          Next page
        </Button>
      ) : null}
    </div>
  );
}
