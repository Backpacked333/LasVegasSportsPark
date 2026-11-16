/**
 * Picks the activity image for anything the customer app shows as an activity: a catalog offering
 * (Discover, offering detail), a calendar item, a team entry or a fixture (ADR-008, "Imagery").
 *
 * The sport alone cannot decide it: the demo seed marks every offering as soccer, 5v5. So the
 * checks run in this order, and the first that fits wins:
 *
 * 1. The kind (offering kinds, SPK-CAT-002; booking, competition and scheduling event kinds).
 * 2. Format, activity type, sport or a word in the name: futsal or indoor, basketball.
 * 3. The age band: a maximum age of 8 or under, or a little-kids name ("mini", "tots"), gives the
 *    kids class; a maximum age of 17 or under gives the youth game.
 * 4. The kind's own default (a league season or a game is an adult league game), then the sport
 *    (soccer), then `park`.
 *
 * Pure: no clock, no state. The image is decorative; the activity's name is always in the text.
 */
import type { Schema } from '@sportspark/api-client';
import {
  activityArtwork,
  homeBand,
  type ActivityArt,
  type ArtworkShape,
  type ArtworkSource,
  type HomeBand,
} from './manifest';

type OfferingKind = Schema<'OfferingKind'>;
type SessionBookingKind = Schema<'SessionBookingKind'>;
type CompetitionKind = Schema<'CompetitionKind'>;
type SportFormat = Schema<'SportFormat'>;
/** Scheduling event kinds (`EventKind` in the scheduling contracts). */
type SchedulingEventKind = Schema<'Event'>['kind'];

/** Kinds that are not in a contract vocabulary but that screens use for their own items. */
type ScreenKind = 'team' | 'team_entry' | 'league' | 'private_lesson' | 'coaching' | 'tryout';

/** Every kind `artworkFor` knows; any other string falls through to the later checks. */
export type ArtworkKind =
  OfferingKind | SessionBookingKind | CompetitionKind | SchedulingEventKind | ScreenKind;

/**
 * The fields `artworkFor` reads. A `PublicOffering` (or `Offering`, `OfferingListItem`) fits as
 * it is; a Home, Calendar or Teams item passes what it has (for example `title` and `bookingKind`
 * as `kind`, or a team entry's `sportFormat` with `kind: 'team_entry'`).
 */
export interface ArtworkSubject {
  kind?: ArtworkKind | (string & {}) | null;
  format?: string | null;
  sportFormat?: SportFormat | (string & {}) | null;
  activityType?: string | null;
  sport?: string | null;
  name?: string | null;
  title?: string | null;
  ageBand?: { minAgeYears?: number; maxAgeYears?: number } | null;
  ageMin?: number | null;
  ageMax?: number | null;
}

/** What a kind decides: an image outright, or (`refine`) the later checks with a default. */
type KindRule = { art: ActivityArt } | { refine: ActivityArt | null };

const art = (value: ActivityArt): KindRule => ({ art: value });
const refine = (fallback: ActivityArt | null = null): KindRule => ({ refine: fallback });

/** SPK-CAT-002 offering kinds; `Record` so a new kind in the contracts fails the type check. */
const OFFERING_KIND_RULES: Readonly<Record<OfferingKind, KindRule>> = {
  party: art('party'),
  rental: art('rental-field'),
  camp: art('camp'),
  pickup: art('pickup'),
  private_coaching: art('coaching'),
  membership: art('membership'),
  trial: art('trial'),
  // A league season: futsal, youth or adult league, by the later checks.
  season: refine('soccer-league'),
  term: refine(),
  session: refine(),
  makeup: refine(),
  package: refine(),
};

const OTHER_KIND_RULES: Readonly<Record<Exclude<ArtworkKind, OfferingKind>, KindRule>> = {
  // Competition kinds and scheduling event kinds.
  league: refine('soccer-league'),
  tournament: refine('soccer-league'),
  game: refine('soccer-league'),
  practice: art('team'),
  maintenance: art('park'),
  block: art('park'),
  // Screen kinds and synonyms.
  team: art('team'),
  team_entry: art('team'),
  private_lesson: art('coaching'),
  coaching: art('coaching'),
  tryout: art('trial'),
};

const KIND_RULES: Readonly<Record<string, KindRule>> = {
  ...OFFERING_KIND_RULES,
  ...OTHER_KIND_RULES,
};

/** Lower case, with every run of non-letters as one space, so `indoor_boarded` reads as words. */
function words(...parts: (string | null | undefined)[]): string {
  return ` ${parts
    .filter((p): p is string => typeof p === 'string')
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z]+/g, ' ')
    .trim()} `;
}

const has = (text: string, ...terms: string[]): boolean =>
  terms.some((term) => text.includes(` ${term} `));

function kindKey(kind: string | null | undefined): string | null {
  if (!kind) return null;
  return kind
    .trim()
    .toLowerCase()
    .replace(/[^a-z]+/g, '_');
}

/** The `ActivityArt` key for a subject (see the module comment for the order of checks). */
export function activityArtFor(subject: ArtworkSubject): ActivityArt {
  // 1. The kind.
  const key = kindKey(subject.kind);
  const rule = key ? KIND_RULES[key] : undefined;
  if (rule && 'art' in rule) return rule.art;
  const kindDefault = rule?.refine ?? null;

  // 2. Format, activity type, sport, or a word in the name.
  const what = words(subject.format, subject.sportFormat, subject.activityType, subject.sport);
  const name = words(subject.name, subject.title);
  if (has(what, 'futsal', 'indoor') || has(name, 'futsal', 'indoor')) return 'futsal-indoor';
  if (has(what, 'basketball') || has(name, 'basketball')) return 'basketball';

  // 3. The age band.
  const maxAge = subject.ageBand?.maxAgeYears ?? subject.ageMax ?? undefined;
  if ((maxAge !== undefined && maxAge <= 8) || has(name, 'mini', 'tots', 'toddler', 'preschool'))
    return 'kids-class';
  if (maxAge !== undefined && maxAge <= 17) return 'soccer-youth';

  // 4. The kind's default, then the sport, then the park.
  if (kindDefault) return kindDefault;
  if (has(what, 'soccer', 'football')) return 'soccer-league';
  return 'park';
}

/** The image (in the given crop) and its `ActivityArt` key for an offering or activity item. */
export function artworkFor(
  subject: ArtworkSubject,
  shape: ArtworkShape,
): { source: ArtworkSource; art: ActivityArt } {
  const key = activityArtFor(subject);
  return { source: activityArtwork[key][shape], art: key };
}

/**
 * The Home band for an hour of the day in the facility's time zone (SPK-SCHED-008): day from
 * 06:00 to 17:59, night otherwise. The caller derives the hour from the injected clock and
 * `facilities.timezone`; this function reads no clock. Fractions are floored and the hour is
 * taken modulo 24; a value that is not a number gives night. In Legends mode it is always night.
 */
export function homeBandFor(
  hourInFacilityTime: number,
  { legends = false }: { legends?: boolean } = {},
): { source: ArtworkSource; band: HomeBand } {
  const hour = ((Math.floor(hourInFacilityTime) % 24) + 24) % 24;
  // Legends mode is the night theme: its band is the night one at every hour (ADR-008).
  const band: HomeBand = !legends && hour >= 6 && hour <= 17 ? 'day' : 'night';
  return { source: homeBand[band], band };
}
