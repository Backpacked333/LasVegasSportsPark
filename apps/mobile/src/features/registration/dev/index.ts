/**
 * Development-only payment method picker (SCR-C-14). The payment provider is not selected
 * (DEC-019, §5.2), so release builds cannot collect a payment method and show the pending state.
 * Development builds talk to the API's fake payment provider, whose deterministic tokens select a
 * scenario. `__DEV__` is false in release bundles and Metro drops this module from them
 * (scripts/check-release-bundle.mjs checks it).
 */
import type { ComponentType } from 'react';
import type * as PickerModule from './DevPaymentMethodPicker';

export interface PaymentMethodPickerProps {
  /** The selected provider payment-method token, or null. */
  value: string | null;
  onChange: (token: string | null) => void;
}

export const DevPaymentMethodPicker: ComponentType<PaymentMethodPickerProps> | null = __DEV__
  ? // eslint-disable-next-line @typescript-eslint/no-require-imports -- must stay a conditional require so release bundles drop the module
    (require('./DevPaymentMethodPicker') as typeof PickerModule).DevPaymentMethodPickerView
  : null;
