import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import {
  ROSTER_PORT,
  addRosterMemberFixture,
  createDivisionFixture,
  createSeasonFixture,
  createTeamEntryFixture,
  type RosterPort,
} from '../../competition';
import { adult, enrollmentTestApp, post, staff, type Actor } from './support';

describe('free-agent placement (SPK-PLACE-001..005, PlacementMachine)', () => {
  let t: TestApp;
  let leagueManager: Actor;
  let programManager: Actor;
  let seasonId: string;
  let openEntry: string;
  let smallEntry: string;
  let veteransEntry: string;
  let captain: Actor;
  let teammate: string;
  let roster: RosterPort;

  beforeAll(async () => {
    t = await enrollmentTestApp();
    leagueManager = await staff(t, ['league_manager']);
    programManager = await staff(t, ['program_manager']);
    roster = t.app.get(ROSTER_PORT);
    seasonId = (await createSeasonFixture(t)).seasonId;
    captain = await adult(t);
    openEntry = (
      await createTeamEntryFixture(t, {
        seasonId,
        captainPersonId: captain.personId,
        teamName: 'Aardvarks',
      })
    ).teamEntryId;
    smallEntry = (
      await createTeamEntryFixture(t, {
        seasonId,
        captainPersonId: (await adult(t)).personId,
        teamName: 'Badgers',
      })
    ).teamEntryId;
    const veterans = await createDivisionFixture(t, {
      seasonId,
      criteria: { ageBand: { minAge: 35, maxAge: null } },
    });
    veteransEntry = (
      await createTeamEntryFixture(t, {
        seasonId,
        captainPersonId: (await adult(t, { dateOfBirth: '1980-01-01' })).personId,
        divisionId: veterans,
        teamName: 'Veterans',
      })
    ).teamEntryId;
    teammate = (await adult(t)).personId;
    await addRosterMemberFixture(t, { teamEntryId: smallEntry, personId: teammate });
    // The small team has one enrollment-side roster place left (SPK-REG-005 roster places).
    const pool = await post(t, '/v1/capacity-pools', programManager.header, {
      scopeType: 'team_entry',
      scopeId: smallEntry,
      unit: 'roster_places',
      capacity: 1,
    });
    expect(pool.status).toBe(201);
  });
  afterAll(async () => {
    await t.close();
  });

  async function request(player: Actor, extra: Record<string, unknown> = {}) {
    const res = await post(t, '/v1/placement-requests', player.header, {
      participantPersonId: player.personId,
      seasonId,
      availability: [{ weekday: 2, from: '18:00', to: '22:00' }],
      declaredLevel: 'intermediate',
      positionPreferences: ['goalkeeper'],
      ...extra,
    });
    expect(res.status).toBe(201);
    return res.body as { id: string; revision: number };
  }

  it('SPK-PLACE-001/005: approved placement information is recorded and never public', async () => {
    const player = await adult(t, { dateOfBirth: '1999-03-03' });
    const created = await post(t, '/v1/placement-requests', player.header, {
      participantPersonId: player.personId,
      seasonId,
      availability: [{ weekday: 2, from: '18:00', to: '22:00' }],
      declaredLevel: 'intermediate',
      positionPreferences: ['defender'],
      requestedTeammatePersonIds: [teammate],
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      status: 'unassigned',
      declaredLevel: 'intermediate',
      positionPreferences: ['defender'],
      requestedTeammatePersonIds: [teammate],
    });
    const id = created.body.id as string;
    // A captain looking for players, another customer, or the public cannot see free agents.
    expect(
      (await t.http.get(`/v1/placement-requests?seasonId=${seasonId}`).set(captain.header)).status,
    ).toBe(403);
    expect((await t.http.get(`/v1/placement-requests/${id}`).set(captain.header)).status).toBe(404);
    expect((await t.http.get(`/v1/placement-requests/${id}`)).status).toBe(401);
    expect(
      (await t.http.get(`/v1/placement-requests/${id}/candidates`).set(captain.header)).status,
    ).toBe(403);
    expect((await t.http.get(`/v1/placement-requests/${id}`).set(player.header)).status).toBe(200);
    const listed = await t.http
      .get(`/v1/placement-requests?seasonId=${seasonId}`)
      .set(leagueManager.header);
    expect(listed.body.items.map((r: { id: string }) => r.id)).toContain(id);
    // One live request per participant and season.
    const twice = await post(t, '/v1/placement-requests', player.header, {
      participantPersonId: player.personId,
      seasonId,
    });
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe('DUPLICATE_ENTITLEMENT');
  });

  it('SPK-PLACE-002/003: candidates carry explainable reasons, and a recommendation reserves nothing', async () => {
    const player = await adult(t, { dateOfBirth: '1999-03-03' });
    const req = await request(player, { requestedTeammatePersonIds: [teammate] });
    const res = await t.http
      .get(`/v1/placement-requests/${req.id}/candidates`)
      .set(leagueManager.header);
    expect(res.status).toBe(200);
    const byName = new Map<
      string,
      {
        eligible: boolean;
        recommended: boolean;
        reasons: Array<{ code: string; severity: string }>;
        capacity: unknown;
        requestedTeammatesOnRoster: number;
      }
    >(res.body.map((c: { teamName: string }) => [c.teamName, c]));
    expect(byName.get('Badgers')).toMatchObject({
      eligible: true,
      recommended: true,
      requestedTeammatesOnRoster: 1,
      capacity: { available: 1, capacity: 1 },
    });
    expect(byName.get('Badgers')!.reasons.map((r) => r.code)).toContain(
      'requested_teammates_on_roster',
    );
    expect(byName.get('Aardvarks')).toMatchObject({
      eligible: true,
      recommended: false,
      capacity: null,
    });
    const veterans = byName.get('Veterans')!;
    expect(veterans.eligible).toBe(false);
    expect(veterans.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'below_division_age', severity: 'blocking' }),
      ]),
    );
    expect(res.body[0].teamName).toBe('Badgers');
    const pool = await t.db
      .selectFrom('capacity_pools')
      .select(['held', 'committed'])
      .where('scope_id', '=', smallEntry)
      .executeTakeFirstOrThrow();
    expect(pool).toEqual({ held: 0, committed: 0 });
    expect(
      (await t.http.get(`/v1/placement-requests/${req.id}/candidates`).set(programManager.header))
        .status,
    ).toBe(403);
  });

  it('PlacementMachine: propose, reject, propose again, assign through the competition roster, release', async () => {
    const player = await adult(t, { dateOfBirth: '1999-03-03' });
    const req = await request(player);
    const proposed = await post(
      t,
      `/v1/placement-requests/${req.id}/propose`,
      leagueManager.header,
      {
        teamEntryId: openEntry,
        expectedRevision: 1,
      },
    );
    expect(proposed.status).toBe(200);
    expect(proposed.body).toMatchObject({ status: 'proposed', proposedTeamEntryId: openEntry });
    expect(proposed.body.proposalReasons.length).toBeGreaterThan(0);
    // A proposal reserves nothing and adds nobody to the roster (SPK-PLACE-003).
    expect(
      (await roster.effectiveRoster(t.organizationId, openEntry, t.clock.now())).map(
        (m) => m.personId,
      ),
    ).not.toContain(player.personId);
    const rejected = await post(
      t,
      `/v1/placement-requests/${req.id}/reject-proposal`,
      leagueManager.header,
      {
        expectedRevision: 2,
        reason: 'Captain prefers a midfielder',
      },
    );
    expect(rejected.body.status).toBe('unassigned');
    const releaseEarly = await post(
      t,
      `/v1/placement-requests/${req.id}/release`,
      leagueManager.header,
      {
        expectedRevision: 3,
        reason: 'n/a',
      },
    );
    expect(releaseEarly.status).toBe(409);
    expect(releaseEarly.body.code).toBe('INVALID_TRANSITION');
    await post(t, `/v1/placement-requests/${req.id}/propose`, leagueManager.header, {
      teamEntryId: openEntry,
      expectedRevision: 3,
    });
    const assigned = await post(
      t,
      `/v1/placement-requests/${req.id}/assign`,
      leagueManager.header,
      { expectedRevision: 4 },
    );
    expect(assigned.status).toBe(200);
    expect(assigned.body).toMatchObject({
      status: 'assigned',
      assignedTeamEntryId: openEntry,
      decidedByPersonId: leagueManager.personId,
    });
    expect(assigned.body.rosterMembershipRef).toEqual(expect.any(String));
    expect(assigned.body.decisionReasons.map((r: { code: string }) => r.code)).toContain(
      'capacity_checked',
    );
    const members = await roster.effectiveRoster(t.organizationId, openEntry, t.clock.now());
    expect(members.find((m) => m.personId === player.personId)).toMatchObject({
      membershipId: assigned.body.rosterMembershipRef,
      status: 'active',
    });
    const operation = await t.http
      .get(`/v1/operations/${assigned.body.lastOperationId as string}`)
      .set(leagueManager.header);
    expect(operation.body).toMatchObject({
      kind: 'enrollment.assign_placement',
      status: 'succeeded',
    });
    const released = await post(
      t,
      `/v1/placement-requests/${req.id}/release`,
      leagueManager.header,
      {
        expectedRevision: assigned.body.revision,
        reason: 'Player moved away',
      },
    );
    expect(released.status).toBe(200);
    expect(released.body).toMatchObject({ status: 'released', releaseReason: 'Player moved away' });
    t.clock.advance(1000);
    expect(
      (await roster.effectiveRoster(t.organizationId, openEntry, t.clock.now())).map(
        (m) => m.personId,
      ),
    ).not.toContain(player.personId);
  });

  it('SPK-PLACE-003: assignment checks capacity and current eligibility at commitment', async () => {
    const first = await adult(t, { dateOfBirth: '1999-03-03' });
    const second = await adult(t, { dateOfBirth: '1998-03-03' });
    const a = await request(first);
    const b = await request(second);
    const assigned = await post(t, `/v1/placement-requests/${a.id}/assign`, leagueManager.header, {
      teamEntryId: smallEntry,
      expectedRevision: 1,
    });
    expect(assigned.status).toBe(200);
    const allocation = await t.db
      .selectFrom('allocations')
      .selectAll()
      .where('placement_request_id', '=', a.id)
      .executeTakeFirstOrThrow();
    expect(allocation).toMatchObject({ status: 'active', quantity: 1 });
    const full = await post(t, `/v1/placement-requests/${b.id}/assign`, leagueManager.header, {
      teamEntryId: smallEntry,
      expectedRevision: 1,
    });
    expect(full.status).toBe(409);
    expect(full.body.code).toBe('CAPACITY_UNAVAILABLE');
    expect(
      (await roster.effectiveRoster(t.organizationId, smallEntry, t.clock.now())).map(
        (m) => m.personId,
      ),
    ).not.toContain(second.personId);
    const ineligible = await post(
      t,
      `/v1/placement-requests/${b.id}/assign`,
      leagueManager.header,
      { teamEntryId: veteransEntry, expectedRevision: 1 },
    );
    expect(ineligible.status).toBe(422);
    expect(ineligible.body.details.reasons).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'below_division_age' })]),
    );
    expect(
      (await t.http.get(`/v1/placement-requests/${b.id}`).set(leagueManager.header)).body.status,
    ).toBe('unassigned');
    // Program managers do not place league free agents (league administration does).
    expect(
      (
        await post(t, `/v1/placement-requests/${b.id}/assign`, programManager.header, {
          teamEntryId: openEntry,
          expectedRevision: 1,
        })
      ).status,
    ).toBe(403);
  });
});
