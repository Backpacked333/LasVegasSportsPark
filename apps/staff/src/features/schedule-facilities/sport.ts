/**
 * Sport on events (API migration 0304): an event or series may name the sport it is played as, a
 * slug from the scheduling policy's vocabulary (an engineering placeholder until the operator's
 * list of offered sports is decided). League play in basketball gets its own colour on Today and
 * the schedule (`--kind-basketball`); every other block keeps its kind's colour, and the sport is
 * always written as text, never shown by colour alone (SPK-UX-009).
 */
import type { Schema } from '@sportspark/api-client';

type Event = Schema<'Event'>;

/** Activity kinds share one colour family across Today and the schedule (`--kind-*` tokens). */
export const KIND_TOKEN: Record<Event['kind'], string> = {
  game: 'league',
  practice: 'league',
  session: 'program',
  rental: 'rental',
  party: 'party',
  pickup: 'dropin',
  maintenance: 'dropin',
  block: 'dropin',
};

const SPORT_LABEL: Record<string, string> = {
  soccer: 'Soccer',
  indoor_soccer: 'Indoor soccer',
  futsal: 'Futsal',
  basketball: 'Basketball',
  other: 'Other sport',
};

/** The sport written for people ("Indoor soccer"); an unknown slug is shown in words. */
export function sportLabel(sport: string | null | undefined): string | null {
  if (!sport) return null;
  const known = SPORT_LABEL[sport];
  if (known) return known;
  const words = sport.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The colour token of an event block: basketball league play has its own; else the kind's. */
export function kindTokenOf(event: Pick<Event, 'kind'> & { sport?: string | null }): string {
  if (event.sport === 'basketball' && (event.kind === 'game' || event.kind === 'practice')) {
    return 'basketball';
  }
  return KIND_TOKEN[event.kind];
}
