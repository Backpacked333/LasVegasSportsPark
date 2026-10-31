import { newId } from '@sportspark/contracts';
import { seedOrganization } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnitOfWork } from '../../../kernel';
import { staffPrincipal, type TestApp } from '../../../testing';
import {
  FINANCIAL_CONDITIONS_IMPL,
  type FinancialConditionsPort,
  type TeamEntryFinancialStatus,
} from '../competition-matches.ports';
import { TEAM_ENTRY_QUERY_PORT, type TeamEntryQueryPort } from '../ports';
import { financialIssueOf } from '../services/team-entries.service';
import {
  createSeasonFixture,
  createTeamEntryFixture,
  type SeasonFixture,
} from '../testing/competition-fixtures';
import { adultCustomer, competitionTestApp, staffMember, type Actor } from './support';

interface Issue {
  code: string;
  severity: string;
  message: string;
  responsibleRole: string;
  requiredAction: string;
}

/**
 * R2-JOURNEYS-05 (SPK-COMP-004, SPK-CAP-002, SPK-AT-022): the entry's financial status is
 * finance's. Finance records the obligation it created for a team entry through
 * `TEAM_ENTRY_QUERY_PORT.recordFinancialStatusRef`, and the workspace reads the obligation state
 * through `FINANCIAL_CONDITIONS_PORT.entryFinancialStatus` (here a deterministic fake standing in
 * for finance's implementation).
 */
describe('team entry financial status (R2-JOURNEYS-05, SPK-COMP-004, SPK-CAP-002)', () => {
  let t: TestApp;
  let season: SeasonFixture;
  let leagueManager: Actor;
  const statuses = new Map<string, TeamEntryFinancialStatus | 'throws'>();
  const finance: FinancialConditionsPort = {
    fixtureConditions: async () => [],
    entryFinancialStatus: async (_organizationId, teamEntryId) => {
      const status = statuses.get(teamEntryId) ?? { status: 'none' };
      if (status === 'throws') throw new Error('finance read failed');
      return status;
    },
  };

  beforeAll(async () => {
    t = await competitionTestApp({
      providers: [{ provide: FINANCIAL_CONDITIONS_IMPL, useValue: finance }],
    });
    season = await createSeasonFixture(t, { status: 'open' });
    leagueManager = await staffMember(t, ['league_manager']);
  });
  afterAll(async () => {
    await t.close();
  });

  async function entry(name: string): Promise<{ teamEntryId: string; captain: Actor }> {
    const captain = await adultCustomer(t);
    const created = await createTeamEntryFixture(t, {
      seasonId: season.seasonId,
      captainPersonId: captain.personId,
      teamName: name,
    });
    return { teamEntryId: created.teamEntryId, captain };
  }

  async function workspace(teamEntryId: string, actor: Actor) {
    const res = await t.http.get(`/v1/team-entries/${teamEntryId}`).set(actor.header);
    expect(res.status).toBe(200);
    const readiness = res.body.readiness as { financialStatusRef: string | null; issues: Issue[] };
    const financial = readiness.issues.filter(
      (i) => i.code === 'financial_status_unknown' || i.code === 'team_obligation_outstanding',
    );
    return { ref: readiness.financialStatusRef, financial, revision: res.body.entry.revision };
  }

  const record = (teamEntryId: string, obligationId: string, organizationId = t.organizationId) =>
    t.app.get(UnitOfWork).run(({ trx }) =>
      t.app.get<TeamEntryQueryPort>(TEAM_ENTRY_QUERY_PORT).recordFinancialStatusRef(trx, {
        organizationId,
        teamEntryId,
        obligationId,
        actor: staffPrincipal(organizationId, ['finance_operator']),
        correlationId: null,
      }),
    );

  it('R2-JOURNEYS-05 / SPK-COMP-004: finance records the obligation of a team entry through the port in its own transaction, audited, idempotent, organization-scoped', async () => {
    const comets = await entry('Comets');
    const before = await workspace(comets.teamEntryId, comets.captain);
    expect(before.ref).toBeNull();

    const obligationId = newId();
    await record(comets.teamEntryId, obligationId);
    const after = await workspace(comets.teamEntryId, comets.captain);
    expect(after.ref).toBe(obligationId);
    expect(after.revision).toBe(before.revision + 1);
    const audits = await t.db
      .selectFrom('audit_records')
      .select(['action', 'before_revision', 'after_revision', 'details'])
      .where('target_type', '=', 'team_entry')
      .where('target_id', '=', comets.teamEntryId)
      .where('action', '=', 'competition.record_financial_status')
      .execute();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      before_revision: before.revision,
      after_revision: before.revision + 1,
      details: { financialStatusRef: obligationId, previousFinancialStatusRef: null },
    });

    // a replay of the same obligation changes nothing
    await record(comets.teamEntryId, obligationId);
    expect((await workspace(comets.teamEntryId, comets.captain)).revision).toBe(after.revision);

    // another organization cannot point at this entry
    const other = await seedOrganization(t.db);
    await expect(record(comets.teamEntryId, newId(), other.organizationId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect((await workspace(comets.teamEntryId, comets.captain)).ref).toBe(obligationId);
  });

  it('R2-JOURNEYS-05 / SPK-COMP-004 / SPK-CAP-002: the workspace reports finance’s obligation state, so a settled team obligation is no longer “not recorded”', async () => {
    const bolts = await entry('Bolts');
    // no obligation yet: finance owns the next step
    expect((await workspace(bolts.teamEntryId, bolts.captain)).financial).toEqual([
      expect.objectContaining({
        code: 'financial_status_unknown',
        severity: 'unknown',
        message: 'No financial obligation has been recorded for this entry yet.',
        responsibleRole: 'finance_operator',
      }),
    ]);

    // finance creates the team obligation; contributions are still due
    const obligationId = newId();
    await record(bolts.teamEntryId, obligationId);
    statuses.set(bolts.teamEntryId, {
      status: 'outstanding',
      openObligations: 1,
      outstanding: [{ amountMinor: 30000, currency: 'USD' }],
      nextDueAt: '2026-11-15T00:00:00.000Z',
    });
    const open = await workspace(bolts.teamEntryId, bolts.captain);
    expect(open.ref).toBe(obligationId);
    expect(open.financial).toEqual([
      expect.objectContaining({
        code: 'team_obligation_outstanding',
        severity: 'warning',
        responsibleRole: 'captain',
      }),
    ]);
    expect(open.financial[0]?.message).toContain('30000 USD (minor units)');
    expect(open.financial[0]?.message).toContain('POL-017');
    // the league manager reviewing the entry sees the same status
    expect((await workspace(bolts.teamEntryId, leagueManager)).financial).toEqual(open.financial);

    // the contributions settle it: nothing financial is missing any more
    statuses.set(bolts.teamEntryId, { status: 'clear' });
    const settled = await workspace(bolts.teamEntryId, bolts.captain);
    expect(settled.ref).toBe(obligationId);
    expect(settled.financial).toEqual([]);

    // finance cannot answer: unknown, never clear, and the recorded obligation is named
    statuses.set(bolts.teamEntryId, 'throws');
    const failed = await workspace(bolts.teamEntryId, bolts.captain);
    expect(failed.financial).toEqual([
      expect.objectContaining({ code: 'financial_status_unknown', severity: 'unknown' }),
    ]);
    expect(failed.financial[0]?.message).toContain('An obligation is recorded for this entry');
  });

  it('R2-JOURNEYS-05: the issue for each finance answer (unit)', () => {
    expect(financialIssueOf('obl', { status: 'clear' })).toBeNull();
    expect(financialIssueOf(null, { status: 'none' })).toMatchObject({
      code: 'financial_status_unknown',
      severity: 'unknown',
    });
    expect(financialIssueOf('obl', { status: 'none' })?.message).toContain('was canceled');
    expect(
      financialIssueOf(null, { status: 'unknown', explanation: 'no finance check' }),
    ).toMatchObject({
      code: 'financial_status_unknown',
      severity: 'unknown',
      message: expect.stringContaining('no finance check'),
    });
  });
});
