/**
 * Money commands and unknown outcomes (§4.9, SPK-PAY-007, SPK-PAY-008). A command that got no
 * definite answer, a retryable answer, PAYMENT_OUTCOME_UNKNOWN or IDEMPOTENCY_OUTCOME_UNAVAILABLE
 * may already have taken effect (or did), so:
 *
 * - "Try again" resends exactly the request that was sent (same body, so the same
 *   Idempotency-Key), never one rebuilt from fields edited since;
 * - while that outcome is unknown the form is locked (`outcomePending`, which follows
 *   `keepsIntentAfterFailure`: the hook keeps the key exactly as long);
 * - "Start a new request" first reads the record again (the payment and its refunds, the
 *   obligation, the credits) and unlocks only once that read succeeded, so the next request is
 *   decided from the current state, never beside a refund or tender that already happened.
 */
import { keepsIntentAfterFailure, type ApiError } from '@sportspark/api-client';
import { useRef, useState } from 'react';
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

/** The outcome of the last attempt may still be applied (or was): the form stays locked. */
export function outcomePending(error: ApiError | null | undefined): boolean {
  return !!error && keepsIntentAfterFailure(error);
}

export function LockedNote({
  error,
  reread,
  onNewRequest,
}: {
  error: ApiError | null | undefined;
  /** Reads the record again; rejects when the read fails (the form then stays locked). */
  reread: () => Promise<unknown>;
  /** Unlocks the form for a new request (after `reread` succeeded). */
  onNewRequest: () => void;
}) {
  const [checking, setChecking] = useState(false);
  const [readFailed, setReadFailed] = useState(false);
  if (!outcomePending(error)) return null;
  const start = () => {
    setChecking(true);
    setReadFailed(false);
    reread().then(
      () => {
        setChecking(false);
        onNewRequest();
      },
      () => {
        setChecking(false);
        setReadFailed(true);
      },
    );
  };
  return (
    <div className="rf-locked" role="status" data-testid="request-locked">
      <StatusBadge tone="warning" label="Locked until the outcome is known" />
      <p className="caption">
        The fields are locked so a retry sends exactly the same request. To make a different request
        instead, start a new request: the record is read again first, so you decide from its current
        state.
      </p>
      {readFailed ? (
        <p className="caption" role="alert">
          The record could not be read again, so the fields stay locked. Try again when the
          connection is back.
        </p>
      ) : null}
      <Button variant="secondary" busy={checking} onClick={start}>
        Start a new request
      </Button>
    </div>
  );
}
