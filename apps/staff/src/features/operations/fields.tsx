/**
 * Labelled form controls for the operations screens (SPK-UX-009: every control has a visible
 * label, hints and errors are tied to it with aria-describedby, errors set aria-invalid and are
 * text, never colour alone). Required fields use aria-required and the screen's own messages
 * rather than the browser's validation bubbles. Field errors come from the API's VALIDATION_FAILED details
 * (`fieldErrorsOf`), so the user's valid input stays in place (SPK-UX-008 validation failure).
 */
import type { ApiError } from '@sportspark/api-client';
import { useId, type ReactNode } from 'react';

/** VALIDATION_FAILED details are `{ path, message }[]`; map them by top-level and full path. */
export function fieldErrorsOf(error: ApiError | null | undefined): Record<string, string> {
  if (!error || error.code !== 'VALIDATION_FAILED' || !Array.isArray(error.details)) return {};
  const out: Record<string, string> = {};
  for (const issue of error.details as unknown[]) {
    if (!issue || typeof issue !== 'object') continue;
    const { path, message } = issue as { path?: unknown; message?: unknown };
    if (typeof path !== 'string' || typeof message !== 'string') continue;
    out[path] ??= message;
    const top = path.split('.')[0] ?? path;
    out[top] ??= message;
  }
  return out;
}

interface FieldShellProps {
  label: string;
  hint?: string;
  error?: string;
  children: (ids: { id: string; describedBy: string | undefined }) => ReactNode;
}

function FieldShell({ label, hint, error, children }: FieldShellProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className="ops-field">
      <label htmlFor={id}>{label}</label>
      {hint ? (
        <span className="caption" id={hintId}>
          {hint}
        </span>
      ) : null}
      {children({ id, describedBy })}
      {error ? (
        <span className="error-text" id={errorId}>
          <span aria-hidden="true">✕ </span>
          {error}
        </span>
      ) : null}
    </div>
  );
}

export function TextField({
  label,
  value,
  onChange,
  hint,
  error,
  type = 'text',
  required,
  autoComplete = 'off',
  inputMode,
  onEnter,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  error?: string;
  type?: 'text' | 'datetime-local' | 'date' | 'number' | 'search';
  required?: boolean;
  autoComplete?: string;
  inputMode?: 'text' | 'decimal' | 'numeric';
  onEnter?: () => void;
  disabled?: boolean;
}) {
  return (
    <FieldShell label={label} hint={hint} error={error}>
      {({ id, describedBy }) => (
        <input
          id={id}
          type={type}
          value={value}
          aria-required={required || undefined}
          disabled={disabled}
          autoComplete={autoComplete}
          inputMode={inputMode}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && onEnter) {
              event.preventDefault();
              onEnter();
            }
          }}
        />
      )}
    </FieldShell>
  );
}

export function TextAreaField({
  label,
  value,
  onChange,
  hint,
  error,
  required,
  rows = 4,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  error?: string;
  required?: boolean;
  rows?: number;
}) {
  return (
    <FieldShell label={label} hint={hint} error={error}>
      {({ id, describedBy }) => (
        <textarea
          id={id}
          value={value}
          rows={rows}
          aria-required={required || undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </FieldShell>
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

export function SelectField({
  label,
  value,
  onChange,
  options,
  hint,
  error,
  placeholder,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly SelectOption[];
  hint?: string;
  error?: string;
  /** First option with an empty value ("Choose…"), so nothing is preselected for the user. */
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <FieldShell label={label} hint={hint} error={error}>
      {({ id, describedBy }) => (
        <select
          id={id}
          value={value}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
        >
          {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
    </FieldShell>
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
  hint?: string;
  disabled?: boolean;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className="ops-check">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-describedby={hintId}
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
