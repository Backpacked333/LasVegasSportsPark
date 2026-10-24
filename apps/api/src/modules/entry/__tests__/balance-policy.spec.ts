import { json } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../testing';
import { createPersonFixture } from '../../identity';
import { EntryModule } from '../entry.module';
import {
  FINANCIAL_STANDING_IMPL,
  type FinancialStanding,
  type FinancialStandingPort,
} from '../entry.ports';
import {
  CLOCK_START,
  enroll,
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
