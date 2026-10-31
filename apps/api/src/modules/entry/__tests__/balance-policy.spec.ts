import { newId } from '@sportspark/contracts';
import { json } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../testing';
import { createPersonFixture } from '../../identity';
import { createAssignmentFixture } from '../../workforce';
import { EntryModule } from '../entry.module';
import {
  FINANCIAL_STANDING_IMPL,
  type FinancialStanding,
  type FinancialStandingPort,
} from '../entry.ports';
import {
  CLOCK_START,
  enroll,
  family,
  post,
  program,
  sessionRef,
  staffMember,
  type Actor,
  type Program,
} from './support';

/** A finance stand-in: each person's standing is scripted by the test. */
class ScriptedStanding implements FinancialStandingPort {
  readonly byPerson = new Map<string, FinancialStanding>();
  async standingOf(_organizationId: string, personId: string): Promise<FinancialStanding> {
    return this.byPerson.get(personId) ?? { status: 'clear' };
  }
}

describe('SPK-ENTRY-004: an unrelated balance does not block unless the approved policy requires it (DEC-056)', () => {
  let t: TestApp;
  let desk: Actor;
  let p: Program;
  const finance = new ScriptedStanding();

  beforeAll(async () => {
    t = await createTestApp({
      imports: [EntryModule],
      principalResolver: 'module',
      clockStart: CLOCK_START,
      providers: [{ provide: FINANCIAL_STANDING_IMPL, useValue: finance }],
    });
    desk = await staffMember(t, ['front_desk']);
    const manager = await staffMember(t, ['program_manager']);
    p = await program(t, manager);
  });
  afterAll(async () => {
    await t.close();
  });

  const childWithBalance = async (standing: FinancialStanding) => {
    const guardian = await createPersonFixture(t, { kind: 'adult' });
    const child = await createPersonFixture(t, { kind: 'child' });
    await enroll(t, p, child, guardian);
    finance.byPerson.set(child, standing);
    return child;
  };
  const issueCodes = (body: { issues: Array<{ code: string; severity: string }> }) =>
    body.issues.map((i) => `${i.code}:${i.severity}`);

  it('a clear standing adds no issue; a related balance is a warning; an unrelated one is informational', async () => {
    const clear = await childWithBalance({ status: 'clear' });
    const a = await post(t, '/v1/session-checkins', desk, {
      personId: clear,
      activity: sessionRef(p),
    });
    expect(a.body.status).toBe('admitted');
    expect(issueCodes(a.body).some((c) => c.includes('balance'))).toBe(false);

    const related = await childWithBalance({
      status: 'outstanding',
      related: true,
      amountMinor: 5_000,
      currency: 'USD',
      reference: null,
    });
    const b = await post(t, '/v1/session-checkins', desk, {
      personId: related,
      activity: sessionRef(p),
    });
    expect(b.body.status).toBe('admitted');
    expect(issueCodes(b.body)).toContain('outstanding_balance:warning');

    const unrelated = await childWithBalance({
      status: 'outstanding',
      related: false,
      amountMinor: 12_000,
      currency: 'USD',
      reference: null,
    });
    const c = await post(t, '/v1/session-checkins', desk, {
      personId: unrelated,
      activity: sessionRef(p),
    });
    expect(c.body.status).toBe('admitted');
    expect(issueCodes(c.body)).toContain('outstanding_balance:info');
  });

  it('a facility whose approved policy requires it blocks on the unrelated balance', async () => {
    await t.db
      .updateTable('facilities')
      .set({ settings: json({ entry: { blockOnUnrelatedBalance: true } }) })
      .where('id', '=', t.facilityId)
      .execute();
    const unrelated = await childWithBalance({
      status: 'outstanding',
      related: false,
      amountMinor: 12_000,
      currency: 'USD',
      reference: null,
    });
    const res = await post(t, '/v1/session-checkins', desk, {
      personId: unrelated,
      activity: sessionRef(p),
    });
    expect(res.body.status).toBe('held');
    expect(issueCodes(res.body)).toContain('outstanding_balance:blocking');
  });
});

describe('AUTHZ-PRIVACY-01 (SPK-UX-007, §4.14): only staff learn of a balance at check-in; the assigned coach and a guardian never see one or its obligation', () => {
  let t: TestApp;
  let desk: Actor;
  let coach: Actor;
  let p: Program;
  const finance = new ScriptedStanding();

  beforeAll(async () => {
    t = await createTestApp({
      imports: [EntryModule],
      principalResolver: 'module',
      clockStart: CLOCK_START,
      providers: [{ provide: FINANCIAL_STANDING_IMPL, useValue: finance }],
    });
    desk = await staffMember(t, ['front_desk']);
    coach = await staffMember(t, ['coach']);
    const manager = await staffMember(t, ['program_manager']);
    p = await program(t, manager);
    await createAssignmentFixture(t, {
      targetType: 'session',
      targetId: p.sessionId,
      offeringId: p.offering.offeringId,
      personId: coach.personId,
      kind: 'coach',
      role: 'head_coach',
      status: 'accepted',
      scheduledStart: p.start,
      scheduledEnd: p.end,
    });
  });
  afterAll(async () => {
    await t.close();
  });

  const blockOnUnrelatedBalance = async (block: boolean) => {
    await t.db
      .updateTable('facilities')
      .set({ settings: json({ entry: { blockOnUnrelatedBalance: block } }) })
      .where('id', '=', t.facilityId)
      .execute();
  };
  /** A child enrolled by one guardian (who holds `view`) and owing through another adult's order. */
  const childOwing = async (standing: FinancialStanding) => {
    const fam = await family(t, desk, ['view']);
    await enroll(t, p, fam.childA, fam.guardian.personId);
    finance.byPerson.set(fam.childA, standing);
    return fam;
  };
  const owing = (related: boolean, obligationId: string): FinancialStanding => ({
    status: 'outstanding',
    related,
    amountMinor: 12_000,
    currency: 'USD',
    reference: obligationId,
  });
  const codes = (body: { issues: Array<{ code: string; severity: string }> }) =>
    body.issues.map((i) => `${i.code}:${i.severity}`);
  const read = (actor: Actor, id: string) =>
    t.http.get(`/v1/session-checkins/${id}`).set(actor.header);

  it('an unrelated (informational) or related (warning) balance, and an unknown standing, reach the desk only', async () => {
    await blockOnUnrelatedBalance(false);
    for (const [standing, expected] of [
      [owing(false, newId()), 'outstanding_balance:info'],
      [owing(true, newId()), 'outstanding_balance:warning'],
      [{ status: 'unknown', explanation: 'finance is unavailable' }, 'balance_unknown:info'],
    ] as Array<[FinancialStanding, string]>) {
      const fam = await childOwing(standing);
      const obligationId = standing.status === 'outstanding' ? standing.reference! : null;
      // The assigned coach checks the child in: admitted, and nothing about money.
      const checkedIn = await post(t, '/v1/session-checkins', coach, {
        personId: fam.childA,
        activity: sessionRef(p),
      });
      expect(checkedIn.status, JSON.stringify(checkedIn.body)).toBe(201);
      expect(checkedIn.body.status).toBe('admitted');
      const id = checkedIn.body.id as string;
      for (const response of [checkedIn, await read(coach, id), await read(fam.guardian, id)]) {
        expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
        expect(codes(response.body).filter((c) => c.includes('balance'))).toEqual([]);
        if (obligationId) expect(JSON.stringify(response.body)).not.toContain(obligationId);
      }
      // The desk sees the issue, with the obligation.
      const atDesk = await read(desk, id);
      expect(codes(atDesk.body)).toContain(expected);
      if (obligationId) {
        expect(atDesk.body.issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ reference: { type: 'obligation', id: obligationId } }),
          ]),
        );
      }
    }
  });

  it('a balance the approved policy blocks on holds the check-in; the coach and the guardian are told only to see the desk', async () => {
    await blockOnUnrelatedBalance(true);
    const obligationId = newId();
    const fam = await childOwing(owing(false, obligationId));
    const checkedIn = await post(t, '/v1/session-checkins', coach, {
      personId: fam.childA,
      activity: sessionRef(p),
    });
    expect(checkedIn.status, JSON.stringify(checkedIn.body)).toBe(201);
    expect(checkedIn.body.status).toBe('held');
    const id = checkedIn.body.id as string;
    const rechecked = await post(t, `/v1/session-checkins/${id}/recheck`, coach, {
      expectedRevision: checkedIn.body.revision,
    });
    expect(rechecked.status, JSON.stringify(rechecked.body)).toBe(200);
    expect(rechecked.body.status).toBe('held');
    for (const response of [
      checkedIn,
      rechecked,
      await read(coach, id),
      await read(fam.guardian, id),
    ]) {
      // No facility arrival is recorded, so `not_on_site` stays: it is not a finance fact.
      expect(codes(response.body)).toEqual([
        'desk_review_required:blocking',
        'not_on_site:warning',
      ]);
      expect(response.body.issues[0]).toMatchObject({
        nextAction: 'see_the_desk',
        reference: null,
      });
      expect(JSON.stringify(response.body)).not.toContain(obligationId);
      expect(JSON.stringify(response.body)).not.toContain('balance');
    }
    const atDesk = await read(desk, id);
    expect(atDesk.body.issues).toEqual([
      expect.objectContaining({
        code: 'outstanding_balance',
        severity: 'blocking',
        reference: { type: 'obligation', id: obligationId },
      }),
      expect.objectContaining({ code: 'not_on_site' }),
    ]);
    // The desk's recheck answers with the full record; what is stored never changes by reader.
    const deskRecheck = await post(t, `/v1/session-checkins/${id}/recheck`, desk, {
      expectedRevision: rechecked.body.revision,
    });
    expect(codes(deskRecheck.body)).toEqual([
      'outstanding_balance:blocking',
      'not_on_site:warning',
    ]);
    await blockOnUnrelatedBalance(false);
  });
});
