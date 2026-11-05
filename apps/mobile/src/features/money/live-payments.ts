/**
 * A payment still on its way for a record that carries no `liveAttempt` of its own (SPK-PAY-007,
 * FIN-01): a team contribution (SCR-C-25) or an order's checkout payment (SCR-C-34). Found in the
 * account's own payments, `GET /v1/me/payments?purpose=`, newest first: an unresolved attempt
 * blocks a newer one for the same record, so the first unresolved attempt found is the live one.
 * The newest 50 attempts of the purpose are read; the API scopes them to the people this account
 * pays for, so an attempt found here is one the account may open (`GET /v1/payments/{id}`).
 *
 * ContributionRequest and Order carry no `liveAttempt` (an Obligation does): reported.
 */
import { useApiQuery } from '../../api/useApiQuery';
import { useApp } from '../../providers/AppProviders';
import { paymentIsUnresolved, type PaymentAttempt } from './status';

type Purpose = PaymentAttempt['purpose'];

/** The read behind each purpose, shared so screens showing the same records reuse one query. */
export function livePaymentsQuery<P extends Purpose>(purpose: P) {
  return { purpose, limit: 50 } as const;
}

export function useLivePayments(
  purpose: Purpose,
  keyOf: (attempt: PaymentAttempt) => string | null,
  enabled = true,
) {
  const { session } = useApp();
  const payments = useApiQuery({
    path: '/me/payments',
    request: { query: livePaymentsQuery(purpose) },
    enabled: enabled && session.status === 'signed_in',
  });
  const live = new Map<string, PaymentAttempt>();
  for (const attempt of payments.data?.items ?? []) {
    const key = keyOf(attempt);
    if (!key || live.has(key) || !paymentIsUnresolved(attempt.status)) continue;
    live.set(key, attempt);
  }
  return { payments, live };
}

const byOrder = (attempt: PaymentAttempt) => attempt.orderId;

/** The checkout payment still on its way for each order (an order stays `awaiting_payment`). */
export function useOrderPayments(enabled = true) {
  return useLivePayments('checkout', byOrder, enabled);
}
