import { importActorLabel, newId, systemPrincipal, type Principal } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { staffPrincipal, type TestApp } from '../../../testing';
import { createPersonFixture } from '../../identity';
import { CompetitionImportService } from '../services/competition-import.service';
import {
  createCompetitionFixture,
  createDivisionFixture,
  createRuleSetFixture,
} from '../testing/competition-fixtures';
import { competitionTestApp } from './support';

/**
 * Import commands (CMP-09, IF-40; §5.3 seasons, teams and rosters; §5.4 provenance; SPK-AT-024):
 * in-process only, for the migration import principal of one batch; create-if-absent with
 * `id = recordId` and `source = 'import'`; lifecycles through their machines.
 */
describe('competition import commands (CMP-09, IF-40, SPK-AT-024)', () => {
  let t: TestApp;
  let imports: CompetitionImportService;
  let batchId: string;
  let importer: Principal;
  let competitionId: string;
  let ruleSetId: string;

  beforeAll(async () => {
    t = await competitionTestApp();
    imports = t.app.get(CompetitionImportService);
    batchId = newId();
    importer = systemPrincipal(t.organizationId, importActorLabel(batchId));
    competitionId = await createCompetitionFixture(t, { name: 'Imported league' });
    ruleSetId = (await createRuleSetFixture(t, {})).id;
  });
  afterAll(async () => {
    await t.close();
  });

  const provenance = (externalKey: string, recordId: string = newId()) => ({
    batchId,
    externalKey,
    recordId,
  });

  async function importedSeason(name: string) {
    return imports.importSeason(importer, {
      competitionId,
      name,
      ruleSetId,
      startsOn: '2026-09-01',
      endsOn: '2026-12-15',
      status: 'active',
      importProvenance: provenance(`season:${name}`),
    });
  }

  async function importedTeam(name: string) {
    return imports.importTeam(importer, { name, importProvenance: provenance(`team:${name}`) });
  }

  it('SPK-AT-024: importing the same season, team, entry and roster twice creates each once with source import', async () => {
    const seasonInput = {
      competitionId,
      name: 'Autumn 2026',
      ruleSetId,
      startsOn: '2026-09-01',
      endsOn: '2026-12-15',
      status: 'active' as const,
      importProvenance: provenance('season:autumn-2026'),
    };
    const season = await imports.importSeason(importer, seasonInput);
    expect(season).toMatchObject({ id: seasonInput.importProvenance.recordId, status: 'active' });
    expect((await imports.importSeason(importer, seasonInput)).id).toBe(season.id);

    const teamInput = { name: 'Imported Rovers', importProvenance: provenance('team:rovers') };
    const team = await imports.importTeam(importer, teamInput);
    expect((await imports.importTeam(importer, teamInput)).id).toBe(team.id);

    const captain = await createPersonFixture(t, { kind: 'adult' });
    const entryInput = {
      seasonId: season.id,
      teamId: team.id,
      status: 'applied' as const,
      appliedAt: '2026-08-20T10:00:00.000Z',
      captainPersonId: captain,
      importProvenance: provenance('entry:rovers-autumn'),
    };
    const entry = await imports.importTeamEntry(importer, entryInput);
    expect(entry).toMatchObject({ id: entryInput.importProvenance.recordId, status: 'applied' });
    expect((await imports.importTeamEntry(importer, entryInput)).id).toBe(entry.id);

    const player = await createPersonFixture(t, { kind: 'adult' });
    const memberInput = {
      teamEntryId: entry.id,
      personId: player,
      status: 'active' as const,
      effectiveFrom: '2026-08-25T00:00:00.000Z',
      jerseyNumber: 4,
      importProvenance: provenance('roster:rovers-autumn:4'),
    };
    const member = await imports.importRosterMembership(importer, memberInput);
    expect(member).toMatchObject({
      personId: player,
      status: 'active',
      jerseyNumber: 4,
      source: 'import',
      effectiveFrom: '2026-08-25T00:00:00.000Z',
    });
    await imports.importRosterMembership(importer, memberInput);

    const sources = {
      seasons: await t.db
        .selectFrom('seasons')
        .select('source')
        .where('id', '=', season.id)
        .execute(),
      teams: await t.db.selectFrom('teams').select('source').where('id', '=', team.id).execute(),
      entries: await t.db
        .selectFrom('team_entries')
        .select('source')
        .where('id', '=', entry.id)
        .execute(),
      roster: await t.db
        .selectFrom('roster_memberships')
        .select('source')
        .where('id', '=', memberInput.importProvenance.recordId)
        .execute(),
    };
    expect(sources).toEqual({
      seasons: [{ source: 'import' }],
      teams: [{ source: 'import' }],
      entries: [{ source: 'import' }],
      roster: [{ source: 'import' }],
    });
    // one audit record per record, with the import actor and the provenance
    const audits = await t.db
      .selectFrom('audit_records')
      .select(['action', 'actor', 'details'])
      .where('target_id', 'in', [
        season.id,
        team.id,
        entry.id,
        memberInput.importProvenance.recordId,
      ])
      .execute();
    expect(audits.map((a) => a.action).sort()).toEqual([
      'competition.import_roster_membership',
      'competition.import_season',
      'competition.import_team',
      'competition.import_team_entry',
    ]);
    for (const audit of audits) {
      expect(audit.actor).toMatchObject({ kind: 'system', actorLabel: importActorLabel(batchId) });
      expect(audit.details).toMatchObject({ source: 'import', batchId });
    }
    // the captain role is recorded from the application date
    const roles = await t.db
      .selectFrom('team_roles')
      .select(['person_id', 'role', 'effective_from'])
      .where('team_entry_id', '=', entry.id)
      .execute();
    expect(roles).toEqual([
      { person_id: captain, role: 'captain', effective_from: new Date('2026-08-20T10:00:00.000Z') },
    ]);
    // migrated history starts no follow-up work
    const events = await t.db
      .selectFrom('outbox_events')
      .select('event_type')
      .where('aggregate_id', 'in', [season.id, team.id, entry.id])
      .execute();
    expect(events).toEqual([]);

    // different content under the same record id is refused
    await expect(
      imports.importTeam(importer, { ...teamInput, name: 'Renamed Rovers' }),
    ).rejects.toMatchObject({
      code: 'RESOURCE_CONFLICT',
      details: { code: 'IMPORT_CONTENT_MISMATCH' },
    });
    // only the import principal of the batch writes imported records
    await expect(
      imports.importTeam(staffPrincipal(t.organizationId, ['league_manager']), teamInput),
    ).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
      details: { code: 'IMPORT_PRINCIPAL_REQUIRED' },
    });
    await expect(
      imports.importTeam(systemPrincipal(t.organizationId, importActorLabel(newId())), teamInput),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    // one live entry per team per season, like the staff command
    await expect(
      imports.importTeamEntry(importer, {
        ...entryInput,
        importProvenance: provenance('entry:rovers-autumn-again'),
      }),
    ).rejects.toMatchObject({ code: 'DUPLICATE_ENTITLEMENT' });
  });

  it('CMP-09: an imported approved entry passes through applied -> approved and records the snapshot approval date', async () => {
    const season = await importedSeason('Winter 2026');
    const team = await importedTeam('Imported Wanderers');
    const divisionId = await createDivisionFixture(t, { seasonId: season.id, name: 'Imported A' });
    const entry = await imports.importTeamEntry(importer, {
      seasonId: season.id,
      teamId: team.id,
      divisionId,
      status: 'approved',
      appliedAt: '2026-08-01T09:00:00.000Z',
      approvedAt: '2026-08-15T12:00:00.000Z',
      importProvenance: provenance('entry:wanderers-winter'),
    });
    expect(entry).toMatchObject({
      status: 'approved',
      divisionId,
      appliedAt: '2026-08-01T09:00:00.000Z',
      approvedAt: '2026-08-15T12:00:00.000Z',
    });
    const row = await t.db
      .selectFrom('team_entries')
      .select(['status', 'approved_by', 'revision'])
      .where('id', '=', entry.id)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'approved', revision: 2 });
    expect(row.approved_by).toMatchObject({
      kind: 'system',
      actorLabel: importActorLabel(batchId),
    });
    const audit = await t.db
      .selectFrom('audit_records')
      .select('details')
      .where('target_id', '=', entry.id)
      .executeTakeFirstOrThrow();
    expect(audit.details).toMatchObject({
      transitions: ['applied', 'approved'],
      approvedAt: '2026-08-15T12:00:00.000Z',
    });
    // an approved entry carries its approval date, and only an approved one
    await expect(
      imports.importTeamEntry(importer, {
        seasonId: season.id,
        teamId: (await importedTeam('Imported Nomads')).id,
        status: 'approved',
        appliedAt: '2026-08-01T09:00:00.000Z',
        importProvenance: provenance('entry:nomads-winter'),
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { code: 'IMPORT_APPROVAL_DATE' },
    });
  });

  it('CMP-09: a withdrawn entry in the snapshot is refused (it stays staged history); so is a rejected one', async () => {
    const season = await importedSeason('Spring 2026');
    const team = await importedTeam('Imported Drifters');
    for (const status of ['withdrawn', 'rejected'] as const) {
      const recordId = newId();
      await expect(
        imports.importTeamEntry(importer, {
          seasonId: season.id,
          teamId: team.id,
          status,
          appliedAt: '2026-02-01T09:00:00.000Z',
          importProvenance: provenance(`entry:drifters-${status}`, recordId),
        }),
      ).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
        details: { code: 'IMPORT_STATUS_NOT_IMPORTABLE', status },
      });
      expect(
        await t.db.selectFrom('team_entries').select('id').where('id', '=', recordId).execute(),
      ).toEqual([]);
    }
  });

  it('CMP-09: roster memberships keep their effective dates; an ended one is imported as history', async () => {
    const season = await importedSeason('Summer 2026');
    const team = await importedTeam('Imported Pioneers');
    const entry = await imports.importTeamEntry(importer, {
      seasonId: season.id,
      teamId: team.id,
      status: 'applied',
      appliedAt: '2026-05-01T09:00:00.000Z',
      importProvenance: provenance('entry:pioneers-summer'),
    });
    const player = await createPersonFixture(t, { kind: 'adult' });
    const recordId = newId();
    await imports.importRosterMembership(importer, {
      teamEntryId: entry.id,
      personId: player,
      status: 'substitute',
      effectiveFrom: '2026-05-03T00:00:00.000Z',
      effectiveTo: '2026-06-30T00:00:00.000Z',
      importProvenance: provenance('roster:pioneers:ended', recordId),
    });
    const row = await t.db
      .selectFrom('roster_memberships')
      .select(['status', 'status_before_removal', 'effective_from', 'effective_to', 'source'])
      .where('id', '=', recordId)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      status: 'removed',
      status_before_removal: 'substitute',
      effective_from: new Date('2026-05-03T00:00:00.000Z'),
      effective_to: new Date('2026-06-30T00:00:00.000Z'),
      source: 'import',
    });
  });
});
