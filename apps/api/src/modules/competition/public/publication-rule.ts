import { DivisionCriteriaSchema, type PublicationBlocker } from '@sportspark/contracts';

/**
 * Who a competition is for, as far as publication is concerned (SPK-SCHED-010 "no child's name
 * ... appears", §4.14; proposed rule pending DEC-100; security review M-2).
 *
 * The rule fails closed. A competition may be public only when every division of its seasons is
 * positively known to be an adult division, and the only fact that says so is structured: the
 * division's age band with a minimum age of 18 or more (`DivisionCriteria.ageBand.minAge`). The
 * criteria carry no birth-year bound and no other adult marker, so nothing else gives permission.
 *
 * Wording never gives permission. It is only ever a further refusal: a competition, season or
 * division whose name (or a division's level or category) suggests players under 18 is refused
 * even when every age band says adult, because one of the two is wrong and the safe reading is
 * the private one.
 */

/** The age from which a player is an adult for publication (proposed, DEC-100 N2, N3). */
export const PUBLIC_ADULT_AGE = 18;

/**
 * "U19", "Under 19" and "19U" admit players under 18, so labels up to 19 are read as youth. "U21"
 * and "U23" are not (their age bands must still say adult).
 */
const YOUTH_LABEL_MAX = 19;

const NOT_IN_A_WORD_BEFORE = '(?<![a-z])';
const NOT_IN_A_WORD_AFTER = '(?![a-z])';
const YOUTH_WORDS = [
  'youths?',
  'juniors?',
  'jrs?',
  'juveniles?',
  'kids?',
  'kiddies?',
  'boys?',
  'girls?',
  'child',
  'childrens?',
  'minors?',
  'teens?',
  'teenage',
  'teenagers?',
  'tweens?',
  'toddlers?',
  'tots?',
  'pee[-\\s]?wees?',
  'mites?',
  'squirts?',
  'bantams?',
  'midgets?',
  'cadets?',
  'freshman',
  'freshmen',
  'sophomores?',
  'jv',
  'schoolboys?',
  'schoolgirls?',
  'kindergarten',
  'pre[-\\s]?school',
  'pre[-\\s]?k',
  'academy',
  'academies',
  'little\\s+league',
  '(?:high|middle|elementary|primary|secondary|grade|grammar|junior|prep)[-\\s]?schools?',
  'grades?[-\\s]*\\d{1,2}',
  '\\d{1,2}(?:st|nd|rd|th)?[-\\s]?graders?',
  '\\d{1,2}(?:st|nd|rd|th)[-\\s]?grade',
];
const YOUTH_WORD = new RegExp(
  `${NOT_IN_A_WORD_BEFORE}(?:${YOUTH_WORDS.join('|')})${NOT_IN_A_WORD_AFTER}`,
  'i',
);

/** Age-group labels: each captures the age it names. */
const AGE_GROUP_LABELS: readonly RegExp[] = [
  // U12, U-12, U 12, U12s, U12B, BU12, GU14
  /(?<![a-z0-9])[bg]?u[-\s]?(\d{1,2})(?!\d)/gi,
  // 12U, 12-U
  /(?<!\d)(\d{1,2})[-\s]?u(?![a-z])/gi,
  // Under 12, Under-12s
  /(?<![a-z])under[-\s]?(\d{1,2})(?!\d)/gi,
  // 12 and under, 12 & under, 12 or younger
  /(?<!\d)(\d{1,2})[-\s]?(?:and|&|or)[-\s]?(?:under|younger|below)(?![a-z])/gi,
];
/** Stated ages: "ages 8-10", "age 16+", "12 year olds", "9 yrs". The first age is the youngest. */
const STATED_AGES: readonly RegExp[] = [
  /(?<![a-z])ages?[-\s]*(\d{1,2})(?!\d)/gi,
  /(?<!\d)(\d{1,2})[-\s]?(?:years?|yrs?|yo)(?:[-\s]?olds?)?(?![a-z])/gi,
];
const FOUR_DIGIT_YEAR = /(?<!\d)((?:19|20)\d{2})(?!\d)/g;

export interface WordingContext {
  /**
   * The year the name is read in: the season's first year for a season or one of its divisions,
   * the current year for a competition. A four-digit year in a name within 18 years before it
   * reads as a birth year of players under 18 ("2015 Coed").
   */
  referenceYear: number;
  /** Years that are the season's own ("Spring 2026"): never read as a birth year. */
  seasonYears?: ReadonlySet<number>;
}

/**
 * The wording in `text` that suggests players under 18, or null. Used only to refuse: its
 * silence proves nothing about a division.
 */
export function minorWording(text: string, context: WordingContext): string | null {
  const word = YOUTH_WORD.exec(text);
  if (word) return word[0];
  for (const pattern of AGE_GROUP_LABELS) {
    for (const match of text.matchAll(pattern)) {
      if (Number(match[1]) <= YOUTH_LABEL_MAX) return match[0];
    }
  }
  for (const pattern of STATED_AGES) {
    for (const match of text.matchAll(pattern)) {
      if (Number(match[1]) < PUBLIC_ADULT_AGE) return match[0];
    }
  }
  for (const match of text.matchAll(FOUR_DIGIT_YEAR)) {
    const year = Number(match[1]);
    if (context.seasonYears?.has(year)) continue;
    const age = context.referenceYear - year;
    if (age > 0 && age <= PUBLIC_ADULT_AGE) return match[0];
  }
  return null;
}

/**
 * What a division's structured criteria say about its players: `adult` only when its age band
 * states a minimum age of 18 or more. A division without an age band, with a band open at the
 * bottom, or with criteria that cannot be read is `age_not_stated`: nothing says its players are
 * adults, and that is not permission.
 */
export function divisionAudience(criteria: unknown): 'adult' | 'under_18' | 'age_not_stated' {
  const parsed = DivisionCriteriaSchema.safeParse(criteria);
  if (!parsed.success) return 'age_not_stated';
  const band = parsed.data.ageBand;
  if (!band) return 'age_not_stated';
  if (band.minAge === null) {
    return band.maxAge !== null && band.maxAge < PUBLIC_ADULT_AGE ? 'under_18' : 'age_not_stated';
  }
  return band.minAge >= PUBLIC_ADULT_AGE ? 'adult' : 'under_18';
}

export interface AudienceSeason {
  id: string;
  name: string;
  /** The season's first and last calendar year. */
  years: readonly number[];
}
export interface AudienceDivision {
  seasonId: string;
  name: string;
  criteria: unknown;
}

const WHAT_TO_SET = `Set its age band with a minimum age of ${PUBLIC_ADULT_AGE} or more.`;

/**
 * Everything that stops a competition from being public, in a fixed order: the competition, then
 * each season by name, then each division by season and name. Empty means every division is
 * positively known to be an adult division and no name suggests otherwise.
 */
export function publicationBlockers(input: {
  competitionName: string;
  seasons: readonly AudienceSeason[];
  divisions: readonly AudienceDivision[];
  currentYear: number;
}): PublicationBlocker[] {
  const blockers: PublicationBlocker[] = [];
  // By code unit, so the order never depends on the runtime's collation data.
  const text = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const seasons = [...input.seasons].sort((a, b) => text(a.name, b.name) || text(a.id, b.id));
  const everySeasonYear = new Set(seasons.flatMap((season) => season.years));

  const competitionWording = minorWording(input.competitionName, {
    referenceYear: input.currentYear,
    seasonYears: everySeasonYear,
  });
  if (competitionWording) {
    blockers.push({
      scope: 'competition',
      reason: 'name_suggests_minors',
      seasonName: null,
      divisionName: null,
      message: `The competition's name ("${competitionWording}") suggests players under ${PUBLIC_ADULT_AGE}. A competition for under-${PUBLIC_ADULT_AGE} players is not made public; rename it if it is an adult competition.`,
    });
  }
  if (input.divisions.length === 0) {
    blockers.push({
      scope: 'competition',
      reason: 'no_divisions',
      seasonName: null,
      divisionName: null,
      message: `The competition has no division yet, so nothing says who plays in it. Add a division whose age band has a minimum age of ${PUBLIC_ADULT_AGE} or more.`,
    });
  }
  for (const season of seasons) {
    const referenceYear = season.years[0] ?? input.currentYear;
    const context = { referenceYear, seasonYears: new Set(season.years) };
    const seasonWording = minorWording(season.name, context);
    if (seasonWording) {
      blockers.push({
        scope: 'season',
        reason: 'name_suggests_minors',
        seasonName: season.name,
        divisionName: null,
        message: `The name of season "${season.name}" ("${seasonWording}") suggests players under ${PUBLIC_ADULT_AGE}. Rename it if it is an adult season.`,
      });
    }
    const divisions = input.divisions
      .filter((division) => division.seasonId === season.id)
      .sort((a, b) => text(a.name, b.name));
    for (const division of divisions) {
      const where = `Division "${division.name}" (${season.name})`;
      const audience = divisionAudience(division.criteria);
      if (audience === 'under_18') {
        blockers.push({
          scope: 'division',
          reason: 'under_18',
          seasonName: season.name,
          divisionName: division.name,
          message: `${where} admits players under ${PUBLIC_ADULT_AGE}: its age band starts below ${PUBLIC_ADULT_AGE}.`,
        });
      } else if (audience === 'age_not_stated') {
        blockers.push({
          scope: 'division',
          reason: 'age_not_stated',
          seasonName: season.name,
          divisionName: division.name,
          message: `${where} does not say its players are adults. ${WHAT_TO_SET}`,
        });
      }
      const parsed = DivisionCriteriaSchema.safeParse(division.criteria);
      const words = [
        division.name,
        parsed.success ? parsed.data.level : null,
        parsed.success ? parsed.data.category : null,
      ]
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .join(' | ');
      const wording = minorWording(words, context);
      if (wording) {
        blockers.push({
          scope: 'division',
          reason: 'name_suggests_minors',
          seasonName: season.name,
          divisionName: division.name,
          message: `${where}: its name, level or category ("${wording}") suggests players under ${PUBLIC_ADULT_AGE}. Rename it if it is an adult division.`,
        });
      }
    }
  }
  return blockers;
}
