import type { Enrollment } from '@sportspark/contracts';
import { describe, expect, it } from 'vitest';
import { customerPrincipal, staffPrincipal } from '../../testing/principals';
import { redactEnrollment, registrantSnapshot, viewerOf } from './enrollment.shared';

const org = '01a16c09-0000-7000-8000-00000000000f';
const payer = '01a16c09-0000-7000-8000-000000000011';
const other = '01a16c09-0000-7000-8000-000000000012';

const enrollment = {
  id: '01a16c09-0000-7000-8000-000000000013',
  payerPersonId: payer,
  registeredBy: {
    kind: 'customer',
    accountId: null,
    personId: payer,
    staffRoles: [],
    actorLabel: 'customer:payer',
  },
  basketId: '01a16c09-0000-7000-8000-000000000014',
  basketLineId: '01a16c09-0000-7000-8000-000000000015',
  orderRef: 'order-1',
  cancellationConsequence: null,
  transferConsequence: null,
} as unknown as Enrollment;

describe('SPK-AT-004 payer privacy', () => {
  it('shows the payer, the registrant and staff everything', () => {
    expect(
      redactEnrollment(viewerOf(customerPrincipal(org, { personId: payer }), false), enrollment),
    ).toBe(enrollment);
    expect(redactEnrollment(viewerOf(staffPrincipal(org, ['front_desk']), true), enrollment)).toBe(
      enrollment,
    );
  });

  it('hides who registered and pays from another authorized adult', () => {
    const seen = redactEnrollment(
      viewerOf(customerPrincipal(org, { personId: other }), false),
      enrollment,
    );
    expect(seen).toMatchObject({
      payerPersonId: null,
      basketId: null,
      basketLineId: null,
      orderRef: null,
    });
    expect(seen.registeredBy.personId).toBeNull();
    expect(JSON.stringify(seen)).not.toContain(payer);
  });

  it('R3-TRACE-A-02: a staff member reading through a relationship is a family reader', () => {
    // A coach who is the other guardian: their staff kind does not exempt them from payer privacy.
    const coachGuardian = staffPrincipal(org, ['coach'], { personId: other });
    const seen = redactEnrollment(viewerOf(coachGuardian, false), enrollment);
    expect(seen.payerPersonId).toBeNull();
    expect(JSON.stringify(seen)).not.toContain(payer);
    // A customer never reads as staff, whatever a caller passes.
    expect(viewerOf(customerPrincipal(org, { personId: other }), true).staff).toBe(false);
  });
});

describe('SPK-REG-009 registrant snapshot (R3-TRACE-A-02)', () => {
  const accountId = '01a16c09-0000-7000-8000-0000000000aa';

  it('records a staff member acting for their own family wholly as the customer they acted as', () => {
    const scheduler = staffPrincipal(org, ['scheduler'], {
      accountId,
      personId: other,
      actorLabel: `staff:scheduler:${accountId.slice(0, 8)}`,
    });
    expect(registrantSnapshot(scheduler, false)).toEqual({
      kind: 'customer',
      accountId,
      personId: other,
      staffRoles: [],
      actorLabel: `customer:${accountId.slice(0, 8)}`,
    });
  });

  it('keeps the staff actor of an assisted record and any customer as they are', () => {
    const desk = staffPrincipal(org, ['front_desk'], {
      accountId,
      actorLabel: 'staff:front_desk:x',
    });
    expect(registrantSnapshot(desk, true)).toMatchObject({
      kind: 'staff',
      staffRoles: ['front_desk'],
      actorLabel: 'staff:front_desk:x',
    });
    const parent = customerPrincipal(org, { accountId, actorLabel: 'customer:abc' });
    expect(registrantSnapshot(parent, false)).toMatchObject({
      kind: 'customer',
      actorLabel: 'customer:abc',
    });
  });
});
