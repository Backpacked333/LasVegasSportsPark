import { newId } from '@sportspark/contracts';
import {
  createTestDatabase,
  isCheckViolation,
  isForeignKeyViolation,
  isUniqueViolation,
  json,
  pgConstraintName,
  seedOrganization,
  type Db,
  type TestDatabase,
} from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, loadConfig, LocalJwtIdentityProvider } from '../../../kernel';
import { TEST_CONFIG_ENV } from '../../../testing/test-app';
import { createPersonFixture, type IdentityFixtureContext } from '../../identity';
import {
  CompetitionMachine,
  FixtureMachine,
  JoinRequestMachine,
  SeasonMachine,
  TeamEntryMachine,
  TeamInvitationMachine,
  TeamMachine,
} from '../competition.state-machines';
import {
  addRosterMemberFixture,
  assignTeamRoleFixture,
  createCompetitionFixture,
  createDivisionFixture,
  createFixtureFixture,
  createRuleSetFixture,
  createSeasonFixture,
  createTeamEntryFixture,
  type CompetitionFixtureContext,
} from '../testing/competition-fixtures';
import { isRestrictViolation } from './support';

/**
 * Integrity that matters is enforced by the database (§4.7): each test inserts or updates the
 * violating row directly through Kysely and expects the constraint, index or trigger to reject it.
 */
describe('competition schema invariants (migration 0400)', () => {
  let t: TestDatabase;
  let db: Db;
  let ctx: CompetitionFixtureContext & IdentityFixtureContext;
  let otherOrg: { organizationId: string; facilityId: string };
  const actor = json({ kind: 'system', actorLabel: 'schema-test' });
  const clock = new FixedClock('2026-10-23T12:00:00Z');

  beforeAll(async () => {
    t = await createTestDatabase();
    db = t.db;
    const seeded = await seedOrganization(db);
    otherOrg = await seedOrganization(db);
    const config = loadConfig(TEST_CONFIG_ENV);
    ctx = {
      db,
      clock,
      config,
      identityProvider: new LocalJwtIdentityProvider(config),
      organizationId: seeded.organizationId,
      facilityId: seeded.facilityId,
    };
  });
  afterAll(async () => {
    await t.close();
  });

  async function entryWithCaptain(seasonId?: string) {
    const season = seasonId ? { seasonId } : await createSeasonFixture(ctx);
    const captain = await createPersonFixture(ctx, { kind: 'adult' });
    const entry = await createTeamEntryFixture(ctx, {
      seasonId: season.seasonId,
      captainPersonId: captain,
    });
    return { seasonId: season.seasonId, captain, ...entry };
  }

  it('SPK-IAM-001 "Team role": one active role per person per team entry; a new role may follow an ended one', async () => {
    const { teamEntryId, captain } = await entryWithCaptain();
    await expect(
      assignTeamRoleFixture(ctx, { teamEntryId, personId: captain, role: 'co_captain' }),
    ).rejects.toSatisfy(isUniqueViolation);
    await db
      .updateTable('team_roles')
      .set({ effective_to: clock.now(), ended_by: actor, ended_reason: 'handover' })
      .where('team_entry_id', '=', teamEntryId)
      .where('person_id', '=', captain)
      .execute();
    await assignTeamRoleFixture(ctx, { teamEntryId, personId: captain, role: 'member' });
    const rows = await db
      .selectFrom('team_roles')
      .select(['role', 'effective_to'])
      .where('team_entry_id', '=', teamEntryId)
      .orderBy('created_at')
      .execute();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.effective_to).not.toBeNull();
    // the window is never inverted
    await expect(
      assignTeamRoleFixture(ctx, {
        teamEntryId,
        personId: await createPersonFixture(ctx, { kind: 'adult' }),
        role: 'member',
        effectiveFrom: new Date('2026-10-23T12:00:00Z'),
        effectiveTo: new Date('2026-10-22T12:00:00Z'),
      }),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('SPK-COMP-005: no two open roster rows for one person; removal keeps the row and needs its companions', async () => {
    const { teamEntryId } = await entryWithCaptain();
    const player = await createPersonFixture(ctx, { kind: 'adult' });
    const first = await addRosterMemberFixture(ctx, { teamEntryId, personId: player });
    await expect(
      addRosterMemberFixture(ctx, { teamEntryId, personId: player, status: 'guest' }),
    ).rejects.toSatisfy(isUniqueViolation);
    // a removal without effective_to / removed_at / prior status is rejected
    await expect(
      db
        .updateTable('roster_memberships')
        .set({ status: 'removed' })
        .where('id', '=', first)
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
    await db
      .updateTable('roster_memberships')
      .set({
        status: 'removed',
        status_before_removal: 'active',
        effective_to: new Date('2026-10-30T12:00:00Z'),
        removed_at: clock.now(),
        removed_by: actor,
        removal_reason: 'left the team',
      })
      .where('id', '=', first)
      .execute();
    // the history row survives and a new membership can open
    const kept = await db
      .selectFrom('roster_memberships')
      .selectAll()
      .where('id', '=', first)
      .executeTakeFirst();
    expect(kept).toMatchObject({ status: 'removed', status_before_removal: 'active' });
    await addRosterMemberFixture(ctx, {
      teamEntryId,
      personId: player,
      effectiveFrom: new Date('2026-11-01T12:00:00Z'),
    });
    // a jersey number is unique among playing rows
    const other = await createPersonFixture(ctx, { kind: 'adult' });
    const third = await createPersonFixture(ctx, { kind: 'adult' });
    await addRosterMemberFixture(ctx, { teamEntryId, personId: other, jerseyNumber: 9 });
    await expect(
      addRosterMemberFixture(ctx, { teamEntryId, personId: third, jerseyNumber: 9 }),
    ).rejects.toSatisfy(isUniqueViolation);
  });

  it('§4.3: a roster row, a team role or an entry can never point at another organization', async () => {
    const { teamEntryId } = await entryWithCaptain();
    const foreigner = await createPersonFixture(ctx, {
      kind: 'adult',
      organizationId: otherOrg.organizationId,
    });
    await expect(
      addRosterMemberFixture(ctx, { teamEntryId, personId: foreigner }),
    ).rejects.toSatisfy(isForeignKeyViolation);
    await expect(
      assignTeamRoleFixture(ctx, { teamEntryId, personId: foreigner, role: 'member' }),
    ).rejects.toSatisfy(isForeignKeyViolation);
    const foreignSeason = await createSeasonFixture(ctx, {
      organizationId: otherOrg.organizationId,
    });
    const captain = await createPersonFixture(ctx, { kind: 'adult' });
    await expect(
      createTeamEntryFixture(ctx, { seasonId: foreignSeason.seasonId, captainPersonId: captain }),
    ).rejects.toSatisfy(isForeignKeyViolation);
  });

  it('§4.7 (2): one live entry per team per season; a withdrawn entry frees the slot', async () => {
    const { seasonId, teamId, teamEntryId, captain } = await entryWithCaptain();
    await expect(
      createTeamEntryFixture(ctx, {
        seasonId,
        captainPersonId: captain,
        teamId,
        status: 'applied',
      }),
    ).rejects.toSatisfy(isUniqueViolation);
    await db
      .updateTable('team_entries')
      .set({
        status: 'withdrawn',
        withdrawn_at: clock.now(),
        withdrawn_by: actor,
        withdrawal_reason: 'folded',
      })
      .where('id', '=', teamEntryId)
      .execute();
    await createTeamEntryFixture(ctx, {
      seasonId,
      captainPersonId: captain,
      teamId,
      status: 'applied',
    });
  });

  it('SPK-COMP-004: the entry status and its approval, rejection and withdrawal facts agree', async () => {
    const { seasonId, captain } = await entryWithCaptain();
    const entry = await createTeamEntryFixture(ctx, {
      seasonId,
      captainPersonId: captain,
      status: 'applied',
    });
    await expect(
      db
        .updateTable('team_entries')
        .set({ status: 'approved' })
        .where('id', '=', entry.teamEntryId)
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      db
        .updateTable('team_entries')
        .set({ approved_at: clock.now(), approved_by: actor })
        .where('id', '=', entry.teamEntryId)
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      db
        .updateTable('team_entries')
        .set({ status: 'bogus' as 'approved' })
        .where('id', '=', entry.teamEntryId)
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
    // an approved entry that withdraws keeps its approval as history; a rejected one cannot have been approved
    await db
      .updateTable('team_entries')
      .set({ status: 'approved', approved_at: clock.now(), approved_by: actor })
      .where('id', '=', entry.teamEntryId)
      .execute();
    await db
      .updateTable('team_entries')
      .set({
        status: 'withdrawn',
        withdrawn_at: clock.now(),
        withdrawn_by: actor,
        withdrawal_reason: 'folded',
      })
      .where('id', '=', entry.teamEntryId)
      .execute();
    const withdrawn = await db
      .selectFrom('team_entries')
      .select(['approved_at', 'withdrawn_at'])
      .where('id', '=', entry.teamEntryId)
      .executeTakeFirstOrThrow();
    expect(withdrawn.approved_at).not.toBeNull();
    expect(withdrawn.withdrawn_at).not.toBeNull();
    await expect(
      db
        .updateTable('team_entries')
        .set({
          status: 'rejected',
          withdrawn_at: null,
          withdrawn_by: null,
          withdrawal_reason: null,
          rejected_at: clock.now(),
          rejected_by: actor,
          rejection_reason: 'x',
        })
        .where('id', '=', entry.teamEntryId)
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('§4.7 (3): division capacity is enforced by the database on placement', async () => {
    const season = await createSeasonFixture(ctx);
    const division = await createDivisionFixture(ctx, {
      seasonId: season.seasonId,
      capacityTeamEntries: 1,
    });
    const c1 = await createPersonFixture(ctx, { kind: 'adult' });
    const c2 = await createPersonFixture(ctx, { kind: 'adult' });
    await createTeamEntryFixture(ctx, {
      seasonId: season.seasonId,
      captainPersonId: c1,
      divisionId: division,
    });
    const second = await createTeamEntryFixture(ctx, {
      seasonId: season.seasonId,
      captainPersonId: c2,
    });
    let failure: unknown;
    try {
      await db
        .updateTable('team_entries')
        .set({ division_id: division })
        .where('id', '=', second.teamEntryId)
        .execute();
    } catch (error) {
      failure = error;
    }
    expect(isCheckViolation(failure)).toBe(true);
    expect(pgConstraintName(failure)).toBe('team_entries_division_capacity');
    // a division of another season cannot be referenced
    const otherSeason = await createSeasonFixture(ctx);
    const otherDivision = await createDivisionFixture(ctx, { seasonId: otherSeason.seasonId });
    await expect(
      db
        .updateTable('team_entries')
        .set({ division_id: otherDivision })
        .where('id', '=', second.teamEntryId)
        .execute(),
    ).rejects.toSatisfy(isForeignKeyViolation);
  });

  it('SPK-COMP-002: a rule-set version is immutable (append-only), and versions chain by name', async () => {
    const v1 = await createRuleSetFixture(ctx, { name: 'Immutable', format: 'futsal' });
    await expect(
      db
        .updateTable('rule_sets')
        .set({ content: json({ changed: true }) })
        .where('id', '=', v1.id)
        .execute(),
    ).rejects.toSatisfy(isRestrictViolation);
    await expect(db.deleteFrom('rule_sets').where('id', '=', v1.id).execute()).rejects.toSatisfy(
      isRestrictViolation,
    );
    // version 2 must name what it supersedes; version 1 must not
    await expect(
      createRuleSetFixture(ctx, {
        name: 'Immutable',
        format: 'futsal',
        version: 2,
        supersedesRuleSetId: null,
      }),
    ).rejects.toSatisfy(isCheckViolation);
    await createRuleSetFixture(ctx, {
      name: 'Immutable',
      format: 'futsal',
      version: 2,
      supersedesRuleSetId: v1.id,
    });
    await expect(
      createRuleSetFixture(ctx, {
        name: 'Immutable',
        format: 'futsal',
        version: 2,
        supersedesRuleSetId: v1.id,
      }),
    ).rejects.toSatisfy(isUniqueViolation);
  });

  it('§4.4 Matches: a fixture never pairs an entry with itself, and `scheduled` needs a scheduling event', async () => {
    const a = await entryWithCaptain();
    const b = await entryWithCaptain(a.seasonId);
    await expect(
      createFixtureFixture(ctx, {
        seasonId: a.seasonId,
        homeEntryId: a.teamEntryId,
        awayEntryId: a.teamEntryId,
      }),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      createFixtureFixture(ctx, {
        seasonId: a.seasonId,
        homeEntryId: a.teamEntryId,
        awayEntryId: b.teamEntryId,
        status: 'scheduled',
        scheduledStart: new Date('2027-01-16T02:00:00Z'),
        scheduledEnd: new Date('2027-01-16T03:00:00Z'),
      }),
    ).rejects.toSatisfy(isCheckViolation);
    // an entry of another season cannot play in this one
    const elsewhere = await entryWithCaptain();
    await expect(
      createFixtureFixture(ctx, {
        seasonId: a.seasonId,
        homeEntryId: a.teamEntryId,
        awayEntryId: elsewhere.teamEntryId,
      }),
    ).rejects.toSatisfy(isForeignKeyViolation);
    // a bye is a fixture without an opponent
    await createFixtureFixture(ctx, { seasonId: a.seasonId, homeEntryId: a.teamEntryId, round: 1 });
  });

  it('SPK-CAP-003: one RSVP per person per fixture; no_response has no response instant', async () => {
    const a = await entryWithCaptain();
    const b = await entryWithCaptain(a.seasonId);
    const fixture = await createFixtureFixture(ctx, {
      seasonId: a.seasonId,
      homeEntryId: a.teamEntryId,
      awayEntryId: b.teamEntryId,
    });
    const insert = (state: 'available' | 'no_response', respondedAt: Date | null) =>
      db
        .insertInto('availability_responses')
        .values({
          id: newId(),
          organization_id: ctx.organizationId,
          fixture_id: fixture,
          team_entry_id: a.teamEntryId,
          person_id: a.captain,
          state,
          responded_at: respondedAt,
          responded_by: actor,
          note: null,
        })
        .execute();
    await expect(insert('no_response', clock.now())).rejects.toSatisfy(isCheckViolation);
    await expect(insert('available', null)).rejects.toSatisfy(isCheckViolation);
    await insert('available', clock.now());
    await expect(insert('available', clock.now())).rejects.toSatisfy(isUniqueViolation);
  });

  it('SPK-IAM-004: an invitation names exactly one recipient and at most one pending per recipient', async () => {
    const { teamEntryId } = await entryWithCaptain();
    const recipient = await createPersonFixture(ctx, { kind: 'adult' });
    const insert = (values: {
      recipient_person_id: string | null;
      recipient_contact_kind: 'email' | null;
      recipient_contact_value: string | null;
    }) =>
      db
        .insertInto('team_invitations')
        .values({
          id: newId(),
          organization_id: ctx.organizationId,
          team_entry_id: teamEntryId,
          invited_by: actor,
          invited_by_person_id: null,
          ...values,
          message: null,
          token_hash: newId(),
          expires_at: new Date('2026-10-30T12:00:00Z'),
          accepted_at: null,
          accepted_by_person_id: null,
          declined_at: null,
          revoked_at: null,
          revoked_by: null,
          revocation_reason: null,
          roster_membership_id: null,
        })
        .execute();
    await expect(
      insert({
        recipient_person_id: recipient,
        recipient_contact_kind: 'email',
        recipient_contact_value: 'x@example.test',
      }),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      insert({
        recipient_person_id: null,
        recipient_contact_kind: null,
        recipient_contact_value: null,
      }),
    ).rejects.toSatisfy(isCheckViolation);
    await insert({
      recipient_person_id: recipient,
      recipient_contact_kind: null,
      recipient_contact_value: null,
    });
    await expect(
      insert({
        recipient_person_id: recipient,
        recipient_contact_kind: null,
        recipient_contact_value: null,
      }),
    ).rejects.toSatisfy(isUniqueViolation);
  });

  it('§4.6: the check constraints accept exactly the state-machine states', async () => {
    const competitionId = await createCompetitionFixture(ctx);
    for (const status of CompetitionMachine.states) {
      await db
        .updateTable('competitions')
        .set({ status })
        .where('id', '=', competitionId)
        .execute();
    }
    const season = await createSeasonFixture(ctx, { competitionId });
    for (const status of SeasonMachine.states) {
      await db.updateTable('seasons').set({ status }).where('id', '=', season.seasonId).execute();
    }
    await expect(
      db
        .updateTable('seasons')
        .set({ status: 'closed' as 'open' })
        .where('id', '=', season.seasonId)
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
    const { teamId, teamEntryId, captain } = await entryWithCaptain(season.seasonId);
    for (const status of TeamMachine.states) {
      await db.updateTable('teams').set({ status }).where('id', '=', teamId).execute();
    }
    for (const status of TeamEntryMachine.states) {
      // companion facts travel with the status (SPK-COMP-004)
      await db
        .updateTable('team_entries')
        .set({
          status,
          approved_at: status === 'approved' ? clock.now() : null,
          approved_by: status === 'approved' ? actor : null,
          rejected_at: status === 'rejected' ? clock.now() : null,
          rejected_by: status === 'rejected' ? actor : null,
          withdrawn_at: status === 'withdrawn' ? clock.now() : null,
          withdrawn_by: status === 'withdrawn' ? actor : null,
        })
        .where('id', '=', teamEntryId)
        .execute();
    }
    const fixture = await createFixtureFixture(ctx, {
      seasonId: season.seasonId,
      homeEntryId: teamEntryId,
    });
    for (const status of FixtureMachine.states) {
      if (status === 'scheduled') continue; // needs a scheduling event (covered above)
      await db.updateTable('fixtures').set({ status }).where('id', '=', fixture).execute();
    }
    await expect(
      db
        .updateTable('fixtures')
        .set({ status: 'done' as 'played' })
        .where('id', '=', fixture)
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
    const inviteId = newId();
    await db
      .insertInto('team_invitations')
      .values({
        id: inviteId,
        organization_id: ctx.organizationId,
        team_entry_id: teamEntryId,
        invited_by: actor,
        invited_by_person_id: null,
        recipient_person_id: captain,
        recipient_contact_kind: null,
        recipient_contact_value: null,
        message: null,
        token_hash: newId(),
        expires_at: clock.now(),
        accepted_at: null,
        accepted_by_person_id: null,
        declined_at: null,
        revoked_at: null,
        revoked_by: null,
        revocation_reason: null,
        roster_membership_id: null,
      })
      .execute();
    for (const status of TeamInvitationMachine.states) {
      await db
        .updateTable('team_invitations')
        .set({ status, accepted_at: status === 'accepted' ? clock.now() : null })
        .where('id', '=', inviteId)
        .execute();
    }
    const requestId = newId();
    await db
      .insertInto('join_requests')
      .values({
        id: requestId,
        organization_id: ctx.organizationId,
        team_entry_id: teamEntryId,
        person_id: captain,
        requested_by: actor,
        requested_by_person_id: null,
        message: null,
        decided_by: null,
        decided_by_person_id: null,
        decided_at: null,
        decision_note: null,
        roster_membership_id: null,
      })
      .execute();
    for (const status of JoinRequestMachine.states) {
      await db
        .updateTable('join_requests')
        .set({ status, decided_at: status === 'pending' ? null : clock.now() })
        .where('id', '=', requestId)
        .execute();
    }
  });
});
