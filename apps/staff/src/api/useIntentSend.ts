/**
 * Commands sent from multi-step, optimistic screen flows (§4.9): one intent per key (a drag of one
 * booking, the approval of one application), so a retry of the same input reuses its idempotency
 * key and a double tap never doubles an effect. A failure is thrown to the caller as an `ApiError`,
 * which reverts its optimistic state and says what did not save (redesign handoff "Writes are
 * optimistic, with Undo"). The same pattern as Today's `useTodayCommands`, with the queries to
 * read again given by the screen.
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
import { useApi } from '../providers/AppProviders';
import type { CommandRequest } from './useApiCommand';

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

export function useIntentSend(invalidate: readonly (readonly unknown[])[]) {
  const api = useApi();
  const queryClient = useQueryClient();
  const trackers = useRef(new Map<string, CommandIntentTracker>());
  const keys = useRef(invalidate);
  keys.current = invalidate;

  const refresh = useCallback(
    () =>
      Promise.all(keys.current.map((queryKey) => queryClient.invalidateQueries({ queryKey }))).then(
        () => undefined,
      ),
    [queryClient],
  );

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
        if (options.refresh !== false) void refresh();
        return data;
      } catch (cause) {
        tracker.failed(cause);
        throw asApiError(cause);
      }
    },
    [api, refresh],
  );

  return useMemo(() => ({ send, refresh }), [send, refresh]);
}
