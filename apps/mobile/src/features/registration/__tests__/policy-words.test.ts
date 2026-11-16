/**
 * SPK-PAY-002, MONEY-08 and PA-11 SPK-UX-011 (**Proposed**): the engineering defaults a quote
 * lists read as plain customer sentences, one per kind, and the API's text with its codes is kept
 * for "Details for support".
 */
import {
  customerPolicyDefault,
  customerPolicyDefaults,
  POLICY_DEFAULT_FALLBACK,
  policyDefaultSupportLines,
} from '../policy-words';

describe('policy defaults in customer words (SPK-PAY-002, PA-11)', () => {
  it.each([
    [
      'installment: engineering default (POL-016, DEC-008)',
      "Paying in parts follows the facility's standard terms.",
    ],
    [
      'installment.noticeDaysBefore: engineering default 3 (POL-016, DEC-008)',
      "Paying in parts follows the facility's standard terms.",
    ],
    [
      'overpayment: hold as credit pending approval (POL-015, DEC-008)',
      'If you pay more than you owe, the extra is kept as credit until the facility checks it.',
    ],
    [
      'refund/compensation: refund (POL-009, DEC-009)',
      'If the facility cancels, you get your money back.',
    ],
    [
      'refund/compensation: credit (POL-009, DEC-009)',
      'If the facility cancels, you get account credit.',
    ],
    [
      'refund/compensation: manual (POL-009, DEC-009)',
      'If the facility cancels, the front desk contacts you about a refund or credit.',
    ],
    ['something new: value (POL-123, DEC-456)', POLICY_DEFAULT_FALLBACK],
    ['', POLICY_DEFAULT_FALLBACK],
  ])('PA-11: "%s" reads "%s", with no code', (entry, sentence) => {
    expect(customerPolicyDefault(entry)).toBe(sentence);
    expect(customerPolicyDefault(entry)).not.toMatch(/POL-|DEC-|engineering/);
  });

  it('SPK-PAY-002: one sentence per kind, in order; the API text goes to support unchanged', () => {
    const defaults = [
      'installment.enabled: engineering default false (POL-016, DEC-008)',
      'installment.maxInstallments: engineering default 4 (POL-016, DEC-008)',
      'refund/compensation: refund (POL-009, DEC-009)',
    ];
    expect(customerPolicyDefaults(defaults)).toEqual([
      "Paying in parts follows the facility's standard terms.",
      'If the facility cancels, you get your money back.',
    ]);
    expect(policyDefaultSupportLines(defaults)).toEqual([
      { label: 'Standard term 1', value: defaults[0] },
      { label: 'Standard term 2', value: defaults[1] },
      { label: 'Standard term 3', value: defaults[2] },
    ]);
    expect(policyDefaultSupportLines([defaults[2]!])).toEqual([
      { label: 'Standard term', value: defaults[2] },
    ]);
  });
});
