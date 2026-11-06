/**
 * Care notes card on the person record (migration 0181; §1.7 "not a medical assessment system",
 * SPK-DISC-005, §4.14). Operational notes only: an allergy and what to do, or a care instruction;
 * never a diagnosis or medical advice. The notes are protected: `GET /v1/people/{id}/care-notes`
 * answers them to the roles the API names (`visibleToRoles`), the person and holders of `view`;
 * anyone else reads "not available", without learning whether notes exist (§4.10). Every read that
 * returns a note is recorded in the audit log, and the card says so.
 *
 * Recording (`POST /v1/people/{id}/care-notes`) and retiring with a reason
 * (`POST /v1/care-notes/{id}/retire`, expected revision) are offered to roles holding
 * `identity.manage_care_notes` while online; a correction retires the note and records a new one.
 */
import { presentationForError, type Schema } from '@sportspark/api-client';
import { useState, type FormEvent } from 'react';
import { usePermissions } from '../../api/permissions';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { roleLabel } from '../../features/insight-admin/labels';
import { useApp } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { CommandError, CommandSuccess } from '../../ui/CommandFeedback';
import { SelectField, TextAreaField, TextField } from '../../ui/FormFields';
import { Icon } from '../../ui/Icon';
import { StatusBadge } from '../../ui/StatusBadge';

type CareNote = Schema<'CareNote'>;

export const CARE_NOTES_KEY = ['api', '/people/{id}/care-notes'] as const;
export const READ_CARE_NOTES_ACTION = 'identity.read_care_notes';
export const MANAGE_CARE_NOTES_ACTION = 'identity.manage_care_notes';

export const CARE_NOTE_KIND: Record<CareNote['kind'], string> = {
  allergy: 'Allergy',
  care_instruction: 'Care instruction',
};
const KIND_OPTIONS = (Object.keys(CARE_NOTE_KIND) as CareNote['kind'][]).map((value) => ({
  value,
  label: CARE_NOTE_KIND[value],
}));

function RetireNote({ note, onDone }: { note: CareNote; onDone: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const retire = useApiCommand('post', '/care-notes/{id}/retire', { invalidate: [CARE_NOTES_KEY] });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (reason.trim().length === 0) return;
    void retire
      .submit({
        path: { id: note.id },
        body: { reason: reason.trim(), expectedRevision: note.revision },
      })
      .then(() => {
        setOpen(false);
        onDone(`${CARE_NOTE_KIND[note.kind]} note retired.`);
      })
      .catch(() => undefined);
  };
  if (!open) {
    return (
      <Button
        variant="secondary"
        aria-label={`Retire ${CARE_NOTE_KIND[note.kind].toLowerCase()} note`}
        onClick={() => setOpen(true)}
      >
        Retire
      </Button>
    );
  }
  return (
    <form className="form care-retire" onSubmit={submit}>
      <TextField
        label="Why is this note retired?"
        value={reason}
        onChange={setReason}
        required
        hint="Kept with the note. To correct it, retire it and record a new one."
      />
      <div className="actions-row">
        <Button type="submit" busy={retire.isProcessing} disabled={reason.trim().length === 0}>
          Retire note
        </Button>
        <Button variant="secondary" onClick={() => setOpen(false)}>
          Keep it
        </Button>
      </div>
      <CommandError error={retire.error} onRetry={() => retire.resend()} />
    </form>
  );
}

function AddNote({ personId, onDone }: { personId: string; onDone: (m: string) => void }) {
  const [kind, setKind] = useState<CareNote['kind'] | ''>('');
  const [body, setBody] = useState('');
  const record = useApiCommand('post', '/people/{id}/care-notes', {
    invalidate: [CARE_NOTES_KEY],
  });
  const valid = kind !== '' && body.trim().length > 0;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    void record
      .submit({ path: { id: personId }, body: { kind, body: body.trim() } })
      .then(() => {
        setKind('');
        setBody('');
        onDone('Care note recorded.');
      })
      .catch(() => undefined);
  };
  return (
    <form className="form care-add" onSubmit={submit} aria-label="Add a care note">
      <SelectField
        label="Kind of note"
        value={kind}
        onChange={(v) => setKind(v as CareNote['kind'] | '')}
        options={KIND_OPTIONS}
        placeholder="Choose a kind"
        required
      />
      <TextAreaField
        label="What staff need to know and do"
        value={body}
        onChange={setBody}
        rows={2}
        maxLength={500}
        required
        hint="Operational only, for example “Peanuts: EpiPen in the kit bag”. Not a diagnosis or medical advice."
      />
      <div className="actions-row">
        <Button type="submit" busy={record.isProcessing} disabled={!valid}>
          Record care note
        </Button>
      </div>
      <CommandError error={record.error} onRetry={() => record.resend()} />
    </form>
  );
}

export function CareNotesCard({ personId, merged }: { personId: string; merged: boolean }) {
  const { online } = useApp();
  const permissions = usePermissions();
  const readable = permissions.isPermitted(READ_CARE_NOTES_ACTION);
  const manageable = permissions.isPermitted(MANAGE_CARE_NOTES_ACTION) === true;
  const [outcome, setOutcome] = useState<string | null>(null);
  const notes = useApiQuery({
    path: '/people/{id}/care-notes',
    request: { path: { id: personId } },
    enabled: readable !== false,
  });
  const canChange = online && manageable && !merged;

  let body;
  if (readable === false) {
    body = <p className="caption">Care notes are not available to you.</p>;
  } else if (!notes.data) {
    body = (
      <p className="caption">
        {notes.error
          ? presentationForError(notes.error) === 'unavailable'
            ? 'Care notes are not available to you.'
            : `Care notes could not load (${notes.error.code}).`
          : 'Loading care notes…'}
      </p>
    );
  } else {
    const data = notes.data;
    body = (
      <>
        {data.notes.length === 0 ? (
          <p className="caption">No care note is recorded.</p>
        ) : (
          <ul className="list care-notes" aria-label="Care notes">
            {data.notes.map((n) => (
              <li key={n.id} data-kind={n.kind}>
                <span className="row-text">
                  <span className="row-title">
                    <b>{CARE_NOTE_KIND[n.kind]}:</b> {n.body}
                  </span>
                </span>
                {canChange ? <RetireNote note={n} onDone={setOutcome} /> : null}
              </li>
            ))}
          </ul>
        )}
        <p className="caption">
          <b>Visible to:</b> {data.visibleToRoles.map((r) => roleLabel(r)).join(', ')}, the person
          and adults holding view permission.
        </p>
        <p className="caption">Every view of these notes is recorded in the audit log.</p>
      </>
    );
  }
  return (
    <section className="card care-card" aria-labelledby="care-notes-title">
      <div className="card-head">
        <h4 id="care-notes-title">Care notes</h4>
        <span className="care-protected">
          <Icon name="lock" size={16} />
          <StatusBadge tone="info" label="Protected" />
        </span>
      </div>
      <div className="card-body">
        {body}
        <CommandSuccess message={outcome} />
        {canChange && notes.data ? <AddNote personId={personId} onDone={setOutcome} /> : null}
      </div>
    </section>
  );
}
