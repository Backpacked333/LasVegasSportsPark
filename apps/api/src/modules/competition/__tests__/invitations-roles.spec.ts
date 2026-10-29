import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import {
  createContactPointFixture,
  createPersonFixture,
  createRelationshipFixture,
} from '../../identity';
import { proposedRuleSetContent } from '../competition.policy';
import { TEAM_ENTRY_QUERY_PORT, type TeamEntryQueryPort } from '../ports';
import {
  addRosterMemberFixture,
  assignTeamRoleFixture,
  createSeasonFixture,
  createTeamEntryFixture,
  type SeasonFixture,
} from '../testing/competition-fixtures';
import {
  adultCustomer,
  CLOCK_START,
  competitionTestApp,
  key,
  staffMember,
  type Actor,
} from './support';

const NOW = new Date(CLOCK_START).toISOString();
const EXPIRY_JOB = 'competition.expire_team_invitations';

/**
 * Team invitation reads and decline (CMP-03), their background expiry (CMP-07), and the roster
 * rules of CMP-13: jersey number ranges and the captain/co-captain handover.
 */
describe('team invitations and team roles (CMP-03, CMP-07, CMP-13; SPK-CAP-001, SPK-COMP-005, §4.6, §4.10, §4.12)', () => {
  let t: TestApp;
  let leagueManager: Actor;
  let season: SeasonFixture;

  beforeAll(async () => {
    t = await competitionTestApp();
    leagueManager = await staffMember(t, ['league_manager']);
    season = await createSeasonFixture(t, { status: 'open', name: 'Spring league' });
  });
  afterAll(async () => {
    await t.close();
  });

  const post = (path: string, actor: Actor, body: object, k: string = key()) =>
    t.http.post(`/v1${path}`).set(actor.header).set('Idempotency-Key', k).send(body);
  const get = (path: string, actor: Actor) => t.http.get(`/v1${path}`).set(actor.header);

  async function teamOf(name: string, seasonId = season.seasonId) {
    const captain = await adultCustomer(t);
    const entry = await createTeamEntryFixture(t, {
      seasonId,
      captainPersonId: captain.personId,
      teamName: name,
    });
    await addRosterMemberFixture(t, { teamEntryId: entry.teamEntryId, personId: captain.personId });
    return { captain, ...entry };
  }

  async function invite(
    team: { teamEntryId: string; captain: Actor },
    body: Record<string, unknown>,
  ) {
    const res = await post(`/team-entries/${team.teamEntryId}/invitations`, team.captain, body);
    expect(res.status).toBe(201);
    return res.body as { id: string; token: string; rosterMembershipId: string | null };
  }

  const invitationRow = (id: string) =>
    t.db.selectFrom('team_invitations').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  const resolvedEvents = (id: string) =>
    t.db
      .selectFrom('outbox_events')
      .select('payload')
      .where('event_type', '=', 'competition.team_invitation_resolved')
      .where('aggregate_id', '=', id)
      .execute();

  // CMP-03 ---------------------------------------------------------------------------------------
  it('SPK-CAP-001: an invited player reads and declines a team invitation, which can then no longer be accepted', async () => {
    const team = await teamOf('Falcons');
    const player = await adultCustomer(t);
    const invited = await invite(team, { recipientPersonId: player.personId, message: 'Join us' });

    const mine = await get('/me/team-invitations', player);
    expect(mine.status).toBe(200);
    expect(mine.body.items).toHaveLength(1);
    const captainName = await t.db
      .selectFrom('persons')
      .select(['given_name', 'family_name'])
      .where('id', '=', team.captain.personId)
      .executeTakeFirstOrThrow();
    expect(mine.body.items[0]).toEqual({
      id: invited.id,
      teamEntryId: team.teamEntryId,
      teamName: 'Falcons',
      seasonName: 'Spring league',
      invitedBy: {
        personId: team.captain.personId,
        displayName: `${captainName.given_name} ${captainName.family_name}`,
      },
      message: 'Join us',
      status: 'pending',
      effectiveStatus: 'pending',
      expiresAt: expect.any(String),
      revision: 1,
    });
    // the token is never returned by a read
    expect(JSON.stringify(mine.body)).not.toContain(invited.token);
    const one = await get(`/team-invitations/${invited.id}`, player);
    expect(one.status).toBe(200);
    expect(JSON.stringify(one.body)).not.toContain(invited.token);

    const declined = await post(`/team-invitations/${invited.id}/decline`, player, {
      reason: 'Playing elsewhere this season',
    });
    expect(declined.status).toBe(200);
    expect(declined.body).toMatchObject({
      status: 'declined',
      effectiveStatus: 'declined',
      revision: 2,
    });
    const row = await invitationRow(invited.id);
    expect(row.status).toBe('declined');
    expect(new Date(row.declined_at as Date).toISOString()).toBe(NOW);
    // the invited placeholder leaves the roster
    const placeholder = await t.db
      .selectFrom('roster_memberships')
      .select('effective_to')
      .where('id', '=', invited.rosterMembershipId as string)
      .executeTakeFirstOrThrow();
    expect(placeholder.effective_to).not.toBeNull();
    expect((await resolvedEvents(invited.id)).map((e) => e.payload)).toEqual([
      {
        invitationId: invited.id,
        teamEntryId: team.teamEntryId,
        status: 'declined',
        personId: player.personId,
      },
    ]);
    const audit = await t.db
      .selectFrom('audit_records')
      .select(['action', 'reason'])
      .where('target_id', '=', invited.id)
      .where('action', '<>', 'competition.invite_player')
      .executeTakeFirstOrThrow();
    expect(audit).toEqual({
      action: 'competition.team_invitation_declined',
      reason: 'Playing elsewhere this season',
    });

    const accept = await post(`/team-invitations/${invited.id}/accept`, player, {
      token: invited.token,
    });
    expect(accept.status).toBe(409);
    expect(accept.body.code).toBe('INVALID_TRANSITION');
    const again = await post(`/team-invitations/${invited.id}/decline`, player, {});
    expect(again.status).toBe(409);
    // the default list is pending invitations; declined ones are asked for by status
    expect((await get('/me/team-invitations', player)).body.items).toEqual([]);
    expect(
      (await get('/me/team-invitations?status=declined', player)).body.items.map(
        (i: { id: string }) => i.id,
      ),
    ).toEqual([invited.id]);
  });

  it('CMP-03: an invitation addressed to a verified contact point is listed and declined by its holder; an unverified contact does not count', async () => {
    const team = await teamOf('Hawks');
    const holder = await adultCustomer(t);
    await createContactPointFixture(t, {
      personId: holder.personId,
      kind: 'email',
      value: 'keeper@example.test',
      verified: true,
    });
    const unverified = await adultCustomer(t);
    await createContactPointFixture(t, {
      personId: unverified.personId,
      kind: 'email',
      value: 'keeper@example.test',
      verified: false,
      isPrimary: false,
    });
    const invited = await invite(team, {
      recipientContact: { kind: 'email', value: 'keeper@example.test' },
    });
    expect(
      (await get('/me/team-invitations', holder)).body.items.map((i: { id: string }) => i.id),
    ).toEqual([invited.id]);
    expect((await get('/me/team-invitations', unverified)).body.items).toEqual([]);
    expect((await get(`/team-invitations/${invited.id}`, unverified)).status).toBe(404);
    expect((await post(`/team-invitations/${invited.id}/decline`, unverified, {})).status).toBe(
      404,
    );
    const declined = await post(`/team-invitations/${invited.id}/decline`, holder, {});
    expect(declined.status).toBe(200);
    expect(declined.body.status).toBe('declined');
  });

  it('CMP-03: a captain reads an invitation of their entry; a stranger gets NOT_FOUND', async () => {
    const team = await teamOf('Owls');
    const other = await teamOf('Ravens');
    const coCaptain = await adultCustomer(t);
    await assignTeamRoleFixture(t, {
      teamEntryId: team.teamEntryId,
      personId: coCaptain.personId,
      role: 'co_captain',
    });
    const player = await adultCustomer(t);
    const invited = await invite(team, { recipientPersonId: player.personId });
    expect((await get(`/team-invitations/${invited.id}`, team.captain)).status).toBe(200);
    expect((await get(`/team-invitations/${invited.id}`, coCaptain)).status).toBe(200);
    expect((await get(`/team-invitations/${invited.id}`, leagueManager)).status).toBe(200);
    const stranger = await adultCustomer(t);
    const hidden = await get(`/team-invitations/${invited.id}`, stranger);
    expect(hidden.status).toBe(404);
    expect(hidden.body.code).toBe('NOT_FOUND');
    expect((await get(`/team-invitations/${invited.id}`, other.captain)).status).toBe(404);
    // only the recipient declines: not a stranger, not the captain
    expect((await post(`/team-invitations/${invited.id}/decline`, stranger, {})).status).toBe(404);
    expect((await post(`/team-invitations/${invited.id}/decline`, team.captain, {})).status).toBe(
      404,
    );
    expect((await invitationRow(invited.id)).status).toBe('pending');

    // a guardian with register reads and declines for a child recipient; view alone is not enough
    const child = await createPersonFixture(t, { kind: 'child' });
    const guardian = await adultCustomer(t);
    const viewer = await adultCustomer(t);
    await createRelationshipFixture(t, {
      actorPersonId: guardian.personId,
      subjectPersonId: child,
      permissions: ['view', 'register'],
    });
    await createRelationshipFixture(t, {
      actorPersonId: viewer.personId,
      subjectPersonId: child,
      permissions: ['view'],
    });
    const forChild = await invite(team, { recipientPersonId: child });
    expect((await get(`/team-invitations/${forChild.id}`, viewer)).status).toBe(404);
    expect((await post(`/team-invitations/${forChild.id}/decline`, viewer, {})).status).toBe(404);
    expect((await get(`/team-invitations/${forChild.id}`, guardian)).status).toBe(200);
    const byGuardian = await post(`/team-invitations/${forChild.id}/decline`, guardian, {});
    expect(byGuardian.status).toBe(200);
    expect((await resolvedEvents(forChild.id)).map((e) => e.payload)).toEqual([
      expect.objectContaining({ status: 'declined', personId: child }),
    ]);
  });

  // CMP-07 ---------------------------------------------------------------------------------------
  it('SPK-CAP-001: a team invitation past expiry is expired by the sweep once and can no longer be accepted; a replayed run is a no-op', async () => {
    const team = await teamOf('Swifts');
    const player = await adultCustomer(t);
    const lasting = await adultCustomer(t);
    const shortLived = await invite(team, {
      recipientPersonId: player.personId,
      expiresInHours: 1,
    });
    const longLived = await invite(team, { recipientPersonId: lasting.personId });
    t.clock.advance(2 * 3_600_000);
    try {
      // until the sweep records it, a read already shows the expiry
      const read = await get(`/team-invitations/${shortLived.id}`, player);
      expect(read.body).toMatchObject({ status: 'pending', effectiveStatus: 'expired' });
      expect((await post(`/team-invitations/${shortLived.id}/decline`, player, {})).status).toBe(
        409,
      );

      const [run] = await t.runPeriodicJobs([EXPIRY_JOB]);
      expect(run).toMatchObject({ name: EXPIRY_JOB, ran: true, failed: false });
      expect(run?.processed).toBeGreaterThanOrEqual(1);
      const row = await invitationRow(shortLived.id);
      expect(row).toMatchObject({ status: 'expired', revision: 2 });
      expect((await invitationRow(longLived.id)).status).toBe('pending');
      const placeholder = await t.db
        .selectFrom('roster_memberships')
        .select('effective_to')
        .where('id', '=', shortLived.rosterMembershipId as string)
        .executeTakeFirstOrThrow();
      expect(placeholder.effective_to).not.toBeNull();
      const audit = await t.db
        .selectFrom('audit_records')
        .select(['action', 'actor'])
        .where('target_id', '=', shortLived.id)
        .where('action', '<>', 'competition.invite_player')
        .execute();
      expect(audit).toEqual([
        {
          action: 'competition.expire_team_invitation',
          actor: expect.objectContaining({ kind: 'system', actorLabel: EXPIRY_JOB }),
        },
      ]);
      expect((await resolvedEvents(shortLived.id)).map((e) => e.payload)).toEqual([
        {
          invitationId: shortLived.id,
          teamEntryId: team.teamEntryId,
          status: 'expired',
          personId: null,
        },
      ]);

      // a replayed run finds nothing due and changes nothing
      const [replay] = await t.runPeriodicJobs([EXPIRY_JOB]);
      expect(replay).toMatchObject({ ran: true, processed: 0, failed: false });
      expect((await invitationRow(shortLived.id)).revision).toBe(2);
      expect(await resolvedEvents(shortLived.id)).toHaveLength(1);

      const accept = await post(`/team-invitations/${shortLived.id}/accept`, player, {
        token: shortLived.token,
      });
      expect(accept.status).toBe(409);
      expect(await resolvedEvents(shortLived.id)).toHaveLength(1);
    } finally {
      t.clock.set(CLOCK_START);
    }
  });

  it('CMP-07: the lazy expiry on acceptance announces the same fact as the sweep', async () => {
    const team = await teamOf('Kites');
    const player = await adultCustomer(t);
    const invited = await invite(team, { recipientPersonId: player.personId, expiresInHours: 1 });
    t.clock.advance(2 * 3_600_000);
    try {
      const late = await post(`/team-invitations/${invited.id}/accept`, player, {
        token: invited.token,
      });
      expect(late.status).toBe(409);
      expect((await invitationRow(invited.id)).status).toBe('expired');
      expect((await resolvedEvents(invited.id)).map((e) => e.payload)).toEqual([
        {
          invitationId: invited.id,
          teamEntryId: team.teamEntryId,
          status: 'expired',
          personId: null,
        },
      ]);
      // the sweep afterwards has nothing to do for it
      await t.runPeriodicJobs([EXPIRY_JOB]);
      expect(await resolvedEvents(invited.id)).toHaveLength(1);
    } finally {
      t.clock.set(CLOCK_START);
    }
  });

  // CMP-13 ---------------------------------------------------------------------------------------
  it('CMP-13: a jersey number outside the configured range is refused; without a range only duplicates are', async () => {
    const base = proposedRuleSetContent('small_sided_other');
    const ranged = await createSeasonFixture(t, {
      status: 'open',
      ruleSet: { roster: { ...base.roster, jerseyNumbers: { min: 1, max: 99 } } },
    });
    const team = await teamOf('Numbers', ranged.seasonId);
    const add = (personId: string, jerseyNumber: number) =>
      post(`/team-entries/${team.teamEntryId}/roster`, team.captain, {
        changes: [{ action: 'add', personId, jerseyNumber }],
      });
    const p1 = await adultCustomer(t);
    const p2 = await adultCustomer(t);
    const tooHigh = await add(p1.personId, 100);
    expect(tooHigh.status).toBe(400);
    expect(tooHigh.body.details).toMatchObject({
      code: 'JERSEY_OUT_OF_RANGE',
      jerseyNumber: 100,
      min: 1,
      max: 99,
    });
    expect((await add(p1.personId, 0)).body.details?.code).toBe('JERSEY_OUT_OF_RANGE');
    expect((await add(p1.personId, 99)).status).toBe(200);
    expect((await add(p2.personId, 99)).status).toBe(409);

    // without a range any number the contract allows is accepted; duplicates still are not
    const open = await teamOf('Anything');
    const addOpen = (personId: string, jerseyNumber: number) =>
      post(`/team-entries/${open.teamEntryId}/roster`, open.captain, {
        changes: [{ action: 'add', personId, jerseyNumber }],
      });
    expect((await addOpen(p1.personId, 500)).status).toBe(200);
    const duplicate = await addOpen(p2.personId, 500);
    expect(duplicate.status).toBe(409);
    expect((await addOpen(p2.personId, 0)).status).toBe(200);
  });

  it('CMP-13: a captain hands the captaincy to a rostered player; both role rows change at one instant', async () => {
    const team = await teamOf('Herons');
    const next = await adultCustomer(t);
    await addRosterMemberFixture(t, { teamEntryId: team.teamEntryId, personId: next.personId });
    const workspace = await get(`/team-entries/${team.teamEntryId}`, team.captain);
    const revision = workspace.body.entry.revision as number;
    const stale = await post(`/team-entries/${team.teamEntryId}/roles/handover`, team.captain, {
      role: 'captain',
      fromPersonId: team.captain.personId,
      toPersonId: next.personId,
      reason: 'Moving away',
      expectedRevision: revision + 5,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVISION');
    t.clock.advance(60_000);
    const handedAt = t.clock.now().toISOString();
    const res = await post(`/team-entries/${team.teamEntryId}/roles/handover`, team.captain, {
      role: 'captain',
      fromPersonId: team.captain.personId,
      toPersonId: next.personId,
      reason: 'Moving away',
      expectedRevision: revision,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      teamEntryId: team.teamEntryId,
      role: 'captain',
      fromPersonId: team.captain.personId,
      toPersonId: next.personId,
      effectiveAt: handedAt,
      entryRevision: revision + 1,
    });
    expect(res.body.roles).toEqual([
      expect.objectContaining({ personId: next.personId, role: 'captain', effectiveTo: null }),
    ]);
    const rows = await t.db
      .selectFrom('team_roles')
      .select(['person_id', 'effective_from', 'effective_to', 'ended_reason'])
      .where('team_entry_id', '=', team.teamEntryId)
      .where('role', '=', 'captain')
      .orderBy('effective_from')
      .execute();
    expect(rows).toHaveLength(2);
    const [outgoing, incoming] = rows;
    expect(outgoing?.person_id).toBe(team.captain.personId);
    expect(incoming?.person_id).toBe(next.personId);
    expect(new Date(outgoing?.effective_to as Date).toISOString()).toBe(handedAt);
    expect(new Date(incoming?.effective_from as Date).toISOString()).toBe(handedAt);
    expect(outgoing?.ended_reason).toBe('Moving away');
    // roleHolders answers the new holder at once (IF-15)
    const port = t.app.get<TeamEntryQueryPort>(TEAM_ENTRY_QUERY_PORT);
    expect(
      await port.roleHolders(t.organizationId, team.teamEntryId, ['captain'], t.clock.now()),
    ).toEqual([{ personId: next.personId, role: 'captain' }]);
    const event = await t.db
      .selectFrom('outbox_events')
      .select('payload')
      .where('event_type', '=', 'competition.team_role_changed')
      .where('aggregate_id', '=', team.teamEntryId)
      .executeTakeFirstOrThrow();
    expect(event.payload).toMatchObject({
      teamEntryId: team.teamEntryId,
      role: 'captain',
      fromPersonId: team.captain.personId,
      toPersonId: next.personId,
      effectiveAt: handedAt,
    });
    const audit = await t.db
      .selectFrom('audit_records')
      .select(['action', 'reason'])
      .where('target_id', '=', team.teamEntryId)
      .where('action', '=', 'competition.handover_team_role')
      .executeTakeFirstOrThrow();
    expect(audit.reason).toBe('Moving away');
    // the former captain no longer holds the authority to hand anything over
    const back = await post(`/team-entries/${team.teamEntryId}/roles/handover`, team.captain, {
      role: 'captain',
      fromPersonId: next.personId,
      toPersonId: team.captain.personId,
      reason: 'Changed my mind',
      expectedRevision: revision + 1,
    });
    expect(back.status).toBe(404);
    // league staff may hand over any role
    const byStaff = await post(`/team-entries/${team.teamEntryId}/roles/handover`, leagueManager, {
      role: 'captain',
      fromPersonId: next.personId,
      toPersonId: team.captain.personId,
      reason: 'Returned',
      expectedRevision: revision + 1,
    });
    expect(byStaff.status).toBe(200);
    t.clock.set(CLOCK_START);
  });

  it('CMP-13: a handover to someone off the roster is refused', async () => {
    const team = await teamOf('Cranes');
    const revision = (await get(`/team-entries/${team.teamEntryId}`, team.captain)).body.entry
      .revision as number;
    const handover = (actor: Actor, body: Record<string, unknown>) =>
      post(`/team-entries/${team.teamEntryId}/roles/handover`, actor, {
        role: 'captain',
        fromPersonId: team.captain.personId,
        reason: 'Handing over',
        expectedRevision: revision,
        ...body,
      });
    const outsider = await adultCustomer(t);
    const offRoster = await handover(team.captain, { toPersonId: outsider.personId });
    expect(offRoster.status).toBe(400);
    expect(offRoster.body.details).toMatchObject({ code: 'NOT_ON_ROSTER' });
    // a child on the roster cannot captain (proposed default)
    const child = await createPersonFixture(t, { kind: 'child' });
    await addRosterMemberFixture(t, { teamEntryId: team.teamEntryId, personId: child });
    const toChild = await handover(team.captain, { toPersonId: child });
    expect(toChild.status).toBe(400);
    expect(toChild.body.details).toMatchObject({ code: 'CAPTAIN_MUST_BE_ADULT' });
    // a player hands over nothing; the role must be held by the person named
    const player = await adultCustomer(t);
    await addRosterMemberFixture(t, { teamEntryId: team.teamEntryId, personId: player.personId });
    expect(
      (await handover(player, { toPersonId: player.personId, fromPersonId: player.personId }))
        .status,
    ).toBe(400);
    expect(
      (
        await handover(player, {
          toPersonId: player.personId,
        })
      ).status,
    ).toBe(404);
    const notHeld = await handover(leagueManager, {
      role: 'co_captain',
      toPersonId: player.personId,
    });
    expect(notHeld.status).toBe(400);
    expect(notHeld.body.details).toMatchObject({ code: 'ROLE_NOT_HELD' });
    // nothing changed: the captain still holds the role
    const port = t.app.get<TeamEntryQueryPort>(TEAM_ENTRY_QUERY_PORT);
    expect(
      await port.roleHolders(t.organizationId, team.teamEntryId, ['captain'], t.clock.now()),
    ).toEqual([{ personId: team.captain.personId, role: 'captain' }]);
  });
});
