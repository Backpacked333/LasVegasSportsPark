import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import {
  addRosterMemberFixture,
  createCompetitionFixture,
  createSeasonFixture,
  createTeamEntryFixture,
} from '../../competition';
import { FakePaymentTokens } from '../providers/fake-payment.provider';
import { createObligationFixture } from '../testing/finance-fixtures';
import { adult, balanceOf, child, financeTestApp, post, staff, type Actor } from './support';

describe('obligations and team billing (SPK-PAY-004/005, SPK-AT-022)', () => {
  let t: TestApp;
  let leagueManager: Actor;
  let finance: Actor;
  let seasonId: string;

  beforeAll(async () => {
    t = await financeTestApp();
    leagueManager = await staff(t, ['league_manager']);
    finance = await staff(t, ['finance_operator']);
    const competitionId = await createCompetitionFixture(t);
    seasonId = (await createSeasonFixture(t, { competitionId })).seasonId;
  });
  afterAll(async () => {
    await t.close();
  });

  async function team(players: number) {
    const captain = await adult(t);
    const entry = await createTeamEntryFixture(t, { seasonId, captainPersonId: captain.personId });
    const roster: Actor[] = [];
    for (let i = 0; i < players; i += 1) {
      const player = await adult(t);
      await addRosterMemberFixture(t, {
        teamEntryId: entry.teamEntryId,
        personId: player.personId,
      });
      roster.push(player);
    }
    return { captain, teamEntryId: entry.teamEntryId, roster };
  }

  async function teamObligation(
    teamEntryId: string,
    amountMinor: number,
    mode = 'team_with_contributions',
    extra = {},
  ) {
    const res = await post(t, '/v1/obligations', leagueManager.header, {
      debtor: { kind: 'team_entry', teamEntryId },
      mode,
      amountMinor,
      currency: 'USD',
      dueAt: '2026-12-01T00:00:00Z',
      description: 'Team fee, autumn season',
      source: { kind: 'team_fee', id: seasonId },
      ...extra,
    });
    expect(res.status).toBe(201);
    return res.body as Record<string, unknown> & { id: string };
  }

  it('SPK-PAY-004: one team obligation; contribution requests are allocations against it, never copies of the debt', async () => {
    const { captain, teamEntryId, roster } = await team(3);
    const obligation = await teamObligation(teamEntryId, 90_000);
    expect(obligation).toMatchObject({
      mode: 'team_with_contributions',
      status: 'open',
      totals: {
        amountMinor: 90_000,
        receivedMinor: 0,
        allocatedMinor: 0,
        remainingMinor: 90_000,
        excessMinor: 0,
      },
    });
    for (const player of roster) {
      const requested = await post(
        t,
        `/v1/obligations/${obligation.id}/contribution-requests`,
        captain.header,
        {
          requestedPersonId: player.personId,
          amountMinor: 30_000,
        },
      );
      expect(requested.status).toBe(201);
    }
    const debts = await t.db
      .selectFrom('obligations')
      .select('id')
      .where('debtor_team_entry_id', '=', teamEntryId)
      .execute();
    expect(debts).toHaveLength(1);
    // Someone off the team cannot be asked to contribute.
    const outsider = await adult(t);
    const notMember = await post(
      t,
      `/v1/obligations/${obligation.id}/contribution-requests`,
      captain.header,
      {
        requestedPersonId: outsider.personId,
        amountMinor: 30_000,
      },
    );
    expect(notMember.status).toBe(400);
    // A player pays their contribution; the captain sees totals and statuses, not the payer's account.
    const [first] = roster as [Actor];
    const request = (
      await t.db
        .selectFrom('contribution_requests')
        .select('id')
        .where('requested_person_id', '=', first.personId)
        .executeTakeFirstOrThrow()
    ).id;
    const paid = await post(t, `/v1/contribution-requests/${request}/pay`, first.header, {
      paymentMethodToken: FakePaymentTokens.succeed,
    });
    expect(paid.status).toBe(201);
    expect(paid.body).toMatchObject({
      payment: { status: 'succeeded' },
      receipt: { amountMinor: 30_000, allocatedMinor: 30_000, excessMinor: 0 },
      overpaymentCreditId: null,
    });
    const captainView = await t.http.get(`/v1/obligations/${obligation.id}`).set(captain.header);
    expect(captainView.status).toBe(200);
    expect(captainView.body.totals).toMatchObject({
      amountMinor: 90_000,
      receivedMinor: 30_000,
      allocatedMinor: 30_000,
      remainingMinor: 60_000,
    });
    expect(captainView.body.contributions).toHaveLength(3);
    expect(
      captainView.body.contributions.find(
        (c: { requestedPersonId: string }) => c.requestedPersonId === first.personId,
      ),
    ).toMatchObject({ status: 'paid', amountMinor: 30_000 });
    expect(JSON.stringify(captainView.body)).not.toContain('pm_fake');
    // The captain gains no access to the player's payment (payer privacy).
    const paymentId = paid.body.payment.id as string;
    expect((await t.http.get(`/v1/payments/${paymentId}`).set(captain.header)).status).toBe(404);
    // A player sees their own request and the team totals, not the obligation's contribution list.
    const second = roster[1] as Actor;
    expect((await t.http.get(`/v1/obligations/${obligation.id}`).set(second.header)).status).toBe(
      404,
    );
    const own = await t.db
      .selectFrom('contribution_requests')
      .select('id')
      .where('requested_person_id', '=', second.personId)
      .executeTakeFirstOrThrow();
    const ownView = await t.http.get(`/v1/contribution-requests/${own.id}`).set(second.header);
    expect(ownView.body).toMatchObject({
      status: 'requested',
      obligation: { totals: { remainingMinor: 60_000 } },
    });
    expect(
      (await t.http.get(`/v1/contribution-requests/${request}`).set(second.header)).status,
    ).toBe(404);
  });

  it('SPK-AT-022 / SPK-PAY-005: concurrent contributions beyond the remaining balance keep the excess visible as a credit pending approval', async () => {
    const { captain, teamEntryId, roster } = await team(2);
    const obligation = await teamObligation(teamEntryId, 100_000);
    const requests: string[] = [];
    for (const player of roster) {
      const res = await post(
        t,
        `/v1/obligations/${obligation.id}/contribution-requests`,
        captain.header,
        {
          requestedPersonId: player.personId,
          amountMinor: 60_000,
        },
      );
      requests.push(res.body.id as string);
    }
    const liabilityBefore = await balanceOf(t, 'overpayment_liability');
    const [a, b] = await Promise.all(
      roster.map((player, i) =>
        post(t, `/v1/contribution-requests/${requests[i] as string}/pay`, player.header, {
          paymentMethodToken: FakePaymentTokens.succeed,
        }),
      ),
    );
    expect([a?.status, b?.status]).toEqual([201, 201]);
    const outcomes = [a?.body, b?.body];
    const excesses = outcomes.map((o) => o.receipt.excessMinor as number).sort((x, y) => x - y);
    expect(excesses).toEqual([0, 20_000]);
    const overpaid = outcomes.find((o) => o.receipt.excessMinor === 20_000);
    expect(overpaid.overpaymentCreditId).toEqual(expect.any(String));
    const view = await t.http.get(`/v1/obligations/${obligation.id}`).set(captain.header);
    expect(view.body).toMatchObject({
      status: 'settled',
      totals: {
        amountMinor: 100_000,
        receivedMinor: 120_000,
        allocatedMinor: 100_000,
        remainingMinor: 0,
        excessMinor: 20_000,
      },
    });
    // Reconciled: receipts = allocations + visible excess; the excess sits in a liability.
    expect(await balanceOf(t, 'overpayment_liability')).toBe(liabilityBefore - 20_000);
    const credit = await t.http
      .get(`/v1/credits/${overpaid.overpaymentCreditId as string}`)
      .set(finance.header);
    expect(credit.body).toMatchObject({
      status: 'pending_approval',
      sourceKind: 'overpayment',
      originalMinor: 20_000,
      remainingMinor: 20_000,
    });
    const review = await t.db
      .selectFrom('operational_exceptions')
      .select(['owner_queue', 'status'])
      .where('category', '=', 'finance.overpayment_review')
      .where('affected_id', '=', overpaid.overpaymentCreditId as string)
      .executeTakeFirstOrThrow();
    expect(review).toEqual({ owner_queue: 'finance_operator', status: 'open' });
    // POL-015 approval: the credit becomes usable and the liability moves to credits payable.
    const stale = await post(
      t,
      `/v1/credits/${overpaid.overpaymentCreditId as string}/approve`,
      finance.header,
      {
        expectedRevision: 99,
      },
    );
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVISION');
    const approved = await post(
      t,
      `/v1/credits/${overpaid.overpaymentCreditId as string}/approve`,
      finance.header,
      {
        expectedRevision: credit.body.revision,
      },
    );
    expect(approved.body.status).toBe('active');
    expect(await balanceOf(t, 'overpayment_liability')).toBe(liabilityBefore);
  });

  it('SPK-PAY-004: one responsible team payer pays; the captain cannot pay that model', async () => {
    const { captain, teamEntryId } = await team(1);
    const treasurer = await adult(t);
    const obligation = await teamObligation(teamEntryId, 40_000, 'single_team_payer', {
      responsiblePayerPersonId: treasurer.personId,
      source: { kind: 'team_fee' },
    });
    const byCaptain = await post(t, `/v1/obligations/${obligation.id}/payments`, captain.header, {
      paymentMethodToken: FakePaymentTokens.succeed,
    });
    expect(byCaptain.status).toBe(404);
    const contribution = await post(
      t,
      `/v1/obligations/${obligation.id}/contribution-requests`,
      captain.header,
      {
        requestedPersonId: captain.personId,
        amountMinor: 1_000,
      },
    );
    expect(contribution.status).toBe(400);
    const tooMuch = await post(t, `/v1/obligations/${obligation.id}/payments`, treasurer.header, {
      paymentMethodToken: FakePaymentTokens.succeed,
      amountMinor: 40_001,
    });
    expect(tooMuch.status).toBe(400);
    const paid = await post(t, `/v1/obligations/${obligation.id}/payments`, treasurer.header, {
      paymentMethodToken: FakePaymentTokens.succeed,
    });
    expect(paid.status).toBe(201);
    expect(paid.body.obligation).toMatchObject({
      status: 'settled',
      totals: { remainingMinor: 0 },
    });
  });

  it('SPK-PAY-004 individual billing: a guardian with pay pays the child; others learn nothing', async () => {
    const guardian = await adult(t);
    const kid = await child(t, [guardian]);
    const obligationId = await createObligationFixture(t, {
      debtorPersonId: kid,
      amountMinor: 12_000,
    });
    const viewOnly = await adult(t);
    await child(t, [viewOnly]);
    const stranger = await adult(t);
    expect((await t.http.get(`/v1/obligations/${obligationId}`).set(stranger.header)).status).toBe(
      404,
    );
    const byStranger = await post(t, `/v1/obligations/${obligationId}/payments`, stranger.header, {
      paymentMethodToken: FakePaymentTokens.succeed,
    });
    expect(byStranger.status).toBe(404);
    const paid = await post(t, `/v1/obligations/${obligationId}/payments`, guardian.header, {
      paymentMethodToken: FakePaymentTokens.succeed,
      amountMinor: 5_000,
    });
    expect(paid.body.obligation).toMatchObject({
      status: 'open',
      totals: { allocatedMinor: 5_000, remainingMinor: 7_000 },
    });
    const list = await t.http.get(`/v1/obligations?debtorPersonId=${kid}`).set(guardian.header);
    expect(list.body.items).toHaveLength(1);
  });

  it('SPK-PAY-012: desk staff record a cash tender with evidence against an existing obligation; customers cannot', async () => {
    const debtor = await adult(t);
    const obligationId = await createObligationFixture(t, {
      debtorPersonId: debtor.personId,
      amountMinor: 8_000,
    });
    const desk = await staff(t, ['front_desk']);
    const tender = {
      obligationId,
      facilityId: t.facilityId,
      tenderKind: 'cash',
      amountMinor: 8_000,
      currency: 'USD',
      evidence: { reference: 'DRAWER-1-0042' },
    };
    expect((await post(t, '/v1/cash-tenders', debtor.header, tender)).status).toBe(403);
    expect(
      (await post(t, '/v1/cash-tenders', desk.header, { ...tender, evidence: {} })).status,
    ).toBe(400);
    const recorded = await post(t, '/v1/cash-tenders', desk.header, tender);
    expect(recorded.status).toBe(201);
    expect(recorded.body).toMatchObject({
      status: 'recorded',
      recordedByPersonId: desk.personId,
      receipt: { sourceKind: 'cash_tender', allocatedMinor: 8_000 },
    });
    // The drawer is reconciled against the recorded tenders (SPK-PAY-011).
    const drawer = await post(t, '/v1/settlement-reconciliations', finance.header, {
      kind: 'cash_drawer',
      facilityId: t.facilityId,
      periodStart: new Date(t.clock.now().getTime() - 3_600_000).toISOString(),
      periodEnd: new Date(t.clock.now().getTime() + 1).toISOString(),
      currency: 'USD',
      reportedMinor: 7_500,
    });
    expect(drawer.status).toBe(201);
    expect(drawer.body).toMatchObject({
      status: 'discrepancy',
      expectedMinor: 8_000,
      differenceMinor: -500,
    });
    const tenderRow = await t.db
      .selectFrom('cash_tenders')
      .select(['status', 'reconciliation_id'])
      .where('id', '=', recorded.body.id as string)
      .executeTakeFirstOrThrow();
    expect(tenderRow).toEqual({ status: 'reconciled', reconciliation_id: drawer.body.id });
    const discrepancy = await t.db
      .selectFrom('operational_exceptions')
      .select('owner_queue')
      .where('category', '=', 'finance.settlement_discrepancy')
      .where('affected_id', '=', drawer.body.id as string)
      .executeTakeFirstOrThrow();
    expect(discrepancy.owner_queue).toBe('finance_operator');
  });

  it('staff role matrix: league managers bill teams; desk staff and schedulers cannot create obligations', async () => {
    const { teamEntryId } = await team(0);
    const body = {
      debtor: { kind: 'team_entry', teamEntryId },
      mode: 'team_with_contributions',
      amountMinor: 1_000,
      currency: 'USD',
      dueAt: '2026-12-01T00:00:00Z',
      description: 'Fee',
    };
    expect(
      (await post(t, '/v1/obligations', (await staff(t, ['front_desk'])).header, body)).status,
    ).toBe(403);
    expect(
      (await post(t, '/v1/obligations', (await staff(t, ['scheduler'])).header, body)).status,
    ).toBe(403);
    expect((await post(t, '/v1/obligations', finance.header, body)).status).toBe(201);
  });
});
