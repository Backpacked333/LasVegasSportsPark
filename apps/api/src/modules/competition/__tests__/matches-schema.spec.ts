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
  createBracketNodeFixture,
  createResultRevisionFixture,
  createSuspensionFixture,
} from '../testing/competition-matches-fixtures';
import {
  createFixtureFixture,
  createSeasonFixture,
  createTeamEntryFixture,
  type CompetitionFixtureContext,
} from '../testing/competition-fixtures';
import { isRestrictViolation } from './support';

/**
 * Integrity that matters is enforced by the database (§4.7): each test writes the violating row
 * directly and expects the constraint, index or trigger of migration 0450 to reject it.
 */
describe('competition matches schema invariants (migration 0450)', () => {
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

  async function fixtureWithTeams() {
    const season = await createSeasonFixture(ctx, { status: 'active' });
    const home = await createTeamEntryFixture(ctx, {
      seasonId: season.seasonId,
      captainPersonId: await createPersonFixture(ctx, { kind: 'adult' }),
    });
    const away = await createTeamEntryFixture(ctx, {
      seasonId: season.seasonId,
      captainPersonId: await createPersonFixture(ctx, { kind: 'adult' }),
    });
    const fixtureId = await createFixtureFixture(ctx, {
      seasonId: season.seasonId,
      homeEntryId: home.teamEntryId,
      awayEntryId: away.teamEntryId,
    });
    return { season, home, away, fixtureId };
  }

  it('§4.7 invariant 8: exactly one official result per fixture and one revision in progress', async () => {
    const { fixtureId } = await fixtureWithTeams();
    await createResultRevisionFixture(ctx, { fixtureId, status: 'official', revisionNo: 1 });
    await expect(
      createResultRevisionFixture(ctx, { fixtureId, status: 'official', revisionNo: 2 }),
    ).rejects.toSatisfy(isUniqueViolation);
    await createResultRevisionFixture(ctx, { fixtureId, status: 'submitted', revisionNo: 2 });
    await expect(
      createResultRevisionFixture(ctx, { fixtureId, status: 'draft', revisionNo: 3 }),
    ).rejects.toSatisfy(isUniqueViolation);
    // revision numbers are unique per fixture
    await expect(
      createResultRevisionFixture(ctx, { fixtureId, status: 'superseded', revisionNo: 2 }),
    ).rejects.toSatisfy(isUniqueViolation);
  });

  it('§4.7 invariant 9: an official row may only become superseded; superseded rows are immutable; nothing is deleted', async () => {
    const { fixtureId } = await fixtureWithTeams();
    const officialId = await createResultRevisionFixture(ctx, {
      fixtureId,
      status: 'official',
      homeScore: 2,
      awayScore: 1,
    });
    const rewrite = db
      .updateTable('result_revisions')
      .set({ home_score: 5 })
      .where('id', '=', officialId)
      .execute();
    await expect(rewrite).rejects.toSatisfy(isRestrictViolation);
    await expect(rewrite.catch((e: unknown) => pgConstraintName(e))).resolves.toBe(
      'result_revisions_official_immutable',
    );
    await expect(
      db
        .updateTable('result_revisions')
        .set({ status: 'submitted', published_at: null })
        .where('id', '=', officialId)
        .execute(),
    ).rejects.toSatisfy(isRestrictViolation);
    // the one permitted change keeps scores, actor, reason and publication time
    const correctionId = await createResultRevisionFixture(ctx, {
      fixtureId,
      status: 'submitted',
      revisionNo: 2,
      supersedesRevisionId: officialId,
      homeScore: 2,
      awayScore: 2,
    });
    await db
      .updateTable('result_revisions')
      .set({
        status: 'superseded',
        superseded_at: clock.now(),
        superseded_by: actor,
        superseded_by_revision_id: correctionId,
        revision: 2,
      })
      .where('id', '=', officialId)
      .execute();
    const superseded = await db
      .selectFrom('result_revisions')
      .selectAll()
      .where('id', '=', officialId)
      .executeTakeFirstOrThrow();
    expect(superseded).toMatchObject({ status: 'superseded', home_score: 2, away_score: 1 });
    expect(superseded.published_at).not.toBeNull();
    const history = db
      .updateTable('result_revisions')
      .set({ away_score: 9 })
      .where('id', '=', officialId)
      .execute();
    await expect(history).rejects.toSatisfy(isRestrictViolation);
    await expect(history.catch((e: unknown) => pgConstraintName(e))).resolves.toBe(
      'result_revisions_history_immutable',
    );
    await expect(
      db.deleteFrom('result_revisions').where('id', '=', correctionId).execute(),
    ).rejects.toSatisfy(isRestrictViolation);
  });

  it('result facts agree with the state: published instants, submission instants, forfeiting entry and scores', async () => {
    const { fixtureId, home } = await fixtureWithTeams();
    const base = {
      organization_id: ctx.organizationId,
      fixture_id: fixtureId,
      details: json({}),
      submitted_by: actor,
      submitted_at: clock.now(),
    };
    await expect(
      db
        .insertInto('result_revisions')
        .values({
          ...base,
          id: newId(),
          revision_no: 1,
          status: 'official',
          classification: 'completed',
          home_score: 1,
          away_score: 0,
          published_at: null,
        })
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      db
        .insertInto('result_revisions')
        .values({
          ...base,
          id: newId(),
          revision_no: 1,
          status: 'submitted',
          submitted_at: null,
          classification: 'completed',
          home_score: 1,
          away_score: 0,
        })
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      db
        .insertInto('result_revisions')
        .values({
          ...base,
          id: newId(),
          revision_no: 1,
          status: 'submitted',
          classification: 'completed',
          home_score: null,
          away_score: null,
        })
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      db
        .insertInto('result_revisions')
        .values({
          ...base,
          id: newId(),
          revision_no: 1,
          status: 'submitted',
          classification: 'forfeit',
          home_score: 3,
          away_score: 0,
          forfeiting_entry_id: null,
        })
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
    // §4.7 invariant 8: an official row always names its publisher
    const anonymous = db
      .insertInto('result_revisions')
      .values({
        ...base,
        id: newId(),
        revision_no: 1,
        status: 'official',
        classification: 'completed',
        home_score: 1,
        away_score: 0,
        published_at: clock.now(),
        published_by: null,
      })
      .execute();
    await expect(anonymous).rejects.toSatisfy(isCheckViolation);
    await expect(anonymous.catch((e: unknown) => pgConstraintName(e))).resolves.toBe(
      'result_revisions_publisher_fact',
    );
    // a result of another organization's fixture is impossible (composite foreign key)
    await expect(
      createResultRevisionFixture(ctx, { fixtureId, organizationId: otherOrg.organizationId }),
    ).rejects.toSatisfy(isForeignKeyViolation);
    expect(home.teamEntryId).toBeDefined();
  });

  it('SPK-DISC-003: a rule-set suspension names the fixture it came from and exists once per person, fixture and rule', async () => {
    const { fixtureId } = await fixtureWithTeams();
    const person = await createPersonFixture(ctx, { kind: 'adult' });
    const proposal = (overrides: Record<string, unknown> = {}) =>
      db
        .insertInto('suspensions')
        .values({
          id: newId(),
          organization_id: ctx.organizationId,
          subject_person_id: person,
          basis: 'sent off',
          scope: 'all',
          match_count: 1,
          completion_criteria: 'one match served',
          source_kind: 'red_card',
          source_fixture_id: fixtureId,
          created_by: actor,
          ...overrides,
        })
        .execute();
    await proposal();
    const duplicate = proposal();
    await expect(duplicate).rejects.toSatisfy(isUniqueViolation);
    await expect(duplicate.catch((e: unknown) => pgConstraintName(e))).resolves.toBe(
      'suspensions_rule_source_idx',
    );
    // another rule for the same fixture is a different proposal
    await proposal({ source_kind: 'yellow_accumulation' });
    // a rule-set proposal always names its fixture; a manual one never does
    await expect(proposal({ source_fixture_id: null })).rejects.toSatisfy(isCheckViolation);
    await expect(proposal({ source_kind: 'manual' })).rejects.toSatisfy(isCheckViolation);
    // the source fixture belongs to the same organization
    await expect(
      proposal({
        organization_id: otherOrg.organizationId,
        subject_person_id: await createPersonFixture(ctx, {
          kind: 'adult',
          organizationId: otherOrg.organizationId,
        }),
      }),
    ).rejects.toSatisfy(isForeignKeyViolation);
  });

  it('standings projections are append-only', async () => {
    const { season } = await fixtureWithTeams();
    const id = newId();
    await db
      .insertInto('standings_projections')
      .values({
        id,
        organization_id: ctx.organizationId,
        season_id: season.seasonId,
        division_id: null,
        rule_set_id: season.ruleSetId,
        rule_set_version: 1,
        computed_at: clock.now(),
        rows: json([]),
        tiebreak_explanations: json([]),
        trigger_result_id: null,
        created_by: actor,
      })
      .execute();
    await expect(
      db
        .updateTable('standings_projections')
        .set({ rows: json([{ x: 1 }]) })
        .where('id', '=', id)
        .execute(),
    ).rejects.toSatisfy(isRestrictViolation);
    await expect(
      db.deleteFrom('standings_projections').where('id', '=', id).execute(),
    ).rejects.toSatisfy(isRestrictViolation);
  });

  it('SPK-DISC-002: a suspension states a period or a match count, names its competitions when scoped, is approved before it is active, and never serves more than its count', async () => {
    const person = await createPersonFixture(ctx, { kind: 'adult' });
    const terms = {
      id: newId(),
      organization_id: ctx.organizationId,
      subject_person_id: person,
      basis: 'red card',
      completion_criteria: 'served',
      created_by: actor,
    };
    await expect(
      db
        .insertInto('suspensions')
        .values({ ...terms, scope: 'all', match_count: null, effective_from: null })
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      db
        .insertInto('suspensions')
        .values({
          ...terms,
          id: newId(),
          scope: 'competitions',
          competition_ids: [],
          match_count: 1,
        })
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      db
        .insertInto('suspensions')
        .values({
          ...terms,
          id: newId(),
          scope: 'all',
          match_count: 1,
          status: 'active',
          approved_at: null,
        })
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
    const id = await createSuspensionFixture(ctx, { subjectPersonId: person, matchCount: 2 });
    await expect(
      db.updateTable('suspensions').set({ matches_served: 3 }).where('id', '=', id).execute(),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      createSuspensionFixture(ctx, {
        subjectPersonId: await createPersonFixture(ctx, {
          kind: 'adult',
          organizationId: otherOrg.organizationId,
        }),
        matchCount: 1,
      }),
    ).rejects.toSatisfy(isForeignKeyViolation);
  });

  it('appeals target exactly one record and only one appeal per target is open', async () => {
    const person = await createPersonFixture(ctx, { kind: 'adult' });
    const suspensionId = await createSuspensionFixture(ctx, {
      subjectPersonId: person,
      matchCount: 1,
    });
    const appeal = (overrides: Record<string, unknown>) => ({
      id: newId(),
      organization_id: ctx.organizationId,
      subject_person_id: person,
      grounds: 'mistaken identity',
      submitted_by: actor,
      submitted_at: clock.now(),
      ...overrides,
    });
    await expect(db.insertInto('appeals').values(appeal({})).execute()).rejects.toSatisfy(
      isCheckViolation,
    );
    await db
      .insertInto('appeals')
      .values(appeal({ suspension_id: suspensionId }))
      .execute();
    await expect(
      db
        .insertInto('appeals')
        .values(appeal({ suspension_id: suspensionId }))
        .execute(),
    ).rejects.toSatisfy(isUniqueViolation);
    await expect(
      db
        .insertInto('appeals')
        .values(appeal({ suspension_id: suspensionId, status: 'granted', decided_at: null }))
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('bracket slots are unique per round and publication carries its instant; disputes and incidents keep their facts consistent', async () => {
    const { season, fixtureId, home } = await fixtureWithTeams();
    await createBracketNodeFixture(ctx, { seasonId: season.seasonId, round: 1, slot: 1 });
    await expect(
      createBracketNodeFixture(ctx, { seasonId: season.seasonId, round: 1, slot: 1 }),
    ).rejects.toSatisfy(isUniqueViolation);
    await expect(
      db
        .insertInto('bracket_nodes')
        .values({
          id: newId(),
          organization_id: ctx.organizationId,
          season_id: season.seasonId,
          round: 2,
          slot: 1,
          source_rule: json({ home: { kind: 'bye' }, away: { kind: 'bye' } }),
          published: true,
          published_at: null,
          created_by: actor,
        })
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      db
        .insertInto('disputes')
        .values({
          id: newId(),
          organization_id: ctx.organizationId,
          fixture_id: fixtureId,
          submitting_role: 'captain',
          submitted_by: actor,
          submitted_at: clock.now(),
          submission_deadline_at: new Date(clock.now().getTime() - 1000),
          reason: 'late',
        })
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      db
        .insertInto('disputes')
        .values({
          id: newId(),
          organization_id: ctx.organizationId,
          fixture_id: fixtureId,
          submitting_role: 'captain',
          submitted_by: actor,
          submitted_at: clock.now(),
          submission_deadline_at: new Date(clock.now().getTime() + 1000),
          reason: 'decided without a decision',
          status: 'decided',
          decided_at: clock.now(),
          decision: null,
        })
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      db
        .insertInto('incidents')
        .values({
          id: newId(),
          organization_id: ctx.organizationId,
          kind: 'card',
          card_kind: null,
          subject_person_id: home.captainRoleId ? null : null,
          occurred_at: clock.now(),
          severity: 'low',
          summary: 'yellow',
          reported_by: actor,
        })
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
  });
});
