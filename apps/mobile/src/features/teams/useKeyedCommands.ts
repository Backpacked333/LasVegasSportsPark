/**
 * Several independent intents of the same command on one screen (§4.9): inviting several
 * recipients at once (SCR-C-23, partial completion permitted and shown per recipient) or inviting
 * suggested prior players after a renewal (SCR-C-27). Each item key has its own intent tracker, so
 * retrying one recipient reuses that recipient's idempotency key and never repeats another's.
 */
import {
  ApiError,
  type CommandIntentTracker,
  type CommandMethod,
  type PathsWithMethod,
  type ResponseBody,
} from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import type { CommandRequest } from '../../api/useApiCommand';
import { useApi } from '../../providers/AppProviders';

export type KeyedState<T> =
  | { status: 'processing' }
  | { status: 'succeeded'; data: T }
  | { status: 'failed'; error: ApiError };

export function useKeyedCommands<M extends CommandMethod, P extends PathsWithMethod<M>>(
  method: M,
  path: P,
  options: { invalidate?: readonly (readonly unknown[])[] } = {},
) {
  const api = useApi();
  const queryClient = useQueryClient();
  const trackers = useRef(new Map<string, CommandIntentTracker>());
  const [states, setStates] = useState<Record<string, KeyedState<ResponseBody<P, M>>>>({});
  const invalidate = options.invalidate;

  const submit = useCallback(
    async (key: string, request: CommandRequest<M, P>): Promise<boolean> => {
      let tracker = trackers.current.get(key);
      if (!tracker) {
        tracker = api.intentTracker();
        trackers.current.set(key, tracker);
      }
      const intent = tracker.current(request);
      setStates((s) => ({ ...s, [key]: { status: 'processing' } }));
      try {
        const send = api[method] as (path: P, options: object) => Promise<ResponseBody<P, M>>;
        const data = await send(path, { ...request, intent });
        tracker.complete();
        setStates((s) => ({ ...s, [key]: { status: 'succeeded', data } }));
        await Promise.all(
          (invalidate ?? []).map((queryKey) => queryClient.invalidateQueries({ queryKey })),
        );
        return true;
      } catch (error) {
        const apiError =
          error instanceof ApiError
            ? error
            : new ApiError({
                kind: 'unexpected_response',
                status: null,
                code: 'UNEXPECTED_RESPONSE',
                message: 'The request could not be completed.',
                nextAction: 'retry_or_contact_support',
                correlationId: null,
              });
        tracker.failed(apiError);
        setStates((s) => ({ ...s, [key]: { status: 'failed', error: apiError } }));
        return false;
      }
    },
    [api, method, path, queryClient, invalidate],
  );

  /** Forget an item (removed from the form): its next submission is a new intent. */
  const forget = useCallback((key: string) => {
    trackers.current.get(key)?.reset();
    trackers.current.delete(key);
    setStates((s) => {
      const next = { ...s };
      delete next[key];
      return next;
    });
  }, []);

  return { submit, states, forget };
}
