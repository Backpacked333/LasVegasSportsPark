/**
 * Consequential commands from screens (§4.9). One hook instance is one user intent: retrying the
 * same input reuses the idempotency key (a double tap or a retry after a timeout never duplicates
 * an effect); changed input, a confirmed success or a definitive refusal (an answer the API stores
 * and would replay for the same key) starts a new intent with a new key.
 * Pass `expectedRevision` in the body wherever the API takes it; a STALE_REVISION answer is shown
 * with "Reload" and the user's input is kept (SPK-UX-008).
 */
import type {
  ApiError,
  CommandMethod,
  PathsWithMethod,
  RequestOptions,
  ResponseBody,
} from '@sportspark/api-client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useRef } from 'react';
import { useApi } from '../providers/AppProviders';

export type CommandRequest<M extends CommandMethod, P extends PathsWithMethod<M>> = Omit<
  RequestOptions<P, M>,
  'intent' | 'signal'
>;

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
    }),
    [
      mutation.mutateAsync,
      mutation.status,
      mutation.error,
      mutation.data,
      mutation.isPending,
      reset,
    ],
  );
}
