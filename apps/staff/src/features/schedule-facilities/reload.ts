/**
 * "Reload" for a command refused as STALE_REVISION or INVALID_TRANSITION (SPK-UX-008 stale
 * version, SCR-S-06, SCR-S-07, SCR-S-41): clear the refusal and re-read the records it was about,
 * so the next attempt carries the current revision as a new intent (a new Idempotency-Key, §4.9).
 * What the user typed stays in the form.
 */
import { useQueryClient } from '@tanstack/react-query';

export function useCommandReload(
  reset: () => void,
  keys: readonly (readonly unknown[])[],
): () => void {
  const queryClient = useQueryClient();
  return () => {
    reset();
    for (const queryKey of keys) void queryClient.invalidateQueries({ queryKey });
  };
}
