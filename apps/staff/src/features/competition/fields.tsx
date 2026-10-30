/**
 * Accessible form fields for the competition screens (SPK-UX-009, SPK-UX-008 validation failure):
 * every control has a visible label, required fields say so in text, and a field message is tied
 * to its control with `aria-describedby` and `aria-invalid`. Values stay in the form when a command
 * fails, so the user never retypes after a validation or stale-version answer.
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

function FieldFrame({
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
    <div className="field">
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
        <span className="error-text" id={errorId} role="alert">
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
  placeholder,
  onEnter,
}: BaseProps & {
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'date' | 'datetime-local' | 'time' | 'number';
  inputMode?: 'numeric' | 'text';
  placeholder?: string;
  /**
   * The field's own action on Enter (e.g. a search inside a larger form, SPK-UX-009): Enter
   * runs it instead of submitting the enclosing form.
   */
  onEnter?: () => void;
}) {
  const ids = useFieldIds(hint, error);
  return (
    <FieldFrame {...ids} label={label} required={required} hint={hint} error={error}>
      <input
        id={ids.id}
        type={type}
        value={value}
        inputMode={inputMode}
        placeholder={placeholder}
        disabled={disabled}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={ids.describedBy}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={
          onEnter
            ? (event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  onEnter();
                }
              }
            : undefined
        }
      />
    </FieldFrame>
  );
}

/** Whole numbers are typed as text and parsed on submit, so a half-typed value is never lost. */
export function NumberField(props: BaseProps & { value: string; onChange: (v: string) => void }) {
  return <TextField {...props} inputMode="numeric" />;
}

export function TextAreaField({
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
    <FieldFrame {...ids} label={label} required={required} hint={hint} error={error}>
      <textarea
        id={ids.id}
        value={value}
        rows={3}
        disabled={disabled}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={ids.describedBy}
        onChange={(event) => onChange(event.target.value)}
      />
    </FieldFrame>
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
  placeholder = 'Choose…',
}: BaseProps & {
  value: string;
  onChange: (value: string) => void;
  options: readonly Option[];
  /** Shown as the empty choice; pass null when a value is always selected. */
  placeholder?: string | null;
}) {
  const ids = useFieldIds(hint, error);
  return (
    <FieldFrame {...ids} label={label} required={required} hint={hint} error={error}>
      <select
        id={ids.id}
        value={value}
        disabled={disabled}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={ids.describedBy}
        onChange={(event) => onChange(event.target.value)}
      >
        {placeholder !== null ? <option value="">{placeholder}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </FieldFrame>
  );
}

export function CheckboxField({
  label,
  hint,
  disabled,
  checked,
  onChange,
}: Omit<BaseProps, 'error' | 'required'> & {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="field field-check">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-describedby={hint ? hintId : undefined}
        onChange={(event) => onChange(event.target.checked)}
      />
      <label htmlFor={id}>{label}</label>
      {hint ? (
        <span className="caption" id={hintId}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

/** Yes / No choice with no preselected answer, for rule values nobody may assume (DEC-002). */
export function YesNoField({
  label,
  hint,
  error,
  required,
  disabled,
  value,
  onChange,
}: BaseProps & { value: boolean | null; onChange: (value: boolean | null) => void }) {
  return (
    <SelectField
      label={label}
      hint={hint}
      error={error}
      required={required}
      disabled={disabled}
      value={value === null ? '' : value ? 'yes' : 'no'}
      onChange={(v) => onChange(v === '' ? null : v === 'yes')}
      options={[
        { value: 'yes', label: 'Yes' },
        { value: 'no', label: 'No' },
      ]}
    />
  );
}

/** Parses a whole number typed into a field; null when empty or not a whole number. */
export function parseWholeNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An opaque record reference as the API issues it (a UUID); never a name or contact. */
export function isRecordReference(value: string): boolean {
  return UUID.test(value.trim());
}
