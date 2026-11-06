import { z } from '../zod';
import { withCommandMeta } from '../commands';
import { CurrencyCode } from '../money';
import { ErrorResponseSchema, openApiRegistry } from '../openapi';
import { Instant } from '../time';

/**
 * Finance desk reads and commands for the redesigned staff screens (park UI redesign gaps; §3.15,
 * SPK-PAY-001/004/006/009/011, SPK-COMMS-002):
 *
 * - payment reminders for past-due obligations (`POST /obligations/{id}/reminders`): a recorded
 *   fact; the essential `payment_attention` notice is composed through communications, whose
 *   channel approval stays pending (DEC-062);
 * - a person's money summary for the person record (`GET /people/{id}/money-summary`, protected:
 *   household money is customer-private, §4.10);
 * - the price of a booking request's basket (`GET /basket-prices/{id}`): what was ordered, or an
 *   estimate from the catalog price rules in effect now (never a client price, SPK-PAY-001).
 *
 * Money is always per currency; amounts in different currencies are never added together.
 */

const Reason = z.string().trim().min(1).max(2000);

// ---------------------------------------------------------------------------------------------
// Payment reminders
// ---------------------------------------------------------------------------------------------

export const PaymentReminderSchema = z
  .object({
    id: z.uuid(),
    obligationId: z.uuid(),
    /** Who is told: the debtor, or the responsible payer of a team obligation. */
    recipientPersonId: z.uuid(),
    /** The balance and due date as they stood when the reminder was requested. */
    remainingMinor: z.number().int(),
    currency: CurrencyCode,
    dueAt: Instant,
    reason: z.string().nullable(),
    requestedByPersonId: z.uuid().nullable(),
    requestedAt: Instant,
  })
  .openapi('PaymentReminder');
export type PaymentReminder = z.infer<typeof PaymentReminderSchema>;

export const CreatePaymentReminderBody = withCommandMeta({ reason: Reason.optional() })
  .strict()
  .openapi('CreatePaymentReminderRequest');
export type CreatePaymentReminderInput = z.infer<typeof CreatePaymentReminderBody>;

// ---------------------------------------------------------------------------------------------
// Person money summary
// ---------------------------------------------------------------------------------------------

export const CurrencyAmountSchema = z
  .object({ currency: CurrencyCode, amountMinor: z.number().int() })
  .openapi('CurrencyAmount');

export const PersonMoneySummarySchema = z
  .object({
    personId: z.uuid(),
    /**
     * Open obligations the person owes (as debtor, or as the responsible payer of a team fee):
     * amount less what was allocated, per currency (SPK-PAY-004).
     */
    accountBalance: z.array(CurrencyAmountSchema),
    openObligations: z.number().int().min(0),
    /** Of those, past their due date now. */
    pastDueObligations: z.number().int().min(0),
    /** Active credits' remaining balances, per currency (SPK-PAY-009). */
    creditsAvailable: z.array(CurrencyAmountSchema),
    /** Credits issued but held pending approval (POL-015), never spendable yet. */
    creditsPendingApproval: z.array(CurrencyAmountSchema),
    /**
     * Customer receipts with this person as payer since `paidSince` (SPK-PAY-011: receipts, not
     * revenue), and the refunds that succeeded on those payers' payments in the same period: shown
     * apart, never netted.
     */
    paidThisYear: z.array(CurrencyAmountSchema),
    refundedThisYear: z.array(CurrencyAmountSchema),
    /** Start of the year the "this year" figures cover, and the zone it was taken in. */
    paidSince: Instant,
    yearTimeZone: z.string(),
    asOf: Instant,
  })
  .openapi('PersonMoneySummary');
export type PersonMoneySummary = z.infer<typeof PersonMoneySummarySchema>;

// ---------------------------------------------------------------------------------------------
// Basket prices (booking requests)
// ---------------------------------------------------------------------------------------------

export const BasketPriceSchema = z
  .object({
    basketId: z.uuid(),
    /**
     * `order`: the basket was checked out; the figures are the order's. `estimate`: the catalog
     * price rules and approved charges in effect now, before discounts and credits (the quote at
     * checkout is authoritative, SPK-PAY-002). `unpriced`: a line has no price rule in effect.
     */
    basis: z.enum(['order', 'estimate', 'unpriced']),
    currency: CurrencyCode.nullable(),
    subtotalMinor: z.number().int().nullable(),
    taxMinor: z.number().int().nullable(),
    feeMinor: z.number().int().nullable(),
    totalMinor: z.number().int().nullable(),
    orderId: z.uuid().nullable(),
    paymentStatus: z.string().nullable(),
    asOf: Instant,
  })
  .openapi('BasketPrice');
export type BasketPrice = z.infer<typeof BasketPriceSchema>;

// ---------------------------------------------------------------------------------------------
// OpenAPI registration
// ---------------------------------------------------------------------------------------------
const IdParams = z.object({ id: z.uuid() });
const err = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorResponseSchema } },
});
const ok = (description: string, schema: z.ZodType) => ({
  description,
  content: { 'application/json': { schema } },
});

openApiRegistry.registerPath({
  method: 'post',
  path: '/obligations/{id}/reminders',
  summary:
    'Remind the debtor of a past-due obligation (essential payment notice; channel approval pending DEC-062)',
  tags: ['Finance'],
  request: {
    params: IdParams,
    headers: z.object({ 'Idempotency-Key': z.string().min(8).max(128) }),
    body: { content: { 'application/json': { schema: CreatePaymentReminderBody } } },
  },
  responses: {
    201: ok('The recorded reminder', PaymentReminderSchema),
    400: err('Validation failed'),
    403: err('Access denied'),
    404: err('Not found or not visible'),
    409: err(
      'OBLIGATION_NOT_PAST_DUE, NOTHING_OUTSTANDING, REMINDED_RECENTLY, INVALID_TRANSITION or IDEMPOTENCY_*',
    ),
    503: err('Paused while the organization recovers from a restore'),
  },
});
openApiRegistry.registerPath({
  method: 'get',
  path: '/people/{id}/money-summary',
  summary:
    "A person's account balance, credits and paid this year, per currency (protected; finance readers, the person or who pays for them)",
  tags: ['Finance'],
  request: { params: IdParams },
  responses: {
    200: ok('Money summary', PersonMoneySummarySchema),
    403: err('Access denied'),
    404: err('Not found or not visible'),
  },
});
openApiRegistry.registerPath({
  method: 'get',
  path: '/basket-prices/{id}',
  summary:
    "A basket's price: the order's figures once checked out, else an estimate from the price rules in effect now (booking requests)",
  tags: ['Finance'],
  request: { params: IdParams },
  responses: {
    200: ok('Basket price', BasketPriceSchema),
    403: err('Access denied'),
    404: err('Not found or not visible'),
  },
});
