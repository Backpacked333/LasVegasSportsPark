import { describe, expect, it } from 'vitest';
import type { TestApp } from '../../testing';
import {
  addRosterMemberFixture,
  createDivisionFixture,
  createSeasonFixture,
  createTeamEntryFixture,
} from '../../modules/competition';
import { at, seedPitchWithHalves } from '../../modules/scheduling';
import {
  adult,
  disableCapability,
  drain,
  enableCapability,
  get,
  journeyApp,
  ok,
  patch,
  post,
  staff,
  type Actor,
} from './support';

interface Team {
  entryId: string;
  captain: Actor;
}

/**
 * §3.16 Tournaments (CMP-15; DEC-016, DEC-078) and SPK-COMP-001, SPK-RESULT-001, across
 * competition (pools, fixtures, results, standings, brackets), scheduling (the pitch: one game at
 * a time) and communications (published results reach both rosters), on the assembled
 * application. Scores and dates are test data.
 */
describe('Tournaments: pools to a seeded final (assembled application)', () => {
  it('pools need the capability; pool games hold the pitch one at a time; published results reach the rosters; standings seed the final only once every pool result is official, even after the switch goes off', async () => {
    const t: TestApp = await journeyApp({ clockStart: '2027-01-10T17:00:00Z' });
    try {
      const admin = await staff(t, ['system_administrator']);
      const lm = await staff(t, ['league_manager']);
      const pitch = await seedPitchWithHalves(t.db, {
        organizationId: t.organizationId,
        facilityId: t.facilityId,
        name: 'Pitch 1',
      });
      const season = await createSeasonFixture(t, {
        status: 'active',
        startsOn: '2027-01-10',
        endsOn: '2027-06-30',
      });
      const divisionId = await createDivisionFixture(t, {
        seasonId: season.seasonId,
        name: 'Spring cup',
      });
      const team = async (name: string): Promise<Team> => {
        const captain = await adult(t);
        const entry = await createTeamEntryFixture(t, {
          seasonId: season.seasonId,
          captainPersonId: captain.personId,
          teamName: name,
          divisionId,
        });
        await addRosterMemberFixture(t, {
          teamEntryId: entry.teamEntryId,
          personId: captain.personId,
          jerseyNumber: 1,
        });
        return { entryId: entry.teamEntryId, captain };
      };
      const [sparks, storms, tides, torrents] = [
        await team('Sparks'),
        await team('Storms'),
        await team('Tides'),
        await team('Torrents'),
      ] as [Team, Team, Team, Team];

      // DEC-016: pools are refused until the administrator enables tournaments (DEC-078).
      const off = await post(t, `/v1/divisions/${divisionId}/pools`, lm.header, { name: 'Pool 1' });
      expect(off.status).toBe(403);
      expect(off.body.details).toMatchObject({
        code: 'CAPABILITY_DISABLED',
        capability: 'tournaments',
      });
      await enableCapability(t, admin, 'tournaments', 'DEC-078');
      const pool = async (name: string, members: Team[]) => {
        let created = await ok<{ id: string; revision: number }>(
          post(t, `/v1/divisions/${divisionId}/pools`, lm.header, { name }),
          201,
        );
        for (const [index, member] of members.entries()) {
          created = await ok(
            post(t, `/v1/pools/${created.id}/entries`, lm.header, {
              teamEntryId: member.entryId,
              seed: index + 1,
              expectedRevision: created.revision,
            }),
          );
        }
        return created.id;
      };
      const pool1 = await pool('Pool 1', [sparks, storms]);
      const pool2 = await pool('Pool 2', [tides, torrents]);

      // Pool games on the pitch: a second game in the same slot is refused by scheduling.
      const schedule = (home: Team, away: Team, date: string) =>
        post(t, '/v1/fixtures', lm.header, {
          seasonId: season.seasonId,
          divisionId,
          homeEntryId: home.entryId,
          awayEntryId: away.entryId,
          schedule: {
            facilityId: t.facilityId,
            resourceIds: [pitch.pitchId],
            scheduledStart: at(date, '18:00'),
            scheduledEnd: at(date, '19:00'),
          },
        });
      const game1 = (
        await ok<{ fixture: { id: string } }>(schedule(sparks, storms, '2027-01-16'), 201)
      ).fixture.id;
      // The refusal names the fixture it left unscheduled: the league schedules that fixture on
      // the next day rather than creating a second one.
      const clash = await schedule(tides, torrents, '2027-01-16');
      expect(clash.status).toBe(409);
      expect(clash.body.details).toMatchObject({ fixtureStatus: 'unscheduled' });
      const game2 = clash.body.details.fixtureId as string;
      await ok(
        patch(t, `/v1/fixtures/${game2}`, lm.header, {
          action: 'schedule',
          expectedRevision: 1,
          schedule: {
            facilityId: t.facilityId,
            resourceIds: [pitch.pitchId],
            scheduledStart: at('2027-01-17', '18:00'),
            scheduledEnd: at('2027-01-17', '19:00'),
          },
        }),
      );
      await drain(t);

      const play = async (
        fixtureId: string,
        date: string,
        homeScore: number,
        awayScore: number,
      ) => {
        t.clock.set(new Date(Date.parse(at(date, '19:05'))));
        const submitted = await ok<{ id: string; revision: number }>(
          post(t, `/v1/fixtures/${fixtureId}/results`, lm.header, {
            classification: 'completed',
            homeScore,
            awayScore,
          }),
          201,
        );
        await ok(
          post(t, `/v1/results/${submitted.id}/publish`, lm.header, {
            expectedRevision: submitted.revision,
          }),
        );
        await drain(t);
      };
      const results = async (actor: Actor) =>
        (
          await ok<{ items: Array<{ kind: string }> }>(
            get(t, '/v1/me/inbox?limit=50', actor.header),
          )
        ).items.filter((i) => i.kind === 'result_published').length;
      await play(game1, '2027-01-16', 2, 0);
      expect(await results(sparks.captain)).toBe(1);
      expect(await results(storms.captain)).toBe(1);
      expect(await results(tides.captain)).toBe(0);

      // The final is seeded from the pool winners only once every pool result is official.
      const standings1 = await ok<{
        rows: Array<{ teamEntryId: string }>;
        pendingFixtureIds: string[];
      }>(get(t, `/v1/pools/${pool1}/standings`, lm.header));
      expect(standings1.rows.map((r) => r.teamEntryId)).toEqual([sparks.entryId, storms.entryId]);
      const final = await ok<{ id: string; revision: number }>(
        post(t, `/v1/seasons/${season.seasonId}/bracket-nodes`, lm.header, {
          divisionId,
          name: 'Final',
          round: 1,
          slot: 1,
          home: { kind: 'seed', seed: 1 },
          away: { kind: 'seed', seed: 2 },
        }),
        201,
      );
      const sources = [
        { poolId: pool1, rank: 1, slot: 'home' },
        { poolId: pool2, rank: 1, slot: 'away' },
      ];
      const early = await post(t, `/v1/bracket-nodes/${final.id}/seed-from-standings`, lm.header, {
        sources,
        expectedRevision: final.revision,
      });
      expect(early.status).toBe(409);
      expect(early.body.details).toMatchObject({
        code: 'STANDINGS_NOT_FINAL',
        pendingFixtureIds: [game2],
      });
      await play(game2, '2027-01-17', 1, 3);
      // Switching tournaments off stops new pools but never what the season already holds.
      await disableCapability(t, admin, 'tournaments', 'DEC-016');
      expect(
        (await post(t, `/v1/divisions/${divisionId}/pools`, lm.header, { name: 'Pool 3' })).status,
      ).toBe(403);
      const seeded = await ok<{
        homeEntryId: string;
        awayEntryId: string;
        homeTeamName: string;
        awayTeamName: string;
      }>(
        post(t, `/v1/bracket-nodes/${final.id}/seed-from-standings`, lm.header, {
          sources,
          expectedRevision: final.revision,
        }),
      );
      expect(seeded).toMatchObject({
        homeEntryId: sparks.entryId,
        awayEntryId: torrents.entryId,
        homeTeamName: 'Sparks',
        awayTeamName: 'Torrents',
      });
      const nodes = await ok<Array<{ id: string; homeEntryId: string | null }>>(
        get(t, `/v1/seasons/${season.seasonId}/bracket-nodes`, sparks.captain.header),
      );
      expect(Array.isArray(nodes)).toBe(true);
    } finally {
      await t.close();
    }
  });
});
