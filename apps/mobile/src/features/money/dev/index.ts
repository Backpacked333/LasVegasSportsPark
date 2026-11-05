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
