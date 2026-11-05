/**
 * Development builds only (see ./index.ts): the fake payment provider's scenario tokens
 * (apps/api/src/modules/finance/providers/fake-payment.provider.ts). Never a card number.
 */
import { SelectField } from '../../../ui/FormFields';
import type { CardMethodPickerProps } from './index';

const METHODS = [
  { value: 'pm_fake_visa', label: 'Development card: succeeds' },
  { value: 'pm_fake_processing', label: 'Development card: processing, outcome later' },
  { value: 'pm_fake_timeout', label: 'Development card: times out after the money was taken' },
  { value: 'pm_fake_decline', label: 'Development card: declined' },
  { value: 'pm_fake_unreachable', label: 'Development card: provider unreachable' },
] as const;

export function DevCardMethodPickerView({ value, onChange, disabled }: CardMethodPickerProps) {
  return (
    <SelectField
      label="Development card method"
      hint="Development build: the fake provider's scenarios. No card details are entered."
      required
      disabled={disabled}
      value={value}
      onChange={onChange}
      placeholder="Choose a scenario"
      options={METHODS}
    />
  );
}
