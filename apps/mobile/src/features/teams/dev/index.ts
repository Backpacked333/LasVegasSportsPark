/**
 * Development-only payment methods for paying a team contribution (SCR-C-25). The payment
 * provider is not selected (DEC-019, §5.2), so a release build cannot collect a payment method and
 * shows the pending state. Development builds talk to the API's fake payment provider, whose
 * deterministic tokens select a scenario. `__DEV__` is false in release bundles and Metro drops the
 * required module from them (the release-bundle check looks for the fake token prefix).
 */
import type * as DevMethods from './payment-methods';

export interface DevPaymentMethod {
  token: string;
  label: string;
}

export const DEV_CONTRIBUTION_PAYMENT_METHODS: readonly DevPaymentMethod[] | null = __DEV__
  ? // eslint-disable-next-line @typescript-eslint/no-require-imports -- must stay a conditional require so release bundles drop the module
    (require('./payment-methods') as typeof DevMethods).DEV_METHODS
  : null;
