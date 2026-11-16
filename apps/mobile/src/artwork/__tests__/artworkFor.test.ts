/**
 * ADR-008 ("Imagery") and PA-11 (the Home, Explore, Calendar and Teams destinations, proposed):
 * every activity those screens show resolves to a bundled image, by kind, then format or name,
 * then age band, then sport, with `park` last.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Schema } from '@sportspark/api-client';
import { activityArtFor, artworkFor, homeBandFor, type ArtworkSubject } from '../artworkFor';
import { ACTIVITY_ART, activityArtwork, homeBand } from '../manifest';

/** The contract vocabularies, from the published OpenAPI document (generated from the zod schemas). */
const openapi = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../../../../docs/api/openapi.json'), 'utf8'),
) as { components: { schemas: Record<string, { enum?: string[] }> } };
const vocabulary = (name: string): string[] => {
  const values = openapi.components.schemas[name]?.enum;
  if (!values?.length) throw new Error(`no ${name} enum in docs/api/openapi.json`);
  return values;
};

describe('ADR-008 / PA-11 artworkFor: every kind resolves to an image', () => {
  it.each(vocabulary('OfferingKind'))('offering kind %s', (kind) => {
    const { source, art } = artworkFor({ kind }, 'wide');
    expect(ACTIVITY_ART).toContain(art);
    expect(source).toBe(activityArtwork[art].wide);
  });

  it.each([
    ...vocabulary('SessionBookingKind'),
    ...vocabulary('CompetitionKind'),
    // Scheduling EventKind (inline in the OpenAPI document).
    'game',
    'practice',
    'session',
    'rental',
    'party',
    'pickup',
    'maintenance',
    'block',
  ])('booking, competition or event kind %s', (kind) => {
    const { source, art } = artworkFor({ kind }, 'square');
    expect(source).toBe(activityArtwork[art].square);
  });

  it.each(vocabulary('SportFormat'))('sport format %s', (sportFormat) => {
    expect(ACTIVITY_ART).toContain(artworkFor({ sportFormat }, 'wide').art);
  });

  it('gives park for an empty subject and an unknown kind', () => {
    expect(artworkFor({}, 'wide')).toEqual({ source: activityArtwork.park.wide, art: 'park' });
    expect(activityArtFor({ kind: 'something_new' })).toBe('park');
    expect(activityArtFor({ kind: null, name: null, ageBand: null })).toBe('park');
  });
});

describe('ADR-008 artworkFor: the order of checks', () => {
  const kinds: [Schema<'OfferingKind'>, string][] = [
    ['party', 'party'],
    ['rental', 'rental-field'],
    ['camp', 'camp'],
    ['pickup', 'pickup'],
    ['private_coaching', 'coaching'],
    ['membership', 'membership'],
    ['trial', 'trial'],
  ];
  it.each(kinds)('1. kind %s gives %s, whatever the sport, format or age', (kind, expected) => {
    expect(
      activityArtFor({
        kind,
        activityType: 'basketball',
        format: 'futsal',
        ageBand: { minAgeYears: 4, maxAgeYears: 6 },
      }),
    ).toBe(expected);
  });

  it('1. screen kinds and synonyms: team entries, practices, private lessons, tryouts', () => {
    expect(activityArtFor({ kind: 'team_entry', sportFormat: 'indoor_boarded' })).toBe('team');
    expect(activityArtFor({ kind: 'team' })).toBe('team');
    expect(activityArtFor({ kind: 'practice' })).toBe('team');
    expect(activityArtFor({ kind: 'Private lesson' })).toBe('coaching');
    expect(activityArtFor({ kind: 'tryout' })).toBe('trial');
    expect(activityArtFor({ kind: 'maintenance', activityType: 'soccer' })).toBe('park');
  });

  it('2. futsal or indoor in the format, activity type, sport or name gives futsal-indoor', () => {
    expect(activityArtFor({ kind: 'term', format: 'futsal' })).toBe('futsal-indoor');
    expect(activityArtFor({ kind: 'season', sportFormat: 'indoor_boarded' })).toBe('futsal-indoor');
    expect(activityArtFor({ activityType: 'Futsal' })).toBe('futsal-indoor');
    expect(activityArtFor({ sport: 'futsal' })).toBe('futsal-indoor');
    expect(activityArtFor({ kind: 'session', name: 'Indoor skills night' })).toBe('futsal-indoor');
    expect(activityArtFor({ title: 'Futsal club' })).toBe('futsal-indoor');
    // A word, not a substring: "outdoor" is not "indoor".
    expect(activityArtFor({ sportFormat: 'outdoor' })).toBe('park');
  });

  it('2. basketball in the activity type, sport or name gives basketball', () => {
    expect(activityArtFor({ kind: 'term', activityType: 'basketball' })).toBe('basketball');
    expect(activityArtFor({ sport: 'basketball', ageMax: 7 })).toBe('basketball');
    expect(activityArtFor({ name: 'Friday basketball run' })).toBe('basketball');
  });

  it('2. futsal is checked before the age band', () => {
    expect(
      activityArtFor({
        kind: 'term',
        format: 'futsal',
        ageBand: { minAgeYears: 4, maxAgeYears: 6 },
      }),
    ).toBe('futsal-indoor');
  });

  it('3. a maximum age of 8 or under gives kids-class; 17 or under gives soccer-youth', () => {
    const at = (maxAgeYears: number) =>
      activityArtFor({ kind: 'term', activityType: 'soccer', ageBand: { maxAgeYears } });
    expect(at(4)).toBe('kids-class');
    expect(at(8)).toBe('kids-class');
    expect(at(9)).toBe('soccer-youth');
    expect(at(17)).toBe('soccer-youth');
    expect(at(18)).toBe('soccer-league');
    expect(activityArtFor({ ageMin: 3, ageMax: 5 })).toBe('kids-class');
    expect(activityArtFor({ ageMax: 14 })).toBe('soccer-youth');
    expect(activityArtFor({ kind: 'season', ageBand: { maxAgeYears: 12 } })).toBe('soccer-youth');
  });

  it('3. a little-kids name gives kids-class when the age band is wider', () => {
    expect(activityArtFor({ name: 'Mini kickers', ageBand: { maxAgeYears: 12 } })).toBe(
      'kids-class',
    );
    expect(activityArtFor({ title: 'Soccer tots' })).toBe('kids-class');
  });

  it('4. the kind default, then soccer, then park', () => {
    expect(activityArtFor({ kind: 'season' })).toBe('soccer-league');
    expect(activityArtFor({ kind: 'game' })).toBe('soccer-league');
    expect(activityArtFor({ kind: 'league', ageBand: { minAgeYears: 18 } })).toBe('soccer-league');
    expect(activityArtFor({ kind: 'term', activityType: 'soccer' })).toBe('soccer-league');
    expect(activityArtFor({ kind: 'session', sport: 'football' })).toBe('soccer-league');
    expect(activityArtFor({ kind: 'package', activityType: 'tennis' })).toBe('park');
  });

  it('returns the requested crop', () => {
    expect(artworkFor({ kind: 'camp' }, 'wide').source).toBe(activityArtwork.camp.wide);
    expect(artworkFor({ kind: 'camp' }, 'square').source).toBe(activityArtwork.camp.square);
    expect(activityArtwork.camp.wide).not.toBe(activityArtwork.camp.square);
  });
});

/**
 * The demo seed (apps/api/src/dev/demo/catalog.ts and league.ts): every offering is soccer, 5v5,
 * and takes its program's age band (Youth soccer school and School holiday camps 5 to 12;
 * Memberships and rentals none). The league is indoor boarded.
 */
describe('ADR-008 / PA-11 artworkFor: the demo offerings', () => {
  const youth = { minAgeYears: 5, maxAgeYears: 12 };
  const soccer = { activityType: 'soccer', format: '5v5' };
  const demo: [string, Schema<'OfferingKind'>, ArtworkSubject['ageBand'], string][] = [
    ['Mini kickers (ages 5 to 8)', 'term', youth, 'kids-class'],
    ['Skills academy (ages 8 to 12)', 'term', youth, 'soccer-youth'],
    ['Park membership (season)', 'membership', {}, 'membership'],
    ['Futsal club (ages 7 to 12)', 'term', youth, 'futsal-indoor'],
    ['Goalkeeper clinic (ages 8 to 12)', 'term', youth, 'soccer-youth'],
    ['Advanced squad (by coach approval)', 'term', youth, 'soccer-youth'],
    ['Holiday camp week', 'camp', youth, 'camp'],
    ['Field 1 rental', 'rental', {}, 'rental-field'],
    ['Spring term: mini kickers (draft)', 'term', youth, 'kids-class'],
  ];

  it.each(demo)('%s (%s) shows %s', (name, kind, ageBand, expected) => {
    const offering: Pick<
      Schema<'PublicOffering'>,
      'name' | 'kind' | 'activityType' | 'format' | 'ageBand'
    > = { name, kind, ageBand: ageBand ?? {}, ...soccer };
    expect(artworkFor(offering, 'wide').art).toBe(expected);
  });

  it('a Friday night league fixture shows the indoor court; its team entry shows the team', () => {
    expect(
      activityArtFor({ kind: 'game', title: 'Friday night league', sportFormat: 'indoor_boarded' }),
    ).toBe('futsal-indoor');
    expect(
      activityArtFor({ kind: 'league', name: 'Spring cup', sportFormat: 'indoor_boarded' }),
    ).toBe('futsal-indoor');
    expect(
      activityArtFor({ kind: 'team_entry', name: 'Winter season', sportFormat: 'indoor_boarded' }),
    ).toBe('team');
  });

  it('a calendar session of the mini kickers class shows the kids class', () => {
    expect(activityArtFor({ kind: 'enrollment_session', title: 'Mini kickers' })).toBe(
      'kids-class',
    );
  });
});

describe('ADR-008 / PA-11 homeBandFor: day from 06:00 to 17:59 facility time', () => {
  it.each([
    [0, 'night'],
    [5, 'night'],
    [5.99, 'night'],
    [6, 'day'],
    [12, 'day'],
    [17, 'day'],
    [17.99, 'day'],
    [18, 'night'],
    [23, 'night'],
    [24, 'night'],
    [30, 'day'],
    [-1, 'night'],
    [Number.NaN, 'night'],
  ] as const)('hour %s is %s', (hour, band) => {
    expect(homeBandFor(hour)).toEqual({ band, source: homeBand[band] });
  });
});
