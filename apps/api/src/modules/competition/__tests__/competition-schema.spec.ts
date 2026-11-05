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

  it('R4-DB-INVARIANTS-10 / SPK-COMP-005: roster history is never deleted or rewritten; a closed membership never changes and an open one may only be closed', async () => {
    const { teamEntryId } = await entryWithCaptain();
    const player = await createPersonFixture(ctx, { kind: 'adult' });
    const someoneElse = await createPersonFixture(ctx, { kind: 'adult' });
    const membership = await addRosterMemberFixture(ctx, {
      teamEntryId,
      personId: player,
      effectiveFrom: new Date('2026-09-01T12:00:00Z'),
      jerseyNumber: 7,
    });
    const constraintOf = async (run: () => Promise<unknown>) => {
      const error = await run().then(
        () => null,
        (e: unknown) => e,
      );
      expect(error, 'the database accepted a rewrite of roster history').not.toBeNull();
      expect(isRestrictViolation(error)).toBe(true);
      return pgConstraintName(error);
    };
    const update = (set: Record<string, unknown>) => () =>
      db.updateTable('roster_memberships').set(set).where('id', '=', membership).execute();

    // An open row keeps who, where and since when it covers, and its status until it closes.
    expect(await constraintOf(update({ person_id: someoneElse }))).toBe(
      'roster_memberships_open_immutable',
    );
    expect(await constraintOf(update({ effective_from: new Date('2026-10-20T12:00:00Z') }))).toBe(
      'roster_memberships_open_immutable',
    );
    expect(await constraintOf(update({ status: 'guest' }))).toBe(
      'roster_memberships_open_immutable',
    );
    expect(await constraintOf(update({ removal_reason: 'not closed' }))).toBe(
      'roster_memberships_open_immutable',
    );
    expect(await constraintOf(update({ effective_to: clock.now(), status: 'guest' }))).toBe(
      'roster_memberships_open_immutable',
    );
    // ...its jersey may change...
    await update({ jersey_number: 8 })();
    // ...and it closes only as a removal of the status it held, recording who removed it and why
    // (0462): not as the removal of another status, not with its status kept and nothing recorded,
    // and not back to its own start so that it covers no instant.
    const removal = {
      status: 'removed',
      status_before_removal: 'active',
      effective_to: new Date('2026-10-20T12:00:00Z'),
      removed_at: clock.now(),
      removed_by: actor,
      removal_reason: 'left the team',
    };
    expect(await constraintOf(update({ ...removal, status_before_removal: 'guest' }))).toBe(
      'roster_memberships_open_immutable',
    );
    expect(await constraintOf(update({ effective_to: new Date('2026-10-20T12:00:00Z') }))).toBe(
      'roster_memberships_open_immutable',
    );
    expect(await constraintOf(update({ effective_to: new Date('2026-09-01T12:00:00Z') }))).toBe(
      'roster_memberships_open_immutable',
    );
    expect(await constraintOf(update({ ...removal, removed_by: null }))).toBe(
      'roster_memberships_open_immutable',
    );
    expect(await constraintOf(update({ ...removal, removal_reason: null }))).toBe(
      'roster_memberships_open_immutable',
    );
    expect(await constraintOf(update({ ...removal, removal_reason: '  ' }))).toBe(
      'roster_memberships_open_immutable',
    );
    await update(removal)();

    // A closed row is history: it is never deleted, re-dated, reopened or rewritten.
    expect(
      await constraintOf(() =>
        db.deleteFrom('roster_memberships').where('id', '=', membership).execute(),
      ),
    ).toBe('roster_memberships_no_delete');
    expect(await constraintOf(update({ effective_from: new Date('2026-10-01T12:00:00Z') }))).toBe(
      'roster_memberships_closed_immutable',
    );
    expect(await constraintOf(update({ effective_to: new Date('2026-10-22T12:00:00Z') }))).toBe(
      'roster_memberships_closed_immutable',
    );
    expect(
      await constraintOf(
        update({
          status: 'active',
          status_before_removal: null,
          effective_to: null,
          removed_at: null,
          removed_by: null,
          removal_reason: null,
        }),
      ),
    ).toBe('roster_memberships_closed_immutable');
    expect(await constraintOf(update({ removal_reason: 'rewritten' }))).toBe(
      'roster_memberships_closed_immutable',
    );
    expect(await constraintOf(update({ jersey_number: 9 }))).toBe(
      'roster_memberships_closed_immutable',
    );
    // An open row is not deleted either.
    const pending = await addRosterMemberFixture(ctx, { teamEntryId, personId: someoneElse });
    expect(
      await constraintOf(() =>
        db.deleteFrom('roster_memberships').where('id', '=', pending).execute(),
      ),
    ).toBe('roster_memberships_no_delete');
    const kept = await db
      .selectFrom('roster_memberships')
      .select(['person_id', 'effective_from', 'effective_to', 'status', 'removal_reason'])
      .where('id', '=', membership)
      .executeTakeFirstOrThrow();
    expect(kept).toMatchObject({
      person_id: player,
      status: 'removed',
      removal_reason: 'left the team',
    });
    expect(new Date(kept.effective_from).toISOString()).toBe('2026-09-01T12:00:00.000Z');
    expect(new Date(kept.effective_to as Date).toISOString()).toBe('2026-10-20T12:00:00.000Z');
  });

  it('R4-DB-INVARIANTS-10 / SPK-COMP-005: closing a roster row never rewrites the status it conferred; a pending row closes as it was', async () => {
    const { teamEntryId } = await entryWithCaptain();
    const from = new Date('2026-09-01T12:00:00Z');
    const to = new Date('2026-10-20T12:00:00Z');
    const pendingRow = async (status: 'invited' | 'requested') => {
      const id = newId();
      await db
        .insertInto('roster_memberships')
        .values({
          id,
          organization_id: ctx.organizationId,
          team_entry_id: teamEntryId,
          person_id: await createPersonFixture(ctx, { kind: 'adult' }),
          status,
          status_before_removal: null,
          effective_from: from,
          effective_to: null,
          jersey_number: null,
          source: status === 'invited' ? 'invitation' : 'join_request',
          added_by: actor,
          added_by_person_id: null,
          removed_at: null,
          removed_by: null,
          removal_reason: null,
        })
        .execute();
      return id;
    };
    const invited = await pendingRow('invited');
    const requested = await pendingRow('requested');
    const guest = await addRosterMemberFixture(ctx, {
      teamEntryId,
      personId: await createPersonFixture(ctx, { kind: 'adult' }),
      status: 'guest',
      effectiveFrom: from,
    });
    const constraintOf = async (run: () => Promise<unknown>) => {
      const error = await run().then(
        () => null,
        (e: unknown) => e,
      );
      expect(error, 'the database accepted a rewrite of roster history').not.toBeNull();
      expect(isRestrictViolation(error)).toBe(true);
      return pgConstraintName(error);
    };
    const update = (id: string, set: Record<string, unknown>) => () =>
      db.updateTable('roster_memberships').set(set).where('id', '=', id).execute();
    const removalOf = (prior: 'active' | 'guest' | 'substitute') => ({
      status: 'removed',
      status_before_removal: prior,
      effective_to: to,
      removed_at: clock.now(),
      removed_by: actor,
      removal_reason: 'left the team',
    });

    // A pending invitation or join request conferred no status: it is never closed as the removal
    // of a playing membership, and a close records no removal facts.
    expect(await constraintOf(update(invited, removalOf('active')))).toBe(
      'roster_memberships_open_immutable',
    );
    expect(await constraintOf(update(requested, removalOf('guest')))).toBe(
      'roster_memberships_open_immutable',
    );
    expect(
      await constraintOf(
        update(invited, { effective_to: to, removed_by: actor, removal_reason: 'declined' }),
      ),
    ).toBe('roster_memberships_open_immutable');
    // A guest is not closed as the removal of an active player (or any other status).
    expect(await constraintOf(update(guest, removalOf('active')))).toBe(
      'roster_memberships_open_immutable',
    );
    expect(await constraintOf(update(guest, removalOf('substitute')))).toBe(
      'roster_memberships_open_immutable',
    );

    // What RosterService writes is accepted: a pending row closes as it was, a removal records the
    // status the row held.
    await update(invited, { effective_to: to })();
    await update(requested, { effective_to: to })();
    await update(guest, removalOf('guest'))();
    const rows = await db
      .selectFrom('roster_memberships')
      .select(['id', 'status', 'status_before_removal', 'removed_by', 'removal_reason'])
      .where('id', 'in', [invited, requested, guest])
      .execute();
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(invited)).toMatchObject({
      status: 'invited',
      status_before_removal: null,
      removed_by: null,
      removal_reason: null,
    });
    expect(byId.get(requested)).toMatchObject({ status: 'requested', status_before_removal: null });
    expect(byId.get(guest)).toMatchObject({
      status: 'removed',
      status_before_removal: 'guest',
      removal_reason: 'left the team',
    });
  });

  it('R4-DB-INVARIANTS-10 / SPK-IAM-001: team-role authority history is never deleted or rewritten; an open role may only be ended', async () => {
    const { teamEntryId, captain } = await entryWithCaptain();
    const member = await createPersonFixture(ctx, { kind: 'adult' });
    const roleId = await assignTeamRoleFixture(ctx, {
      teamEntryId,
      personId: member,
      role: 'co_captain',
      effectiveFrom: new Date('2026-09-01T12:00:00Z'),
    });
    const constraintOf = async (run: () => Promise<unknown>) => {
      const error = await run().then(
        () => null,
        (e: unknown) => e,
      );
      expect(error, 'the database accepted a rewrite of team-role history').not.toBeNull();
      expect(isRestrictViolation(error)).toBe(true);
      return pgConstraintName(error);
    };
    const update = (set: Record<string, unknown>) => () =>
      db.updateTable('team_roles').set(set).where('id', '=', roleId).execute();

    expect(await constraintOf(update({ role: 'captain' }))).toBe('team_roles_open_immutable');
    expect(await constraintOf(update({ person_id: captain }))).toBe('team_roles_open_immutable');
    expect(await constraintOf(update({ effective_from: new Date('2026-10-01T12:00:00Z') }))).toBe(
      'team_roles_open_immutable',
    );
    expect(await constraintOf(update({ ended_reason: 'not ended' }))).toBe(
      'team_roles_open_immutable',
    );
    // A role ends only with who ended it and why (0463): not silently, not back to its own start
    // with nothing recorded, and not without a reason.
    expect(await constraintOf(update({ effective_to: new Date('2026-10-20T12:00:00Z') }))).toBe(
      'team_roles_open_immutable',
    );
    expect(await constraintOf(update({ effective_to: new Date('2026-09-01T12:00:00Z') }))).toBe(
      'team_roles_open_immutable',
    );
    expect(
      await constraintOf(
        update({ effective_to: new Date('2026-10-20T12:00:00Z'), ended_by: actor }),
      ),
    ).toBe('team_roles_open_immutable');
    expect(
      await constraintOf(
        update({ effective_to: new Date('2026-10-20T12:00:00Z'), ended_reason: 'handover' }),
      ),
    ).toBe('team_roles_open_immutable');
    expect(
      await constraintOf(
        update({
          effective_to: new Date('2026-10-20T12:00:00Z'),
          ended_by: actor,
          ended_reason: ' ',
        }),
      ),
    ).toBe('team_roles_open_immutable');
    await update({
      effective_to: new Date('2026-10-20T12:00:00Z'),
      ended_by: actor,
      ended_reason: 'handover',
    })();
    expect(
      await constraintOf(() => db.deleteFrom('team_roles').where('id', '=', roleId).execute()),
    ).toBe('team_roles_no_delete');
    expect(await constraintOf(update({ effective_to: null }))).toBe('team_roles_closed_immutable');
    expect(await constraintOf(update({ effective_from: new Date('2026-10-01T12:00:00Z') }))).toBe(
      'team_roles_closed_immutable',
    );
    expect(await constraintOf(update({ ended_reason: 'rewritten' }))).toBe(
      'team_roles_closed_immutable',
    );
    const captainRole = await db
      .selectFrom('team_roles')
      .select('id')
      .where('team_entry_id', '=', teamEntryId)
      .where('person_id', '=', captain)
      .executeTakeFirstOrThrow();
    expect(
      await constraintOf(() =>
        db.deleteFrom('team_roles').where('id', '=', captainRole.id).execute(),
      ),
    ).toBe('team_roles_no_delete');
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
        .set({
          status,
          accepted_at: status === 'accepted' ? clock.now() : null,
          // migration 0454: a declined invitation records when it was declined
          declined_at: status === 'declined' ? clock.now() : null,
        })
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
