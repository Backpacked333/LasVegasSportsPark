/**
 * Money commands and unknown outcomes (§4.9, SPK-PAY-007, SPK-PAY-008). A command that got no
 * answer, a retryable answer or PAYMENT_OUTCOME_UNKNOWN may still take effect, so:
 *
 * - "Try again" resends exactly the request that was sent (same body, so the same
 *   Idempotency-Key), never one rebuilt from fields edited since;
 * - while that outcome is unknown the form is locked; "Start a new request" clears it and re-reads
 *   the record, and only then can a different request be made.
 */
import type { ApiError } from '@sportspark/api-client';
import { useRef } from 'react';
import { Button } from '../../ui/Button';
import { StatusBadge } from '../../ui/StatusBadge';

export function useSameRequest<R>(submit: (request: R) => Promise<unknown>) {
  const last = useRef<R | null>(null);
  return {
    send(request: R): Promise<unknown> {
      last.current = request;
      return submit(request);
    },
    retry(): void {
      if (last.current !== null) void submit(last.current).catch(() => undefined);
    },
    forget(): void {
      last.current = null;
    },
  };
}

/** The outcome of the last attempt may still be applied: the form stays locked. */
export function outcomePending(error: ApiError | null | undefined): boolean {
  return !!error && error.keepsIntent;
}

export function LockedNote({
  error,
  onNewRequest,
}: {
  error: ApiError | null | undefined;
  onNewRequest: () => void;
}) {
  if (!outcomePending(error)) return null;
  return (
    <div className="rf-locked" role="status" data-testid="request-locked">
      <StatusBadge tone="warning" label="Locked until the outcome is known" />
      <p className="caption">
        The fields are locked so a retry sends exactly the same request. To make a different request
        instead, first check the record, then start a new request.
      </p>
      <Button variant="secondary" onClick={onNewRequest}>
        Start a new request
      </Button>
    </div>
  );
}
