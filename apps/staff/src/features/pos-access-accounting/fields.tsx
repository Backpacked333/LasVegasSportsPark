/**
 * Shared bits of the SCR-S-55 to SCR-S-57 pages: record ids from the route (opaque UUIDs only,
 * §4.14; anything else is "Link not available"), a money field that names its currency
 * (SPK-PAY-001: typed text becomes integer minor units without floating point), and a field that
 * opens a record by its reference, for records the API does not list (a sale of a session).
 */
import { useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Button } from '../../ui/Button';
import { TextField } from '../../ui/FormFields';
import { isUuid } from '../../ui/RecordRef';
import { StateView } from '../../ui/StateView';

/** The route parameter when it is a record id, else null. */
export function useRecordParam(name: string): string | null {
  const value = useParams()[name] ?? '';
  return isUuid(value) ? value : null;
}

export function LinkNotAvailable() {
  return (
    <StateView
      variant="unavailable"
      title="Link not available"
      description="This link does not name a record. Check the link, or open the record from its list."
    />
  );
}

export function MoneyField({
  label,
  currency,
  value,
  onChange,
  error,
  hint,
  required,
  disabled,
}: {
  label: string;
  currency: string | null;
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
  hint?: string;
  required?: boolean;
  disabled?: boolean;
}) {
  return (
    <TextField
      label={currency ? `${label} (${currency})` : label}
      value={value}
      onChange={onChange}
      error={error}
      hint={hint}
      required={required}
      disabled={disabled || !currency}
    />
  );
}

/** "Open a sale by its reference": a record the API does not list is opened from its id. */
export function ReferenceJump({
  label,
  buttonLabel,
  to,
}: {
  label: string;
  buttonLabel: string;
  to: (id: string) => string;
}) {
  const navigate = useNavigate();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const id = value.trim();
    if (!isUuid(id)) {
      setError('Enter a reference: 36 characters such as 0192f1a0-0000-7000-8000-000000000001.');
      return;
    }
    setError(null);
    navigate(to(id));
  };
  return (
    <form className="actions-row" aria-label={label} onSubmit={submit} noValidate>
      <TextField label={label} value={value} onChange={setValue} error={error} />
      <Button type="submit" variant="secondary">
        {buttonLabel}
      </Button>
    </form>
  );
}
