/**
 * The terms a price follows where no approved policy exists, in customer words (SPK-PAY-002,
 * MONEY-08; PA-11 SPK-UX-011 **Proposed**).
 *
 * The quote's `policies.defaults` lists, verbatim, each engineering default the API applied where
 * the facility has no approved policy version: "installment: engineering default (POL-016,
 * DEC-008)", "installment.maxInstallments: engineering default 4 (POL-016, DEC-008)",
 * "overpayment: hold as credit pending approval (POL-015, DEC-008)", "refund/compensation: refund
 * (POL-009, DEC-009)" (`finance-policy.resolver.ts`). That text names policy and decision codes,
 * so customers see one plain sentence per kind of term instead, and the API's own text goes into
 * "Details for support" unchanged (§4.10: available, not prominent).
 *
 * Nothing here decides a term: the sentences say what the API reported it applied.
 */
import type { SupportLine } from '../../ui/SupportDetails';

/** What a default is about: the part before the first ":" ("installment.maxInstallments" → installment). */
function kindOf(entry: string): string {
  const head = entry.split(':')[0]?.trim().toLowerCase() ?? '';
  return head.split('.')[0] ?? '';
}

/** The value after "refund/compensation: " ("refund", "credit", "manual"), without the codes. */
function valueOf(entry: string): string {
  const rest = entry.slice(entry.indexOf(':') + 1);
  return rest
    .replace(/\([^)]*\)/g, '')
    .trim()
    .toLowerCase();
}

/** Unknown kinds of default read as this, never as the API's text. */
export const POLICY_DEFAULT_FALLBACK = "Any other terms follow the facility's standard rules.";

/** One default in customer words. */
export function customerPolicyDefault(entry: string): string {
  switch (kindOf(entry)) {
    case 'installment':
      return "Paying in parts follows the facility's standard terms.";
    case 'overpayment':
      return 'If you pay more than you owe, the extra is kept as credit until the facility checks it.';
    case 'refund/compensation':
      switch (valueOf(entry)) {
        case 'refund':
          return 'If the facility cancels, you get your money back.';
        case 'credit':
          return 'If the facility cancels, you get account credit.';
        default:
          return 'If the facility cancels, the front desk contacts you about a refund or credit.';
      }
    default:
      return POLICY_DEFAULT_FALLBACK;
  }
}

/** The sentences customers see, once each, in the API's order. */
export function customerPolicyDefaults(entries: readonly string[]): string[] {
  return [...new Set(entries.map(customerPolicyDefault))];
}

/** The API's own text for "Details for support", one line each. */
export function policyDefaultSupportLines(entries: readonly string[]): SupportLine[] {
  return entries.map((entry, index) => ({
    label: entries.length === 1 ? 'Standard term' : `Standard term ${index + 1}`,
    value: entry,
  }));
}
