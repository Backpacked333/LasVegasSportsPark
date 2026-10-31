import { newId } from '@sportspark/contracts';
import { seedOrganization } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnitOfWork } from '../../../kernel';
import { staffPrincipal, type TestApp } from '../../../testing';
// Finance's read rule for the obligation is the one the workspace follows (READ_TEAM_OBLIGATION_ACTION).
import { FinanceActions } from '../../finance/finance.actions';
import { createPersonFixture, createRelationshipFixture } from '../../identity';
import {
  FINANCIAL_CONDITIONS_IMPL,
  type FinancialConditionsPort,
  type TeamEntryFinancialStatus,
} from '../competition-matches.ports';
import { TEAM_ENTRY_QUERY_PORT, type TeamEntryQueryPort } from '../ports';
import { financialIssueOf, READ_TEAM_OBLIGATION_ACTION } from '../services/team-entries.service';
import {
  addRosterMemberFixture,
  createDivisionFixture,
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
  let divisionId: string;
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
    // the division plays at the test facility (America/Los_Angeles): due dates are shown there
    divisionId = await createDivisionFixture(t, { seasonId: season.seasonId });
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
      divisionId,
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
    // SPK-PAY-001/004: the amount through the Money helpers, the due date at the facility, and no
    // policy or decision ids in what the captain reads
    const message = open.financial[0]?.message ?? '';
    expect(message).toContain('1 open team obligation with $300.00 outstanding');
    expect(message).toContain('Nov 14, 2026');
    expect(message).toContain('(America/Los_Angeles)');
    expect(message).not.toContain('minor units');
    expect(message).not.toContain('2026-11-15T');
    expect(message).not.toMatch(/POL-|DEC-/);
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

  it('R2-JOURNEYS-05 / SPK-CAP-002: a rostered member, a guardian of a child player and a coach open the workspace but see neither the amount nor the due date of the team balance, which finance shows only to the captain and financial staff', async () => {
    // the workspace follows finance's own read rule for the team obligation
    expect(READ_TEAM_OBLIGATION_ACTION).toBe(FinanceActions.readObligation.id);
    const hawks = await entry('Hawks');
    const member = await adultCustomer(t);
    await addRosterMemberFixture(t, { teamEntryId: hawks.teamEntryId, personId: member.personId });
    const child = await createPersonFixture(t, { kind: 'child', dateOfBirth: '2014-04-02' });
    await addRosterMemberFixture(t, { teamEntryId: hawks.teamEntryId, personId: child });
    const guardian = await adultCustomer(t);
    await createRelationshipFixture(t, {
      actorPersonId: guardian.personId,
      subjectPersonId: child,
      permissions: ['view'],
    });
    const coach = await staffMember(t, ['coach']);
    await record(hawks.teamEntryId, newId());
    statuses.set(hawks.teamEntryId, {
      status: 'outstanding',
      openObligations: 2,
      outstanding: [{ amountMinor: 45050, currency: 'USD' }],
      nextDueAt: '2026-12-01T20:00:00.000Z',
    });

    const captainView = await workspace(hawks.teamEntryId, hawks.captain);
    expect(captainView.financial[0]?.message).toContain('2 open team obligations with $450.50');
    expect(captainView.financial[0]?.message).toContain('Dec 1, 2026');

    for (const viewer of [member, guardian, coach]) {
      const res = await t.http.get(`/v1/team-entries/${hawks.teamEntryId}`).set(viewer.header);
      expect(res.status).toBe(200);
      const issues = (res.body.readiness as { issues: Issue[] }).issues;
      const financial = issues.filter((i) => i.code === 'team_obligation_outstanding');
      expect(financial).toEqual([
        {
          code: 'team_obligation_outstanding',
          severity: 'warning',
          message: 'The team has an open balance. The captain can see the amount and the due date.',
          responsibleRole: 'captain',
          requiredAction: 'The captain collects the remaining contributions or pays the balance.',
        },
      ]);
      const body = JSON.stringify(res.body);
      expect(body).not.toContain('450.50');
      expect(body).not.toContain('45050');
      expect(body).not.toContain('Dec 1, 2026');
      expect(body).not.toContain('2026-12-01T20:00');
    }

    // an unknown status: finance's explanation is for staff, never for customers
    statuses.set(hawks.teamEntryId, {
      status: 'unknown',
      explanation: 'the obligation ledger is being reconciled',
    });
    const staffUnknown = (await workspace(hawks.teamEntryId, leagueManager)).financial[0];
    expect(staffUnknown?.message).toContain('(the obligation ledger is being reconciled)');
    const captainUnknown = (await workspace(hawks.teamEntryId, hawks.captain)).financial[0];
    expect(captainUnknown).toMatchObject({ code: 'financial_status_unknown', severity: 'unknown' });
    expect(captainUnknown?.message).toContain('An obligation is recorded for this entry');
    expect(captainUnknown?.message).not.toContain('reconciled');
    const memberUnknown = (await workspace(hawks.teamEntryId, member)).financial;
    expect(memberUnknown).toEqual([
      expect.objectContaining({
        code: 'financial_status_unknown',
        severity: 'unknown',
        message: "The team's financial status is not confirmed yet.",
        responsibleRole: 'finance_operator',
      }),
    ]);
  });

  it('R2-JOURNEYS-05: the issue for each finance answer and audience (unit)', () => {
    const captain = { readsObligation: true, staff: false, timezone: 'America/Los_Angeles' };
    const staff = { readsObligation: true, staff: true, timezone: null };
    const teammate = { readsObligation: false, staff: false, timezone: 'America/Los_Angeles' };
    expect(financialIssueOf('obl', { status: 'clear' }, captain)).toBeNull();
    expect(financialIssueOf('obl', { status: 'clear' }, teammate)).toBeNull();
    expect(financialIssueOf(null, { status: 'none' }, captain)).toMatchObject({
      code: 'financial_status_unknown',
      severity: 'unknown',
      message: 'No financial obligation has been recorded for this entry yet.',
    });
    expect(financialIssueOf('obl', { status: 'none' }, captain)?.message).toContain('was canceled');
    expect(financialIssueOf('obl', { status: 'none' }, teammate)?.message).toBe(
      "The team's financial status is not confirmed yet.",
    );
    const unknown = { status: 'unknown', explanation: 'no finance check' } as const;
    expect(financialIssueOf(null, unknown, staff)).toMatchObject({
      code: 'financial_status_unknown',
      severity: 'unknown',
      message: expect.stringContaining('(no finance check)'),
    });
    expect(financialIssueOf(null, unknown, captain)?.message).not.toContain('no finance check');
    const outstanding: TeamEntryFinancialStatus & { status: 'outstanding' } = {
      status: 'outstanding',
      openObligations: 1,
      outstanding: [
        { amountMinor: 30000, currency: 'USD' },
        { amountMinor: 1250, currency: 'EUR' },
      ],
      nextDueAt: '2026-11-15T00:00:00.000Z',
    };
    // without a facility the due instant is shown in UTC, named as such
    expect(financialIssueOf(null, outstanding, staff)?.message).toBe(
      '1 open team obligation with $300.00 and €12.50 outstanding; the next payment is due 2026-11-15 00:00 UTC.',
    );
    expect(financialIssueOf(null, { ...outstanding, nextDueAt: null }, staff)?.message).toBe(
      '1 open team obligation with $300.00 and €12.50 outstanding.',
    );
  });
});
