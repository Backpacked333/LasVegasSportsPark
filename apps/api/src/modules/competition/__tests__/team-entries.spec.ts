import { json, seedOrganization } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthorizationService } from '../../../kernel';
import { customerPrincipal, type TestApp } from '../../../testing';
import { createPersonFixture } from '../../identity';
import { CompetitionActions } from '../competition.actions';
import { proposedRuleSetContent } from '../competition.policy';
import { TeamAuthority } from '../services/team-authority.service';
import {
  addRosterMemberFixture,
  assignTeamRoleFixture,
  createDivisionFixture,
  createSeasonFixture,
  createTeamEntryFixture,
  type SeasonFixture,
} from '../testing/competition-fixtures';
import { adultCustomer, competitionTestApp, key, staffMember, type Actor } from './support';

describe('team entries (SPK-COMP-004, SPK-CAP-001, SPK-CAP-005, SPK-AT-002, SPK-AT-003)', () => {
  let t: TestApp;
  let leagueManager: Actor;
  let frontDesk: Actor;
  let captain: Actor;
  let season: SeasonFixture;
  let teamAuthority: TeamAuthority;

  beforeAll(async () => {
    t = await competitionTestApp();
    leagueManager = await staffMember(t, ['league_manager']);
    frontDesk = await staffMember(t, ['front_desk']);
    captain = await adultCustomer(t);
    season = await createSeasonFixture(t, { status: 'open' });
    teamAuthority = t.app.get(TeamAuthority);
  });
  afterAll(async () => {
    await t.close();
  });

  const post = (path: string, actor: Actor, body: object, k: string = key()) =>
    t.http.post(`/v1${path}`).set(actor.header).set('Idempotency-Key', k).send(body);

  it('SPK-AT-002 / SPK-CAP-001: a captain creates an authorized team entry; approval, finance, roster and eligibility stay distinct (SPK-COMP-004)', async () => {
    const res = await post('/team-entries', captain, {
      seasonId: season.seasonId,
      team: { name: 'Red Rockets', colors: { primary: 'red' } },
    });
    expect(res.status).toBe(201);
    expect(res.body.entry).toMatchObject({
      seasonId: season.seasonId,
      divisionId: null,
      status: 'applied',
      appliedByPersonId: captain.personId,
      financialStatusRef: null,
      eligibilityStatus: 'pending',
      rosterComplete: false,
      rosterCount: 0,
      rosterMin: season.ruleSet.rosterMin,
      rosterMax: season.ruleSet.rosterMax,
      renewedFromEntryId: null,
      revision: 1,
    });
    expect(res.body.team).toMatchObject({
      name: 'Red Rockets',
      colors: { primary: 'red' },
      createdByPersonId: captain.personId,
      status: 'active',
    });
    expect(res.body.suggestedPlayers).toEqual([]);
    const entryId = res.body.entry.id as string;
    // the captain role is a competition record, never a label (SPK-IAM-001)
    const roles = await t.db
      .selectFrom('team_roles')
      .select(['person_id', 'role', 'effective_to'])
      .where('team_entry_id', '=', entryId)
      .execute();
    expect(roles).toEqual([{ person_id: captain.personId, role: 'captain', effective_to: null }]);
    expect(
      await teamAuthority.hasTeamRole(t.organizationId, captain.personId, entryId, 'captain'),
    ).toBe(true);
    expect(
      await teamAuthority.hasTeamRole(t.organizationId, captain.personId, entryId, 'member'),
    ).toBe(true);
    expect(
      await teamAuthority.hasTeamRole(t.organizationId, frontDesk.personId, entryId, 'member'),
    ).toBe(false);
    // multi-step command: a durable operation records the outcome
    const operation = await t.db
      .selectFrom('operations')
      .selectAll()
      .where('id', '=', res.body.operationId)
      .executeTakeFirstOrThrow();
    expect(operation).toMatchObject({ kind: 'competition.create_team_entry', status: 'succeeded' });
    expect(operation.result).toMatchObject({
      teamEntryId: entryId,
      captainPersonId: captain.personId,
    });
    // follow-ups: team created, entry created (finance reacts, nothing is charged here), role assigned
    const events = await t.db
      .selectFrom('outbox_events')
      .select(['event_type', 'payload'])
      .where('aggregate_id', 'in', [entryId, res.body.team.id])
      .orderBy('occurred_at')
      .execute();
    expect(events.map((e) => e.event_type).sort()).toEqual([
      'competition.team_created',
      'competition.team_entry_created',
      'competition.team_role_changed',
    ]);
    const created = events.find((e) => e.event_type === 'competition.team_entry_created')
      ?.payload as Record<string, unknown>;
    expect(created).toMatchObject({
      teamEntryId: entryId,
      captainPersonId: captain.personId,
      renewedFromEntryId: null,
      registrationOfferingRef: null,
    });
    // replaying the command returns the same entry
    const replayKey = key();
    const first = await post(
      '/team-entries',
      captain,
      { seasonId: season.seasonId, team: { name: 'Replayed' } },
      replayKey,
    );
    const second = await post(
      '/team-entries',
      captain,
      { seasonId: season.seasonId, team: { name: 'Replayed' } },
      replayKey,
    );
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body.entry.id).toBe(first.body.entry.id);
  });

  it('a customer cannot name another captain, enter an existing team by id, or place the entry', async () => {
    const other = await adultCustomer(t);
    for (const body of [
      { seasonId: season.seasonId, team: { name: 'X' }, captainPersonId: other.personId },
      { seasonId: season.seasonId, teamId: other.personId },
      { seasonId: season.seasonId, team: { name: 'X' }, divisionId: other.personId },
    ]) {
      const res = await post('/team-entries', captain, body);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('ACCESS_DENIED');
    }
    const twoSources = await post('/team-entries', captain, {
      seasonId: season.seasonId,
      team: { name: 'X' },
      renewFromEntryId: other.personId,
    });
    expect(twoSources.status).toBe(400);
  });

  it('a customer may only enter a season whose registration is open; staff may enter a draft season for a named captain', async () => {
    const draft = await createSeasonFixture(t, { status: 'draft' });
    const denied = await post('/team-entries', captain, {
      seasonId: draft.seasonId,
      team: { name: 'Too early' },
    });
    expect(denied.status).toBe(422);
    expect(denied.body.code).toBe('ELIGIBILITY_FAILED');
    const windowed = await createSeasonFixture(t, {
      status: 'open',
      registrationOpensAt: new Date('2026-11-01T08:00:00Z'),
      registrationClosesAt: new Date('2026-12-01T08:00:00Z'),
    });
    const closed = await post('/team-entries', captain, {
      seasonId: windowed.seasonId,
      team: { name: 'Not yet' },
    });
    expect(closed.status).toBe(422);
    expect(closed.body.details).toMatchObject({ registrationOpensAt: '2026-11-01T08:00:00.000Z' });
    const staffEntry = await post('/team-entries', leagueManager, {
      seasonId: draft.seasonId,
      team: { name: 'Staff entered' },
      captainPersonId: captain.personId,
    });
    expect(staffEntry.status).toBe(201);
    expect(staffEntry.body.entry.appliedByPersonId).toBe(leagueManager.personId);
    const roles = await t.db
      .selectFrom('team_roles')
      .select('person_id')
      .where('team_entry_id', '=', staffEntry.body.entry.id)
      .execute();
    expect(roles).toEqual([{ person_id: captain.personId }]);
    const completed = await createSeasonFixture(t, { status: 'completed' });
    const late = await post('/team-entries', leagueManager, {
      seasonId: completed.seasonId,
      team: { name: 'Too late' },
      captainPersonId: captain.personId,
    });
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('INVALID_TRANSITION');
    // a child cannot be named captain (proposed default pending the child-account decision)
    const child = await createPersonFixture(t, { kind: 'child' });
    const childCaptain = await post('/team-entries', leagueManager, {
      seasonId: season.seasonId,
      team: { name: 'Kids' },
      captainPersonId: child,
    });
    expect(childCaptain.status).toBe(400);
  });

  it('§4.7 (2): a team has one live entry per season', async () => {
    const owner = await adultCustomer(t);
    const first = await post('/team-entries', owner, {
      seasonId: season.seasonId,
      team: { name: 'Twice' },
    });
    expect(first.status).toBe(201);
    const again = await post('/team-entries', leagueManager, {
      seasonId: season.seasonId,
      teamId: first.body.team.id,
      captainPersonId: owner.personId,
    });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('DUPLICATE_ENTITLEMENT');
  });

  it('SPK-COMP-004: the league manager approves and places an entry; the lifecycle and revision are guarded', async () => {
    const owner = await adultCustomer(t);
    const created = await post('/team-entries', owner, {
      seasonId: season.seasonId,
      team: { name: 'Approve me' },
    });
    const entryId = created.body.entry.id as string;
    const division = await createDivisionFixture(t, {
      seasonId: season.seasonId,
      capacityTeamEntries: 1,
    });

    const byFrontDesk = await post(`/team-entries/${entryId}/approve`, frontDesk, {
      expectedRevision: 1,
    });
    expect(byFrontDesk.status).toBe(403);
    const byCaptain = await post(`/team-entries/${entryId}/approve`, owner, {
      expectedRevision: 1,
    });
    expect(byCaptain.status).toBe(403);
    const stale = await post(`/team-entries/${entryId}/approve`, leagueManager, {
      expectedRevision: 7,
      divisionId: division,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVISION');
    const approved = await post(`/team-entries/${entryId}/approve`, leagueManager, {
      expectedRevision: 1,
      divisionId: division,
      note: 'welcome',
    });
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({
      status: 'approved',
      divisionId: division,
      approvalNote: 'welcome',
      revision: 2,
      financialStatusRef: null,
      rosterComplete: false,
    });
    expect(approved.body.approvedAt).toBe('2026-10-23T12:00:00.000Z');
    const twice = await post(`/team-entries/${entryId}/approve`, leagueManager, {
      expectedRevision: 2,
    });
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe('INVALID_TRANSITION');
    const reject = await post(`/team-entries/${entryId}/reject`, leagueManager, {
      expectedRevision: 2,
      reason: 'changed my mind',
    });
    expect(reject.status).toBe(409);
    expect(reject.body.code).toBe('INVALID_TRANSITION');
    const status = await t.db
      .selectFrom('outbox_events')
      .select('payload')
      .where('aggregate_id', '=', entryId)
      .where('event_type', '=', 'competition.team_entry_status_changed')
      .execute();
    expect(status.map((s) => s.payload)).toEqual([
      expect.objectContaining({
        status: 'approved',
        previousStatus: 'applied',
        divisionId: division,
      }),
    ]);

    // §4.7 (3): the division is full
    const second = await adultCustomer(t);
    const other = await post('/team-entries', second, {
      seasonId: season.seasonId,
      team: { name: 'No room' },
    });
    const full = await post(`/team-entries/${other.body.entry.id}/approve`, leagueManager, {
      expectedRevision: 1,
      divisionId: division,
    });
    expect(full.status).toBe(409);
    expect(full.body.code).toBe('CAPACITY_UNAVAILABLE');
    const unchanged = await t.db
      .selectFrom('team_entries')
      .select(['status', 'division_id', 'revision'])
      .where('id', '=', other.body.entry.id)
      .executeTakeFirstOrThrow();
    expect(unchanged).toEqual({ status: 'applied', division_id: null, revision: 1 });
    // without a division the approval goes through
    const placedLater = await post(`/team-entries/${other.body.entry.id}/approve`, leagueManager, {
      expectedRevision: 1,
    });
    expect(placedLater.status).toBe(200);
  });

  it('withdraw and reject: the captain withdraws by team role, a stranger is told not-found (§4.10), staff reject with a reason', async () => {
    const owner = await adultCustomer(t);
    const stranger = await adultCustomer(t);
    const created = await post('/team-entries', owner, {
      seasonId: season.seasonId,
      team: { name: 'Leaving' },
    });
    const entryId = created.body.entry.id as string;
    const byStranger = await post(`/team-entries/${entryId}/withdraw`, stranger, {
      expectedRevision: 1,
      reason: 'not mine',
    });
    expect(byStranger.status).toBe(404);
    const withdrawn = await post(`/team-entries/${entryId}/withdraw`, owner, {
      expectedRevision: 1,
      reason: 'not enough players',
    });
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body).toMatchObject({
      status: 'withdrawn',
      withdrawalReason: 'not enough players',
      revision: 2,
    });
    const approveWithdrawn = await post(`/team-entries/${entryId}/approve`, leagueManager, {
      expectedRevision: 2,
    });
    expect(approveWithdrawn.status).toBe(409);
    // an approved entry may withdraw too, and keeps its approval as history
    const approvedThenGone = await post('/team-entries', owner, {
      seasonId: season.seasonId,
      team: { name: 'Approved then gone' },
    });
    await post(`/team-entries/${approvedThenGone.body.entry.id}/approve`, leagueManager, {
      expectedRevision: 1,
    });
    const gone = await post(`/team-entries/${approvedThenGone.body.entry.id}/withdraw`, owner, {
      expectedRevision: 2,
      reason: 'moving away',
    });
    expect(gone.status).toBe(200);
    expect(gone.body).toMatchObject({
      status: 'withdrawn',
      approvedAt: '2026-10-23T12:00:00.000Z',
      withdrawnAt: '2026-10-23T12:00:00.000Z',
    });

    const second = await post('/team-entries', owner, {
      seasonId: season.seasonId,
      team: { name: 'Rejected' },
    });
    const rejected = await post(`/team-entries/${second.body.entry.id}/reject`, leagueManager, {
      expectedRevision: 1,
      reason: 'incomplete application',
    });
    expect(rejected.status).toBe(200);
    expect(rejected.body).toMatchObject({
      status: 'rejected',
      rejectionReason: 'incomplete application',
    });
    const noReason = await post(`/team-entries/${second.body.entry.id}/reject`, leagueManager, {
      expectedRevision: 2,
    });
    expect(noReason.status).toBe(400);
  });

  it('SPK-AT-003 / SPK-CAP-005: renewal creates new season records, suggests prior players, re-evaluates everything, charges nothing and leaves prior rows byte-identical', async () => {
    const owner = await adultCustomer(t);
    const p1 = await createPersonFixture(t, { kind: 'adult' });
    const p2 = await createPersonFixture(t, { kind: 'adult' });
    const prior = await createSeasonFixture(t, {
      status: 'completed',
      startsOn: '2026-01-10',
      endsOn: '2026-04-10',
    });
    const priorEntry = await createTeamEntryFixture(t, {
      seasonId: prior.seasonId,
      captainPersonId: owner.personId,
      teamName: 'Evergreens',
      financialStatusRef: 'obligation:2026',
    });
    await addRosterMemberFixture(t, {
      teamEntryId: priorEntry.teamEntryId,
      personId: p1,
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    });
    const removed = await addRosterMemberFixture(t, {
      teamEntryId: priorEntry.teamEntryId,
      personId: p2,
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    });
    await t.db
      .updateTable('roster_memberships')
      .set({
        status: 'removed',
        status_before_removal: 'active',
        effective_to: new Date('2026-03-01T00:00:00Z'),
        removed_at: new Date('2026-03-01T00:00:00Z'),
        removed_by: json({ kind: 'system' }),
        removal_reason: 'moved away',
      })
      .where('id', '=', removed)
      .execute();
    const snapshot = async () => ({
      entry: await t.db
        .selectFrom('team_entries')
        .selectAll()
        .where('id', '=', priorEntry.teamEntryId)
        .execute(),
      roster: await t.db
        .selectFrom('roster_memberships')
        .selectAll()
        .where('team_entry_id', '=', priorEntry.teamEntryId)
        .orderBy('id')
        .execute(),
      roles: await t.db
        .selectFrom('team_roles')
        .selectAll()
        .where('team_entry_id', '=', priorEntry.teamEntryId)
        .orderBy('id')
        .execute(),
      team: await t.db
        .selectFrom('teams')
        .selectAll()
        .where('id', '=', priorEntry.teamId)
        .execute(),
    });
    const before = JSON.stringify(await snapshot());

    const stranger = await adultCustomer(t);
    const notMine = await post('/team-entries', stranger, {
      seasonId: season.seasonId,
      renewFromEntryId: priorEntry.teamEntryId,
    });
    expect(notMine.status).toBe(404);

    const renewed = await post('/team-entries', owner, {
      seasonId: season.seasonId,
      renewFromEntryId: priorEntry.teamEntryId,
    });
    expect(renewed.status).toBe(201);
    expect(renewed.body.team.id).toBe(priorEntry.teamId);
    expect(renewed.body.team.name).toBe('Evergreens');
    expect(renewed.body.renewedFromEntryId).toBe(priorEntry.teamEntryId);
    expect(renewed.body.entry).toMatchObject({
      seasonId: season.seasonId,
      status: 'applied',
      renewedFromEntryId: priorEntry.teamEntryId,
      // nothing carries over automatically: no obligation, no roster, no approval
      financialStatusRef: null,
      rosterCount: 0,
      rosterComplete: false,
      divisionId: null,
    });
    expect(renewed.body.entry.id).not.toBe(priorEntry.teamEntryId);
    const suggested = (
      renewed.body.suggestedPlayers as Array<{
        personId: string;
        lastStatus: string;
        lastEffectiveTo: string | null;
      }>
    ).sort((a, b) => a.personId.localeCompare(b.personId));
    expect(suggested).toEqual(
      [
        {
          personId: p1,
          lastStatus: 'active',
          lastEffectiveTo: null,
          displayName: expect.any(String),
        },
        {
          personId: p2,
          lastStatus: 'active',
          lastEffectiveTo: '2026-03-01T00:00:00.000Z',
          displayName: expect.any(String),
        },
      ].sort((a, b) => a.personId.localeCompare(b.personId)),
    );
    const newRoster = await t.db
      .selectFrom('roster_memberships')
      .select('id')
      .where('team_entry_id', '=', renewed.body.entry.id)
      .execute();
    expect(newRoster).toEqual([]);
    const operation = await t.db
      .selectFrom('operations')
      .select(['kind', 'status'])
      .where('id', '=', renewed.body.operationId)
      .executeTakeFirstOrThrow();
    expect(operation).toEqual({ kind: 'competition.renew_team_entry', status: 'succeeded' });
    const created = await t.db
      .selectFrom('outbox_events')
      .select('payload')
      .where('aggregate_id', '=', renewed.body.entry.id)
      .where('event_type', '=', 'competition.team_entry_created')
      .executeTakeFirstOrThrow();
    expect(created.payload).toMatchObject({
      renewedFromEntryId: priorEntry.teamEntryId,
      teamId: priorEntry.teamId,
    });
    expect(JSON.stringify(await snapshot())).toBe(before);
    // the prior season's participation is untouched and still readable as history
    const priorRoster = await t.db
      .selectFrom('roster_memberships')
      .select(['person_id', 'status'])
      .where('team_entry_id', '=', priorEntry.teamEntryId)
      .orderBy('person_id')
      .execute();
    expect(priorRoster).toHaveLength(2);
  });

  it('SPK-CAP-001 / SPK-CAP-002: the workspace shows readiness indicators to captains, a limited view to players, nothing to strangers or other organizations', async () => {
    const owner = await adultCustomer(t);
    const player = await adultCustomer(t, { dateOfBirth: '1990-05-05' });
    const stranger = await adultCustomer(t);
    const created = await post('/team-entries', owner, {
      seasonId: season.seasonId,
      team: { name: 'Workspace' },
    });
    const entryId = created.body.entry.id as string;
    await addRosterMemberFixture(t, {
      teamEntryId: entryId,
      personId: player.personId,
      jerseyNumber: 7,
    });

    const asCaptain = await t.http.get(`/v1/team-entries/${entryId}`).set(owner.header);
    expect(asCaptain.status).toBe(200);
    expect(asCaptain.body.entry.id).toBe(entryId);
    expect(asCaptain.body.team.name).toBe('Workspace');
    expect(asCaptain.body.season).toMatchObject({ id: season.seasonId, status: 'open' });
    expect(asCaptain.body.ruleSet).toMatchObject({ id: season.ruleSetId, version: 1 });
    expect(asCaptain.body.roles).toEqual([
      expect.objectContaining({ personId: owner.personId, role: 'captain', effectiveTo: null }),
    ]);
    expect(asCaptain.body.readiness).toMatchObject({
      approval: 'applied',
      financialStatusRef: null,
      rosterCount: 1,
      rosterMin: season.ruleSet.rosterMin,
      rosterComplete: false,
      eligiblePlayers: 1,
      pendingInvitations: 0,
      pendingJoinRequests: 0,
    });
    const codes = asCaptain.body.readiness.issues.map(
      (i: { code: string; severity: string; responsibleRole: string }) => [
        i.code,
        i.severity,
        i.responsibleRole,
      ],
    );
    expect(codes).toEqual(
      expect.arrayContaining([
        ['entry_not_approved', 'blocking', 'league_manager'],
        ['financial_status_unknown', 'unknown', 'finance_operator'],
        ['roster_below_minimum', 'blocking', 'captain'],
      ]),
    );
    // readiness indicators only: a display name and codes, no date of birth, contacts or family details
    const member = asCaptain.body.roster.find(
      (m: { personId: string }) => m.personId === player.personId,
    );
    expect(member).toMatchObject({
      status: 'active',
      jerseyNumber: 7,
      personKind: 'adult',
      eligibility: { status: 'eligible', blocking: 0 },
    });
    expect(member.displayName).toEqual(expect.any(String));
    expect(Object.keys(member)).not.toEqual(
      expect.arrayContaining(['dateOfBirth', 'contactPoints', 'household']),
    );
    expect(JSON.stringify(asCaptain.body)).not.toContain('1990-05-05');
    expect(asCaptain.body.pendingInvitations).toEqual([]);
    expect(asCaptain.body.upcomingFixtures).toEqual([]);

    const asPlayer = await t.http.get(`/v1/team-entries/${entryId}`).set(player.header);
    expect(asPlayer.status).toBe(200);
    expect(asPlayer.body.readiness.rosterCount).toBe(1);
    expect((await t.http.get(`/v1/team-entries/${entryId}`).set(stranger.header)).status).toBe(404);
    expect((await t.http.get(`/v1/team-entries/${entryId}`).set(frontDesk.header)).status).toBe(
      200,
    );
    const other = await seedOrganization(t.db);
    const otherManager = await staffMember(t, ['league_manager'], other.organizationId);
    expect((await t.http.get(`/v1/team-entries/${entryId}`).set(otherManager.header)).status).toBe(
      404,
    );
    // the staff list of a season shows what is missing (SPK-COMP-004); customers never list a season's entries
    const list = await t.http
      .get('/v1/team-entries')
      .set(frontDesk.header)
      .query({ seasonId: season.seasonId, status: 'applied' });
    expect(list.status).toBe(200);
    expect(list.body.map((e: { id: string }) => e.id)).toContain(entryId);
    expect(
      (await t.http.get('/v1/team-entries').set(owner.header).query({ seasonId: season.seasonId }))
        .status,
    ).toBe(403);
    // the continuing team identity is readable by its captain and editable through the captain role (§4.5)
    const team = await t.http.get(`/v1/teams/${created.body.team.id}`).set(owner.header);
    expect(team.status).toBe(200);
    const renamed = await t.http
      .patch(`/v1/teams/${created.body.team.id}`)
      .set(owner.header)
      .set('Idempotency-Key', key())
      .send({ name: 'Workspace FC', colors: { primary: 'green' }, expectedRevision: 1 });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({
      name: 'Workspace FC',
      colors: { primary: 'green' },
      revision: 2,
    });
    expect(
      (await t.http.get(`/v1/teams/${created.body.team.id}`).set(stranger.header)).status,
    ).toBe(404);
  });

  it('TEAM_AUTHORITY_IMPL: downward hierarchy, co-captain policy from the rule set, ended roles, and the kernel authorization path', async () => {
    const owner = await createPersonFixture(t, { kind: 'adult' });
    const coCaptain = await createPersonFixture(t, { kind: 'adult' });
    const entry = await createTeamEntryFixture(t, {
      seasonId: season.seasonId,
      captainPersonId: owner,
    });
    const roleId = await assignTeamRoleFixture(t, {
      teamEntryId: entry.teamEntryId,
      personId: coCaptain,
      role: 'co_captain',
    });
    const org = t.organizationId;
    expect(await teamAuthority.hasTeamRole(org, coCaptain, entry.teamEntryId, 'member')).toBe(true);
    expect(await teamAuthority.hasTeamRole(org, coCaptain, entry.teamEntryId, 'co_captain')).toBe(
      true,
    );
    // proposed default (DEC-002): a co-captain does not satisfy captain checks
    expect(await teamAuthority.hasTeamRole(org, coCaptain, entry.teamEntryId, 'captain')).toBe(
      false,
    );
    expect(await teamAuthority.hasTeamRole(org, owner, entry.teamEntryId, 'co_captain')).toBe(true);

    const permissive = await createSeasonFixture(t, {
      ruleSet: {
        roster: {
          ...proposedRuleSetContent('small_sided_other').roster,
          coCaptainMayActAsCaptain: true,
        },
      },
    });
    const entry2 = await createTeamEntryFixture(t, {
      seasonId: permissive.seasonId,
      captainPersonId: owner,
    });
    await assignTeamRoleFixture(t, {
      teamEntryId: entry2.teamEntryId,
      personId: coCaptain,
      role: 'co_captain',
    });
    expect(await teamAuthority.hasTeamRole(org, coCaptain, entry2.teamEntryId, 'captain')).toBe(
      true,
    );

    // an ended role confers nothing; a future role nothing yet
    // half-open window: a role ended at the clock instant is no longer effective at it
    await t.db
      .updateTable('team_roles')
      .set({ effective_to: new Date('2026-10-23T12:00:00Z') })
      .where('id', '=', roleId)
      .execute();
    expect(await teamAuthority.hasTeamRole(org, coCaptain, entry.teamEntryId, 'member')).toBe(
      false,
    );
    const future = await createPersonFixture(t, { kind: 'adult' });
    await assignTeamRoleFixture(t, {
      teamEntryId: entry.teamEntryId,
      personId: future,
      role: 'member',
      effectiveFrom: new Date('2026-11-01T00:00:00Z'),
    });
    expect(await teamAuthority.hasTeamRole(org, future, entry.teamEntryId, 'member')).toBe(false);
    t.clock.set('2026-11-02T00:00:00Z');
    expect(await teamAuthority.hasTeamRole(org, future, entry.teamEntryId, 'member')).toBe(true);
    t.clock.set('2026-10-23T12:00:00Z');

    // the kernel resolves the registered implementation at call time (captain of A has nothing on B)
    const authorization = t.app.get(AuthorizationService);
    const principal = customerPrincipal(org, { personId: owner });
    const onA = await authorization.decide(principal, CompetitionActions.manageRoster, {
      type: 'team_entry',
      organizationId: org,
      teamEntryId: entry.teamEntryId,
    });
    expect(onA).toEqual({ allowed: true, basis: 'team_role:captain' });
    const otherEntry = await createTeamEntryFixture(t, {
      seasonId: season.seasonId,
      captainPersonId: coCaptain,
    });
    const onB = await authorization.decide(principal, CompetitionActions.manageRoster, {
      type: 'team_entry',
      organizationId: org,
      teamEntryId: otherEntry.teamEntryId,
      protected: true,
    });
    expect(onB).toMatchObject({ allowed: false, protectedRecord: true });
  });
});
