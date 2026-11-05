/**
 * Labelled form fields for staff commands (SPK-UX-008 validation failure, SPK-UX-009): every input
 * has a visible label tied to it, "(required)" is written out rather than shown by colour or an
 * asterisk alone, hints and errors are linked with `aria-describedby`, and an invalid field is
 * marked `aria-invalid`. Values stay in the caller's state, so a failed command keeps the input.
 */
import { useId, type ReactNode } from 'react';
import './form-fields.css';

interface FieldFrameProps {
  label: string;
  required?: boolean;
  hint?: string;
  error?: string | null;
}

function useFieldIds(hint?: string, error?: string | null) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return { id, hintId, errorId, describedBy };
}

function LabelText({ label, required }: { label: string; required?: boolean }) {
  return (
    <>
      {label}
      {required ? <span className="field-required"> (required)</span> : null}
    </>
  );
}

function FieldMessages({
  hint,
  hintId,
  error,
  errorId,
}: {
  hint?: string;
  hintId?: string;
  error?: string | null;
  errorId?: string;
}) {
  return (
    <>
      {hint ? (
        <span className="caption" id={hintId}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span className="error-text" id={errorId}>
          <span aria-hidden="true">✕ </span>
          {error}
        </span>
      ) : null}
    </>
  );
}

export interface TextFieldProps extends FieldFrameProps {
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'search' | 'datetime-local' | 'number';
  disabled?: boolean;
  autoComplete?: string;
  placeholder?: string;
}

export function TextField({
  label,
  required,
  hint,
  error,
  value,
  onChange,
  type = 'text',
  disabled,
  autoComplete = 'off',
  placeholder,
}: TextFieldProps) {
  const ids = useFieldIds(hint, error);
  return (
    <div className="field">
      <label htmlFor={ids.id}>
        <LabelText label={label} required={required} />
      </label>
      <input
        id={ids.id}
        type={type}
        value={value}
        disabled={disabled}
        required={required}
        autoComplete={autoComplete}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        aria-describedby={ids.describedBy}
        onChange={(event) => onChange(event.target.value)}
      />
      <FieldMessages hint={hint} hintId={ids.hintId} error={error} errorId={ids.errorId} />
    </div>
  );
}

export interface TextAreaFieldProps extends FieldFrameProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  rows?: number;
  maxLength?: number;
}

export function TextAreaField({
  label,
  required,
  hint,
  error,
  value,
  onChange,
  disabled,
  rows = 3,
  maxLength,
}: TextAreaFieldProps) {
  const ids = useFieldIds(hint, error);
  return (
    <div className="field">
      <label htmlFor={ids.id}>
        <LabelText label={label} required={required} />
      </label>
      <textarea
        id={ids.id}
        value={value}
        rows={rows}
        maxLength={maxLength}
        disabled={disabled}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={ids.describedBy}
        onChange={(event) => onChange(event.target.value)}
      />
      <FieldMessages hint={hint} hintId={ids.hintId} error={error} errorId={ids.errorId} />
    </div>
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectFieldProps extends FieldFrameProps {
  value: string;
  onChange: (value: string) => void;
  options: readonly SelectOption[];
  disabled?: boolean;
  /** Shown first with an empty value, e.g. "Choose a category". */
  placeholder?: string;
}

export function SelectField({
  label,
  required,
  hint,
  error,
  value,
  onChange,
  options,
  disabled,
  placeholder,
}: SelectFieldProps) {
  const ids = useFieldIds(hint, error);
  return (
    <div className="field">
      <label htmlFor={ids.id}>
        <LabelText label={label} required={required} />
      </label>
      <select
        id={ids.id}
        value={value}
        disabled={disabled}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={ids.describedBy}
        onChange={(event) => onChange(event.target.value)}
      >
        {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <FieldMessages hint={hint} hintId={ids.hintId} error={error} errorId={ids.errorId} />
    </div>
  );
}

export interface CheckboxGroupProps {
  legend: string;
  options: readonly SelectOption[];
  value: readonly string[];
  onChange: (value: string[]) => void;
  hint?: string;
  error?: string | null;
  disabled?: boolean;
}

/** One checkbox per option; nothing is pre-selected unless the caller's value says so. */
export function CheckboxGroup({
  legend,
  options,
  value,
  onChange,
  hint,
  error,
  disabled,
}: CheckboxGroupProps) {
  const ids = useFieldIds(hint, error);
  const toggle = (option: string, checked: boolean) => {
    const next = checked ? [...value, option] : value.filter((v) => v !== option);
    onChange(options.map((o) => o.value).filter((v) => next.includes(v)));
  };
  return (
    <fieldset
      className="field fieldset"
      aria-describedby={ids.describedBy}
      aria-invalid={error ? true : undefined}
      disabled={disabled}
    >
      <legend>{legend}</legend>
      {options.map((o) => (
        <label key={o.value} className="choice">
          <input
            type="checkbox"
            checked={value.includes(o.value)}
            onChange={(event) => toggle(o.value, event.target.checked)}
          />
          {o.label}
        </label>
      ))}
      <FieldMessages hint={hint} hintId={ids.hintId} error={error} errorId={ids.errorId} />
    </fieldset>
  );
}

export interface RadioGroupProps {
  legend: string;
  name: string;
  options: readonly SelectOption[];
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  error?: string | null;
  disabled?: boolean;
  required?: boolean;
}

export function RadioGroup({
  legend,
  name,
  options,
  value,
  onChange,
  hint,
  error,
  disabled,
  required,
}: RadioGroupProps) {
  const ids = useFieldIds(hint, error);
  return (
    <fieldset
      className="field fieldset"
      aria-describedby={ids.describedBy}
      aria-invalid={error ? true : undefined}
      disabled={disabled}
    >
      <legend>
        <LabelText label={legend} required={required} />
      </legend>
      {options.map((o) => (
        <label key={o.value} className="choice">
          <input
            type="radio"
            name={name}
            value={o.value}
            checked={value === o.value}
            onChange={() => onChange(o.value)}
          />
          {o.label}
        </label>
      ))}
      <FieldMessages hint={hint} hintId={ids.hintId} error={error} errorId={ids.errorId} />
    </fieldset>
  );
}

/** A titled group of read-only facts: `<dl>` so screen readers pair each term and value. */
export function Facts({ label, items }: { label?: string; items: [string, ReactNode][] }) {
  return (
    <dl className="facts" aria-label={label}>
      {items.map(([term, detail]) => (
        <div key={term} className="fact">
          <dt>{term}</dt>
          <dd>{detail}</dd>
        </div>
      ))}
    </dl>
  );
}
