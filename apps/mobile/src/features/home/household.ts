/**
 * The household as the redesigned parent screens show it (redesign handoff 1b, 1j, Phase 0 person
 * colours): the signed-in person ("Me") and the people the API says this account may view
 * (`GET /v1/me` authorities with `view`, SPK-IAM-003), each with a given name
 * (`GET /v1/person-names`, §4.14 given names only) and a person colour (`ui/person-colors`).
 *
 * The client decides nothing about authority: `permissions` is what `GET /v1/me` reports, used only
 * to choose which reads to ask for (the API checks every one again).
 */
import type { Schema } from '@sportspark/api-client';
import { useMemo } from 'react';
import type { FilterPerson } from '../../ui/PersonFilter';
import { personColorOf, personColorSlots, type PersonColorSlot } from '../../ui/person-colors';
import { useTheme } from '../../ui/theme';
import { nameOf, useMe, usePersonNames, viewablePersonIds } from '../today/queries';

type Me = Schema<'Me'>;
export type GrantPermission = Schema<'GrantPermission'>;

export interface HouseholdPerson {
  id: string;
  /** The given name ("Maya"); the account holder's own given name for "Me". */
  givenName: string;
  /** "Me" for the account holder, the given name for everyone else. */
  label: string;
  self: boolean;
  slot: PersonColorSlot;
  /** What `GET /v1/me` says this account holds over the person; null for oneself. */
  permissions: readonly GrantPermission[] | null;
}

/** May this account do `permission` for the person (themselves always)? */
export function holds(person: HouseholdPerson | undefined, permission: GrantPermission): boolean {
  if (!person) return false;
  return person.self || (person.permissions ?? []).includes(permission);
}

function order(slot: PersonColorSlot | undefined): number {
  return slot === 'self' || slot === undefined ? Number.MAX_SAFE_INTEGER : slot;
}

/** The household from `GET /v1/me` and the names read for it (pure, for tests). */
export function householdOf(me: Me | undefined, names: Map<string, string>): HouseholdPerson[] {
  if (!me) return [];
  const selfId = me.principal.personId;
  const ids = viewablePersonIds(me);
  const slots = personColorSlots(ids, selfId);
  // Children in their colour order first, the account holder ("Me") last, as the chips show them.
  const ordered = [...ids].sort((a, b) => order(slots.get(a)) - order(slots.get(b)));
  return ordered.map((id) => {
    const self = id === selfId;
    const givenName = self ? (me.person?.givenName ?? 'You') : nameOf(names, id);
    return {
      id,
      givenName,
      label: self ? 'Me' : givenName,
      self,
      slot: slots.get(id) ?? 0,
      permissions: self
        ? null
        : (me.authorities.find((a) => a.subjectPersonId === id)?.permissions ?? []),
    };
  });
}

export function useHousehold() {
  const me = useMe();
  const ids = useMemo(() => viewablePersonIds(me.data), [me.data]);
  const names = usePersonNames(ids, me.data);
  // One array per distinct household, so the reads keyed on it are not rebuilt every render.
  const nameKey = ids.map((id) => `${id}=${names.get(id) ?? ''}`).join(',');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `nameKey` stands for `names`
  const people = useMemo(() => householdOf(me.data, names), [me.data, nameKey]);
  const selfId = me.data?.principal.personId ?? null;
  return { me, people, selfId, names };
}

/** The household as chips for `PersonChipRow`, in the theme's person colours. */
export function useFilterPeople(people: readonly HouseholdPerson[]): FilterPerson[] {
  const theme = useTheme();
  return people.map((p) => ({
    id: p.id,
    label: p.label,
    accessibilityLabel: p.self ? `Me (${p.givenName})` : p.givenName,
    color: personColorOf(theme, p.slot),
  }));
}
