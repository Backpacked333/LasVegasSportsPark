import type { WaiverAcceptance } from '@sportspark/contracts';
import { describe, expect, it } from 'vitest';
import {
  acceptedInstant,
  addMonthsUtc,
  judgeWaiver,
  parseWaiverContent,
  type WaiverVersionInForce,
} from './waiver-rule';

const V1 = '0192f1a0-0000-7000-8000-000000000001';
const V2 = '0192f1a0-0000-7000-8000-000000000002';
const PERSON = '0192f1a0-0000-7000-8000-0000000000aa';

const inForce = (
  id: string,
  version: number,
  rule: { reaccept?: boolean; months?: number | null; enforcement?: 'warn' | 'block' } = {},
): WaiverVersionInForce => ({
  ref: {
    policyVersionId: id,
    version,
    title: 'Liability waiver',
    effectiveFrom: '2026-06-01T00:00:00.000Z',
  },
  content: {
    text: 'wording',
    renewal: {
      reacceptOnNewVersion: rule.reaccept ?? false,
      renewEveryMonths: rule.months ?? null,
    },
    enforcement: rule.enforcement ?? 'warn',
    overrideRoles: [],
  },
});

let n = 0;
const acceptance = (
  versionId: string,
  signedAt: string,
  over: Partial<WaiverAcceptance> = {},
): WaiverAcceptance => {
  n += 1;
  const merged = {
    acknowledgmentId: `0192f1a0-0000-7000-8000-${String(n).padStart(12, '0')}`,
    policyVersionId: versionId,
    version: versionId === V1 ? 1 : 2,
    subjectPersonId: PERSON,
    signedByPersonId: PERSON,
    basis: 'self' as const,
    method: 'digital' as const,
    signedAt,
    paperDatedOn: null,
    recordedByKind: 'customer' as const,
    recordedByPersonId: null,
    status: 'active' as const,
    withdrawnAt: null,
    withdrawnReason: null,
    ...over,
  };
  return { ...merged, acceptedAt: acceptedInstant(merged).toISOString() };
};

const AT = new Date('2026-11-14T12:00:00Z');

describe('judgeWaiver (SPK-REG-011, proposed amendment PA-01)', () => {
  it('SPK-REG-011: missing when the person never accepted, or only a withdrawn acceptance exists', () => {
    expect(
      judgeWaiver({ policyKey: 'liability', at: AT, inForce: inForce(V1, 1), acceptances: [] }),
    ).toMatchObject({ status: 'missing', reason: 'never_accepted', acceptance: null });
    expect(
      judgeWaiver({
        policyKey: 'liability',
        at: AT,
        inForce: inForce(V1, 1),
        acceptances: [acceptance(V1, '2026-07-01T00:00:00.000Z', { status: 'withdrawn' })],
      }).status,
    ).toBe('missing');
  });

  it('SPK-REG-011: with no version in force nothing is judged current (unknown is never a pass)', () => {
    const judged = judgeWaiver({
      policyKey: 'liability',
      at: AT,
      inForce: null,
      acceptances: [acceptance(V1, '2026-07-01T00:00:00.000Z')],
    });
    expect(judged).toMatchObject({ status: 'missing', reason: 'no_version_in_force', rule: null });
    expect(judged.acceptance?.policyVersionId).toBe(V1);
  });

  it('SPK-REG-011: an acceptance of an earlier version stays current unless the version in force requires re-acceptance', () => {
    const old = acceptance(V1, '2026-07-01T00:00:00.000Z');
    expect(
      judgeWaiver({ policyKey: 'liability', at: AT, inForce: inForce(V2, 2), acceptances: [old] }),
    ).toMatchObject({ status: 'current', reason: null, validUntil: null });
    const lapsed = judgeWaiver({
      policyKey: 'liability',
      at: AT,
      inForce: inForce(V2, 2, { reaccept: true }),
      acceptances: [old],
    });
    expect(lapsed).toMatchObject({
      status: 'lapsed',
      reason: 'new_version',
      lapsedAt: '2026-06-01T00:00:00.000Z',
    });
    expect(lapsed.acceptance?.policyVersionId).toBe(V1);
    expect(
      judgeWaiver({
        policyKey: 'liability',
        at: AT,
        inForce: inForce(V2, 2, { reaccept: true }),
        acceptances: [old, acceptance(V2, '2026-11-01T00:00:00.000Z')],
      }).status,
    ).toBe('current');
  });

  it('SPK-REG-011: periodic renewal lapses an acceptance on the month boundary and not a moment before', () => {
    const signed = acceptance(V1, '2025-11-14T12:00:00.000Z');
    const rule = inForce(V1, 1, { months: 12 });
    expect(
      judgeWaiver({
        policyKey: 'liability',
        at: new Date('2026-11-14T11:59:59.999Z'),
        inForce: rule,
        acceptances: [signed],
      }),
    ).toMatchObject({ status: 'current', validUntil: '2026-11-14T12:00:00.000Z' });
    expect(
      judgeWaiver({ policyKey: 'liability', at: AT, inForce: rule, acceptances: [signed] }),
    ).toMatchObject({
      status: 'lapsed',
      reason: 'renewal_due',
      lapsedAt: '2026-11-14T12:00:00.000Z',
    });
  });

  it('SPK-REG-011: a paper acceptance counts from the date on the paper, not from the staff entry', () => {
    const paper = acceptance(V1, '2026-11-10T09:00:00.000Z', {
      method: 'paper',
      paperDatedOn: '2025-10-01',
      recordedByKind: 'staff',
    });
    expect(paper.acceptedAt).toBe('2025-10-01T00:00:00.000Z');
    expect(
      judgeWaiver({
        policyKey: 'liability',
        at: AT,
        inForce: inForce(V1, 1, { months: 12 }),
        acceptances: [paper],
      }),
    ).toMatchObject({ status: 'lapsed', reason: 'renewal_due' });
  });

  it('an acceptance recorded after the instant asked about does not count at that instant', () => {
    expect(
      judgeWaiver({
        policyKey: 'liability',
        at: new Date('2026-06-15T00:00:00Z'),
        inForce: inForce(V1, 1),
        acceptances: [acceptance(V1, '2026-07-01T00:00:00.000Z')],
      }).status,
    ).toBe('missing');
  });

  it('addMonthsUtc keeps the day and clamps to the last day of a shorter month', () => {
    expect(addMonthsUtc(new Date('2026-01-31T10:00:00Z'), 1).toISOString()).toBe(
      '2026-02-28T10:00:00.000Z',
    );
    expect(addMonthsUtc(new Date('2026-03-15T00:00:00Z'), 12).toISOString()).toBe(
      '2027-03-15T00:00:00.000Z',
    );
  });

  it('a waiver version states every value of its rule: incomplete content is not a rule', () => {
    expect(parseWaiverContent({ text: 'wording' })).toBeNull();
    expect(
      parseWaiverContent({
        text: 'wording',
        renewal: { reacceptOnNewVersion: false, renewEveryMonths: null },
        enforcement: 'warn',
        overrideRoles: [],
      }),
    ).not.toBeNull();
  });
});
