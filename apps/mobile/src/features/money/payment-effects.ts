/**
 * What a payment can change once it settles (SCR-C-34, SCR-C-35; SPK-PAY-005, SPK-PAY-006,
 * SPK-PAY-007): balances, installments, orders, credits (an overpayment), team contributions and
 * the account's money lists. One list for every screen that pays or watches a payment settle
 * (ObligationScreen, PaymentAttemptScreen), so none of them keeps showing a state that changed.
 */
export const PAYMENT_EFFECT_KEYS: readonly (readonly unknown[])[] = [
  ['api', '/obligations'],
  ['api', '/obligations/{id}'],
  ['api', '/installment-plans/{id}'],
  ['api', '/orders/{id}'],
  ['api', '/credits'],
  ['api', '/contribution-requests/{id}'],
  ['api', '/me/payments'],
  ['api', '/me/receipts'],
  ['api', '/me/orders'],
  ['api', '/me/contribution-requests'],
  ['api', '/me/registration-checkouts'],
];
