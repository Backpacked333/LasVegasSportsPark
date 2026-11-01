import { describe, expect, it } from 'vitest';
import type { QuoteDiscountLine } from '@sportspark/contracts';
import { participantRedemptions, redemptionsByDiscount } from './discount-redemptions';

const SIBLING = '00000000-0000-7000-8000-0000000000d1';
const EARLY = '00000000-0000-7000-8000-0000000000d2';
const A = '00000000-0000-7000-8000-0000000000a1';
const B = '00000000-0000-7000-8000-0000000000b1';

const applied = (discountDefinitionId: string, amountMinor: number): QuoteDiscountLine => ({
  discountDefinitionId,
  code: null,
  name: discountDefinitionId,
  amountMinor,
  explanation: [],
});

describe('discount redemptions per participant (R3-TIME-MONEY-01, SPK-PAY-003)', () => {
  it('redeems once per participant, referenced by their first discounted line, with their share', () => {
    const redemptions = participantRedemptions(
      [applied(SIBLING, 3_500), applied(EARLY, 500)],
      [
        // out of sequence on purpose: the first line is chosen by sequence, not input order
        {
          orderLineId: 'l3',
          sequence: 3,
          participantPersonId: A,
          discounts: [applied(SIBLING, 1_000)],
        },
        {
          orderLineId: 'l1',
          sequence: 1,
          participantPersonId: A,
          discounts: [applied(SIBLING, 1_500)],
        },
        {
          orderLineId: 'l2',
          sequence: 2,
          participantPersonId: B,
          discounts: [applied(SIBLING, 1_000), applied(EARLY, 500)],
        },
      ],
    );
    expect(redemptions).toEqual([
      { discountDefinitionId: SIBLING, personId: A, orderLineId: 'l1', amountMinor: 2_500 },
      { discountDefinitionId: SIBLING, personId: B, orderLineId: 'l2', amountMinor: 1_000 },
      { discountDefinitionId: EARLY, personId: B, orderLineId: 'l2', amountMinor: 500 },
    ]);
  });

  it('a participant whose lines the discount did not reduce redeems nothing', () => {
    expect(
      participantRedemptions(
        [applied(EARLY, 700)],
        [
          { orderLineId: 'l1', sequence: 1, participantPersonId: A, discounts: [] },
          {
            orderLineId: 'l2',
            sequence: 2,
            participantPersonId: B,
            discounts: [applied(EARLY, 700)],
          },
        ],
      ),
    ).toEqual([{ discountDefinitionId: EARLY, personId: B, orderLineId: 'l2', amountMinor: 700 }]);
  });

  it('refuses an applied discount that no line carries (it could be redeemed for no one)', () => {
    expect(() =>
      participantRedemptions(
        [applied(EARLY, 700)],
        [{ orderLineId: 'l1', sequence: 1, participantPersonId: A, discounts: [] }],
      ),
    ).toThrow(/allocated to no line/);
  });
  it('groups the redemptions of each discount in the order they were given (the abort releases them per discount)', () => {
    const redemptions = [
      { discountDefinitionId: SIBLING, personId: A, orderLineId: 'l1', amountMinor: 500 },
      { discountDefinitionId: EARLY, personId: A, orderLineId: 'l1', amountMinor: 100 },
      { discountDefinitionId: SIBLING, personId: B, orderLineId: 'l2', amountMinor: 500 },
    ];
    const grouped = redemptionsByDiscount(redemptions);
    expect([...grouped.keys()]).toEqual([SIBLING, EARLY]);
    expect(grouped.get(SIBLING)?.map((r) => r.personId)).toEqual([A, B]);
    expect(grouped.get(EARLY)?.map((r) => r.orderLineId)).toEqual(['l1']);
  });
});
