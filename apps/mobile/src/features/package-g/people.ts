/**
 * Whose a membership or booking is, in words (SPK-UX-003 "a label names the participant"; §4.14
 * child data minimised): "You" for the signed-in person (`GET /v1/me`), otherwise the given name
 * from `GET /v1/person-names` (ID-02), which answers only for people this account may view. A
 * person the API leaves out is "Family member", never a guess; nothing here is logged or routed.
 */
import { usePersonNames } from '../../api/person-names';
import { useApiQuery } from '../../api/useApiQuery';
import { useApp } from '../../providers/AppProviders';

export function usePersonLabels(ids: readonly string[]): (personId: string) => string {
  const { session } = useApp();
  const me = useApiQuery({ path: '/me', enabled: session.status === 'signed_in' });
  const selfId = me.data?.person?.id ?? null;
  const others = me.data ? ids.filter((id) => id !== selfId) : [];
  const names = usePersonNames(others);
  return (personId) => {
    if (selfId !== null && personId === selfId) return 'You';
    if (!me.data) return me.error ? 'Family member' : 'Loading name…';
    const entry = names.get(personId);
    switch (entry?.state) {
      case 'ready':
        return entry.name.givenName;
      case 'unavailable':
        return 'Family member';
      case 'error':
        return 'Name not available';
      default:
        return 'Loading name…';
    }
  };
}
