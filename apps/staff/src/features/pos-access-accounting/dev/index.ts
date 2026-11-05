/**
 * Development-only card payment method for SCR-S-55 card tenders. The payment processor and its
 * card-present flow are not selected (DEC-019, Technical lead/account owners; §5.2), so release
 * builds cannot take a card tender and show that pending decision instead. Development builds pick
 * one of the API's fake provider tokens, which select a scenario; no card details exist anywhere
 * (§4.14). `import.meta.env.DEV` is false in `vite build`, the branch is removed and the picker
 * chunk is not emitted (scripts/check-release-bundle.mjs looks for its marker).
 */
import { lazy, type ComponentType } from 'react';

export interface CardMethodPickerProps {
  /** The selected provider payment-method token, or '' for none. */
  value: string;
  onChange: (token: string) => void;
  disabled?: boolean;
}

export const DevCardMethodPicker: ComponentType<CardMethodPickerProps> | null = import.meta.env.DEV
  ? lazy(() =>
      import('./DevCardMethodPicker').then((m) => ({ default: m.DevCardMethodPickerView })),
    )
  : null;
