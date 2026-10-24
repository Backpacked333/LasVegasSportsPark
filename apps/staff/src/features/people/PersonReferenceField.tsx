/**
 * A person reference input (SPK-IAM-001, §4.10): the API has no person search, so staff enter the
 * opaque person id from a case, an exception, a receipt or the customer's account. The format is
 * checked before any request; a valid reference is previewed with `GET /v1/people/{id}` so staff
 * confirm who they mean. A protected NOT_FOUND reads "no person with this reference is available
 * to you", never that the person exists.
 */
import { useApiQuery } from '../../api/useApiQuery';
import { TextField } from '../../ui/FormFields';
import { isUuid } from '../../ui/RecordRef';
import { personName } from './people';

export const REFERENCE_FORMAT_ERROR =
  'Enter a person reference: 36 characters such as 0192f1a0-0000-7000-8000-000000000001.';

export function referenceError(value: string, required: boolean): string | null {
  const trimmed = value.trim();
  if (!trimmed) return required ? 'Enter a person reference.' : null;
  return isUuid(trimmed) ? null : REFERENCE_FORMAT_ERROR;
}

export function PersonPreview({ personId }: { personId: string }) {
  const person = useApiQuery({
    path: '/people/{id}',
    request: { path: { id: personId } },
    enabled: isUuid(personId),
  });
  if (!isUuid(personId)) return null;
  if (person.data) {
    return (
      <span className="caption" data-testid="person-preview">
        {personName(person.data)} · {person.data.kind} · status {person.data.status}
      </span>
    );
  }
  if (person.error) {
    return (
      <span className="caption" data-testid="person-preview">
        {person.error.isNotFound || person.error.isPermissionRestriction
          ? 'No person with this reference is available to you.'
          : `Could not check this reference (${person.error.code}).`}
      </span>
    );
  }
  return <span className="caption">Checking the reference…</span>;
}

export function PersonReferenceField({
  label,
  value,
  onChange,
  error,
  required,
  hint,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
  required?: boolean;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <div className="field">
      <TextField
        label={label}
        value={value}
        onChange={onChange}
        error={error}
        required={required}
        hint={hint}
        disabled={disabled}
      />
      <PersonPreview personId={value.trim()} />
    </div>
  );
}
