/**
 * Labelled form fields for the Reports and Administration screens (SPK-UX-008 validation failure,
 * SPK-UX-009): every control has a visible label tied to it, "(required)" is written out rather
 * than signalled by colour or an asterisk, hints and errors are linked through
 * `aria-describedby`, and an invalid control is `aria-invalid`. Values live in the caller's state,
 * so a failed command keeps what was typed.
 */
import { useId, type ReactNode } from 'react';

interface FieldFrameProps {
  label: string;
  required?: boolean;
  hint?: ReactNode;
  error?: string | null;
  children: (ids: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
}

function FieldFrame({ label, required, hint, error, children }: FieldFrameProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className="ia-field">
      <label htmlFor={id}>
        {label}
        {required ? ' (required)' : ''}
      </label>
      {children({ id, describedBy, invalid: Boolean(error) })}
      {hint ? (
        <span id={hintId} className="caption">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={errorId} className="error-text">
          {error}
        </span>
      ) : null}
    </div>
  );
}

export interface TextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  hint?: ReactNode;
  error?: string | null;
  type?: 'text' | 'date' | 'datetime-local' | 'number';
  disabled?: boolean;
  placeholder?: string;
  inputMode?: 'text' | 'decimal' | 'numeric';
  maxLength?: number;
}

export function TextField({
  label,
  value,
  onChange,
  required,
  hint,
  error,
  ...rest
}: TextFieldProps) {
  return (
    <FieldFrame label={label} required={required} hint={hint} error={error}>
      {({ id, describedBy, invalid }) => (
        <input
          id={id}
          type={rest.type ?? 'text'}
          value={value}
          required={required}
          disabled={rest.disabled}
          placeholder={rest.placeholder}
          inputMode={rest.inputMode}
          maxLength={rest.maxLength}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </FieldFrame>
  );
}

export function TextAreaField({
  label,
  value,
  onChange,
  required,
  hint,
  error,
  disabled,
  rows = 3,
}: Omit<TextFieldProps, 'type'> & { rows?: number }) {
  return (
    <FieldFrame label={label} required={required} hint={hint} error={error}>
      {({ id, describedBy, invalid }) => (
        <textarea
          id={id}
          value={value}
          rows={rows}
          required={required}
          disabled={disabled}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </FieldFrame>
  );
}

export interface Option {
  value: string;
  label: string;
}

export function SelectField({
  label,
  value,
  onChange,
  options,
  required,
  hint,
  error,
  disabled,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly Option[];
  required?: boolean;
  hint?: ReactNode;
  error?: string | null;
  disabled?: boolean;
  /** Text of an empty first option; omitted when the field must always have a value. */
  placeholder?: string;
}) {
  return (
    <FieldFrame label={label} required={required} hint={hint} error={error}>
      {({ id, describedBy, invalid }) => (
        <select
          id={id}
          value={value}
          required={required}
          disabled={disabled}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          onChange={(event) => onChange(event.target.value)}
        >
          {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      )}
    </FieldFrame>
  );
}

/** A group of checkboxes (roles, facility scope, permissions) inside a fieldset with a legend. */
export function CheckboxGroup({
  legend,
  options,
  selected,
  onChange,
  hint,
  error,
  disabled,
}: {
  legend: string;
  options: readonly Option[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
  hint?: ReactNode;
  error?: string | null;
  disabled?: boolean;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return (
    <fieldset
      className="ia-fieldset"
      aria-describedby={[hintId, errorId].filter(Boolean).join(' ') || undefined}
      aria-invalid={error ? true : undefined}
    >
      <legend>{legend}</legend>
      {options.map((option) => {
        const checked = selected.includes(option.value);
        return (
          <label key={option.value} className="ia-check">
            <input
              type="checkbox"
              checked={checked}
              disabled={disabled}
              onChange={() =>
                onChange(
                  checked
                    ? selected.filter((value) => value !== option.value)
                    : [...selected, option.value],
                )
              }
            />
            {option.label}
          </label>
        );
      })}
      {hint ? (
        <span id={hintId} className="caption">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={errorId} className="error-text">
          {error}
        </span>
      ) : null}
    </fieldset>
  );
}

/** Radio buttons with no preselected value where the choice must be explicit (SPK-REPORT-004). */
export function RadioGroup({
  legend,
  name,
  options,
  value,
  onChange,
  hint,
  error,
  required,
  disabled,
}: {
  legend: string;
  name: string;
  options: readonly (Option & { description?: string })[];
  value: string;
  onChange: (value: string) => void;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  disabled?: boolean;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return (
    <fieldset
      className="ia-fieldset"
      role="radiogroup"
      aria-describedby={[hintId, errorId].filter(Boolean).join(' ') || undefined}
      aria-invalid={error ? true : undefined}
      aria-required={required || undefined}
    >
      <legend>
        {legend}
        {required ? ' (required)' : ''}
      </legend>
      {options.map((option) => (
        <label key={option.value} className="ia-check">
          <input
            type="radio"
            name={`${name}-${id}`}
            value={option.value}
            checked={value === option.value}
            disabled={disabled}
            onChange={() => onChange(option.value)}
          />
          <span>
            {option.label}
            {option.description ? <span className="caption"> ({option.description})</span> : null}
          </span>
        </label>
      ))}
      {hint ? (
        <span id={hintId} className="caption">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={errorId} className="error-text">
          {error}
        </span>
      ) : null}
    </fieldset>
  );
}

export function CheckboxField({
  label,
  checked,
  onChange,
  hint,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className="ia-field">
      <label className="ia-check" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          aria-describedby={hintId}
          onChange={(event) => onChange(event.target.checked)}
        />
        {label}
      </label>
      {hint ? (
        <span id={hintId} className="caption">
          {hint}
        </span>
      ) : null}
    </div>
  );
}
