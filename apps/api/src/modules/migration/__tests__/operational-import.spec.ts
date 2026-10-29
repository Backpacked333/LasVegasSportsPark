import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ImportEntityTypeValue, StagedRow } from '@sportspark/contracts';
import type { TestApp } from '../../../testing';
import { createCompetitionFixture, createRuleSetFixture } from '../../competition';
import { at, createScheduledEvent, EventsService, seedPitchWithHalves } from '../../scheduling';
import {
  createAuthorityAssignmentFixture,
  legacyAuthorityFixture,
  stagedEvent,
  stagedPerson,
  stagedPreferences,
  stagedRoster,
  stagedSeason,
  stagedTeam,
  stagedTeamEntry,
} from '../testing/migration-fixtures';
import {
  APPLIED_CATEGORIES,
  countRows,
  exceptionsOf,
  get,
  importSnapshot,
  migrationTestApp,
  post,
  rowsOf,
  stageAndValidate,
  staff,
  type Actor,
} from './support';

/** Operational categories created through the owning modules' import commands (MIG-02). */
const OPERATIONAL: readonly ImportEntityTypeValue[] = [
  'season',
  'team',
  'roster',
  'future_schedule',
  'communication_preference',
];

const TABLES = [
  'persons',
  'programs',
  'seasons',
  'teams',
  'team_entries',
  'roster_memberships',
  'events',
  'communication_preference_imports',
  'communication_preferences',
  'reservations',
  'publications',
  'notifications',
] as const;

/**
 * MIG-02 (§5.3, §5.4, §5.5 level 4, §5.6, SPK-AT-024; IF-40): the apply creates persons, programs,
 * seasons, teams, team entries, roster memberships, future events (as drafts) and communication
 * preferences only through the owning modules' import commands, each row in one unit of work that
 * the command joins, with the record id its mapping reserved.
 */
describe('operational categories through import commands (MIG-02)', () => {
  let t: TestApp;
  let operator: Actor;
  let competitionId: string;
  let ruleSetId: string;
  let pitchId: string;
  let nativeGame: string;

  beforeAll(async () => {
    t = await migrationTestApp();
    operator = await staff(t, ['general_manager']);
    competitionId = await createCompetitionFixture(t, { name: 'Legacy Adult League' });
    ruleSetId = (await createRuleSetFixture(t, {})).id;
    const pitch = await seedPitchWithHalves(t.db, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      name: 'Pitch 1',
    });
    pitchId = pitch.pitchId;
    // A game SportsPark scheduled before the legacy booking tool was named authoritative.
    nativeGame = (
      await createScheduledEvent(t.app.get(EventsService), {
        organizationId: t.organizationId,
        facilityId: t.facilityId,
        resourceIds: [pitchId],
        start: at('2027-02-13', '10:00'),
        end: at('2027-02-13', '11:00'),
        title: 'SportsPark rental',
      })
    ).id;
    // §5.6: importing a category needs the legacy system to be authoritative for it.
    await legacyAuthorityFixture(t, [...APPLIED_CATEGORIES, ...OPERATIONAL]);
  });
  afterAll(async () => {
    await t.close();
  });

  async function counts(): Promise<Record<(typeof TABLES)[number], number>> {
    const out = {} as Record<(typeof TABLES)[number], number>;
    for (const table of TABLES) out[table] = await countRows(t, table);
    return out;
  }

  async function nonMigrationOutbox(): Promise<number> {
    const row = await t.db
      .selectFrom('outbox_events')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('organization_id', '=', t.organizationId)
      .where('event_type', 'not like', 'migration.%')
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  function snapshot(): StagedRow[] {
    return [
      stagedPerson('OP-CAP', { givenName: 'Cara', familyName: 'Captain' }),
      stagedPerson('OP-PLY', { givenName: 'Pat', familyName: 'Player', email: 'pat@example.test' }),
      {
        entityType: 'program',
        externalId: 'OP-PRG',
        payload: { name: 'Imported Adult League Program', activityType: 'soccer' },
      },
      stagedSeason('OP-S', { competitionId, ruleSetId, name: 'Winter 2027' }),
      stagedTeam('OP-T', { name: 'Imported Rovers', primaryColor: 'green' }),
      stagedTeamEntry('OP-E', {
        teamExternalId: 'OP-T',
        seasonExternalId: 'OP-S',
        captainExternalId: 'OP-CAP',
      }),
      stagedRoster('OP-R1', {
        entryExternalId: 'OP-E',
        personExternalId: 'OP-CAP',
        jerseyNumber: 10,
      }),
      stagedRoster('OP-R2', {
        entryExternalId: 'OP-E',
        personExternalId: 'OP-PLY',
        jerseyNumber: 7,
      }),
      stagedEvent('OP-EV', {
        facilityId: t.facilityId,
        resourceIds: [pitchId],
        scheduledStart: at('2027-02-06', '10:00'),
        scheduledEnd: at('2027-02-06', '11:00'),
        title: 'Rovers v Strikers',
      }),
      stagedPreferences('OP-CP', {
        personExternalId: 'OP-PLY',
        preferences: [
          { channel: 'email', category: 'promotional', enabled: false },
          { channel: 'sms', category: 'operational', enabled: true },
        ],
      }),
    ];
  }

  it('SPK-AT-024: applying the same snapshot twice creates every person, program, season, team, entry, roster row, event and preference once', async () => {
    const before = await counts();
    const outboxBefore = await nonMigrationOutbox();
    const first = await importSnapshot(t, operator, snapshot());
    expect(first.outcomeCounts).toEqual({
      created: 10,
      matched: 0,
      updated: 0,
      skipped: 0,
      exception: 0,
    });
    const afterFirst = await counts();
    expect({
      persons: afterFirst.persons - before.persons,
      programs: afterFirst.programs - before.programs,
      seasons: afterFirst.seasons - before.seasons,
      teams: afterFirst.teams - before.teams,
      team_entries: afterFirst.team_entries - before.team_entries,
      roster_memberships: afterFirst.roster_memberships - before.roster_memberships,
      events: afterFirst.events - before.events,
      communication_preference_imports:
        afterFirst.communication_preference_imports - before.communication_preference_imports,
    }).toEqual({
      persons: 2,
      programs: 1,
      seasons: 1,
      teams: 1,
      team_entries: 1,
      roster_memberships: 2,
      events: 1,
      communication_preference_imports: 1,
    });
    // Every record carries the id its mapping reserved and the owning module's import source.
    const rows = await rowsOf(t, operator, first.id);
    const id = (externalId: string) => rows.find((r) => r.externalId === externalId)?.internalId;
    const mappings = await t.db
      .selectFrom('external_mappings')
      .select(['external_id', 'internal_id', 'reserved_record_id', 'team_id', 'team_entry_id'])
      .where('organization_id', '=', t.organizationId)
      .where('first_seen_batch_id', '=', first.id)
      .execute();
    expect(mappings).toHaveLength(10);
    for (const m of mappings) expect(m.internal_id).toBe(m.reserved_record_id);
    expect(mappings.find((m) => m.external_id === 'OP-T')?.team_id).toBe(id('OP-T'));
    expect(mappings.find((m) => m.external_id === 'OP-E')?.team_entry_id).toBe(id('OP-E'));
    const sources = await Promise.all([
      t.db
        .selectFrom('persons')
        .select('source')
        .where('id', '=', id('OP-CAP')!)
        .executeTakeFirstOrThrow(),
      t.db
        .selectFrom('programs')
        .select('source')
        .where('id', '=', id('OP-PRG')!)
        .executeTakeFirstOrThrow(),
      t.db
        .selectFrom('seasons')
        .select(['source', 'status'])
        .where('id', '=', id('OP-S')!)
        .executeTakeFirstOrThrow(),
      t.db
        .selectFrom('teams')
        .select('source')
        .where('id', '=', id('OP-T')!)
        .executeTakeFirstOrThrow(),
      t.db
        .selectFrom('team_entries')
        .select(['source', 'status', 'season_id', 'team_id'])
        .where('id', '=', id('OP-E')!)
        .executeTakeFirstOrThrow(),
    ]);
    expect(sources).toEqual([
      { source: 'import' },
      { source: 'import' },
      { source: 'import', status: 'active' },
      { source: 'import' },
      { source: 'import', status: 'approved', season_id: id('OP-S'), team_id: id('OP-T') },
    ]);
    const roster = await t.db
      .selectFrom('roster_memberships')
      .select(['person_id', 'jersey_number', 'source'])
      .where('team_entry_id', '=', id('OP-E')!)
      .orderBy('jersey_number')
      .execute();
    expect(roster).toEqual([
      { person_id: id('OP-PLY'), jersey_number: 7, source: 'import' },
      { person_id: id('OP-CAP'), jersey_number: 10, source: 'import' },
    ]);
    const preferences = await t.db
      .selectFrom('communication_preferences')
      .select(['channel', 'category', 'enabled', 'source'])
      .where('person_id', '=', id('OP-PLY')!)
      .orderBy('channel')
      .execute();
    expect(preferences).toEqual([
      { channel: 'email', category: 'promotional', enabled: false, source: 'import' },
      { channel: 'sms', category: 'operational', enabled: true, source: 'import' },
    ]);
    const outboxAfterFirst = await nonMigrationOutbox();

    // The same snapshot again: every mapping is applied, nothing is called, nothing is created.
    t.clock.advance(60_000);
    const second = await importSnapshot(t, operator, snapshot());
    expect(second.sameChecksumBatchIds).toContain(first.id);
    expect(second.outcomeCounts).toEqual({
      created: 0,
      matched: 10,
      updated: 0,
      skipped: 0,
      exception: 0,
    });
    expect(await counts()).toEqual(afterFirst);
    expect(await nonMigrationOutbox()).toBe(outboxAfterFirst);
    // The import sent nothing: no notification was created for any of it (§5.4).
    expect(afterFirst.notifications).toBe(before.notifications);
    expect(outboxAfterFirst).toBeGreaterThanOrEqual(outboxBefore);

    // A later change the legacy system made to an imported season is reviewed, never forced.
    const changed = snapshot().map((row) =>
      row.externalId === 'OP-S'
        ? { ...row, payload: { ...row.payload, name: 'Winter 2027 (b)' } }
        : row,
    );
    t.clock.advance(60_000);
    const revalidated = await stageAndValidate(t, operator, changed);
    const reviewItems = await exceptionsOf(t, operator, revalidated.id);
    expect(reviewItems.map((e) => [e.externalId, e.kind, e.reasons[0]?.code])).toEqual([
      ['OP-S', 'conflict', 'imported_record_changed'],
    ]);
  });

  it('§5.6: imported events are drafts and nothing is published by the import', async () => {
    const event = await t.db
      .selectFrom('events')
      .select(['id', 'status', 'source_type', 'title'])
      .where('organization_id', '=', t.organizationId)
      .where('title', '=', 'Rovers v Strikers')
      .executeTakeFirstOrThrow();
    expect(event).toMatchObject({ status: 'draft', source_type: 'import' });
    // A draft holds no space: no reservation and no publication exist for it.
    const reservations = await t.db
      .selectFrom('reservations')
      .select('id')
      .where('event_id', '=', event.id)
      .execute();
    expect(reservations).toEqual([]);
    const published = await t.db
      .selectFrom('outbox_events')
      .select('event_type')
      .where('organization_id', '=', t.organizationId)
      .where('aggregate_id', '=', event.id)
      .execute();
    expect(published).toEqual([]);
    // The native game SportsPark scheduled is untouched.
    const native = await t.db
      .selectFrom('events')
      .select('status')
      .where('id', '=', nativeGame)
      .executeTakeFirstOrThrow();
    expect(native.status).toBe('published');
  });

  it('an event that conflicts at import becomes one IMPORT_SCHEDULE_CONFLICT exception and the rest of the batch applies', async () => {
    const rows: StagedRow[] = [
      stagedEvent('CF-EV-1', {
        facilityId: t.facilityId,
        resourceIds: [pitchId],
        scheduledStart: at('2027-02-13', '10:30'),
        scheduledEnd: at('2027-02-13', '11:30'),
        title: 'Clashes with the SportsPark rental',
      }),
      stagedEvent('CF-EV-2', {
        facilityId: t.facilityId,
        resourceIds: [pitchId],
        scheduledStart: at('2027-02-13', '14:00'),
        scheduledEnd: at('2027-02-13', '15:00'),
        title: 'Afternoon game',
      }),
      stagedPerson('CF-P', { givenName: 'After', familyName: 'Conflict' }),
    ];
    const validated = await stageAndValidate(t, operator, rows, { sourceSystem: 'legacy-booking' });
    // The dry run cannot see the clash: scheduling's import command detects it at apply.
    expect(validated.exceptions.open).toBe(0);
    const reviewed = await post(t, `/v1/import-batches/${validated.id}/review`, operator, {
      expectedRevision: validated.revision,
    });
    expect(reviewed.status, JSON.stringify(reviewed.body)).toBe(200);
    const applied = await post(t, `/v1/import-batches/${validated.id}/apply`, operator, {});
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(applied.body.outcomeCounts).toEqual({
      created: 2,
      matched: 0,
      updated: 0,
      skipped: 0,
      exception: 1,
    });
    const exceptions = await exceptionsOf(t, operator, validated.id);
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]).toMatchObject({
      externalId: 'CF-EV-1',
      kind: 'conflict',
      status: 'open',
    });
    expect(exceptions[0]?.reasons).toEqual([
      expect.objectContaining({
        code: 'owning_module_refused',
        details: expect.objectContaining({
          code: 'RESOURCE_CONFLICT',
          refusal: 'IMPORT_SCHEDULE_CONFLICT',
        }),
      }),
    ]);
    // The refused row's unit of work rolled back whole: no event, an unlinked reservation only.
    const clash = await t.db
      .selectFrom('events')
      .select('id')
      .where('title', '=', 'Clashes with the SportsPark rental')
      .execute();
    expect(clash).toEqual([]);
    const mapping = await t.db
      .selectFrom('external_mappings')
      .select(['status', 'event_id', 'reserved_record_id'])
      .where('source_system', '=', 'legacy-booking')
      .where('external_id', '=', 'CF-EV-1')
      .executeTakeFirstOrThrow();
    expect(mapping).toMatchObject({ status: 'pending', event_id: null });
    expect(mapping.reserved_record_id).not.toBeNull();
    // The rows around it applied.
    const outcomes = await rowsOf(t, operator, validated.id);
    expect(
      outcomes
        .map((r) => [r.externalId, r.outcome])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual([
      ['CF-EV-1', 'exception'],
      ['CF-EV-2', 'created'],
      ['CF-P', 'created'],
    ]);
    // Reconciliation level 4 reports the future event that was not applied.
    const report = await post(
      t,
      `/v1/import-batches/${validated.id}/reconciliation-reports`,
      operator,
      {},
    );
    expect(report.status, JSON.stringify(report.body)).toBe(201);
    expect(report.body.discrepancies).toContainEqual(
      expect.objectContaining({
        level: 'operational_outcomes',
        entityType: 'future_schedule',
        code: 'active_records_not_applied',
        countDifference: -1,
      }),
    );
  });

  it('§5.3 future schedules: an event that already ended is retained as history, not scheduled', async () => {
    const validated = await stageAndValidate(
      t,
      operator,
      [
        stagedEvent('PAST-EV', {
          facilityId: t.facilityId,
          resourceIds: [pitchId],
          scheduledStart: at('2027-01-09', '10:00'),
          scheduledEnd: at('2027-01-09', '11:00'),
        }),
      ],
      { sourceSystem: 'legacy-past' },
    );
    const [row] = await rowsOf(t, operator, validated.id);
    expect(row).toMatchObject({ plannedOutcome: 'skipped' });
    expect(row?.reasons.map((r) => r.code)).toEqual(['not_a_future_event']);
  });

  it('§5.6: a season whose competition SportsPark already runs is a conflict, never a second writer', async () => {
    const native = await createCompetitionFixture(t, { name: 'Native league' });
    await createAuthorityAssignmentFixture(t, {
      recordCategory: 'season',
      authoritativeSystem: 'sportspark',
      competitionId: native,
    });
    const validated = await stageAndValidate(
      t,
      operator,
      [
        stagedSeason('NS-1', { competitionId: native, ruleSetId, name: 'Native spring' }),
        stagedSeason('NS-2', { competitionId, ruleSetId, name: 'Legacy spring' }),
      ],
      { sourceSystem: 'legacy-seasons' },
    );
    const exceptions = await exceptionsOf(t, operator, validated.id);
    expect(exceptions.map((e) => [e.externalId, e.kind, e.reasons[0]?.code])).toEqual([
      ['NS-1', 'conflict', 'sportspark_authoritative'],
    ]);
    const batch = await get(t, `/v1/import-batches/${validated.id}`, operator);
    expect(batch.body.plannedCounts).toMatchObject({ created: 1, exception: 1 });
  });
});
