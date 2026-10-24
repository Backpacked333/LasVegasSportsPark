import type { Enrollment } from '@sportspark/contracts';
import { describe, expect, it } from 'vitest';
import { customerPrincipal, staffPrincipal } from '../../testing/principals';
import { redactEnrollment } from './enrollment.shared';

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
    expect(redactEnrollment(customerPrincipal(org, { personId: payer }), enrollment)).toBe(
      enrollment,
    );
    expect(redactEnrollment(staffPrincipal(org, ['front_desk']), enrollment)).toBe(enrollment);
  });

  it('hides who registered and pays from another authorized adult', () => {
    const seen = redactEnrollment(customerPrincipal(org, { personId: other }), enrollment);
    expect(seen).toMatchObject({
      payerPersonId: null,
      basketId: null,
      basketLineId: null,
      orderRef: null,
    });
    expect(seen.registeredBy.personId).toBeNull();
    expect(JSON.stringify(seen)).not.toContain(payer);
  });
});
