import { describe, expect, it } from 'vitest';
import { proposedRuleSetContent } from '../../modules/competition/competition.policy';
import { seedResource } from '../../modules/scheduling';
import { adult, drain, get, journeyApp, ok, patch, post, staff } from './support';

/**
 * Phase 0 verification of an adult league season against the way the facility's current system is
 * used (docs/package-a/legacy-parity-verification.md): staff set up the season over the API,
 * captains enter teams, a game is scheduled on a field, the score is entered and the table
 * updates. It records what the assembled application does today. Names and dates are test data.
 */

type Json = Record<string, unknown>;
const HOUR = 3_600_000;

describe('Facility league scenarios (assembled application)', () => {
  it('SPK-COMP-003/004: a season is set up over the API, captains enter teams, a full division takes no more, and a played game moves the standings', async () => {
    const t = await journeyApp({ clockStart: '2026-11-02T17:00:00Z' });
    try {
      const lm = await staff(t, ['league_manager']);
      const field = await seedResource(t.db, {
        organizationId: t.organizationId,
        facilityId: t.facilityId,
        name: 'Field 1',
      });
      const rules = await ok<{ id: string }>(
        post(t, '/v1/rule-sets', lm.header, {
          name: 'Adult indoor rules',
          format: 'indoor_boarded',
          content: proposedRuleSetContent('indoor_boarded'),
        }),
        201,
      );
      const competition = await ok<{ id: string }>(
        post(t, '/v1/competitions', lm.header, {
          name: 'Monday Men Open',
          kind: 'league',
          sportFormat: 'indoor_boarded',
        }),
        201,
      );
      const season = await ok<{ id: string; revision: number; status: string }>(
        post(t, '/v1/seasons', lm.header, {
          competitionId: competition.id,
          name: 'Winter 2026',
          ruleSetId: rules.id,
          startsOn: '2026-11-16',
          endsOn: '2027-01-25',
        }),
        201,
      );
      expect(season.status).toBe('draft');
      await ok(
        patch(t, `/v1/seasons/${season.id}`, lm.header, {
          status: 'open',
          expectedRevision: season.revision,
        }),
      );
      const division = await ok<{ id: string }>(
        post(t, '/v1/divisions', lm.header, {
          seasonId: season.id,
          name: 'Open',
          capacityTeamEntries: 2,
        }),
        201,
      );
      // A captain enters a team; only staff place it in a division.
      const enter = async (name: string) => {
        const captain = await adult(t);
        const placed = await post(t, '/v1/team-entries', captain.header, {
          seasonId: season.id,
          team: { name },
          divisionId: division.id,
        });
        expect(placed.status).toBe(403);
        const res = await ok<{ entry: Json & { id: string; revision: number } }>(
          post(t, '/v1/team-entries', captain.header, { seasonId: season.id, team: { name } }),
          201,
        );
        expect(res.entry).toMatchObject({ status: 'applied', divisionId: null });
        return res.entry;
      };
      const approve = (entry: { id: string; revision: number }) =>
        post(t, `/v1/team-entries/${entry.id}/approve`, lm.header, {
          divisionId: division.id,
          expectedRevision: entry.revision,
        });
      const comets = await enter('Comets');
      const rockets = await enter('Rockets');
      const latecomers = await enter('Latecomers');
      expect((await ok<Json>(approve(comets))).status).toBe('approved');
      expect((await ok<Json>(approve(rockets))).status).toBe('approved');
      // Recorded gap (proposed amendment PA-10): a full division refuses the third team and there
      // is no team waiting list for it to join; the entry stays applied.
      const full = await approve(latecomers);
      expect(full.status).toBe(409);
      expect(full.body).toMatchObject({
        code: 'CAPACITY_UNAVAILABLE',
        details: { capacity: 2, occupied: 2 },
      });
      expect(await ok<Json>(get(t, `/v1/team-entries/${latecomers.id}`, lm.header))).toMatchObject({
        entry: { status: 'applied' },
      });

      // SPK-SCHED-002: the game reserves the field.
      const start = Date.parse('2026-11-17T03:00:00Z');
      const game = await ok<{ fixture: Json & { id: string } }>(
        post(t, '/v1/fixtures', lm.header, {
          seasonId: season.id,
          divisionId: division.id,
          round: 1,
          homeEntryId: comets.id,
          awayEntryId: rockets.id,
          schedule: {
            facilityId: t.facilityId,
            resourceIds: [field.resourceId],
            scheduledStart: new Date(start).toISOString(),
            scheduledEnd: new Date(start + HOUR).toISOString(),
          },
        }),
        201,
      );
      expect(game.fixture).toMatchObject({ status: 'scheduled' });
      expect(game.fixture['schedulingEventId']).toEqual(expect.any(String));

      t.clock.set(new Date(start + HOUR + 300_000));
      const result = await ok<{ id: string; revision: number }>(
        post(t, `/v1/fixtures/${game.fixture.id}/results`, lm.header, {
          classification: 'completed',
          homeScore: 5,
          awayScore: 3,
        }),
        201,
      );
      const published = await ok<{ revision: Json }>(
        post(t, `/v1/results/${result.id}/publish`, lm.header, {
          expectedRevision: result.revision,
        }),
      );
      expect(published.revision).toMatchObject({ status: 'official' });
      await drain(t);

      const standings = `/v1/seasons/${season.id}/standings?divisionId=${division.id}`;
      const table = await ok<{ rows: Json[] }>(get(t, standings, lm.header));
      expect(table.rows).toEqual([
        expect.objectContaining({
          position: 1,
          teamName: 'Comets',
          played: 1,
          won: 1,
          points: 3,
          goalsFor: 5,
          goalsAgainst: 3,
          goalDifference: 2,
        }),
        expect.objectContaining({
          position: 2,
          teamName: 'Rockets',
          played: 1,
          lost: 1,
          points: 0,
        }),
      ]);
      // Recorded gap (proposed amendment PA-06): standings are not readable without signing in.
      expect((await get(t, standings)).status).toBe(401);
    } finally {
      await t.close();
    }
  });
});
