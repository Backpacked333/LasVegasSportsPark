/**
 * "Looking for" (redesign handoff 1d, INTERACTIONS "1d · Explore" row 2): the household with each
 * person's age on the facility's day, and the shared who-filter (`usePersonFilter`, the same choice
 * as Home and Calendar). Ages come from each person's date of birth (`GET /v1/people/{id}`, read
 * only for the people `GET /v1/me` lists; the API checks again); a person without one has no age
 * and narrows nothing. Names are given names only (§4.14).
 */
import { useMemo } from 'react';
import { useNow } from '../../providers/AppProviders';
import { todayIn } from '../../ui/DateStrip';
import { usePersonFilter } from '../../ui/PersonFilter';
import { useHousehold, type HouseholdPerson } from '../home/household';
import { useApiRecords } from '../registration/queries';
import { ageOn } from './fit';

export interface LookingForPerson extends HouseholdPerson {
  /** Whole years on the facility's day; null when no date of birth is known. */
  age: number | null;
}

export function useLookingFor(zone: string) {
  const { me, people, selfId } = useHousehold();
  const now = useNow();
  const today = todayIn(now, zone);
  const ids = useMemo(() => people.map((p) => p.id), [people]);
  const records = useApiRecords('/people/{id}', ids, me.data !== undefined);
  const withAges: LookingForPerson[] = people.map((p) => {
    const dob = records[p.id]?.data?.dateOfBirth ?? null;
    return { ...p, age: dob ? ageOn(dob, today) : null };
  });
  const filter = usePersonFilter(withAges);
  const selected = withAges.find((p) => p.id === filter.selected) ?? null;
  return { me, people: withAges, selfId, selected, select: filter.select };
}

/** "Maya · 8", or the label alone without an age ("Me"). */
export function chipLabel(person: LookingForPerson): string {
  return person.age !== null && !person.self ? `${person.label} · ${person.age}` : person.label;
}

/** The hint under the chips: what the list shows and what is flagged. */
export function lookingForHint(person: LookingForPerson | null): string {
  if (!person) return 'Showing every activity. Choose who it is for to see what fits.';
  const name = person.self ? 'your' : `${person.givenName}'s`;
  if (person.age === null) {
    return `Showing all ages. Times that clash with ${name} calendar are flagged.`;
  }
  return `Only showing activities for ages ${person.age}. Times that clash with ${name} calendar are flagged.`;
}
