import { describe, expect, it } from 'vitest';
import { proposedRuleSetContent } from '../../modules/competition/competition.policy';
import { seedResource } from '../../modules/scheduling';
import { adult, drain, enableCapability, get, journeyApp, ok, patch, post, staff } from './support';

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
      // Recorded gap (proposed amendment PA-10), kept while the `team_waitlist` capability is off:
      // a full division refuses the third team and nothing waits; the entry stays applied. The
      // waiting path with the capability on is the next scenario.
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
      // Recorded gap (proposed amendment PA-06), kept on the staff route and while the
      // `public_schedule` capability is off: standings are not readable without signing in. The
      // public read of a published competition is the last scenario.
      expect((await get(t, standings)).status).toBe(401);
    } finally {
      await t.close();
    }
  });

  it('SPK-COMP-006 (proposed amendment PA-10, capability team_waitlist on): the third team waits in order for the full division, owes nothing, is offered the place a withdrawal frees, and its acceptance returns it to the approval path', async () => {
    const t = await journeyApp({ clockStart: '2026-11-02T17:00:00Z' });
    try {
      const admin = await staff(t, ['system_administrator']);
      await enableCapability(t, admin, 'team_waitlist', 'DEC-104');
      const lm = await staff(t, ['league_manager']);
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
      const season = await ok<{ id: string; revision: number }>(
        post(t, '/v1/seasons', lm.header, {
          competitionId: competition.id,
          name: 'Winter 2026',
          ruleSetId: rules.id,
          startsOn: '2026-11-16',
          endsOn: '2027-01-25',
        }),
        201,
      );
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
      const enter = async (name: string) => {
        const captain = await adult(t);
        const res = await ok<{ entry: Json & { id: string; revision: number } }>(
          post(t, '/v1/team-entries', captain.header, { seasonId: season.id, team: { name } }),
          201,
        );
        return { captain, ...res.entry };
      };
      const place = (entry: { id: string; revision: number }) =>
        ok<Json & { revision: number }>(
          post(t, `/v1/team-entries/${entry.id}/approve`, lm.header, {
            divisionId: division.id,
            expectedRevision: entry.revision,
          }),
        );
      const comets = await enter('Comets');
      const rockets = await enter('Rockets');
      expect((await place(comets)).status).toBe('approved');
      const rocketsApproved = await place(rockets);
      expect(rocketsApproved.status).toBe('approved');

      // The division is full: the third and fourth teams wait, in the order they met it.
      const latecomers = await enter('Latecomers');
      const waiting = await place(latecomers);
      expect(waiting).toMatchObject({
        status: 'waiting',
        divisionId: null,
        waitingDivisionId: division.id,
        financialStatusRef: null,
      });
      t.clock.advance(60_000);
      const stragglers = await enter('Stragglers');
      expect((await place(stragglers)).status).toBe('waiting');
      const waitingList = `/v1/seasons/${season.id}/waiting-list`;
      expect(await ok<Json>(get(t, waitingList, lm.header))).toMatchObject({
        offerHours: 48,
        lists: [
          {
            capacity: 2,
            placed: 2,
            freePlaces: 0,
            entries: [
              { position: 1, teamName: 'Latecomers' },
              { position: 2, teamName: 'Stragglers' },
            ],
          },
        ],
      });
      // The captain sees that the team is waiting and where it stands.
      const workspace = `/v1/team-entries/${latecomers.id}`;
      expect(await ok<Json>(get(t, workspace, latecomers.captain.header))).toMatchObject({
        entry: { status: 'waiting' },
        waiting: { position: 1, listLength: 2, openOffer: null },
      });
      // A waiting team counts for nothing in the season: not in the division, not in the table.
      const divisions = await ok<Json[]>(get(t, `/v1/divisions?seasonId=${season.id}`, lm.header));
      expect(divisions).toEqual([expect.objectContaining({ entryCount: 2 })]);
      const standings = `/v1/seasons/${season.id}/standings?divisionId=${division.id}`;
      const table = await ok<{ rows: Json[] }>(get(t, standings, lm.header));
      expect(table.rows.map((row) => row['teamName']).sort()).toEqual(['Comets', 'Rockets']);

      // A place opens; staff offer it to the first in the order; the offer stands 48 hours.
      await ok(
        post(t, `/v1/team-entries/${rockets.id}/withdraw`, lm.header, {
          expectedRevision: rocketsApproved.revision,
          reason: 'Team folded before the season',
        }),
      );
      const offered = await ok<{ offer: Json & { id: string; revision: number } }>(
        post(t, `/v1/team-entries/${latecomers.id}/place-offers`, lm.header, {
          expectedRevision: waiting.revision,
        }),
        201,
      );
      expect(offered.offer).toMatchObject({
        status: 'offered',
        positionAtOffer: 1,
        expiresAt: new Date(t.clock.now().getTime() + 48 * HOUR).toISOString(),
      });
      // The captain accepts on the phone: applied in the division, then approved as any entry.
      const accepted = await ok<{ entry: Json & { id: string; revision: number } }>(
        post(
          t,
          `/v1/team-entry-place-offers/${offered.offer.id}/accept`,
          latecomers.captain.header,
          { expectedRevision: offered.offer.revision },
        ),
      );
      expect(accepted.entry).toMatchObject({ status: 'applied', divisionId: division.id });
      const approved = await ok<Json>(
        post(t, `/v1/team-entries/${latecomers.id}/approve`, lm.header, {
          expectedRevision: accepted.entry.revision,
        }),
      );
      expect(approved).toMatchObject({ status: 'approved', divisionId: division.id });
      await drain(t);
      expect(await ok<Json>(get(t, waitingList, lm.header))).toMatchObject({
        lists: [{ placed: 2, freePlaces: 0, entries: [{ position: 1, teamName: 'Stragglers' }] }],
      });
      // The remaining captain withdraws from the list.
      const stillWaiting = await ok<{ entry: { revision: number } }>(
        get(t, `/v1/team-entries/${stragglers.id}`, stragglers.captain.header),
      );
      const out = await ok<Json>(
        post(t, `/v1/team-entries/${stragglers.id}/withdraw`, stragglers.captain.header, {
          expectedRevision: stillWaiting.entry.revision,
          reason: 'Found another league',
        }),
      );
      expect(out).toMatchObject({ status: 'withdrawn' });
    } finally {
      await t.close();
    }
  });

  it('SPK-SCHED-010 (proposed amendment PA-06, capability public_schedule on): once staff make the competition public its fixtures, results and standings are read without sign-in, and the facility day schedule shows the game by field; the staff route still needs sign-in', async () => {
    const t = await journeyApp({ clockStart: '2026-11-02T17:00:00Z' });
    try {
      const admin = await staff(t, ['system_administrator']);
      await enableCapability(t, admin, 'public_schedule', 'DEC-100');
      const lm = await staff(t, ['league_manager']);
      const field = await seedResource(t.db, {
        organizationId: t.organizationId,
        facilityId: t.facilityId,
        name: 'Field 1',
      });
      const organization = await t.db
        .selectFrom('organizations')
        .select('slug')
        .where('id', '=', t.organizationId)
        .executeTakeFirstOrThrow();
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
      const season = await ok<{ id: string; revision: number }>(
        post(t, '/v1/seasons', lm.header, {
          competitionId: competition.id,
          name: 'Winter 2026',
          ruleSetId: rules.id,
          startsOn: '2026-11-16',
          endsOn: '2027-01-25',
        }),
        201,
      );
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
          criteria: { ageBand: { minAge: 18, maxAge: null } },
        }),
        201,
      );
      const enter = async (name: string) => {
        const captain = await adult(t);
        const created = await ok<{ entry: { id: string; revision: number } }>(
          post(t, '/v1/team-entries', captain.header, { seasonId: season.id, team: { name } }),
          201,
        );
        await ok(
          post(t, `/v1/team-entries/${created.entry.id}/approve`, lm.header, {
            divisionId: division.id,
            expectedRevision: created.entry.revision,
          }),
        );
        return created.entry.id;
      };
      const comets = await enter('Comets');
      const rockets = await enter('Rockets');
      const start = Date.parse('2026-11-17T03:00:00Z');
      const game = await ok<{ fixture: { id: string } }>(
        post(t, '/v1/fixtures', lm.header, {
          seasonId: season.id,
          divisionId: division.id,
          round: 1,
          homeEntryId: comets,
          awayEntryId: rockets,
          schedule: {
            facilityId: t.facilityId,
            resourceIds: [field.resourceId],
            scheduledStart: new Date(start).toISOString(),
            scheduledEnd: new Date(start + HOUR).toISOString(),
          },
        }),
        201,
      );
      t.clock.set(new Date(start + HOUR + 300_000));
      const result = await ok<{ id: string; revision: number }>(
        post(t, `/v1/fixtures/${game.fixture.id}/results`, lm.header, {
          classification: 'completed',
          homeScore: 5,
          awayScore: 3,
        }),
        201,
      );
      await ok(
        post(t, `/v1/results/${result.id}/publish`, lm.header, {
          expectedRevision: result.revision,
        }),
      );
      await drain(t);

      // Private until staff publish it: nothing public exists yet, and the staff route needs
      // sign-in whatever the competition's visibility.
      const standings = `/v1/seasons/${season.id}/standings?divisionId=${division.id}`;
      expect((await get(t, standings)).status).toBe(401);
      const publication = `/v1/competitions/${competition.id}/publication`;
      const before = await ok<Json & { revision: number }>(get(t, publication, lm.header));
      expect(before).toMatchObject({ visibility: 'private', publicCode: null });
      const published = await ok<{ publicCode: string; seasons: Array<{ publicCode: string }> }>(
        post(t, `/v1/competitions/${competition.id}/publish`, lm.header, {
          expectedRevision: before.revision,
        }),
      );
      const seasonCode = published.seasons[0]?.publicCode as string;

      // No sign-in: the season's fixtures, results and standings by public code.
      const view = await ok<{ divisions: Array<{ fixtures: Json[]; standings: Json[] }> }>(
        get(t, `/v1/public/${organization.slug}/seasons/${seasonCode}`),
      );
      expect(view).toMatchObject({ competitionName: 'Monday Men Open', seasonName: 'Winter 2026' });
      expect(view.divisions[0]?.fixtures).toEqual([
        expect.objectContaining({
          home: 'Comets',
          away: 'Rockets',
          status: 'played',
          score: { home: 5, away: 3 },
          fields: ['Field 1'],
        }),
      ]);
      expect(view.divisions[0]?.standings).toEqual([
        expect.objectContaining({ position: 1, team: 'Comets', played: 1, won: 1, points: 3 }),
        expect.objectContaining({ position: 2, team: 'Rockets', played: 1, lost: 1, points: 0 }),
      ]);
      // The record ids open nothing publicly, and the staff route still answers 401.
      expect((await get(t, `/v1/public/${organization.slug}/seasons/${season.id}`)).status).toBe(
        404,
      );
      expect((await get(t, standings)).status).toBe(401);

      // The lobby schedule of the day, by field: the scheduler enables the facility's view.
      const scheduler = await staff(t, ['scheduler']);
      const lobby = await ok<{ publicCode: string }>(
        post(t, `/v1/facilities/${t.facilityId}/public-schedule-view/enable`, scheduler.header),
      );
      const day = await ok<{ entries: Json[]; fields: string[] }>(
        get(t, `/v1/public/${organization.slug}/schedule/${lobby.publicCode}?date=2026-11-16`),
      );
      expect(day.fields).toEqual(['Field 1']);
      expect(day.entries).toEqual([
        {
          startsAt: new Date(start).toISOString(),
          endsAt: new Date(start + HOUR).toISOString(),
          fields: ['Field 1'],
          kind: 'game',
          title: 'Comets vs Rockets',
          score: { home: 5, away: 3 },
        },
      ]);
    } finally {
      await t.close();
    }
  });
});
