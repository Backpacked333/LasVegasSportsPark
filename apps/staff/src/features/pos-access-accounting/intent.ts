/**
 * One user intent per money or device command form (§4.9). `useApiCommand` keeps the idempotency
 * key while the outcome is not known (no answer, a retryable code, PAYMENT_OUTCOME_UNKNOWN); this
 * keeps the request that was sent, so "Try again" resends exactly it with the same key, and marks
 * the form `locked` meanwhile: a changed amount would be a new intent with a new key, which could
 * apply a tender, a return or a close twice (SPK-PAY-007). Reloading the record and starting again
 * is a new decision made from the current state (`restart`).
 */
import type { ApiError } from '@sportspark/api-client';
import { useCallback, useRef } from 'react';

interface CommandLike<Req, Res> {
  submit: (request: Req) => Promise<Res>;
  error: ApiError | null;
  reset: () => void;
}

export function useIntentForm<Req, Res>(command: CommandLike<Req, Res>) {
  const last = useRef<Req | null>(null);
  const { submit, reset } = command;
  const send = useCallback(
    async (request: Req): Promise<Res | null> => {
      last.current = request;
      try {
        return await submit(request);
      } catch {
        return null; // shown from command.error; the input is kept (SPK-UX-008)
      }
    },
    [submit],
  );
  const retry = useCallback(() => {
    if (last.current !== null) void send(last.current);
  }, [send]);
  const restart = useCallback(() => {
    last.current = null;
    reset();
  }, [reset]);
  return {
    send,
    retry,
    restart,
    /** The outcome of the last attempt is not known: only the same request may be resent. */
    locked: command.error !== null && command.error.keepsIntent,
  };
}
