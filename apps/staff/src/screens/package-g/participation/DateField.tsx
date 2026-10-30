/**
 * A labelled facility-local calendar date input for the Package G screens (SCR-S-51 to SCR-S-54;
 * SPK-SCHED-008, SPK-UX-009): the label names the facility's zone so the date is never read as
 * browser time; hint and error are linked with `aria-describedby`. The value is the `YYYY-MM-DD`
 * text the user chose.
 */
import { useId } from 'react';

export function DateField({
  label,
  value,
  onChange,
  required,
  hint,
  error,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  hint?: string;
  error?: string | null;
}) {
  const id = useId();
  const describedBy =
    [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') ||
    undefined;
  return (
    <div className="field">
      <label htmlFor={id}>
        {label}
        {required ? <span className="field-required"> (required)</span> : null}
      </label>
      <input
        id={id}
        type="date"
        value={value}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint ? (
        <span className="caption" id={`${id}-hint`}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span className="error-text" id={`${id}-error`}>
          <span aria-hidden="true">✕ </span>
          {error}
        </span>
      ) : null}
    </div>
  );
}
