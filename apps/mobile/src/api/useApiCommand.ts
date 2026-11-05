/**
 * Consequential commands from screens (§4.9). One hook instance is one user intent: retrying the
 * same input reuses the idempotency key (a double tap or a retry after a timeout never duplicates
 * an effect); changed input, a confirmed success or a definitive refusal (an answer the API stores
 * and would replay for the same key) starts a new intent with a new key. IDEMPOTENCY_OUTCOME_
 * UNAVAILABLE keeps the key (`keepsIntentAfterFailure`): the command committed, and a new key would
 * run it again.
 * Pass `expectedRevision` in the body wherever the API takes it; a STALE_REVISION answer is shown
 * with "Reload" and the user's input is kept (SPK-UX-008).
 *
 * The hook also remembers the key whose last attempt got no definite answer (`NoAnswerMemory`), so
 * a refusal before running that answers the re-check under that key is marked
 * (`refusedAfterNoAnswer`): it proves only that the check did not run, and the screens keep the
 * outcome open (SPK-PAY-007, SPK-AT-028, R4-CLIENTS-A11Y-COPY-01).
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
import { NoAnswerMemory, keepsIntentAfterFailure } from './command-outcome';

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
  const noAnswer = useRef(new NoAnswerMemory());

  const mutation = useMutation<ResponseBody<P, M>, ApiError, CommandRequest<M, P>>({
    mutationFn: async (request) => {
      const intent = tracker.current.current(request);
      const send = api[method] as (path: P, options: object) => Promise<ResponseBody<P, M>>;
      try {
        const data = await send(path, { ...request, intent });
        noAnswer.current.settled();
        return data;
      } catch (error) {
        noAnswer.current.failed(intent.key, error);
        throw error;
      }
    },
    // A definitive refusal ends the intent: the API replays a stored 4xx for the same key, so the
    // next attempt (after the user fixed the cause) needs a new key. Unknown outcomes keep it, and
    // so does IDEMPOTENCY_OUTCOME_UNAVAILABLE (committed, its answer lost).
    onError: (error) => {
      if (!keepsIntentAfterFailure(error)) tracker.current.complete();
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
    noAnswer.current.settled();
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
