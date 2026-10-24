/**
 * A reference to a record owned by any module (`{ type, id }`), shown with the machine type name
 * (journeys.md section 3 rule 4) and the opaque id so staff can quote it. Never decorates the id
 * with personal data.
 */
import './form-fields.css';

export function RecordRef({ type, id }: { type: string; id: string }) {
  return (
    <span className="record-ref">
      {type} <code>{id}</code>
    </span>
  );
}

/** A canonical UUID (any version), as the API's `z.uuid()` accepts it. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value.trim());
}
