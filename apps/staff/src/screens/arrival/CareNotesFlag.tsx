/**
 * Care notes at the arrival desk (migration 0181; SPK-ENTRY-004 actionable arrival information,
 * §1.7 operational notes only, never a diagnosis; §4.14 protected and audited).
 *
 * - From a pass scan, each person's `careNotes` comes with the scan (`POST /v1/passes/scan`): an
 *   array when the scanning role may read care notes (the API records the view in the audit log),
 *   null when it may not, which the desk is told rather than shown nothing silently.
 * - For a person looked up without a pass, the notes are read with `GET /v1/people/{id}/care-notes`
 *   when `GET /v1/me/permissions` lists `identity.read_care_notes`; also audited by the API.
 */
import { presentationForError, type Schema } from '@sportspark/api-client';
import { usePermissions } from '../../api/permissions';
import { useApiQuery } from '../../api/useApiQuery';
import { Icon } from '../../ui/Icon';

type ScanCareNote = Schema<'ScanCareNote'>;

const KIND_WORD: Record<ScanCareNote['kind'], string> = {
  allergy: 'Allergy',
  care_instruction: 'Care',
};

export function CareNotesFlag({
  notes,
  name,
}: {
  notes: readonly ScanCareNote[] | null | undefined;
  name: string;
}) {
  if (notes === null) {
    return <p className="caption">Care notes are not shown to your role.</p>;
  }
  if (!notes || notes.length === 0) return null;
  return (
    <ul className="care-flags" aria-label={`Care notes for ${name}`}>
      {notes.map((n) => (
        <li key={n.id} className="care-flag" data-kind={n.kind}>
          <Icon name="lock" size={15} />
          <span>
            <b>{KIND_WORD[n.kind]}:</b> {n.body}
          </span>
        </li>
      ))}
      <li className="caption care-flags-audit">
        Protected: this view is recorded in the audit log.
      </li>
    </ul>
  );
}

/** A looked-up person's notes, read when the viewer's role may read them. */
export function PersonCareNotes({ personId, name }: { personId: string; name: string }) {
  const permissions = usePermissions();
  const permitted = permissions.isPermitted('identity.read_care_notes');
  const notes = useApiQuery({
    path: '/people/{id}/care-notes',
    request: { path: { id: personId } },
    enabled: permitted === true,
  });
  if (permitted === false) return <CareNotesFlag notes={null} name={name} />;
  if (notes.error) {
    return (
      <p className="caption">
        {presentationForError(notes.error) === 'unavailable'
          ? 'Care notes are not shown to your role.'
          : `Care notes could not load (${notes.error.code}).`}
      </p>
    );
  }
  return <CareNotesFlag notes={notes.data?.notes} name={name} />;
}
