/**
 * The household as the Who step and the activity page read it (handoff 1e, 3d): each person the
 * account may register, their age, the API's eligibility for the activity's registration intent,
 * and whether they already hold a place (`GET /v1/enrollments?participantPersonId=&offeringId=`).
 * Children first in their colour order, the account holder ("Me") last.
 */
import { useMemo } from 'react';
import { useApiReads } from '../today/queries';
import { useNow } from '../../providers/AppProviders';
import { todayIn } from '../../ui/DateStrip';
import { INTENT_HANDLING } from '../registration/intents';
import { useRegistrationOptions } from '../registration/options';
import { useParticipants } from '../registration/participants';
import { useApiRecords } from '../registration/queries';
import type { RegistrationIntent } from '../registration/format';
import { ageOn } from './fit';
import { holdsPlace, whoRow, type WhoRow } from './who';

export interface WhoPerson {
  personId: string;
  /** Given name ("Maya"); the account holder's own given name. */
  name: string;
  self: boolean;
  age: number | null;
}

/** The intent this flow registers with: the API's first basket intent for the activity. */
export function basketIntentOf(
  available: readonly RegistrationIntent[],
): RegistrationIntent | null {
  // A child's place first (the parent app registers children), then the API's order.
  if (available.includes('youth')) return 'youth';
  return available.find((i) => INTENT_HANDLING[i] === 'basket') ?? null;
}

export function useWho(
  offeringId: string,
  zone: string,
  enabled = true,
  /** The intent chosen on Who, when the activity takes more than one. */
  chosen: RegistrationIntent | null = null,
) {
  const { me, participants, namesLoading, namesError, retryNames } = useParticipants();
  const now = useNow();
  const today = todayIn(now, zone);
  const ids = useMemo(() => participants.map((p) => p.personId), [participants]);
  const ready = enabled && me.data !== undefined && !namesLoading && namesError === null;
  const options = useRegistrationOptions(offeringId, ids, ready);
  const records = useApiRecords('/people/{id}', ids, ready);
  const requests = useMemo(
    () =>
      ids.map((personId) => ({ query: { participantPersonId: personId, offeringId, limit: 5 } })),
    [ids, offeringId],
  );
  const enrollments = useApiReads('/enrollments', requests, ready);
  const intent = options.data
    ? chosen && options.data.availableIntents.includes(chosen)
      ? chosen
      : basketIntentOf(options.data.availableIntents)
    : null;
  const people: WhoPerson[] = participants
    .map((p) => {
      const dob = records[p.personId]?.data?.dateOfBirth ?? null;
      return {
        personId: p.personId,
        name: p.self ? (me.data?.person?.givenName ?? 'You') : p.displayName,
        self: p.self,
        age: dob ? ageOn(dob, today) : null,
      };
    })
    .sort((a, b) => Number(a.self) - Number(b.self));
  const rows: WhoRow[] = people.map((person) => {
    const index = ids.indexOf(person.personId);
    const held = (enrollments[index]?.data?.items ?? []).some(holdsPlace);
    return whoRow({
      personId: person.personId,
      name: person.name,
      age: person.age,
      options: options.data,
      intent,
      alreadyIn: held,
    });
  });
  return {
    me,
    people,
    rows,
    intent,
    options,
    loading:
      me.isPending || namesLoading || (ready && options.data === undefined && !options.error),
    namesError,
    retryNames,
  };
}
