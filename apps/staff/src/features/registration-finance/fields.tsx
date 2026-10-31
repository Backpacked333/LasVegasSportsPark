/**
 * Accessible form fields for the registration and finance screens (SPK-UX-009, SPK-UX-008
 * validation failure): every control has a visible label, required fields say so in text, and a
 * field message is tied to its control with `aria-describedby` and `aria-invalid`. Forms keep
 * their values when a command fails, so staff never retype after a validation or stale answer.
 */
import { useId, type ReactNode } from 'react';

interface BaseProps {
  label: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
  disabled?: boolean;
}

function useFieldIds(hint?: string, error?: string | null) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');
  return { id, hintId, errorId, describedBy: describedBy || undefined };
}

function Frame({
  id,
  label,
  required,
  hint,
  hintId,
  error,
  errorId,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  hint?: string;
  hintId: string;
  error?: string | null;
  errorId: string;
  children: ReactNode;
}) {
  return (
    <div className="rf-field">
      <label htmlFor={id}>
        {label}
        {required ? <span className="caption"> (required)</span> : null}
      </label>
      {hint ? (
        <span className="caption" id={hintId}>
          {hint}
        </span>
      ) : null}
      {children}
      {error ? (
        <span className="rf-error" id={errorId}>
          {error}
        </span>
      ) : null}
    </div>
  );
}

export function TextField({
  label,
  hint,
  error,
  required,
  disabled,
  value,
  onChange,
  type = 'text',
  inputMode,
  onEnter,
}: BaseProps & {
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'date' | 'datetime-local' | 'number';
  inputMode?: 'numeric' | 'decimal' | 'text';
  /**
   * Enter runs this instead of submitting an enclosing form (for a search field inside a command
   * form: Enter searches, it never sends the command).
   */
  onEnter?: () => void;
}) {
  const ids = useFieldIds(hint, error);
  return (
    <Frame {...ids} label={label} required={required} hint={hint} error={error}>
      <input
        id={ids.id}
        type={type}
        value={value}
        inputMode={inputMode}
        required={required}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={ids.describedBy}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={
          onEnter
            ? (event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                onEnter();
              }
            : undefined
        }
      />
    </Frame>
  );
}

export function TextArea({
  label,
  hint,
  error,
  required,
  disabled,
  value,
  onChange,
}: BaseProps & { value: string; onChange: (value: string) => void }) {
  const ids = useFieldIds(hint, error);
  return (
    <Frame {...ids} label={label} required={required} hint={hint} error={error}>
      <textarea
        id={ids.id}
        value={value}
        rows={3}
        required={required}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={ids.describedBy}
        onChange={(event) => onChange(event.target.value)}
      />
    </Frame>
  );
}

export interface Option {
  value: string;
  label: string;
}

export function SelectField({
  label,
  hint,
  error,
  required,
  disabled,
  value,
  onChange,
  options,
  placeholder,
}: BaseProps & {
  value: string;
  onChange: (value: string) => void;
  options: readonly Option[];
  /** First, empty choice ("Choose…" or "None"). */
  placeholder?: string;
}) {
  const ids = useFieldIds(hint, error);
  return (
    <Frame {...ids} label={label} required={required} hint={hint} error={error}>
      <select
        id={ids.id}
        value={value}
        required={required}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={ids.describedBy}
        onChange={(event) => onChange(event.target.value)}
      >
        {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Frame>
  );
}

export function CheckboxField({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const ids = useFieldIds(hint, null);
  return (
    <div className="rf-field rf-check">
      <input
        id={ids.id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-describedby={ids.describedBy}
        onChange={(event) => onChange(event.target.checked)}
      />
      <label htmlFor={ids.id}>{label}</label>
      {hint ? (
        <span className="caption" id={ids.hintId}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

/** A group of related checkboxes with one accessible name (a fieldset and its legend). */
export function CheckboxGroup({
  legend,
  hint,
  options,
  values,
  onChange,
  disabled,
}: {
  legend: string;
  hint?: string;
  options: readonly Option[];
  values: readonly string[];
  onChange: (values: string[]) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="rf-fieldset">
      <legend>{legend}</legend>
      {hint ? <p className="caption">{hint}</p> : null}
      {options.length === 0 ? <p className="caption">None available.</p> : null}
      {options.map((option) => (
        <CheckboxField
          key={option.value}
          label={option.label}
          checked={values.includes(option.value)}
          disabled={disabled}
          onChange={(checked) =>
            onChange(
              checked
                ? [...values, option.value]
                : values.filter((value) => value !== option.value),
            )
          }
        />
      ))}
    </fieldset>
  );
}

/** Definition list of label and value pairs for record summaries. */
export function Facts({
  label,
  items,
}: {
  label: string;
  items: readonly (readonly [term: string, value: ReactNode])[];
}) {
  return (
    <dl className="rf-facts" aria-label={label}>
      {items.map(([term, value]) => (
        <div key={term}>
          <dt>{term}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
