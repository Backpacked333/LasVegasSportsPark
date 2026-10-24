/**
 * Several independent commands on one screen (one per person, per check-in, per fee submission),
 * each its own user intent (§4.9): a retry of the same input reuses that intent's idempotency key
 * (a double click or a retry after a timeout never records twice); changed input, or a confirmed
 * success, starts a new intent. Every outcome is kept per key so partial completion is shown per
 * record (SPK-UX-008).
 */
import {
  ApiError,
  type CommandIntentTracker,
  type CommandMethod,
  type PathsWithMethod,
  type ResponseBody,
} from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useRef, useState } from 'react';
import type { CommandRequest } from '../../api/useApiCommand';
import { useApi } from '../../providers/AppProviders';

export type KeyedStatus = 'idle' | 'pending' | 'success' | 'error';

export interface KeyedOutcome {
  status: KeyedStatus;
  data?: unknown;
  error?: ApiError;
}

const IDLE: KeyedOutcome = { status: 'idle' };

export function useKeyedCommands(options: { invalidate?: readonly (readonly unknown[])[] } = {}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const trackers = useRef(new Map<string, CommandIntentTracker>());
  const [outcomes, setOutcomes] = useState<Record<string, KeyedOutcome>>({});
  const invalidate = options.invalidate;

  const run = useCallback(
    async <M extends CommandMethod, P extends PathsWithMethod<M>>(
      key: string,
      method: M,
      path: P,
      request: CommandRequest<M, P>,
    ): Promise<ResponseBody<P, M> | undefined> => {
      let tracker = trackers.current.get(key);
      if (!tracker) {
        tracker = api.intentTracker();
        trackers.current.set(key, tracker);
      }
      const intent = tracker.current(request);
      setOutcomes((prev) => ({ ...prev, [key]: { status: 'pending' } }));
      try {
        const send = api[method] as unknown as (
          path: P,
          options: object,
        ) => Promise<ResponseBody<P, M>>;
        const data = await send(path, { ...request, intent });
        tracker.complete();
        setOutcomes((prev) => ({ ...prev, [key]: { status: 'success', data } }));
        await Promise.all(
          (invalidate ?? []).map((queryKey) => queryClient.invalidateQueries({ queryKey })),
        );
        return data;
      } catch (cause) {
        const error =
          cause instanceof ApiError
            ? cause
            : new ApiError({
                kind: 'unexpected_response',
                status: null,
                code: 'UNEXPECTED_RESPONSE',
                message: 'The request could not be completed.',
                nextAction: 'contact_support',
                correlationId: null,
                cause,
              });
        // A definitive refusal ends this key's intent (the API replays stored 4xx answers).
        tracker.failed(error);
        setOutcomes((prev) => ({ ...prev, [key]: { status: 'error', error } }));
        return undefined;
      }
    },
    [api, queryClient, invalidate],
  );

  const reset = useCallback((key?: string) => {
    if (key === undefined) {
      trackers.current.clear();
      setOutcomes({});
      return;
    }
    trackers.current.get(key)?.reset();
    setOutcomes((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  return useMemo(
    () => ({
      run,
      reset,
      outcome: (key: string): KeyedOutcome => outcomes[key] ?? IDLE,
      anyPending: Object.values(outcomes).some((o) => o.status === 'pending'),
    }),
    [run, reset, outcomes],
  );
}
