/**
 * The API's fake payment provider tokens (apps/api/src/modules/finance/providers/
 * fake-payment.provider.ts) for development builds only. No card details exist anywhere: a token
 * only selects the provider scenario (§4.14).
 */
export const DEV_METHODS = [
  { token: 'pm_fake_visa', label: 'Development payment: succeeds' },
  { token: 'pm_fake_processing', label: 'Development payment: processing, outcome later' },
  { token: 'pm_fake_timeout', label: 'Development payment: times out after the money was taken' },
  { token: 'pm_fake_decline', label: 'Development payment: declined' },
] as const;
