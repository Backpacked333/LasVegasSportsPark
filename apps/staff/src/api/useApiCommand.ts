/**
 * Consequential commands from screens (§4.9). One hook instance is one user intent: retrying the
 * same input reuses the idempotency key (a double tap or a retry after a timeout never duplicates
 * an effect); changed input, a confirmed success or a definitive refusal (an answer the API stores
 * and would replay for the same key) starts a new intent with a new key. IDEMPOTENCY_OUTCOME_
 * UNAVAILABLE keeps the key (`CommandIntentTracker.failed` uses `keepsIntentAfterFailure`): the
 * command committed, and a new key would run it a second time.
 *
 * After an answer that says the command may have taken effect or did (`mayHaveTakenEffect`,
 * `mustNotCreateAgain`), the `invalidate` queries are read again as after a success, so a list
 * shows the record the command may have made. `reread()` reads them again on demand (a "Start a
 * new request" that must look at the current state first). It resolves only once every query of
 * those keys shown on screen was fetched again and succeeded; it rejects when none is shown, when
 * one failed, and when one could not start (TanStack pauses a fetch while the dashboard is
 * offline and resolves its refetch at once, without reading anything).
 * Pass `expectedRevision` in the body wherever the API takes it; a STALE_REVISION answer is shown
 * with "Reload" and the user's input is kept (SPK-UX-008).
 */
import {
  mayHaveTakenEffect,
  mustNotCreateAgain,
  type ApiError,
  type CommandMethod,
  type PathsWithMethod,
  type RequestOptions,
  type ResponseBody,
} from '@sportspark/api-client';
import { useMutation, useQueryClient, type Query, type QueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useRef } from 'react';
import { useApi } from '../providers/AppProviders';

export type CommandRequest<M extends CommandMethod, P extends PathsWithMethod<M>> = Omit<
  RequestOptions<P, M>,
  'intent' | 'signal'
>;

/**
 * Reads the shown queries of `keys` again and resolves only when each was read afresh: every
 * active, enabled query matched (at least one) ended a new fetch successfully. A refetch TanStack
 * paused (offline) or one that failed rejects, so a form that waits for it stays locked.
 */
export async function rereadQueries(
  queryClient: QueryClient,
  keys: readonly (readonly unknown[])[],
): Promise<void> {
  const cache = queryClient.getQueryCache();
  const shown = new Map<Query, number>();
  for (const queryKey of keys) {
    for (const query of cache.findAll({ queryKey, type: 'active' })) {
      if (!query.isDisabled()) shown.set(query, query.state.dataUpdateCount);
    }
  }
  if (shown.size === 0) throw new Error('Nothing on screen to read again.');
  await Promise.all(
    keys.map((queryKey) => queryClient.invalidateQueries({ queryKey }, { throwOnError: true })),
  );
  for (const [query, updatesBefore] of shown) {
    const { status, fetchStatus, dataUpdateCount } = query.state;
    if (fetchStatus !== 'idle' || status !== 'success' || dataUpdateCount <= updatesBefore) {
      throw new Error('The record could not be read again.');
    }
  }
}

export interface UseApiCommandOptions {
  /** Query keys (or prefixes) to refetch after success, e.g. `['api', '/me/inbox']`. */
  invalidate?: readonly (readonly unknown[])[];
}

export function useApiCommand<M extends CommandMethod, P extends PathsWithMethod<M>>(
  method: M,
  path: P,
  options: UseApiCommandOptions = {},
) {
  const api = useApi();
  const queryClient = useQueryClient();
  const tracker = useRef(api.intentTracker());
  const invalidateKeys = options.invalidate;
  const reread = useCallback(
    () => rereadQueries(queryClient, invalidateKeys ?? []),
    [invalidateKeys, queryClient],
  );

  const mutation = useMutation<ResponseBody<P, M>, ApiError, CommandRequest<M, P>>({
    mutationFn: (request) => {
      const intent = tracker.current.current(request);
      const send = api[method] as (path: P, options: object) => Promise<ResponseBody<P, M>>;
      return send(path, { ...request, intent });
    },
    // A definitive refusal ends the intent: the API replays a stored 4xx for the same key, so the
    // next attempt (after the user fixed the cause) needs a new key. Unknown outcomes keep it.
    onError: (error) => {
      tracker.current.failed(error);
      // The command may have made or changed records: show them as they now are.
      if (error && (mayHaveTakenEffect(error) || mustNotCreateAgain(error))) {
        void Promise.all(
          (options.invalidate ?? []).map((queryKey) => queryClient.invalidateQueries({ queryKey })),
        );
      }
    },
    onSuccess: async () => {
      tracker.current.complete();
      await Promise.all(
        (options.invalidate ?? []).map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      );
    },
  });

  const reset = useCallback(() => {
    tracker.current.reset();
    mutation.reset();
  }, [mutation]);

  return useMemo(
    () => ({
      submit: mutation.mutateAsync,
      status: mutation.status,
      error: mutation.error,
      data: mutation.data,
      isProcessing: mutation.isPending,
      reset,
      reread,
    }),
    [
      mutation.mutateAsync,
      mutation.status,
      mutation.error,
      mutation.data,
      mutation.isPending,
      reset,
      reread,
    ],
  );
}
