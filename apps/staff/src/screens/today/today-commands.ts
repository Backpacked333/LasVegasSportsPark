/**
 * Today's in-place commands (§4.9): one intent per key (a candidate, a game to cancel), so a retry
 * of the same input reuses its idempotency key and a double tap never doubles an effect. Unlike
 * `useKeyedCommands`, a failure is thrown to the caller, which reverts its optimistic state and
 * says what did not save (redesign handoff "Writes are optimistic, with Undo").
 */
import {
  ApiError,
  type CommandIntentTracker,
  type CommandMethod,
  type PathsWithMethod,
  type ResponseBody,
} from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useRef } from 'react';
import type { CommandRequest } from '../../api/useApiCommand';
import { useApi } from '../../providers/AppProviders';

export const TODAY_INVALIDATE: readonly (readonly unknown[])[] = [
  ['api', '/today'],
  ['api', '/assignments'],
  ['api', '/events'],
  ['api', '/events/{id}/detail'],
  ['api', '/fixtures/{id}/readiness'],
  ['api', '/exceptions'],
];

export function asApiError(cause: unknown): ApiError {
  return cause instanceof ApiError
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
}

export function useTodayCommands() {
  const api = useApi();
  const queryClient = useQueryClient();
  const trackers = useRef(new Map<string, CommandIntentTracker>());

  const send = useCallback(
    async <M extends CommandMethod, P extends PathsWithMethod<M>>(
      key: string,
      method: M,
      path: P,
      request: CommandRequest<M, P>,
      options: { refresh?: boolean } = {},
    ): Promise<ResponseBody<P, M>> => {
      let tracker = trackers.current.get(key);
      if (!tracker) {
        tracker = api.intentTracker();
        trackers.current.set(key, tracker);
      }
      const intent = tracker.current(request);
      try {
        const call = api[method] as unknown as (
          path: P,
          options: object,
        ) => Promise<ResponseBody<P, M>>;
        const data = await call(path, { ...request, intent });
        tracker.complete();
        trackers.current.delete(key);
        if (options.refresh !== false) {
          void Promise.all(
            TODAY_INVALIDATE.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
          );
        }
        return data;
      } catch (cause) {
        tracker.failed(cause);
        throw asApiError(cause);
      }
    },
    [api, queryClient],
  );

  return useMemo(() => ({ send }), [send]);
}
