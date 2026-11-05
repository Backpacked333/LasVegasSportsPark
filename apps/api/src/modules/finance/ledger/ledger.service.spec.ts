import { describe, expect, it } from 'vitest';
import { balancedLines } from './ledger.service';

describe('subledger postings (SPK-PAY-010)', () => {
  it('keeps balanced non-zero lines', () => {
    expect(
      balancedLines([
        { account: 'cash_processor', debitMinor: 1000 },
        { account: 'customer_receivable', creditMinor: 800 },
        { account: 'overpayment_liability', creditMinor: 200 },
        { account: 'processor_fees', debitMinor: 0 },
      ]),
    ).toHaveLength(3);
  });

  it('refuses unbalanced, one-sided and double-sided postings', () => {
    expect(() =>
      balancedLines([
        { account: 'cash_processor', debitMinor: 1000 },
        { account: 'customer_receivable', creditMinor: 999 },
      ]),
    ).toThrow(/does not balance/);
    expect(() => balancedLines([{ account: 'cash_processor', debitMinor: 1000 }])).toThrow();
    expect(() =>
      balancedLines([
        { account: 'cash_processor', debitMinor: 10, creditMinor: 10 },
        { account: 'refunds', debitMinor: 10 },
      ]),
    ).toThrow(/debit or a credit/);
  });
});
