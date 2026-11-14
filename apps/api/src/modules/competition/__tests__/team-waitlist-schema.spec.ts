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
  createDivisionFixture,
  createSeasonFixture,
  createTeamEntryFixture,
  type CompetitionFixtureContext,
} from '../testing/competition-fixtures';
import { isRestrictViolation } from './support';

/**
 * Team waiting list integrity (SPK-COMP-006, migration 0467). Each test writes the violating row
 * directly through Kysely and expects the constraint, index or trigger to reject it (§4.7): the
 * service checks give earlier feedback but are not the guarantee.
 */
describe('team waiting list schema invariants (SPK-COMP-006, migration 0467)', () => {
  let t: TestDatabase;
  let db: Db;
  let ctx: CompetitionFixtureContext & IdentityFixtureContext;
  let otherOrg: { organizationId: string; facilityId: string };
  const actor = json({ kind: 'system', actorLabel: 'schema-test' });
  const clock = new FixedClock('2026-10-23T12:00:00Z');
  const later = new Date('2026-10-25T12:00:00Z');

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

  async function setup(capacity: number | null = 1) {
    const season = await createSeasonFixture(ctx);
    const divisionId = await createDivisionFixture(ctx, {
      seasonId: season.seasonId,
      capacityTeamEntries: capacity,
    });
    return { seasonId: season.seasonId, divisionId };
  }

  async function entry(
    seasonId: string,
    input: Partial<Parameters<typeof createTeamEntryFixture>[1]> = {},
  ): Promise<string> {
    const captain = await createPersonFixture(ctx, { kind: 'adult' });
    const created = await createTeamEntryFixture(ctx, {
      seasonId,
      captainPersonId: captain,
      ...input,
    });
    return created.teamEntryId;
  }

  const offer = (
    seasonId: string,
    teamEntryId: string,
    divisionId: string,
    overrides: Record<string, unknown> = {},
  ) =>
    db
      .insertInto('team_entry_place_offers')
      .values({
        id: newId(),
        organization_id: ctx.organizationId,
        season_id: seasonId,
        team_entry_id: teamEntryId,
        division_id: divisionId,
        position_at_offer: 1,
        offered_at: clock.now(),
        offered_by: actor,
        expires_at: later,
        note: null,
        ...overrides,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

  const failure = async (run: () => Promise<unknown>): Promise<unknown> => {
    try {
      await run();
    } catch (error) {
      return error;
    }
    return null;
  };

  it('SPK-COMP-006: a waiting entry holds no division place, carries the instant its wait began, and owes nothing', async () => {
    const { seasonId, divisionId } = await setup(5);
    const waiting = await entry(seasonId, { status: 'waiting', waitingDivisionId: divisionId });
    // a waiting entry with a division place
    const placed = await failure(() =>
      db
        .updateTable('team_entries')
        .set({ division_id: divisionId })
        .where('id', '=', waiting)
        .execute(),
    );
    expect(isCheckViolation(placed)).toBe(true);
    expect(pgConstraintName(placed)).toBe('team_entries_waiting_holds_no_place');
    // waiting without the instant the wait began
    const noFact = await failure(() =>
      db
        .updateTable('team_entries')
        .set({ waiting_since: null })
        .where('id', '=', waiting)
        .execute(),
    );
    expect(pgConstraintName(noFact)).toBe('team_entries_waiting_fact');
    // a waiting entry with an obligation recorded
    const owing = await failure(() =>
      db
        .updateTable('team_entries')
        .set({ financial_status_ref: 'obligation-1' })
        .where('id', '=', waiting)
        .execute(),
    );
    expect(pgConstraintName(owing)).toBe('team_entries_waiting_owes_nothing');
    // the wait does not survive the state
    const applied = await entry(seasonId, { status: 'applied' });
    const stale = await failure(() =>
      db
        .updateTable('team_entries')
        .set({ waiting_since: clock.now() })
        .where('id', '=', applied)
        .execute(),
    );
    expect(pgConstraintName(stale)).toBe('team_entries_waiting_fact');
    const staleDivision = await failure(() =>
      db
        .updateTable('team_entries')
        .set({ waiting_division_id: divisionId })
        .where('id', '=', applied)
        .execute(),
    );
    expect(pgConstraintName(staleDivision)).toBe(
      'team_entries_waiting_division_only_while_waiting',
    );
    // the status check lists the machine's states
    await expect(
      db
        .updateTable('team_entries')
        .set({ status: 'queued' as 'waiting' })
        .where('id', '=', applied)
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it("§4.7 (2) / SPK-COMP-006: a waiting entry is the team's one live entry in the season", async () => {
    const { seasonId } = await setup();
    const captain = await createPersonFixture(ctx, { kind: 'adult' });
    const first = await createTeamEntryFixture(ctx, {
      seasonId,
      captainPersonId: captain,
      status: 'waiting',
    });
    await expect(
      createTeamEntryFixture(ctx, {
        seasonId,
        captainPersonId: captain,
        teamId: first.teamId,
        status: 'applied',
      }),
    ).rejects.toSatisfy(isUniqueViolation);
    // a withdrawn wait frees the slot
    await db
      .updateTable('team_entries')
      .set({
        status: 'withdrawn',
        withdrawn_at: clock.now(),
        withdrawn_by: actor,
        waiting_since: null,
      })
      .where('id', '=', first.teamEntryId)
      .execute();
    await createTeamEntryFixture(ctx, {
      seasonId,
      captainPersonId: captain,
      teamId: first.teamId,
      status: 'applied',
    });
  });

  it('SPK-COMP-006: one open offer per entry; an offer is made to a waiting entry only and is created open', async () => {
    const { seasonId, divisionId } = await setup(5);
    const waiting = await entry(seasonId, { status: 'waiting', waitingDivisionId: divisionId });
    const first = await offer(seasonId, waiting, divisionId);
    // a second open offer for the entry
    const second = await failure(() => offer(seasonId, waiting, divisionId));
    expect(isUniqueViolation(second)).toBe(true);
    expect(pgConstraintName(second)).toBe('team_entry_place_offers_one_open_idx');
    // once the first is settled, another may follow
    await db
      .updateTable('team_entry_place_offers')
      .set({ status: 'declined', resolved_at: clock.now(), resolved_by: actor })
      .where('id', '=', first.id)
      .execute();
    await offer(seasonId, waiting, divisionId);
    // an offer to an entry that is not waiting
    const applied = await entry(seasonId, { status: 'applied' });
    const notWaiting = await failure(() => offer(seasonId, applied, divisionId));
    expect(isCheckViolation(notWaiting)).toBe(true);
    expect(pgConstraintName(notWaiting)).toBe('team_entry_place_offers_entry_waiting');
    // an offer inserted already settled
    const other = await entry(seasonId, { status: 'waiting', waitingDivisionId: divisionId });
    const settled = await failure(() =>
      offer(seasonId, other, divisionId, {
        status: 'accepted',
        resolved_at: clock.now(),
        resolved_by: actor,
      }),
    );
    expect(pgConstraintName(settled)).toBe('team_entry_place_offers_created_open');
    // an expiry not after the offer
    const instant = await failure(() =>
      offer(seasonId, other, divisionId, { expires_at: clock.now() }),
    );
    expect(pgConstraintName(instant)).toBe('team_entry_place_offers_expiry_after_offer');
  });

  it('§4.7 (3) / SPK-COMP-006: the database refuses an offer over capacity, and an approval or placement into a place an open offer holds', async () => {
    const { seasonId, divisionId } = await setup(2);
    await entry(seasonId, { divisionId });
    const first = await entry(seasonId, { status: 'waiting', waitingDivisionId: divisionId });
    const second = await entry(seasonId, { status: 'waiting', waitingDivisionId: divisionId });
    // one placed entry, capacity two: one place can be offered
    const held = await offer(seasonId, first, divisionId);
    // an offer over capacity
    const over = await failure(() => offer(seasonId, second, divisionId));
    expect(isCheckViolation(over)).toBe(true);
    expect(pgConstraintName(over)).toBe('team_entry_place_offers_division_capacity');
    // an approval over capacity: the open offer holds the last place
    const applied = await entry(seasonId, { status: 'applied' });
    const approval = await failure(() =>
      db
        .updateTable('team_entries')
        .set({
          status: 'approved',
          division_id: divisionId,
          approved_at: clock.now(),
          approved_by: actor,
        })
        .where('id', '=', applied)
        .execute(),
    );
    expect(isCheckViolation(approval)).toBe(true);
    expect(pgConstraintName(approval)).toBe('team_entries_division_capacity');
    // a new entry placed straight into the held place
    const captain = await createPersonFixture(ctx, { kind: 'adult' });
    const insert = await failure(() =>
      createTeamEntryFixture(ctx, { seasonId, captainPersonId: captain, divisionId }),
    );
    expect(pgConstraintName(insert)).toBe('team_entries_division_capacity');
    // the entry the place was offered to takes it: its own offer is not counted against it
    await db
      .updateTable('team_entry_place_offers')
      .set({ status: 'accepted', resolved_at: clock.now(), resolved_by: actor })
      .where('id', '=', held.id)
      .execute();
    await db
      .updateTable('team_entries')
      .set({
        status: 'applied',
        division_id: divisionId,
        waiting_since: null,
        waiting_division_id: null,
      })
      .where('id', '=', first)
      .execute();
    // the division is full again
    const full = await failure(() => offer(seasonId, second, divisionId));
    expect(pgConstraintName(full)).toBe('team_entry_place_offers_division_capacity');
    // a waiting entry never consumes capacity: ten more may wait on a full division
    for (let i = 0; i < 10; i += 1) {
      await entry(seasonId, { status: 'waiting', waitingDivisionId: divisionId });
    }
  });

  it('SPK-COMP-006: an offer is resolved once, its terms never change, it is never deleted, and an entry does not leave the list with an open offer', async () => {
    const { seasonId, divisionId } = await setup(5);
    const waiting = await entry(seasonId, { status: 'waiting', waitingDivisionId: divisionId });
    const open = await offer(seasonId, waiting, divisionId);
    // the entry cannot leave the list while its offer is open
    const leaving = await failure(() =>
      db
        .updateTable('team_entries')
        .set({
          status: 'withdrawn',
          withdrawn_at: clock.now(),
          withdrawn_by: actor,
          waiting_since: null,
          waiting_division_id: null,
        })
        .where('id', '=', waiting)
        .execute(),
    );
    expect(pgConstraintName(leaving)).toBe('team_entries_waiting_offer_settled');
    // the terms of an open offer never change
    const terms = await failure(() =>
      db
        .updateTable('team_entry_place_offers')
        .set({ expires_at: new Date('2027-01-01T00:00:00Z') })
        .where('id', '=', open.id)
        .execute(),
    );
    expect(pgConstraintName(terms)).toBe('team_entry_place_offers_terms_immutable');
    // a resolution carries its instant and its actor
    const noFact = await failure(() =>
      db
        .updateTable('team_entry_place_offers')
        .set({ status: 'expired' })
        .where('id', '=', open.id)
        .execute(),
    );
    expect(pgConstraintName(noFact)).toBe('team_entry_place_offers_resolution_fact');
    await db
      .updateTable('team_entry_place_offers')
      .set({ status: 'expired', resolved_at: clock.now(), resolved_by: actor })
      .where('id', '=', open.id)
      .execute();
    // resolved once
    const again = await failure(() =>
      db
        .updateTable('team_entry_place_offers')
        .set({ status: 'accepted' })
        .where('id', '=', open.id)
        .execute(),
    );
    expect(pgConstraintName(again)).toBe('team_entry_place_offers_resolved_once');
    await expect(
      db.deleteFrom('team_entry_place_offers').where('id', '=', open.id).execute(),
    ).rejects.toSatisfy(isRestrictViolation);
    // the status check lists the machine's states
    const other = await entry(seasonId, { status: 'waiting', waitingDivisionId: divisionId });
    await expect(offer(seasonId, other, divisionId, { status: 'pending' })).rejects.toSatisfy(
      isCheckViolation,
    );
  });

  it('§4.3 / SPK-COMP-006: an offer or a wait can never point at another organization, or at a division of another season', async () => {
    const { seasonId, divisionId } = await setup(5);
    const waiting = await entry(seasonId, { status: 'waiting', waitingDivisionId: divisionId });
    const foreignSeason = await createSeasonFixture(ctx, {
      organizationId: otherOrg.organizationId,
    });
    const foreignDivision = await createDivisionFixture(ctx, {
      seasonId: foreignSeason.seasonId,
      organizationId: otherOrg.organizationId,
      facilityId: otherOrg.facilityId,
      capacityTeamEntries: 5,
    });
    const foreignCaptain = await createPersonFixture(ctx, {
      kind: 'adult',
      organizationId: otherOrg.organizationId,
    });
    const foreignEntry = await createTeamEntryFixture(ctx, {
      seasonId: foreignSeason.seasonId,
      captainPersonId: foreignCaptain,
      organizationId: otherOrg.organizationId,
      status: 'waiting',
      waitingDivisionId: foreignDivision,
    });
    // this organization's offer naming another organization's entry
    await expect(offer(seasonId, foreignEntry.teamEntryId, divisionId)).rejects.toSatisfy(
      (error) => isForeignKeyViolation(error) || isCheckViolation(error),
    );
    // this organization's offer naming another organization's division
    await expect(offer(seasonId, waiting, foreignDivision)).rejects.toSatisfy(
      isForeignKeyViolation,
    );
    // an offer of the other organization naming this organization's entry and division
    await expect(
      offer(seasonId, waiting, divisionId, { organization_id: otherOrg.organizationId }),
    ).rejects.toSatisfy((error) => isForeignKeyViolation(error) || isCheckViolation(error));
    // a division of another season of the same organization
    const elsewhere = await setup(5);
    await expect(offer(seasonId, waiting, elsewhere.divisionId)).rejects.toSatisfy(
      isForeignKeyViolation,
    );
    // an entry waiting for another organization's division, or another season's
    await expect(
      db
        .updateTable('team_entries')
        .set({ waiting_division_id: foreignDivision })
        .where('id', '=', waiting)
        .execute(),
    ).rejects.toSatisfy(isForeignKeyViolation);
    await expect(
      db
        .updateTable('team_entries')
        .set({ waiting_division_id: elsewhere.divisionId })
        .where('id', '=', waiting)
        .execute(),
    ).rejects.toSatisfy(isForeignKeyViolation);
  });
});
