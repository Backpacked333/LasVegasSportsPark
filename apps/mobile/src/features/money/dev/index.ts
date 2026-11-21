/**
 * Development-only payment method for SCR-C-34 (pay a balance). The payment provider and its
 * hosted card entry are not selected (DEC-019, Technical lead/account owners; §5.2), so release
 * builds cannot collect a payment method and show that pending decision instead. Development
 * builds pick one of the API's fake provider tokens, which select a scenario; no card details
 * exist anywhere (§4.14). `__DEV__` is false in release bundles and Metro drops this module from
 * them (scripts/check-release-bundle.mjs looks for its markers).
 */
import type { ComponentType } from 'react';
import type * as PickerModule from './DevPaymentMethodPicker';

export interface PaymentMethodPickerProps {
  /** The selected provider payment-method token, or null. */
  value: string | null;
  onChange: (token: string) => void;
}

export const DevPaymentMethodPicker: ComponentType<PaymentMethodPickerProps> | null = __DEV__
  ? // eslint-disable-next-line @typescript-eslint/no-require-imports -- must stay a conditional require so release bundles drop the module
    (require('./DevPaymentMethodPicker') as typeof PickerModule).DevPaymentMethodPickerView
  : null;

/**
 * The same fake provider scenarios as a list of payment methods, for the Pay sheet (handoff 2b's
 * "card row"); null in release builds, which show the DEC-019 pay-at-desk notice instead.
 */
export const DEV_PAYMENT_METHODS: readonly { token: string; label: string }[] | null = __DEV__
  ? // eslint-disable-next-line @typescript-eslint/no-require-imports -- must stay a conditional require so release bundles drop the module
    (require('./DevPaymentMethodPicker') as typeof PickerModule).DEV_PAYMENT_SCENARIOS
  : null;

/** The Pay sheet's words for a development method; null in release builds. */
export const DEV_PAYMENT_WORDS: { method: string; methodNoPayment: string } | null = __DEV__
  ? // eslint-disable-next-line @typescript-eslint/no-require-imports -- must stay a conditional require so release bundles drop the module
    (require('./DevPaymentMethodPicker') as typeof PickerModule).DEV_PAYMENT_WORDS
  : null;
