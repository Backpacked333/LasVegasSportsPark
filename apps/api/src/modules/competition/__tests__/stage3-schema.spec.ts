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
import { createResultRevisionFixture } from '../testing/competition-matches-fixtures';
import {
  createDivisionFixture,
  createFixtureFixture,
  createSeasonFixture,
  createTeamEntryFixture,
  type CompetitionFixtureContext,
} from '../testing/competition-fixtures';
import { isRestrictViolation } from './support';

/**
 * Stage-3 integrity (migrations 0454 to 0459): each test writes the violating row directly and
 * expects the database, not the service, to reject it (CLAUDE.md, §4.7).
 */
describe('competition stage-3 schema invariants (migrations 0454-0459)', () => {
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

  const adult = () => createPersonFixture(ctx, { kind: 'adult' });

  async function fixtureWithTeams(input: { divisionId?: string; seasonId?: string } = {}) {
    const seasonId =
      input.seasonId ?? (await createSeasonFixture(ctx, { status: 'active' })).seasonId;
    const home = await createTeamEntryFixture(ctx, {
      seasonId,
      captainPersonId: await adult(),
      divisionId: input.divisionId ?? null,
    });
    const away = await createTeamEntryFixture(ctx, {
      seasonId,
      captainPersonId: await adult(),
      divisionId: input.divisionId ?? null,
    });
    const fixtureId = await createFixtureFixture(ctx, {
      seasonId,
      homeEntryId: home.teamEntryId,
      awayEntryId: away.teamEntryId,
      divisionId: input.divisionId ?? null,
    });
    return { seasonId, home, away, fixtureId };
  }

  it('CMP-03 (0454): a declined invitation always records when, and only a declined one does', async () => {
    const { home } = await fixtureWithTeams();
    const invitation = (overrides: Record<string, unknown>) =>
      db
        .insertInto('team_invitations')
        .values({
          id: newId(),
          organization_id: ctx.organizationId,
          team_entry_id: home.teamEntryId,
          invited_by: actor,
          invited_by_person_id: null,
          recipient_person_id: null,
          recipient_contact_kind: 'email',
          recipient_contact_value: `${newId()}@example.test`,
          message: null,
          token_hash: newId(),
          expires_at: new Date('2026-10-30T12:00:00Z'),
          ...overrides,
        })
        .execute();
    await expect(invitation({ status: 'declined', declined_at: null })).rejects.toSatisfy(
      (e: unknown) =>
        isCheckViolation(e) && pgConstraintName(e) === 'team_invitations_declined_fact',
    );
    await expect(invitation({ status: 'pending', declined_at: clock.now() })).rejects.toSatisfy(
      isCheckViolation,
    );
    await expect(
      invitation({ status: 'declined', declined_at: clock.now() }),
    ).resolves.toBeDefined();
  });

  it('CMP-04 (0455): the copied venue and its facility are present together, agree, belong to the organization and carry a positive event revision', async () => {
    const { fixtureId } = await fixtureWithTeams();
    const venue = (facilityId: string) =>
      json({ eventId: newId(), facilityId, timezone: 'America/Los_Angeles', resources: [] });
    const set = (values: Record<string, unknown>) =>
      db.updateTable('fixtures').set(values).where('id', '=', fixtureId).execute();
    await expect(set({ venue: venue(ctx.facilityId) })).rejects.toSatisfy(
      (e: unknown) => isCheckViolation(e) && pgConstraintName(e) === 'fixtures_venue_presence',
    );
    await expect(set({ venue_facility_id: ctx.facilityId })).rejects.toSatisfy(isCheckViolation);
    // the json names another facility than the column
    await expect(
      set({ venue: venue(newId()), venue_facility_id: ctx.facilityId, venue_event_revision: 1 }),
    ).rejects.toSatisfy(
      (e: unknown) => isCheckViolation(e) && pgConstraintName(e) === 'fixtures_venue_shape',
    );
    await expect(
      set({ venue: json([1, 2]), venue_facility_id: ctx.facilityId, venue_event_revision: 1 }),
    ).rejects.toSatisfy(isCheckViolation);
    // another organization's facility can never be a venue (composite foreign key)
    await expect(
      set({
        venue: venue(otherOrg.facilityId),
        venue_facility_id: otherOrg.facilityId,
        venue_event_revision: 1,
      }),
    ).rejects.toSatisfy(isForeignKeyViolation);
    await expect(
      set({
        venue: venue(ctx.facilityId),
        venue_facility_id: ctx.facilityId,
        venue_event_revision: 0,
      }),
    ).rejects.toSatisfy(
      (e: unknown) => isCheckViolation(e) && pgConstraintName(e) === 'fixtures_venue_revision',
    );
    await expect(set({ venue_event_revision: 2 })).rejects.toSatisfy(isCheckViolation);
    await set({
      venue: venue(ctx.facilityId),
      venue_facility_id: ctx.facilityId,
      venue_event_revision: 3,
    });
  });

  it('CMP-09 (0456): source columns accept only staff or import, and staff stays the default', async () => {
    const season = await createSeasonFixture(ctx, {});
    const row = await db
      .selectFrom('seasons')
      .select('source')
      .where('id', '=', season.seasonId)
      .executeTakeFirstOrThrow();
    expect(row.source).toBe('staff');
    await expect(
      db
        .updateTable('seasons')
        .set({ source: 'spreadsheet' as never })
        .where('id', '=', season.seasonId)
        .execute(),
    ).rejects.toSatisfy(
      (e: unknown) => isCheckViolation(e) && pgConstraintName(e) === 'seasons_source_check',
    );
    const entry = await createTeamEntryFixture(ctx, {
      seasonId: season.seasonId,
      captainPersonId: await adult(),
    });
    await expect(
      db
        .updateTable('teams')
        .set({ source: 'other' as never })
        .where('id', '=', entry.teamId)
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      db
        .updateTable('team_entries')
        .set({ source: 'other' as never })
        .where('id', '=', entry.teamEntryId)
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
    await db
      .updateTable('team_entries')
      .set({ source: 'import' })
      .where('id', '=', entry.teamEntryId)
      .execute();
    const membership = {
      organization_id: ctx.organizationId,
      team_entry_id: entry.teamEntryId,
      status: 'active' as const,
      status_before_removal: null,
      effective_from: clock.now(),
      effective_to: null,
      jersey_number: null,
      added_by: actor,
      added_by_person_id: null,
      removed_at: null,
      removed_by: null,
      removal_reason: null,
    };
    await db
      .insertInto('roster_memberships')
      .values({ ...membership, id: newId(), person_id: await adult(), source: 'import' })
      .execute();
    await expect(
      db
        .insertInto('roster_memberships')
        .values({
          ...membership,
          id: newId(),
          person_id: await adult(),
          source: 'spreadsheet' as never,
        })
        .execute(),
    ).rejects.toSatisfy(
      (e: unknown) =>
        isCheckViolation(e) && pgConstraintName(e) === 'roster_memberships_source_check',
    );
  });

  it('CMP-10 (0457): the database rejects a shootout winner on a result that is not a draw or that names neither side, and freezes it once official', async () => {
    const { fixtureId, home, away, seasonId } = await fixtureWithTeams();
    const stranger = await createTeamEntryFixture(ctx, {
      seasonId,
      captainPersonId: await adult(),
    });
    const revision = await createResultRevisionFixture(ctx, {
      fixtureId,
      status: 'draft',
      homeScore: 2,
      awayScore: 1,
    });
    const setWinner = (values: Record<string, unknown>) =>
      db.updateTable('result_revisions').set(values).where('id', '=', revision).execute();
    await expect(setWinner({ shootout_winner_entry_id: home.teamEntryId })).rejects.toSatisfy(
      (e: unknown) =>
        isCheckViolation(e) && pgConstraintName(e) === 'result_revisions_shootout_draw',
    );
    await expect(
      setWinner({
        classification: 'forfeit',
        home_score: null,
        away_score: null,
        forfeiting_entry_id: away.teamEntryId,
        shootout_winner_entry_id: home.teamEntryId,
      }),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      setWinner({ home_score: 1, away_score: 1, shootout_winner_entry_id: stranger.teamEntryId }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        isCheckViolation(e) && pgConstraintName(e) === 'result_revisions_shootout_side',
    );
    await setWinner({ home_score: 1, away_score: 1, shootout_winner_entry_id: away.teamEntryId });
    // §4.7 invariant 9: an official revision's shootout winner can no longer change
    const official = await createResultRevisionFixture(ctx, {
      fixtureId: (await fixtureWithTeams({ seasonId })).fixtureId,
      homeScore: 0,
      awayScore: 0,
    });
    const officialFixture = await db
      .selectFrom('result_revisions')
      .innerJoin('fixtures', 'fixtures.id', 'result_revisions.fixture_id')
      .select(['fixtures.home_entry_id'])
      .where('result_revisions.id', '=', official)
      .executeTakeFirstOrThrow();
    await expect(
      db
        .updateTable('result_revisions')
        .set({ shootout_winner_entry_id: officialFixture.home_entry_id })
        .where('id', '=', official)
        .execute(),
    ).rejects.toSatisfy(isRestrictViolation);
  });

  it('CMP-14 (0458): an availability request is append-only, names one of the fixture sides and stays in its organization', async () => {
    const { fixtureId, home, seasonId } = await fixtureWithTeams();
    const stranger = await createTeamEntryFixture(ctx, {
      seasonId,
      captainPersonId: await adult(),
    });
    const request = (overrides: Record<string, unknown>) =>
      db
        .insertInto('availability_requests')
        .values({
          id: newId(),
          organization_id: ctx.organizationId,
          fixture_id: fixtureId,
          team_entry_id: home.teamEntryId,
          requested_by: actor,
          requested_by_person_id: null,
          message: null,
          requested_at: clock.now(),
          recipient_count: 2,
          ...overrides,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
    await expect(request({ team_entry_id: stranger.teamEntryId })).rejects.toSatisfy(
      (e: unknown) =>
        isCheckViolation(e) && pgConstraintName(e) === 'availability_requests_fixture_side',
    );
    await expect(request({ recipient_count: -1 })).rejects.toSatisfy(isCheckViolation);
    await expect(request({ message: 'x'.repeat(501) })).rejects.toSatisfy(isCheckViolation);
    await expect(request({ organization_id: otherOrg.organizationId })).rejects.toSatisfy(
      (e: unknown) => isForeignKeyViolation(e) || isCheckViolation(e),
    );
    const { id } = await request({ message: 'Who can make Saturday?' });
    await expect(
      db
        .updateTable('availability_requests')
        .set({ recipient_count: 0 })
        .where('id', '=', id)
        .execute(),
    ).rejects.toSatisfy(isRestrictViolation);
    await expect(
      db.deleteFrom('availability_requests').where('id', '=', id).execute(),
    ).rejects.toSatisfy(isRestrictViolation);
  });

  it('CMP-15 (0459): the database rejects a pool entry from another season or division and an entry in two pools of one division', async () => {
    const season = await createSeasonFixture(ctx, { status: 'active' });
    const otherSeason = await createSeasonFixture(ctx, { status: 'active' });
    const divisionA = await createDivisionFixture(ctx, { seasonId: season.seasonId, name: 'A' });
    const divisionB = await createDivisionFixture(ctx, { seasonId: season.seasonId, name: 'B' });
    const otherSeasonDivision = await createDivisionFixture(ctx, {
      seasonId: otherSeason.seasonId,
      name: 'A',
    });
    const pool = (divisionId: string, name: string, seasonId = season.seasonId) => {
      const id = newId();
      return db
        .insertInto('pools')
        .values({
          id,
          organization_id: ctx.organizationId,
          season_id: seasonId,
          division_id: divisionId,
          name,
          created_by: actor,
        })
        .execute()
        .then(() => id);
    };
    const pool1 = await pool(divisionA, 'Pool 1');
    const pool2 = await pool(divisionA, 'Pool 2');
    // a pool names a division of its own season, and a name once per division
    await expect(pool(otherSeasonDivision, 'Pool 1')).rejects.toSatisfy(isForeignKeyViolation);
    await expect(pool(divisionA, 'Pool 1')).rejects.toSatisfy(isUniqueViolation);
    await pool(divisionB, 'Pool 1');

    const inA = await createTeamEntryFixture(ctx, {
      seasonId: season.seasonId,
      divisionId: divisionA,
      captainPersonId: await adult(),
    });
    const inB = await createTeamEntryFixture(ctx, {
      seasonId: season.seasonId,
      divisionId: divisionB,
      captainPersonId: await adult(),
    });
    const elsewhere = await createTeamEntryFixture(ctx, {
      seasonId: otherSeason.seasonId,
      divisionId: otherSeasonDivision,
      captainPersonId: await adult(),
    });
    const undivided = await createTeamEntryFixture(ctx, {
      seasonId: season.seasonId,
      captainPersonId: await adult(),
    });
    const place = (
      poolId: string,
      teamEntryId: string,
      over: { seasonId?: string; divisionId?: string; seed?: number | null } = {},
    ) =>
      db
        .insertInto('pool_entries')
        .values({
          organization_id: ctx.organizationId,
          pool_id: poolId,
          season_id: over.seasonId ?? season.seasonId,
          division_id: over.divisionId ?? divisionA,
          team_entry_id: teamEntryId,
          seed: over.seed ?? null,
          added_by: actor,
        })
        .execute();
    await place(pool1, inA.teamEntryId, { seed: 1 });
    // another division's entry, even when the row claims the pool's division
    await expect(place(pool1, inB.teamEntryId)).rejects.toSatisfy(isForeignKeyViolation);
    await expect(place(pool1, inB.teamEntryId, { divisionId: divisionB })).rejects.toSatisfy(
      isForeignKeyViolation,
    );
    // another season's entry
    await expect(place(pool1, elsewhere.teamEntryId)).rejects.toSatisfy(isForeignKeyViolation);
    await expect(
      place(pool1, elsewhere.teamEntryId, {
        seasonId: otherSeason.seasonId,
        divisionId: otherSeasonDivision,
      }),
    ).rejects.toSatisfy(isForeignKeyViolation);
    // an entry without a division can never join a pool
    await expect(place(pool1, undivided.teamEntryId)).rejects.toSatisfy(isForeignKeyViolation);
    // one pool per division
    await expect(place(pool2, inA.teamEntryId)).rejects.toSatisfy(
      (e: unknown) =>
        isUniqueViolation(e) &&
        pgConstraintName(e) === 'pool_entries_organization_id_division_id_team_entry_id_key',
    );
    const second = await createTeamEntryFixture(ctx, {
      seasonId: season.seasonId,
      divisionId: divisionA,
      captainPersonId: await adult(),
    });
    await expect(place(pool2, second.teamEntryId, { seed: 0 })).rejects.toSatisfy(isCheckViolation);
  });

  it('CMP-15 (0459): compressed-play specification fields are optional and positive', async () => {
    const season = await createSeasonFixture(ctx, { status: 'active' });
    const divisionId = await createDivisionFixture(ctx, { seasonId: season.seasonId });
    const specification = (overrides: Record<string, unknown>) =>
      db
        .insertInto('fixture_specifications')
        .values({
          id: newId(),
          organization_id: ctx.organizationId,
          season_id: season.seasonId,
          division_id: divisionId,
          facility_id: ctx.facilityId,
          name: `Spec ${newId()}`,
          games_per_team: 3,
          opponent_frequency: 1,
          starts_on: '2027-01-10',
          ends_on: '2027-01-12',
          match_duration_minutes: 40,
          playoff_structure: null,
          created_by: actor,
          ...overrides,
        })
        .execute();
    await specification({});
    await specification({ max_games_per_team_per_day: 2, officials_per_game: 1 });
    await expect(specification({ max_games_per_team_per_day: 0 })).rejects.toSatisfy(
      isCheckViolation,
    );
    await expect(specification({ officials_per_game: 0 })).rejects.toSatisfy(isCheckViolation);
  });
});
