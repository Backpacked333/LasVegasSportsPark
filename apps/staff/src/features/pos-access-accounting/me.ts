/**
 * The signed-in staff member's person id (`GET /v1/me`), for four-eyes commands: the author of an
 * access policy or the proposer of an accounting mapping is not offered its approval, and is told
 * another person approves it. The API still refuses it (author_cannot_approve, FOUR_EYES_REQUIRED).
 */
import { useApiQuery } from '../../api/useApiQuery';

export function useMyPersonId(): string | null {
  const me = useApiQuery({ path: '/me' });
  return me.data?.principal.personId ?? null;
}
