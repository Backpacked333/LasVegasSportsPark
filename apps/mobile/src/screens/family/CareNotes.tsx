/**
 * Care notes for oneself or a person one manages (SCR-C-31; §1.7 "not a medical assessment
 * system", spec "operational injury or incident recording must remain distinct from diagnosis or
 * medical advice", SPK-DISC-005, §4.14, SPK-IAM-003).
 *
 * Operational notes only: an allergy and what to do, or a care instruction the front desk and
 * program staff need. Never a diagnosis, a medical record or medical advice, and the screen says
 * so. The notes are protected (§4.10): `GET /v1/people/{id}/care-notes` answers the person, holders
 * of `view` and the staff roles it names (`visibleToRoles`); anyone else gets NOT_FOUND, shown as
 * "not available" without saying whether notes exist. Every read is recorded in the audit log
 * (`readAudited`), so the notes are read only when the customer opens them.
 *
 * Recording (`POST /v1/people/{id}/care-notes`, kind and text up to 500 characters) and retiring
 * with a reason and the note's revision (`POST /v1/care-notes/{id}/retire`) are offered to the
 * person themselves and to holders of `complete_forms` (identity.manage_care_notes; the API checks
 * again). A correction retires the note and records a new one. STALE_REVISION reloads the notes.
 *
 * States: loading; empty ("No care notes"); ready; validation failure (field messages); not
 * available; error with code and "Try again"; offline (cached notes with their age, changes
 * disabled); processing; success (the list as it now stands).
 */
import type { Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { View } from 'react-native';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { useConnectivity } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { ListRow } from '../../ui/ListRow';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StatusBadge } from '../../ui/StatusBadge';
import { makeStyles, radius, spacing } from '../../ui/theme';
import { CommandError } from '../account/components/CommandError';
import { ChoiceGroup, Paragraph, TextField } from '../account/components/forms';

type CareNote = Schema<'CareNote'>;
type CareNoteKind = CareNote['kind'];

export const CARE_NOTES_KEY = ['api', '/people/{id}/care-notes'] as const;

export const CARE_NOTE_KIND: Record<CareNoteKind, string> = {
  allergy: 'Allergy',
  care_instruction: 'Care instruction',
};

const ROLE_WORDS: Record<string, string> = {
  front_desk: 'the front desk',
  program_manager: 'program managers',
  general_manager: 'general managers',
  league_manager: 'league managers',
  coach: 'coaches',
  official: 'officials',
  support_operator: 'support',
  system_administrator: 'system administrators',
};

/** "the front desk, program managers and general managers". */
export function rolesText(roles: readonly string[]): string {
  const words = roles.map((r) => ROLE_WORDS[r] ?? r.replace(/_/g, ' '));
  if (words.length <= 1) return words[0] ?? 'no staff';
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

export const NOT_MEDICAL =
  'Care notes are for practical needs only, such as an allergy and what to do, or a care instruction. They are not medical advice or a medical record, and nobody here checks them medically.';

export function CareNotes({
  personId,
  personName,
  canManage,
}: {
  personId: string;
  /** "you" or the given name, in sentences. */
  personName: string;
  canManage: boolean;
}) {
  const styles = useStyles();
  const notes = useApiQuery({
    path: '/people/{id}/care-notes',
    request: { path: { id: personId } },
  });
  return (
    <View style={styles.box} testID={`care-notes-${personId}`}>
      <Paragraph inset={false}>{NOT_MEDICAL}</Paragraph>
      <QueryBoundary
        query={notes}
        label="care notes"
        isEmpty={() => false}
        empty={{ title: '', description: '' }}
        unavailableOffline={['adding a care note', 'retiring a care note']}
      >
        {(data) => (
          <View>
            <Paragraph inset={false} muted>
              {`Seen by ${personName === 'you' ? 'you, adults you allow to view your record' : `you, other adults allowed to view ${personName}`}, and ${rolesText(data.visibleToRoles)}. Every time the notes are read, it is recorded.`}
            </Paragraph>
            {data.notes.length === 0 ? (
              <Paragraph inset={false}>No care notes.</Paragraph>
            ) : (
              <View accessibilityRole="list">
                {data.notes.map((note) => (
                  <NoteRow key={note.id} note={note} personId={personId} canManage={canManage} />
                ))}
              </View>
            )}
            {canManage ? <AddCareNote personId={personId} /> : null}
          </View>
        )}
      </QueryBoundary>
    </View>
  );
}

function NoteRow({
  note,
  personId,
  canManage,
}: {
  note: CareNote;
  personId: string;
  canManage: boolean;
}) {
  const [retiring, setRetiring] = useState(false);
  return (
    <View>
      <ListRow
        title={CARE_NOTE_KIND[note.kind]}
        detail={note.body}
        testID={`care-note-${note.id}`}
      />
      {canManage && !retiring ? (
        <Button
          label={`Retire: ${CARE_NOTE_KIND[note.kind]}`}
          variant="secondary"
          onPress={() => setRetiring(true)}
          accessibilityHint="Asks for a reason, then removes the note from use"
        />
      ) : null}
      {retiring ? (
        <RetireCareNote note={note} personId={personId} onClose={() => setRetiring(false)} />
      ) : null}
    </View>
  );
}

function RetireCareNote({
  note,
  personId,
  onClose,
}: {
  note: CareNote;
  personId: string;
  onClose: () => void;
}) {
  const styles = useStyles();
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [attempted, setAttempted] = useState(false);
  const retire = useApiCommand('post', '/care-notes/{id}/retire', {
    invalidate: [CARE_NOTES_KEY],
  });
  const sent = useRef<{ reason: string; expectedRevision: number } | null>(null);
  const reasonError = reason.trim() ? null : 'Say why this note no longer applies.';
  const send = async (request: { reason: string; expectedRevision: number }) => {
    sent.current = request;
    try {
      await retire.submit({ path: { id: note.id }, body: request });
      sent.current = null;
      onClose();
    } catch {
      // retire.error is rendered below; the reason is kept.
    }
  };
  return (
    <View style={styles.form} testID={`retire-care-note-${note.id}`}>
      <TextField
        label="Why it no longer applies"
        value={reason}
        onChangeText={(next) => {
          setReason(next);
          sent.current = null;
          if (retire.error) retire.reset();
        }}
        error={attempted ? reasonError : null}
        editable={!retire.isProcessing}
      />
      <View style={styles.actions}>
        <Button
          label="Retire note"
          onPress={() => {
            setAttempted(true);
            if (reasonError) return;
            void send({ reason: reason.trim(), expectedRevision: note.revision });
          }}
          busy={retire.isProcessing}
          disabled={offline}
        />
        <Button
          label="Keep note"
          variant="secondary"
          onPress={onClose}
          disabled={retire.isProcessing}
        />
      </View>
      {offline ? (
        <Paragraph inset={false} muted>
          Retiring a note needs a connection.
        </Paragraph>
      ) : null}
      {retire.error ? (
        <CommandError
          error={retire.error}
          onRetry={() => {
            if (sent.current) void send(sent.current);
          }}
          onReload={() => {
            // The note changed elsewhere: read the notes as they are now.
            retire.reset();
            void queryClient.invalidateQueries({
              queryKey: ['api', '/people/{id}/care-notes', { id: personId }],
            });
            onClose();
          }}
        />
      ) : null}
    </View>
  );
}

const KIND_OPTIONS = (Object.keys(CARE_NOTE_KIND) as CareNoteKind[]).map((value) => ({
  value,
  label: CARE_NOTE_KIND[value],
}));

function AddCareNote({ personId }: { personId: string }) {
  const styles = useStyles();
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<CareNoteKind | null>(null);
  const [body, setBody] = useState('');
  const [attempted, setAttempted] = useState(false);
  const record = useApiCommand('post', '/people/{id}/care-notes', {
    invalidate: [CARE_NOTES_KEY],
  });
  const sent = useRef<{ kind: CareNoteKind; body: string } | null>(null);
  const kindError = kind ? null : 'Choose what kind of note this is.';
  const text = body.trim();
  const bodyError = !text
    ? 'Write what staff need to know.'
    : text.length > 500
      ? 'Use at most 500 characters.'
      : null;
  const send = async (request: { kind: CareNoteKind; body: string }) => {
    sent.current = request;
    try {
      await record.submit({ path: { id: personId }, body: request });
      sent.current = null;
      setKind(null);
      setBody('');
      setAttempted(false);
      setOpen(false);
    } catch {
      // record.error is rendered below; the input is kept.
    }
  };
  if (!open) {
    return (
      <View style={styles.actions}>
        {record.status === 'success' ? (
          <StatusBadge tone="success" label="Care note saved" testID="care-note-saved" />
        ) : null}
        <Button
          label="Add a care note"
          variant="secondary"
          onPress={() => {
            record.reset();
            setOpen(true);
          }}
          disabled={offline}
        />
      </View>
    );
  }
  return (
    <View style={styles.form} testID={`add-care-note-${personId}`}>
      <ChoiceGroup<CareNoteKind>
        label="Kind of note"
        options={KIND_OPTIONS}
        value={kind}
        onChange={(next) => {
          setKind(next);
          sent.current = null;
        }}
        disabled={record.isProcessing}
      />
      {attempted && kindError ? <Paragraph inset={false}>{`✕ ${kindError}`}</Paragraph> : null}
      <TextField
        label="What staff need to know"
        hint="For example: Peanut allergy, EpiPen in the front pocket of the bag. Not a diagnosis or medical advice."
        value={body}
        onChangeText={(next) => {
          setBody(next);
          sent.current = null;
          if (record.error) record.reset();
        }}
        error={attempted ? bodyError : null}
        editable={!record.isProcessing}
        testID={`care-note-body-${personId}`}
      />
      <View style={styles.actions}>
        <Button
          label="Save care note"
          onPress={() => {
            setAttempted(true);
            if (kindError || bodyError || !kind) return;
            void send({ kind, body: text });
          }}
          busy={record.isProcessing}
          disabled={offline}
        />
        <Button
          label="Cancel"
          variant="secondary"
          onPress={() => setOpen(false)}
          disabled={record.isProcessing}
        />
      </View>
      {offline ? (
        <Paragraph inset={false} muted>
          Adding a care note needs a connection.
        </Paragraph>
      ) : null}
      {record.error ? (
        <CommandError
          error={record.error}
          onRetry={() => {
            if (sent.current) void send(sent.current);
          }}
        />
      ) : null}
    </View>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  box: {
    marginTop: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
    gap: spacing.sm,
  },
  form: { gap: spacing.sm, paddingVertical: spacing.sm },
  actions: { gap: spacing.sm, paddingTop: spacing.xs },
}));
