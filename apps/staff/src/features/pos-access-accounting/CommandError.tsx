/**
 * How a point of sale, access hardware or accounting export command's refusal is shown
 * (SPK-UX-008, §4.9, §4.10). The API names each domain refusal in `details.code`; this states what
 * it means and what the staff member can do, with the API's own figures (what remains to pay, what
 * may still be returned, which accounts have no approved mapping) and the code and correlation
 * reference for support. Nothing was changed by a refused command, and the form keeps its input.
 *
 * Four-eyes refusals (an access policy or accounting mapping approved by its own author) say that
 * another person approves it, not that the screen is unavailable. Everything else (stale version,
 * payment outcome unknown, pending refund, no answer, field validation, not available, turned off)
 * is the Finance area's `CommandError`.
 */
import type { ApiError } from '@sportspark/api-client';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { StatusBadge } from '../../ui/StatusBadge';
import { CommandError as FinanceCommandError } from '../registration-finance/CommandError';
import { formatMoney } from '../registration-finance/format';
import { ledgerAccountLabel } from './labels';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function detailCode(error: ApiError | null | undefined): string | null {
  const code = record(error?.details)?.code;
  return typeof code === 'string' ? code : null;
}

function detailNumber(error: ApiError, key: string): number | null {
  const value = record(error.details)?.[key];
  return typeof value === 'number' ? value : null;
}

function detailString(error: ApiError, key: string): string | null {
  const value = record(error.details)?.[key];
  return typeof value === 'string' ? value : null;
}

function detailStrings(error: ApiError, key: string): string[] {
  const value = record(error.details)?.[key];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

interface Explained {
  title: string;
  /** What to do about it; the API's message is shown above it. */
  advice: ReactNode;
}

type Context = { currency?: string | null };

const EXPLAINED: Readonly<Record<string, (error: ApiError, ctx: Context) => Explained>> = {
  // Point of sale (FIN-06)
  SKU_TAKEN: () => ({ title: 'This SKU is already used', advice: 'Choose another SKU.' }),
  REGISTER_CODE_TAKEN: () => ({
    title: 'This register code is already used',
    advice: 'Choose another code for this facility.',
  }),
  REGISTER_SESSION_OPEN: () => ({
    title: 'The register has an open session',
    advice: 'Close the open session with its counted cash first.',
  }),
  SESSION_HAS_OPEN_SALES: (e) => {
    const n = detailNumber(e, 'openSales');
    return {
      title: 'The session still has open sales',
      advice: `Complete or void ${n === null ? 'the open sales' : n === 1 ? 'the 1 open sale' : `the ${n} open sales`} of this session, then close it.`,
    };
  },
  PRODUCT_RETIRED: () => ({
    title: 'The product is retired',
    advice: 'Retired products are not sold. Choose an active product.',
  }),
  PRODUCT_NOT_AT_FACILITY: () => ({
    title: 'The product is not sold at this facility',
    advice: 'Choose a product of this facility or of every facility.',
  }),
  CURRENCY_MISMATCH: () => ({
    title: 'The product is priced in another currency',
    advice: 'A sale is in one currency. Choose a product priced in the sale currency.',
  }),
  CHARGE_POLICY_NOT_APPROVED: (e) => ({
    title: 'A tax or fee of this product is not approved',
    advice: `${detailString(e, 'policyKey') ?? 'A charge policy'} has no approved version in effect (DEC-057). Nothing was added. Finance approves the tax or fee, or the product is changed.`,
  }),
  CHARGE_POLICY_INVALID: (e) => ({
    title: 'A tax or fee of this product cannot be applied',
    advice: `${detailString(e, 'policyKey') ?? 'A charge policy'} is not a valid approved tax or fee. Ask finance to correct it.`,
  }),
  CHARGE_POLICY_CURRENCY_MISMATCH: (e) => ({
    title: 'A fixed fee is in another currency',
    advice: `${detailString(e, 'policyKey') ?? 'A charge policy'} is a fixed amount in another currency than the sale.`,
  }),
  TENDER_EXCEEDS_REMAINING: (e, ctx) => ({
    title: 'The tender exceeds what remains to be paid',
    advice: `Remaining to pay: ${formatMoney(detailNumber(e, 'remainingMinor'), ctx.currency)}.`,
  }),
  CARD_TENDER_NEEDS_CUSTOMER: () => ({
    title: 'A card tender needs the customer',
    advice:
      'The payer of a card payment is a person (DEC-019). Start the sale with its customer to take a card.',
  }),
  SALE_HAS_CARD_TENDER: () => ({
    title: 'A card was charged or is being charged',
    advice: 'This sale cannot be voided. Complete it, then return what was bought.',
  }),
  LINE_NOT_ON_SALE: () => ({
    title: 'A returned line is not on this sale',
    advice: 'Reload the sale and choose its lines again.',
  }),
  RETURN_EXCEEDS_QUANTITY: (e) => ({
    title: 'More units are returned than were sold',
    advice: `Units that can still be returned on that line: ${detailNumber(e, 'returnableQuantity') ?? 'not stated'}.`,
  }),
  NOTHING_TO_RETURN: () => ({
    title: 'Nothing was paid for these units',
    advice: 'Choose units that were paid for.',
  }),
  RETURN_EXCEEDS_TENDER: (e, ctx) => ({
    title: 'The return exceeds what was paid this way',
    advice: `Still refundable by ${detailString(e, 'tenderKind') ?? 'this tender'}: ${formatMoney(detailNumber(e, 'availableMinor'), ctx.currency)}. Choose another tender kind or fewer units.`,
  }),
  CASH_RETURN_NEEDS_OPEN_SESSION: () => ({
    title: 'A cash return needs an open register session',
    advice:
      "Cash is paid from an open register session at the sale's facility. Open one, then return again.",
  }),
  REFUND_EXCEEDS_REFUNDABLE: () => ({
    title: 'No card payment of this sale can be refunded',
    advice: 'Nothing captured on a card is left to refund. Choose another tender kind.',
  }),
  RECEIPT_NOT_AVAILABLE: () => ({
    title: 'The sale is not paid',
    advice: 'A receipt exists once the sale is paid.',
  }),

  // Accounting export (FIN-07)
  NOTHING_TO_EXPORT: () => ({
    title: 'Nothing to export in this period',
    advice: 'Every journal entry of the period is already in a live batch, or there is none.',
  }),
  ACCOUNTING_MAPPING_REQUIRED: (e) => ({
    title: 'Unmapped accounts: nothing was prepared',
    advice: (
      <>
        No account is exported under an assumed mapping (SPK-PAY-011, DEC-022). Propose a mapping
        for each account below; another person approves it, then prepare again.
        <ul aria-label="Accounts without an approved mapping">
          {detailStrings(e, 'accounts').map((account) => (
            <li key={account}>
              {ledgerAccountLabel(account)}:{' '}
              <Link
                to={`/finance/accounting-exports/mappings?propose=${encodeURIComponent(account)}`}
              >
                Propose a mapping for {account}
              </Link>
            </li>
          ))}
        </ul>
      </>
    ),
  }),
  FOUR_EYES_REQUIRED: () => ({
    title: 'Another person approves this',
    advice: 'You proposed this mapping. Someone other than its proposer approves it (four eyes).',
  }),
  MAPPING_ALREADY_APPROVED: (e) => ({
    title: 'This account already has an approved mapping',
    advice: `Retire the approved mapping of ${ledgerAccountLabel(detailString(e, 'ledgerAccount') ?? 'the account')} first, then approve this one.`,
  }),
  ENTRIES_ALREADY_IN_BATCH: () => ({
    title: 'Some entries are already in another batch',
    advice: 'Reload the batches; each entry is exported at most once.',
  }),

  // Access hardware (ENT-05)
  device_ref_in_use: () => ({
    title: 'This provider device reference is already registered',
    advice: 'A retired device keeps its reference. Check the reference on the device.',
  }),
  author_cannot_approve: () => ({
    title: 'Another person approves this policy',
    advice: 'You drafted this policy. Someone other than its author approves it (four eyes).',
  }),
  author_required: () => ({
    title: 'A policy is drafted by a named person',
    advice: 'Sign in with your own staff account to draft a policy.',
  }),
  policy_already_active: () => ({
    title: 'Another policy of this device was just approved',
    advice: 'Reload the policies to see the one now in force.',
  }),
};

export interface CommandErrorProps {
  error: ApiError | null | undefined;
  onRetry?: () => void;
  onReload?: () => void;
  /** Currency of amounts the API reports in `details`. */
  currency?: string | null;
}

export function CommandError({ error, onRetry, onReload, currency }: CommandErrorProps) {
  if (!error) return null;
  const code = detailCode(error);
  const explain = code && !error.isCapabilityDisabled ? EXPLAINED[code] : undefined;
  if (!explain) {
    return (
      <FinanceCommandError
        error={error}
        onRetry={onRetry}
        onReload={onReload}
        currency={currency}
      />
    );
  }
  const { title, advice } = explain(error, { currency });
  return (
    <section className="state" aria-live="polite" data-testid="state-validation">
      <StatusBadge tone="danger" label={title} />
      <p>{error.message} Nothing was changed.</p>
      <div>{advice}</div>
      <p className="caption">
        Error code: {error.code} ({code})
        {error.correlationId ? `. Reference: ${error.correlationId}` : ''}
      </p>
    </section>
  );
}
