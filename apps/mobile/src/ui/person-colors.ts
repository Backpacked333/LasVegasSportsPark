/**
 * Person colours (redesign handoff README "Person colours", BUILD_PLAN Phase 0; ADR-008 visual
 * system v2, **Proposed**): every member of a household keeps one colour everywhere: the filter
 * chip (`PersonFilter`), the calendar stripe and week-strip dot, the avatar ring and the initials
 * fallback (`Avatar` `personColor`).
 *
 * Assignment is deterministic and needs no stored state:
 * - the account holder ("Me") always gets `theme.selfPersonColor`;
 * - the other members, ordered by person id (ids are UUID v7, so this is the order the records
 *   were created in, the same on every device), take `theme.personColors` in turn: pink, blue,
 *   orange, teal, purple, then the list repeats.
 *
 * So a family's first child is pink and the second blue in both themes (the same slot, the
 * theme's own value). A colour is never the only cue: the name or initials are always next to it.
 */
import type { PersonColor, Theme } from './theme';

/** A person's colour slot: the account holder's own, or an index into `theme.personColors`. */
export type PersonColorSlot = 'self' | number;

/**
 * The slot of each person of a household. `selfId` is the signed-in person (null when unknown:
 * then everyone is ordered as a child would be).
 */
export function personColorSlots(
  personIds: readonly string[],
  selfId: string | null,
): Map<string, PersonColorSlot> {
  const slots = new Map<string, PersonColorSlot>();
  const others = [...new Set(personIds)].filter((id) => id !== selfId).sort();
  if (selfId && personIds.includes(selfId)) slots.set(selfId, 'self');
  others.forEach((id, index) => slots.set(id, index));
  return slots;
}

/** The colour of a slot in a theme. */
export function personColorOf(theme: Theme, slot: PersonColorSlot): PersonColor {
  if (slot === 'self') return theme.selfPersonColor;
  const list = theme.personColors;
  return list[((slot % list.length) + list.length) % list.length] as PersonColor;
}
