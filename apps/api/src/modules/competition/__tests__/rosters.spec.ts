import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { idempotencyStoreContains, type TestApp } from '../../../testing';
import {
  createContactPointFixture,
  createPersonFixture,
  createRelationshipFixture,
} from '../../identity';
import { proposedRuleSetContent } from '../competition.policy';
import {
  ROSTER_PORT,
  SUSPENSION_CHECK_IMPL,
  type RosterPort,
  type SuspensionCheckPort,
} from '../ports';
import {
  addRosterMemberFixture,
  createDivisionFixture,
  createFixtureFixture,
  createSeasonFixture,
  createTeamEntryFixture,
  type SeasonFixture,
} from '../testing/competition-fixtures';
import { adultCustomer, competitionTestApp, key, staffMember, type Actor } from './support';

const NOW = '2026-10-23T12:00:00.000Z';

describe('rosters, eligibility, invitations and join requests (SPK-COMP-005, SPK-CAP-002, SPK-CAP-004, SPK-AT-002, SPK-AT-013)', () => {
  let t: TestApp;
  let leagueManager: Actor;
  let season: SeasonFixture;
  const suspended = new Set<string>();
  /** Period suspensions [from, to) that restrict only at instants inside the period. */
  const periods = new Map<string, { from: string; to: string }>();
  /** Stands in for the discipline module (part 2): suspensions are authoritative facts from the port. */
  const suspensions: SuspensionCheckPort = {
    activeSuspensions: async (_organizationId, personId, at) => {
      if (suspended.has(personId)) {
        return [
          { id: 'suspension-1', reason: 'card accumulation', scope: 'competition', until: null },
        ];
      }
      const period = periods.get(personId);
      if (period && new Date(period.from) <= at && at < new Date(period.to)) {
        return [
          { id: 'suspension-period', reason: 'dissent', scope: 'organization', until: period.to },
        ];
      }
      return [];
    },
  };

  beforeAll(async () => {
    t = await competitionTestApp({
      providers: [{ provide: SUSPENSION_CHECK_IMPL, useValue: suspensions }],
    });
    leagueManager = await staffMember(t, ['league_manager']);
    season = await createSeasonFixture(t, { status: 'open' });
  });
  afterAll(async () => {
    await t.close();
  });

  const post = (path: string, actor: Actor, body: object, k: string = key()) =>
    t.http.post(`/v1${path}`).set(actor.header).set('Idempotency-Key', k).send(body);
  const add = (
    entryId: string,
    actor: Actor,
    personId: string,
    extra: Record<string, unknown> = {},
    k?: string,
  ) =>
    post(
      `/team-entries/${entryId}/roster`,
      actor,
      { changes: [{ action: 'add', personId, ...extra }] },
      k,
    );
  const reasonCodes = (body: { details?: { reasons?: Array<{ code: string }> } }) =>
    body.details?.reasons?.map((r) => r.code) ?? [];

  async function teamOf(seasonId: string, options: { divisionId?: string | null } = {}) {
    const captain = await adultCustomer(t);
    const entry = await createTeamEntryFixture(t, {
      seasonId,
      captainPersonId: captain.personId,
      divisionId: options.divisionId,
    });
    return { captain, ...entry };
  }

  it('SPK-COMP-005: roster changes carry effective dates; a player removed today is still on last week’s roster', async () => {
    const team = await teamOf(season.seasonId);
    const p1 = await adultCustomer(t);
    const p3 = await adultCustomer(t);
    const k = key();
    const added = await add(team.teamEntryId, team.captain, p1.personId, { jerseyNumber: 10 }, k);
    expect(added.status).toBe(200);
    expect(added.body.members).toEqual([
      expect.objectContaining({
        personId: p1.personId,
        status: 'active',
        jerseyNumber: 10,
        effectiveFrom: NOW,
        effectiveTo: null,
        source: 'captain',
        eligibility: expect.objectContaining({ status: 'eligible' }),
      }),
    ]);
    const replay = await add(team.teamEntryId, team.captain, p1.personId, { jerseyNumber: 10 }, k);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    const twice = await add(team.teamEntryId, team.captain, p1.personId);
    expect(twice.status).toBe(422);
    expect(reasonCodes(twice.body)).toContain('already_on_roster');
    await add(team.teamEntryId, team.captain, p3.personId);

    t.clock.set('2026-10-30T12:00:00Z');
    const removed = await post(`/team-entries/${team.teamEntryId}/roster`, team.captain, {
      changes: [{ action: 'remove', personId: p1.personId, reason: 'left the team' }],
    });
    expect(removed.status).toBe(200);
    expect(removed.body.members.map((m: { personId: string }) => m.personId)).toEqual([
      p3.personId,
    ]);

    const lastWeek = await t.http
      .get(`/v1/team-entries/${team.teamEntryId}/roster`)
      .set(team.captain.header)
      .query({ at: '2026-10-26T12:00:00.000Z' });
    expect(lastWeek.status).toBe(200);
    expect(lastWeek.body.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          personId: p1.personId,
          status: 'removed',
          statusBeforeRemoval: 'active',
          effectiveTo: '2026-10-30T12:00:00.000Z',
          removalReason: 'left the team',
        }),
      ]),
    );
    const now = await t.http
      .get(`/v1/team-entries/${team.teamEntryId}/roster`)
      .set(team.captain.header);
    expect(now.body.members.map((m: { personId: string }) => m.personId)).toEqual([p3.personId]);
    const history = await t.http
      .get(`/v1/team-entries/${team.teamEntryId}/roster`)
      .set(team.captain.header)
      .query({ includeHistory: 'true' });
    expect(history.body.members).toHaveLength(2);
    // a player sees the current roster but not the management history
    expect(
      (await t.http.get(`/v1/team-entries/${team.teamEntryId}/roster`).set(p3.header)).status,
    ).toBe(200);
    expect(
      (
        await t.http
          .get(`/v1/team-entries/${team.teamEntryId}/roster`)
          .set(p3.header)
          .query({ includeHistory: 'true' })
      ).status,
    ).toBe(404);
    // the row was never deleted, and the port answers the same way
    const rows = await t.db
      .selectFrom('roster_memberships')
      .select(['person_id', 'status', 'effective_to'])
      .where('team_entry_id', '=', team.teamEntryId)
      .orderBy('effective_from')
      .execute();
    expect(rows).toHaveLength(2);
    const port = t.app.get<RosterPort>(ROSTER_PORT);
    const effective = await port.effectiveRoster(
      t.organizationId,
      team.teamEntryId,
      new Date('2026-10-26T12:00:00Z'),
    );
    expect(effective.map((m) => [m.personId, m.status]).sort()).toEqual(
      [
        [p1.personId, 'active'],
        [p3.personId, 'active'],
      ].sort(),
    );
    expect(
      (
        await port.effectiveRoster(
          t.organizationId,
          team.teamEntryId,
          new Date('2026-10-31T12:00:00Z'),
        )
      ).map((m) => m.personId),
    ).toEqual([p3.personId]);
    const events = await t.db
      .selectFrom('outbox_events')
      .select('payload')
      .where('aggregate_id', '=', team.teamEntryId)
      .where('event_type', '=', 'competition.roster_changed')
      .execute();
    expect(events.map((e) => (e.payload as { change: string }).change).sort()).toEqual([
      'added',
      'added',
      'removed',
    ]);
    t.clock.set(NOW);
  });

  it('SPK-COMP-002 roster limits: the rule set caps regular players and guests; the explanation names the source and the responsible role', async () => {
    const small = await createSeasonFixture(t, {
      ruleSet: {
        rosterMin: 1,
        rosterMax: 2,
        minimumPlayers: 1,
        roster: { ...proposedRuleSetContent('small_sided_other').roster, guestMaxConcurrent: 1 },
      },
    });
    const team = await teamOf(small.seasonId);
    const players = [
      await createPersonFixture(t, { kind: 'adult' }),
      await createPersonFixture(t, { kind: 'adult' }),
      await createPersonFixture(t, { kind: 'adult' }),
    ];
    expect((await add(team.teamEntryId, team.captain, players[0] as string)).status).toBe(200);
    expect((await add(team.teamEntryId, team.captain, players[1] as string)).status).toBe(200);
    const full = await add(team.teamEntryId, team.captain, players[2] as string);
    expect(full.status).toBe(422);
    expect(full.body.code).toBe('ELIGIBILITY_FAILED');
    expect(full.body.details.reasons).toEqual([
      expect.objectContaining({
        code: 'roster_full',
        severity: 'blocking',
        source: { type: 'rule_set', id: small.ruleSetId },
        responsibleRole: 'captain',
      }),
    ]);
    const explained = await t.http
      .get(`/v1/team-entries/${team.teamEntryId}/eligibility`)
      .set(team.captain.header)
      .query({ personId: players[2] });
    expect(explained.status).toBe(200);
    expect(explained.body).toMatchObject({
      eligible: false,
      membershipStatus: 'active',
      reasons: [expect.objectContaining({ code: 'roster_full' })],
    });
    // guests have their own limit and do not consume regular places
    expect(
      (await add(team.teamEntryId, team.captain, players[2] as string, { status: 'guest' })).status,
    ).toBe(200);
    const guest2 = await add(
      team.teamEntryId,
      team.captain,
      await createPersonFixture(t, { kind: 'adult' }),
      { status: 'guest' },
    );
    expect(reasonCodes(guest2.body)).toEqual(['guest_limit_reached']);
    const workspace = await t.http
      .get(`/v1/team-entries/${team.teamEntryId}`)
      .set(team.captain.header);
    expect(workspace.body.readiness).toMatchObject({
      rosterCount: 2,
      rosterMax: 2,
      rosterComplete: true,
    });
    expect(workspace.body.entry.rosterComplete).toBe(true);
  });

  it('SPK-COMP-005 multi-team restrictions from the rule set: same division never, entries per season capped', async () => {
    const division = await createDivisionFixture(t, { seasonId: season.seasonId });
    const a = await teamOf(season.seasonId, { divisionId: division });
    const b = await teamOf(season.seasonId, { divisionId: division });
    const c = await teamOf(season.seasonId);
    const x = await createPersonFixture(t, { kind: 'adult' });
    expect((await add(a.teamEntryId, a.captain, x)).status).toBe(200);
    const sameDivision = await add(b.teamEntryId, b.captain, x);
    expect(sameDivision.status).toBe(422);
    expect(reasonCodes(sameDivision.body)).toEqual(['already_in_division']);
    expect((await add(c.teamEntryId, c.captain, x)).status).toBe(200);

    const strict = await createSeasonFixture(t, {
      ruleSet: {
        multiTeamRestrictions: {
          maxEntriesPerSeason: 1,
          allowSameDivision: false,
          allowCrossDivision: true,
        },
      },
    });
    const d = await teamOf(strict.seasonId);
    const e = await teamOf(strict.seasonId);
    expect((await add(d.teamEntryId, d.captain, x)).status).toBe(200);
    const second = await add(e.teamEntryId, e.captain, x);
    expect(reasonCodes(second.body)).toEqual(['multi_team_limit']);
  });

  it('SPK-COMP-003 / §4.5: age is evaluated from the date of birth at the rule set’s reference date, never a stored age', async () => {
    const youth = await createSeasonFixture(t, { startsOn: '2027-01-10', endsOn: '2027-04-10' });
    const u12 = await createDivisionFixture(t, {
      seasonId: youth.seasonId,
      criteria: { ageBand: { minAge: 6, maxAge: 12 } },
    });
    const team = await teamOf(youth.seasonId, { divisionId: u12 });
    const thirteenAtKickoff = await createPersonFixture(t, {
      kind: 'child',
      dateOfBirth: '2014-01-05',
    });
    const eleven = await createPersonFixture(t, { kind: 'child', dateOfBirth: '2015-06-01' });
    const unknownAge = await createPersonFixture(t, { kind: 'child', dateOfBirth: null });
    const tooOld = await add(team.teamEntryId, team.captain, thirteenAtKickoff);
    expect(tooOld.status).toBe(422);
    expect(tooOld.body.details.reasons).toEqual([
      expect.objectContaining({
        code: 'above_division_age',
        source: { type: 'division', id: u12 },
        responsibleRole: 'league_manager',
      }),
    ]);
    expect(tooOld.body.details.reasons[0].message).toContain('2027-01-10');
    expect((await add(team.teamEntryId, team.captain, eleven)).status).toBe(200);
    const unknown = await add(team.teamEntryId, team.captain, unknownAge);
    expect(unknown.status).toBe(422);
    expect(unknown.body.details.reasons).toEqual([
      expect.objectContaining({ code: 'date_of_birth_unknown', severity: 'unknown' }),
    ]);
    // the same child is 12 today: under a match-date reference the division accepts them
    const matchDate = await createSeasonFixture(t, {
      startsOn: '2027-01-10',
      ruleSet: { eligibilityReferenceDate: { rule: 'match_date' } },
    });
    const u12b = await createDivisionFixture(t, {
      seasonId: matchDate.seasonId,
      criteria: { ageBand: { minAge: 6, maxAge: 12 } },
    });
    const team2 = await teamOf(matchDate.seasonId, { divisionId: u12b });
    expect((await add(team2.teamEntryId, team2.captain, thirteenAtKickoff)).status).toBe(200);
    // the explanation is explicit about the reference date (SPK-READY-003)
    const explained = await t.http
      .get(`/v1/team-entries/${team.teamEntryId}/eligibility`)
      .set(leagueManager.header)
      .query({ personId: thirteenAtKickoff, at: '2027-02-01T00:00:00.000Z' });
    expect(explained.body.reasons[0].message).toContain('Age 13 on 2027-01-10');
  });

  it('SPK-CAP-004 / SPK-AT-013: a captain cannot bypass eligibility by labelling someone a guest or substitute; suspensions block everyone', async () => {
    const gated = await createSeasonFixture(t, {
      ruleSet: {
        roster: {
          ...proposedRuleSetContent('small_sided_other').roster,
          guestOrSubstituteRequiresApproval: true,
        },
      },
    });
    const team = await teamOf(gated.seasonId);
    const guest = await createPersonFixture(t, { kind: 'adult' });
    const byCaptain = await add(team.teamEntryId, team.captain, guest, { status: 'guest' });
    expect(byCaptain.status).toBe(422);
    expect(byCaptain.body.details.reasons).toEqual([
      expect.objectContaining({
        code: 'approval_required',
        severity: 'blocking',
        responsibleRole: 'league_manager',
      }),
    ]);
    const byStaff = await add(team.teamEntryId, leagueManager, guest, { status: 'guest' });
    expect(byStaff.status).toBe(200);
    expect(byStaff.body.members).toEqual([
      expect.objectContaining({ personId: guest, status: 'guest', source: 'staff' }),
    ]);

    const banned = await createPersonFixture(t, { kind: 'adult' });
    suspended.add(banned);
    for (const actor of [team.captain, leagueManager]) {
      for (const status of ['guest', 'substitute', 'active']) {
        const res = await add(team.teamEntryId, actor, banned, { status });
        expect(res.status).toBe(422);
        expect(res.body.details.reasons).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: 'suspended',
              severity: 'blocking',
              // SPK-CAP-002 / SPK-DISC-004: only staff learn the suspension record id
              source: { type: 'suspension', id: actor === leagueManager ? 'suspension-1' : null },
            }),
          ]),
        );
      }
    }
    suspended.delete(banned);

    const noGuests = await createSeasonFixture(t, {
      ruleSet: {
        roster: {
          ...proposedRuleSetContent('small_sided_other').roster,
          guestPlayersAllowed: false,
          substitutesAllowed: false,
        },
      },
    });
    const team2 = await teamOf(noGuests.seasonId);
    expect(
      reasonCodes((await add(team2.teamEntryId, team2.captain, guest, { status: 'guest' })).body),
    ).toEqual(['guests_not_allowed']);
    expect(
      reasonCodes(
        (await add(team2.teamEntryId, team2.captain, guest, { status: 'substitute' })).body,
      ),
    ).toEqual(['substitutes_not_allowed']);
    // the eligibility snapshot is kept with the membership for later readiness explanations
    const snapshot = await t.db
      .selectFrom('roster_memberships')
      .select('eligibility_snapshot')
      .where('team_entry_id', '=', team.teamEntryId)
      .where('person_id', '=', guest)
      .executeTakeFirstOrThrow();
    expect(snapshot.eligibility_snapshot).toEqual([]);
  });

  it('§4.8 invitations: a captain invites on their own entry only; acceptance needs the token and the invited person or a guardian with register (SPK-IAM-003)', async () => {
    const a = await teamOf(season.seasonId);
    const b = await teamOf(season.seasonId);
    const x = await adultCustomer(t, { dateOfBirth: '1992-02-02' });
    const y = await adultCustomer(t);
    const onB = await post(`/team-entries/${b.teamEntryId}/invitations`, a.captain, {
      recipientPersonId: x.personId,
    });
    expect(onB.status).toBe(404);
    const inviteKey = key();
    const invited = await post(
      `/team-entries/${a.teamEntryId}/invitations`,
      a.captain,
      { recipientPersonId: x.personId, message: 'Join us' },
      inviteKey,
    );
    expect(invited.status).toBe(201);
    // §4.14: the token is stored only as a hash, never with the idempotency key; a replay names
    // the invitation and withholds the token.
    expect(await idempotencyStoreContains(t.db, invited.body.token as string)).toBe(false);
    const replayed = await post(
      `/team-entries/${a.teamEntryId}/invitations`,
      a.captain,
      { recipientPersonId: x.personId, message: 'Join us' },
      inviteKey,
    );
    expect(replayed.status).toBe(409);
    expect(replayed.body).toMatchObject({
      code: 'IDEMPOTENCY_SECRET_WITHHELD',
      details: { resourceId: invited.body.id },
    });
    expect(invited.body).toMatchObject({
      teamEntryId: a.teamEntryId,
      invitedByPersonId: a.captain.personId,
      recipientPersonId: x.personId,
      status: 'pending',
      eligibilityPreview: { status: 'eligible', blocking: 0 },
    });
    expect(invited.body.token).toEqual(expect.any(String));
    expect(JSON.stringify(invited.body)).not.toContain('1992-02-02');
    const placeholder = await t.db
      .selectFrom('roster_memberships')
      .select(['status', 'effective_to'])
      .where('id', '=', invited.body.rosterMembershipId)
      .executeTakeFirstOrThrow();
    expect(placeholder).toEqual({ status: 'invited', effective_to: null });
    const duplicate = await post(`/team-entries/${a.teamEntryId}/invitations`, a.captain, {
      recipientPersonId: x.personId,
    });
    expect(duplicate.status).toBe(409);
    // the workspace counts it for the captain; a suspended person cannot even be invited (SPK-CAP-004)
    expect(
      (await t.http.get(`/v1/team-entries/${a.teamEntryId}`).set(a.captain.header)).body.readiness
        .pendingInvitations,
    ).toBe(1);
    suspended.add(y.personId);
    const ineligible = await post(`/team-entries/${a.teamEntryId}/invitations`, a.captain, {
      recipientPersonId: y.personId,
    });
    expect(ineligible.status).toBe(422);
    expect(reasonCodes(ineligible.body)).toEqual(['suspended']);
    suspended.delete(y.personId);

    const wrongPerson = await post(`/team-invitations/${invited.body.id}/accept`, y, {
      token: invited.body.token,
    });
    expect(wrongPerson.status).toBe(404);
    const wrongToken = await post(`/team-invitations/${invited.body.id}/accept`, x, {
      token: 'not-the-token-at-all',
    });
    expect(wrongToken.status).toBe(404);
    const accepted = await post(`/team-invitations/${invited.body.id}/accept`, x, {
      token: invited.body.token,
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body.invitation).toMatchObject({
      status: 'accepted',
      acceptedByPersonId: x.personId,
      acceptedAt: NOW,
    });
    expect(accepted.body.membership).toMatchObject({
      personId: x.personId,
      status: 'active',
      source: 'invitation',
      effectiveFrom: NOW,
    });
    const rows = await t.db
      .selectFrom('roster_memberships')
      .select(['status', 'effective_to'])
      .where('team_entry_id', '=', a.teamEntryId)
      .where('person_id', '=', x.personId)
      .orderBy('created_at')
      .execute();
    expect(rows).toEqual([
      { status: 'invited', effective_to: expect.any(Date) },
      { status: 'active', effective_to: null },
    ]);
    const again = await post(`/team-invitations/${invited.body.id}/accept`, x, {
      token: invited.body.token,
    });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('INVALID_TRANSITION');

    // revocation by the captain closes the placeholder; expiry is applied lazily on acceptance
    const z = await adultCustomer(t);
    const revocable = await post(`/team-entries/${b.teamEntryId}/invitations`, b.captain, {
      recipientPersonId: z.personId,
    });
    expect(
      (
        await post(`/team-invitations/${revocable.body.id}/revoke`, a.captain, {
          reason: 'wrong team',
        })
      ).status,
    ).toBe(404);
    const revoked = await post(`/team-invitations/${revocable.body.id}/revoke`, b.captain, {
      reason: 'roster full',
    });
    expect(revoked.status).toBe(200);
    expect(revoked.body.status).toBe('revoked');
    const closed = await t.db
      .selectFrom('roster_memberships')
      .select('effective_to')
      .where('id', '=', revocable.body.rosterMembershipId)
      .executeTakeFirstOrThrow();
    expect(closed.effective_to).not.toBeNull();
    const shortLived = await post(`/team-entries/${b.teamEntryId}/invitations`, b.captain, {
      recipientPersonId: z.personId,
      expiresInHours: 1,
    });
    t.clock.set('2026-10-23T14:00:00Z');
    const late = await post(`/team-invitations/${shortLived.body.id}/accept`, z, {
      token: shortLived.body.token,
    });
    expect(late.status).toBe(409);
    expect(late.body.message).toContain('expired');
    expect(
      (
        await t.db
          .selectFrom('team_invitations')
          .select('status')
          .where('id', '=', shortLived.body.id)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('expired');
    t.clock.set(NOW);

    // a guardian accepts for a child only with the register permission; view alone is not enough
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
    const childInvite = await post(`/team-entries/${a.teamEntryId}/invitations`, a.captain, {
      recipientPersonId: child,
    });
    expect(childInvite.status).toBe(201);
    const viewOnly = await post(`/team-invitations/${childInvite.body.id}/accept`, viewer, {
      token: childInvite.body.token,
      personId: child,
    });
    expect(viewOnly.status).toBe(404);
    const byGuardian = await post(`/team-invitations/${childInvite.body.id}/accept`, guardian, {
      token: childInvite.body.token,
      personId: child,
    });
    expect(byGuardian.status).toBe(200);
    expect(byGuardian.body.membership).toMatchObject({
      personId: child,
      personKind: 'child',
      status: 'active',
    });

    // an invitation to a contact is claimed by whoever holds that verified contact point
    const w = await adultCustomer(t);
    await createContactPointFixture(t, {
      personId: w.personId,
      kind: 'email',
      value: 'new.player@example.test',
      verified: true,
    });
    const unverified = await adultCustomer(t);
    const byContact = await post(`/team-entries/${a.teamEntryId}/invitations`, a.captain, {
      recipientContact: { kind: 'email', value: 'New.Player@example.test' },
    });
    expect(byContact.status).toBe(201);
    expect(byContact.body).toMatchObject({
      recipientPersonId: null,
      recipientContact: { kind: 'email', value: 'new.player@example.test' },
      rosterMembershipId: null,
    });
    expect(
      (
        await post(`/team-invitations/${byContact.body.id}/accept`, unverified, {
          token: byContact.body.token,
        })
      ).status,
    ).toBe(403);
    const claimed = await post(`/team-invitations/${byContact.body.id}/accept`, w, {
      token: byContact.body.token,
    });
    expect(claimed.status).toBe(200);
    expect(claimed.body.membership.personId).toBe(w.personId);
  });

  it('SPK-CAP-001 join requests: the player (or a guardian with register) asks, the captain decides, strangers see nothing', async () => {
    const a = await teamOf(season.seasonId);
    const b = await teamOf(season.seasonId);
    const x = await adultCustomer(t);
    const requested = await post(`/team-entries/${a.teamEntryId}/join-requests`, x, {
      message: 'Pick me',
    });
    expect(requested.status).toBe(201);
    expect(requested.body).toMatchObject({
      teamEntryId: a.teamEntryId,
      personId: x.personId,
      requestedByPersonId: x.personId,
      status: 'pending',
      message: 'Pick me',
    });
    expect((await post(`/team-entries/${a.teamEntryId}/join-requests`, x, {})).status).toBe(409);
    expect(
      (await t.http.get(`/v1/team-entries/${a.teamEntryId}`).set(a.captain.header)).body
        .pendingJoinRequests,
    ).toEqual([expect.objectContaining({ id: requested.body.id })]);
    const byOtherCaptain = await post(`/join-requests/${requested.body.id}/decide`, b.captain, {
      decision: 'approve',
    });
    expect(byOtherCaptain.status).toBe(404);
    const approved = await post(`/join-requests/${requested.body.id}/decide`, a.captain, {
      decision: 'approve',
      note: 'welcome',
    });
    expect(approved.status).toBe(200);
    expect(approved.body.request).toMatchObject({
      status: 'approved',
      decidedByPersonId: a.captain.personId,
      decisionNote: 'welcome',
    });
    expect(approved.body.membership).toMatchObject({
      personId: x.personId,
      status: 'active',
      source: 'join_request',
    });
    expect(
      (await post(`/join-requests/${requested.body.id}/decide`, a.captain, { decision: 'decline' }))
        .status,
    ).toBe(409);

    const y = await adultCustomer(t);
    const declined = await post(
      `/join-requests/${(await post(`/team-entries/${a.teamEntryId}/join-requests`, y, {})).body.id}/decide`,
      a.captain,
      { decision: 'decline' },
    );
    expect(declined.status).toBe(200);
    expect(declined.body).toMatchObject({ request: { status: 'declined' }, membership: null });
    const placeholders = await t.db
      .selectFrom('roster_memberships')
      .select(['status', 'effective_to'])
      .where('team_entry_id', '=', a.teamEntryId)
      .where('person_id', '=', y.personId)
      .execute();
    expect(placeholders).toEqual([{ status: 'requested', effective_to: expect.any(Date) }]);

    // a guardian requests for a child with register; a stranger cannot request for someone else
    const child = await createPersonFixture(t, { kind: 'child' });
    const guardian = await adultCustomer(t);
    await createRelationshipFixture(t, {
      actorPersonId: guardian.personId,
      subjectPersonId: child,
      permissions: ['view', 'register'],
    });
    expect(
      (await post(`/team-entries/${b.teamEntryId}/join-requests`, y, { personId: child })).status,
    ).toBe(403);
    const forChild = await post(`/team-entries/${b.teamEntryId}/join-requests`, guardian, {
      personId: child,
    });
    expect(forChild.status).toBe(201);
    expect(forChild.body).toMatchObject({
      personId: child,
      requestedByPersonId: guardian.personId,
    });
    // an ineligible request is refused with reasons (SPK-CAP-004), never silently queued
    suspended.add(y.personId);
    const refused = await post(`/team-entries/${b.teamEntryId}/join-requests`, y, {});
    expect(refused.status).toBe(422);
    suspended.delete(y.personId);
  });

  it('SPK-COMP-005 / §4.7 invariant 9: a captain cannot date a roster change before now, so a player removed today stays on last week’s match roster; league staff correct a past roster only with a reason, audited as retroactive; a completed season’s roster takes no change (SPK-AT-003)', async () => {
    const team = await teamOf(season.seasonId);
    const opponent = await teamOf(season.seasonId);
    const p1 = await adultCustomer(t);
    await addRosterMemberFixture(t, {
      teamEntryId: team.teamEntryId,
      personId: p1.personId,
      effectiveFrom: new Date('2026-10-01T00:00:00Z'),
    });
    const kickoff = '2026-10-16T18:00:00.000Z';
    const played = await createFixtureFixture(t, {
      seasonId: season.seasonId,
      homeEntryId: team.teamEntryId,
      awayEntryId: opponent.teamEntryId,
      status: 'played',
      scheduledStart: kickoff,
      scheduledEnd: '2026-10-16T19:00:00.000Z',
    });
    const rosterAtKickoff = async () =>
      (
        await t.http
          .get(`/v1/team-entries/${team.teamEntryId}/roster`)
          .set(team.captain.header)
          .query({ at: kickoff })
      ).body.members.map((m: { personId: string }) => m.personId);
    expect(await rosterAtKickoff()).toEqual([p1.personId]);
    expect((await t.http.get(`/v1/fixtures/${played}`).set(p1.header)).status).toBe(200);

    // the captain cannot backdate a removal or an addition
    const backdatedRemoval = await post(`/team-entries/${team.teamEntryId}/roster`, team.captain, {
      changes: [
        {
          action: 'remove',
          personId: p1.personId,
          effectiveTo: '2026-10-05T00:00:00.000Z',
          reason: 'left',
        },
      ],
    });
    expect(backdatedRemoval.status).toBe(400);
    expect(backdatedRemoval.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { code: 'retroactive_roster_change', field: 'effectiveTo' },
    });
    expect(await rosterAtKickoff()).toEqual([p1.personId]);
    expect((await t.http.get(`/v1/fixtures/${played}`).set(p1.header)).status).toBe(200);
    const p2 = await createPersonFixture(t, { kind: 'adult' });
    const backdatedAddition = await add(team.teamEntryId, team.captain, p2, {
      effectiveFrom: '2026-09-01T00:00:00.000Z',
    });
    expect(backdatedAddition.status).toBe(400);
    expect(backdatedAddition.body.details).toMatchObject({
      code: 'retroactive_roster_change',
      field: 'effectiveFrom',
    });
    expect(await rosterAtKickoff()).toEqual([p1.personId]);

    // league staff correct a past roster only with a reason, recorded as a retroactive correction
    const removal = {
      action: 'remove',
      personId: p1.personId,
      effectiveTo: '2026-10-10T00:00:00.000Z',
      reason: 'never played for the team',
    };
    const noReason = await post(`/team-entries/${team.teamEntryId}/roster`, leagueManager, {
      changes: [removal],
    });
    expect(noReason.status).toBe(400);
    expect(noReason.body.details.code).toBe('correction_reason_required');
    expect(await rosterAtKickoff()).toEqual([p1.personId]);
    const corrected = await post(`/team-entries/${team.teamEntryId}/roster`, leagueManager, {
      changes: [removal],
      reason: 'Registration error found by the league office.',
    });
    expect(corrected.status).toBe(200);
    expect(await rosterAtKickoff()).toEqual([]);
    const membership = await t.db
      .selectFrom('roster_memberships')
      .select('id')
      .where('team_entry_id', '=', team.teamEntryId)
      .where('person_id', '=', p1.personId)
      .executeTakeFirstOrThrow();
    const audit = await t.db
      .selectFrom('audit_records')
      .select(['reason', 'details'])
      .where('action', '=', 'competition.manage_roster')
      .where('target_type', '=', 'roster_membership')
      .where('target_id', '=', membership.id)
      .execute();
    expect(audit).toEqual([
      expect.objectContaining({
        reason: 'never played for the team',
        details: expect.objectContaining({
          retroactive: true,
          recordedAt: NOW,
          correctionReason: 'Registration error found by the league office.',
          effectiveTo: '2026-10-10T00:00:00.000Z',
        }),
      }),
    ]);
    // a change effective now or later is not a correction and needs no reason
    expect(
      (
        await add(team.teamEntryId, team.captain, p2, {
          effectiveFrom: '2026-11-01T00:00:00.000Z',
        })
      ).status,
    ).toBe(200);

    // a completed season's roster is history: no removal and no addition, by anyone
    const completed = await createSeasonFixture(t, {
      status: 'completed',
      startsOn: '2026-01-10',
      endsOn: '2026-04-10',
    });
    const last = await teamOf(completed.seasonId);
    const veteran = await createPersonFixture(t, { kind: 'adult' });
    await addRosterMemberFixture(t, {
      teamEntryId: last.teamEntryId,
      personId: veteran,
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    });
    for (const [actor, body] of [
      [last.captain, { changes: [{ action: 'remove', personId: veteran, reason: 'renewal' }] }],
      [
        leagueManager,
        {
          changes: [
            {
              action: 'remove',
              personId: veteran,
              effectiveTo: '2026-03-01T00:00:00.000Z',
              reason: 'renewal',
            },
          ],
          reason: 'tidy up',
        },
      ],
      [leagueManager, { changes: [{ action: 'add', personId: p2 }] }],
    ] as const) {
      const refused = await post(`/team-entries/${last.teamEntryId}/roster`, actor, body);
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('INVALID_TRANSITION');
    }
    const march = await t.http
      .get(`/v1/team-entries/${last.teamEntryId}/roster`)
      .set(leagueManager.header)
      .query({ at: '2026-03-15T00:00:00.000Z' });
    expect(march.body.members.map((m: { personId: string }) => m.personId)).toEqual([veteran]);
  });

  it('SPK-COMP-002 roster limits / SPK-CAP-004 / SPK-AT-013: an addition is checked over the whole interval it covers; future-dated rows count toward the limit, and a backdated addition can neither exceed it, place a currently suspended player nor break the multi-team limit', async () => {
    const small = await createSeasonFixture(t, {
      ruleSet: { rosterMin: 1, rosterMax: 3, minimumPlayers: 1 },
    });
    const correction = { reason: 'League office correction.' };
    const team = await teamOf(small.seasonId);
    for (let i = 0; i < 3; i += 1) {
      expect(
        (await add(team.teamEntryId, team.captain, await createPersonFixture(t, { kind: 'adult' })))
          .status,
      ).toBe(200);
    }
    const fourth = await createPersonFixture(t, { kind: 'adult' });
    expect(reasonCodes((await add(team.teamEntryId, team.captain, fourth)).body)).toEqual([
      'roster_full',
    ]);
    const backdated = await post(`/team-entries/${team.teamEntryId}/roster`, leagueManager, {
      changes: [{ action: 'add', personId: fourth, effectiveFrom: '2026-09-01T00:00:00.000Z' }],
      ...correction,
    });
    expect(backdated.status).toBe(422);
    expect(reasonCodes(backdated.body)).toEqual(['roster_full']);

    // a future-dated addition holds its place: later additions effective now count it
    const later = await teamOf(small.seasonId);
    expect(
      (
        await add(
          later.teamEntryId,
          later.captain,
          await createPersonFixture(t, { kind: 'adult' }),
          {
            effectiveFrom: '2026-11-15T00:00:00.000Z',
          },
        )
      ).status,
    ).toBe(200);
    for (let i = 0; i < 2; i += 1) {
      expect(
        (
          await add(
            later.teamEntryId,
            later.captain,
            await createPersonFixture(t, { kind: 'adult' }),
          )
        ).status,
      ).toBe(200);
    }
    const overflow = await add(
      later.teamEntryId,
      later.captain,
      await createPersonFixture(t, { kind: 'adult' }),
    );
    expect(overflow.status).toBe(422);
    expect(reasonCodes(overflow.body)).toEqual(['roster_full']);
    const port = t.app.get<RosterPort>(ROSTER_PORT);
    expect(
      await port.effectiveRoster(
        t.organizationId,
        later.teamEntryId,
        new Date('2026-11-20T00:00:00Z'),
      ),
    ).toHaveLength(3);

    // a period suspension that began yesterday blocks a substitute, backdated or not
    const subs = await teamOf(season.seasonId);
    const banned = await createPersonFixture(t, { kind: 'adult' });
    periods.set(banned, { from: '2026-10-22T00:00:00.000Z', to: '2026-12-31T00:00:00.000Z' });
    for (const [actor, extra] of [
      [subs.captain, {}],
      [leagueManager, { effectiveFrom: '2026-10-20T00:00:00.000Z' }],
    ] as const) {
      const res = await post(`/team-entries/${subs.teamEntryId}/roster`, actor, {
        changes: [{ action: 'add', personId: banned, status: 'substitute', ...extra }],
        ...correction,
      });
      expect(res.status).toBe(422);
      expect(reasonCodes(res.body)).toEqual(['suspended']);
    }
    // a suspension that only starts next week does not block an addition today
    const nextWeek = await createPersonFixture(t, { kind: 'adult' });
    periods.set(nextWeek, { from: '2026-10-30T00:00:00.000Z', to: '2026-12-31T00:00:00.000Z' });
    expect(
      (await add(subs.teamEntryId, subs.captain, nextWeek, { status: 'substitute' })).status,
    ).toBe(200);
    periods.clear();

    // multi-team limit: a backdated or a later membership on another team counts
    const strict = await createSeasonFixture(t, {
      ruleSet: {
        multiTeamRestrictions: {
          maxEntriesPerSeason: 1,
          allowSameDivision: false,
          allowCrossDivision: true,
        },
      },
    });
    const d = await teamOf(strict.seasonId);
    const e = await teamOf(strict.seasonId);
    const x = await createPersonFixture(t, { kind: 'adult' });
    expect((await add(d.teamEntryId, d.captain, x)).status).toBe(200);
    const backdatedSecond = await post(`/team-entries/${e.teamEntryId}/roster`, leagueManager, {
      changes: [{ action: 'add', personId: x, effectiveFrom: '2026-10-01T00:00:00.000Z' }],
      ...correction,
    });
    expect(reasonCodes(backdatedSecond.body)).toEqual(['multi_team_limit']);
    const y = await createPersonFixture(t, { kind: 'adult' });
    expect(
      (await add(d.teamEntryId, d.captain, y, { effectiveFrom: '2026-11-15T00:00:00.000Z' }))
        .status,
    ).toBe(200);
    expect(reasonCodes((await add(e.teamEntryId, e.captain, y)).body)).toEqual([
      'multi_team_limit',
    ]);
  });

  it('SPK-COMP-005 / SPK-COMP-002 multi-team restrictions hold under concurrency: two captains adding one person to two entries of a division at once, or approving two join requests at once, leave exactly one membership', async () => {
    const division = await createDivisionFixture(t, { seasonId: season.seasonId });
    const playingRows = async (personId: string, entryIds: string[]) =>
      t.db
        .selectFrom('roster_memberships')
        .select('team_entry_id')
        .where('person_id', '=', personId)
        .where('team_entry_id', 'in', entryIds)
        .where('status', 'in', ['active', 'guest', 'substitute'])
        .where('effective_to', 'is', null)
        .execute();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const a = await teamOf(season.seasonId, { divisionId: division });
      const b = await teamOf(season.seasonId, { divisionId: division });
      const x = await createPersonFixture(t, { kind: 'adult' });
      const results = await Promise.all([
        add(a.teamEntryId, a.captain, x),
        add(b.teamEntryId, b.captain, x),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 422]);
      const refused = results.find((r) => r.status === 422);
      expect(reasonCodes(refused?.body ?? {})).toEqual(['already_in_division']);
      expect(await playingRows(x, [a.teamEntryId, b.teamEntryId])).toHaveLength(1);

      const y = await adultCustomer(t);
      const requests = [];
      for (const team of [a, b]) {
        const requested = await post(`/team-entries/${team.teamEntryId}/join-requests`, y, {});
        expect(requested.status).toBe(201);
        requests.push({ team, id: requested.body.id as string });
      }
      const decisions = await Promise.all(
        requests.map(({ team, id }) =>
          post(`/join-requests/${id}/decide`, team.captain, { decision: 'approve' }),
        ),
      );
      expect(decisions.map((r) => r.status).sort()).toEqual([200, 422]);
      expect(await playingRows(y.personId, [a.teamEntryId, b.teamEntryId])).toHaveLength(1);
    }
  });

  it('entries that are not live take no players; a captain whose entry is withdrawn loses nothing from history', async () => {
    const team = await teamOf(season.seasonId);
    const p = await createPersonFixture(t, { kind: 'adult' });
    await add(team.teamEntryId, team.captain, p);
    const withdrawn = await post(`/team-entries/${team.teamEntryId}/withdraw`, team.captain, {
      expectedRevision: 2,
      reason: 'folded',
    });
    expect(withdrawn.status).toBe(200);
    const late = await add(
      team.teamEntryId,
      team.captain,
      await createPersonFixture(t, { kind: 'adult' }),
    );
    expect(late.status).toBe(422);
    expect(reasonCodes(late.body)).toContain('entry_not_active');
    const stillThere = await addRosterMemberFixture(t, {
      teamEntryId: team.teamEntryId,
      personId: await createPersonFixture(t, { kind: 'adult' }),
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      effectiveTo: new Date('2026-02-01T00:00:00Z'),
    });
    expect(stillThere).toEqual(expect.any(String));
    const history = await t.http
      .get(`/v1/team-entries/${team.teamEntryId}/roster`)
      .set(team.captain.header)
      .query({ includeHistory: 'true' });
    expect(history.status).toBe(200);
    expect(history.body.members).toHaveLength(2);
  });
  it('SPK-CAP-002 / SPK-DISC-004: captains see eligibility codes without suspension basis, suspension ids or computed ages', async () => {
    const youth = await createSeasonFixture(t, { startsOn: '2027-01-10', endsOn: '2027-04-10' });
    const u12 = await createDivisionFixture(t, {
      seasonId: youth.seasonId,
      criteria: { ageBand: { minAge: 6, maxAge: 12 } },
    });
    const team = await teamOf(youth.seasonId, { divisionId: u12 });
    const tooOld = await createPersonFixture(t, { kind: 'child', dateOfBirth: '2014-01-05' });
    const banned = await adultCustomer(t);
    const leak = (body: unknown) => {
      const text = JSON.stringify(body);
      expect(text).not.toContain('card accumulation');
      expect(text).not.toContain('suspension-1');
      expect(text).not.toMatch(/Age \d+/);
    };
    const adultTeam = await teamOf(season.seasonId);
    const explain = (actor: Actor, personId: string, entryId = team.teamEntryId) =>
      t.http.get(`/v1/team-entries/${entryId}/eligibility`).set(actor.header).query({ personId });

    // explain: an age band reason keeps the code, the limit and the reference date only
    const age = await explain(team.captain, tooOld);
    expect(age.status).toBe(200);
    expect(age.body.reasons).toEqual([
      expect.objectContaining({
        code: 'above_division_age',
        source: { type: 'division', id: u12 },
      }),
    ]);
    expect(age.body.reasons[0].message).toContain('12');
    expect(age.body.reasons[0].message).toContain('2027-01-10');
    leak(age.body);

    suspended.add(banned.personId);
    // explain, roster add, invitation and join-request approval: codes only for the captain
    const explained = await explain(adultTeam.captain, banned.personId, adultTeam.teamEntryId);
    expect(explained.body.reasons).toEqual([
      expect.objectContaining({ code: 'suspended', source: { type: 'suspension', id: null } }),
    ]);
    leak(explained.body);
    const added = await add(adultTeam.teamEntryId, adultTeam.captain, banned.personId);
    expect(added.status).toBe(422);
    expect(reasonCodes(added.body)).toEqual(['suspended']);
    leak(added.body);
    const invited = await post(
      `/team-entries/${adultTeam.teamEntryId}/invitations`,
      adultTeam.captain,
      { recipientPersonId: banned.personId },
    );
    expect(invited.status).toBe(422);
    expect(reasonCodes(invited.body)).toEqual(['suspended']);
    leak(invited.body);
    suspended.delete(banned.personId);
    const requested = await post(
      `/team-entries/${adultTeam.teamEntryId}/join-requests`,
      banned,
      {},
    );
    expect(requested.status).toBe(201);
    suspended.add(banned.personId);
    const approval = await post(`/join-requests/${requested.body.id}/decide`, adultTeam.captain, {
      decision: 'approve',
    });
    expect(approval.status).toBe(422);
    expect(reasonCodes(approval.body)).toEqual(['suspended']);
    leak(approval.body);

    // staff still see the suspension id and the computed age
    const staffExplained = await explain(leagueManager, banned.personId, adultTeam.teamEntryId);
    expect(staffExplained.body.reasons).toEqual([
      expect.objectContaining({
        code: 'suspended',
        source: { type: 'suspension', id: 'suspension-1' },
      }),
    ]);
    expect(JSON.stringify(staffExplained.body)).not.toContain('card accumulation');
    suspended.delete(banned.personId);
    const staffAge = await explain(leagueManager, tooOld);
    expect(staffAge.body.reasons[0].message).toContain('Age 13 on 2027-01-10');
  });
});
