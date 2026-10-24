/**
 * SCR-S-32 Availability and qualifications (SPK-STAFF-001, DEC-011, POL-033).
 *
 * - Qualification evidence (`GET /v1/qualifications`): verify, reject (reason) or revoke (reason),
 *   offered where the workforce Qualification machine has the transition; each sends the expected
 *   revision. Evidence is a reference (a certificate number or document location), not a file.
 *   Which qualifications a role requires is DEC-011 (pending): the screen records and verifies
 *   evidence and does not invent requirements.
 * - Availability windows per person (`GET /v1/availability` needs a person): add an available or
 *   unavailable window, withdraw one with a reason (kept for history).
 * - The API has no directory of officials and coaches: people are those with qualification
 *   evidence, the viewer, or a record id typed in.
 */
import type { Schema } from '@sportspark/api-client';
import { useMemo, useState } from 'react';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { AreaTabs, STAFF_TABS } from '../../features/operations/AreaTabs';
import { useKeyedCommands } from '../../features/operations/commands';
import { nameOf, useOperatingFacility, usePersonNames } from '../../features/operations/context';
import { CommandError, CommandSuccess } from '../../features/operations/feedback';
import {
  CheckboxField,
  SelectField,
  TextAreaField,
  TextField,
  fieldErrorsOf,
} from '../../features/operations/fields';
import {
  formatInstant,
  formatRange,
  humanize,
  instantFromLocalInput,
} from '../../features/operations/format';
import { AVAILABILITY_KIND, QUALIFICATION_STATUS } from '../../features/operations/labels';
import { useNow } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';

type Qualification = Schema<'Qualification'>;
type QualificationStatus = Schema<'QualificationStatus'>;
type Availability = Schema<'StaffAvailability'>;

/** Workforce QualificationMachine transitions. */
const QUALIFICATION_ACTIONS: Record<
  QualificationStatus,
  readonly ('verify' | 'reject' | 'revoke')[]
> = {
  pending_verification: ['verify', 'reject'],
  verified: ['revoke'],
  rejected: [],
  revoked: [],
};
const QUALIFICATIONS_KEY = ['api', '/qualifications'] as const;
const AVAILABILITY_KEY = ['api', '/availability'] as const;

export function AvailabilityQualificationsScreen() {
  const facility = useOperatingFacility();
  const [status, setStatus] = useState<QualificationStatus | ''>('pending_verification');
  const qualifications = useApiQuery({
    path: '/qualifications',
    request: { query: { status: status || undefined } },
  });
  const people = useMemo(
    () => [...new Set((qualifications.data ?? []).map((q) => q.personId))],
    [qualifications.data],
  );
  const names = usePersonNames(people);
  return (
    <section aria-labelledby="availability-title">
      <h2 id="availability-title">Availability and qualifications</h2>
      <AreaTabs label="Staff and officials screens" tabs={STAFF_TABS} />
      <section className="ops-section" aria-labelledby="qualifications-title">
        <h3 id="qualifications-title">Qualification evidence</h3>
        <StateView
          variant="pending-decision"
          subject="Which qualifications each official and coach role requires"
          decisions={['DEC-011']}
          owner="Operations/finance"
        />
        <SelectField
          label="Show"
          value={status}
          onChange={(v) => setStatus(v as QualificationStatus | '')}
          placeholder="Every state"
          options={(Object.keys(QUALIFICATION_STATUS) as QualificationStatus[]).map((s) => ({
            value: s,
            label: QUALIFICATION_STATUS[s].label,
          }))}
        />
        <QueryBoundary
          query={qualifications}
          label="qualification evidence"
          isEmpty={(data) => data.length === 0}
          empty={{
            title: 'No qualification evidence',
            description: 'Evidence recorded for officials and coaches appears here.',
          }}
          unavailableOffline={['verifying, rejecting and revoking evidence']}
        >
          {(data) => (
            <ul className="list" aria-label="Qualification evidence">
              {data.map((q) => (
                <QualificationRow key={q.id} qualification={q} name={nameOf(names, q.personId)} />
              ))}
            </ul>
          )}
        </QueryBoundary>
        <RecordQualification />
      </section>
      <AvailabilitySection
        myPersonId={facility.personId}
        people={people.map((id) => ({ id, name: nameOf(names, id) }))}
      />
    </section>
  );
}

function QualificationRow({
  qualification: q,
  name,
}: {
  qualification: Qualification;
  name: string;
}) {
  const commands = useKeyedCommands({ invalidate: [QUALIFICATIONS_KEY] });
  const [reasonFor, setReasonFor] = useState<'reject' | 'revoke' | null>(null);
  const [reason, setReason] = useState('');
  const [missing, setMissing] = useState(false);
  const badge = QUALIFICATION_STATUS[q.status];
  const actions = QUALIFICATION_ACTIONS[q.status];
  const label = `${humanize(q.kind)}${q.level ? ` (${q.level})` : ''}`;
  const outcomeOf = (k: string) => commands.outcome(`${k}|${q.id}`);
  const error = ['verify', 'reject', 'revoke'].map((k) => outcomeOf(k).error).find(Boolean);
  const run = (k: 'verify' | 'reject' | 'revoke') => {
    if (k !== 'verify' && !reason.trim()) {
      setMissing(true);
      return;
    }
    setMissing(false);
    const body =
      k === 'verify'
        ? { expectedRevision: q.revision }
        : { expectedRevision: q.revision, reason: reason.trim() };
    const path = `/qualifications/{id}/${k}` as const;
    void commands.run(`${k}|${q.id}`, 'post', path, {
      path: { id: q.id },
      body: body as { expectedRevision: number; reason: string },
    });
  };
  return (
    <li aria-label={`${name}: ${label}`}>
      <div className="row-text">
        <span className="row-title">
          {name}: {label}
        </span>
        <StatusBadge tone={badge.tone} label={badge.label} />
        <span className="caption">
          Valid from {formatInstant(q.validFrom)}
          {q.validTo ? ` to ${formatInstant(q.validTo)}` : ''}
          {q.evidenceReference ? ` · Evidence: ${q.evidenceReference}` : ' · No evidence reference'}
          {q.verifiedBy ? ` · Verified by ${q.verifiedBy.actorLabel}` : ''}
          {q.statusReason ? ` · ${q.statusReason}` : ''}
        </span>
      </div>
      {actions.length > 0 ? (
        <div className="ops-actions">
          {actions.includes('verify') ? (
            <Button
              busy={outcomeOf('verify').status === 'pending'}
              aria-label={`Verify ${label} for ${name}`}
              onClick={() => run('verify')}
            >
              Verify
            </Button>
          ) : null}
          {actions.includes('reject') ? (
            <Button
              variant="secondary"
              aria-label={`Reject ${label} for ${name}`}
              onClick={() => setReasonFor('reject')}
            >
              Reject
            </Button>
          ) : null}
          {actions.includes('revoke') ? (
            <Button
              variant="secondary"
              aria-label={`Revoke ${label} for ${name}`}
              onClick={() => setReasonFor('revoke')}
            >
              Revoke
            </Button>
          ) : null}
        </div>
      ) : null}
      {reasonFor ? (
        <form
          className="ops-form"
          aria-label={`${humanize(reasonFor)} ${label} for ${name}`}
          onSubmit={(event) => {
            event.preventDefault();
            run(reasonFor);
          }}
        >
          <TextAreaField
            label={`Reason to ${reasonFor}`}
            value={reason}
            onChange={setReason}
            required
            error={missing ? 'A reason is required.' : undefined}
          />
          <Button type="submit" busy={outcomeOf(reasonFor).status === 'pending'}>
            Confirm {reasonFor}
          </Button>
        </form>
      ) : null}
      {error ? <CommandError error={error} subject="This evidence" /> : null}
    </li>
  );
}

function RecordQualification() {
  const [open, setOpen] = useState(false);
  const [personId, setPersonId] = useState('');
  const [kind, setKind] = useState('');
  const [level, setLevel] = useState('');
  const [evidence, setEvidence] = useState('');
  const [validFrom, setValidFrom] = useState('');
  const [validTo, setValidTo] = useState('');
  const [verify, setVerify] = useState(false);
  const [missing, setMissing] = useState<Record<string, string>>({});
  const command = useApiCommand('post', '/qualifications', { invalidate: [QUALIFICATIONS_KEY] });
  const apiErrors = fieldErrorsOf(command.error);
  if (!open) {
    return (
      <div className="ops-actions">
        <Button variant="secondary" onClick={() => setOpen(true)}>
          Record qualification evidence
        </Button>
      </div>
    );
  }
  const submit = () => {
    const from = instantFromLocalInput(validFrom);
    const to = instantFromLocalInput(validTo);
    const next: Record<string, string> = {};
    if (!kind.trim()) next.kind = 'Name the qualification.';
    if (!from) next.validFrom = 'Give the date it is valid from.';
    setMissing(next);
    if (Object.keys(next).length > 0 || !from) return;
    void command
      .submit({
        body: {
          ...(personId.trim() ? { personId: personId.trim() } : {}),
          kind: kind.trim(),
          ...(level.trim() ? { level: level.trim() } : {}),
          ...(evidence.trim() ? { evidenceReference: evidence.trim() } : {}),
          validFrom: from,
          ...(to ? { validTo: to } : {}),
          verify,
        },
      })
      .catch(() => undefined);
  };
  return (
    <form
      className="ops-form ops-section"
      aria-label="Record qualification evidence"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <TextField
        label="Person (record id)"
        value={personId}
        onChange={setPersonId}
        hint="Leave empty to record your own evidence."
        error={apiErrors.personId}
      />
      <TextField
        label="Qualification"
        value={kind}
        onChange={setKind}
        required
        hint="A lower-case name, for example referee_grade_8."
        error={missing.kind ?? apiErrors.kind}
      />
      <TextField
        label="Level (optional)"
        value={level}
        onChange={setLevel}
        error={apiErrors.level}
      />
      <TextField
        label="Evidence reference (optional)"
        value={evidence}
        onChange={setEvidence}
        hint="A certificate number or where the document is kept."
        error={apiErrors.evidenceReference}
      />
      <TextField
        label="Valid from"
        type="datetime-local"
        value={validFrom}
        onChange={setValidFrom}
        required
        error={missing.validFrom ?? apiErrors.validFrom}
      />
      <TextField
        label="Valid to (optional)"
        type="datetime-local"
        value={validTo}
        onChange={setValidTo}
        error={apiErrors.validTo}
      />
      <CheckboxField
        label="Record as verified"
        checked={verify}
        onChange={setVerify}
        hint="Only staff who manage qualifications may record verified evidence; others' evidence awaits verification."
      />
      <div className="ops-actions">
        <Button type="submit" busy={command.isProcessing}>
          Record evidence
        </Button>
        <Button variant="secondary" onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>
      {command.error && Object.keys(apiErrors).length === 0 ? (
        <CommandError error={command.error} onRetry={submit} />
      ) : null}
      {command.data ? (
        <CommandSuccess label={QUALIFICATION_STATUS[command.data.status].label} />
      ) : null}
    </form>
  );
}

function AvailabilitySection({
  myPersonId,
  people,
}: {
  myPersonId: string | null;
  people: { id: string; name: string }[];
}) {
  const now = useNow(60_000);
  const [choice, setChoice] = useState<string>('me');
  const [typed, setTyped] = useState('');
  const personId =
    choice === 'me' ? myPersonId : choice === 'other' ? typed.trim() || null : choice;
  const from = useMemo(() => new Date(now.getTime() - 86_400_000).toISOString(), [now]);
  const to = useMemo(() => new Date(now.getTime() + 30 * 86_400_000).toISOString(), [now]);
  const windows = useApiQuery({
    path: '/availability',
    request: { query: { personId: personId ?? undefined, from, to, includeWithdrawn: 'true' } },
    enabled: personId !== null,
  });
  return (
    <section className="ops-section" aria-labelledby="windows-title">
      <h3 id="windows-title">Availability (next 30 days)</h3>
      <SelectField
        label="Whose availability"
        value={choice}
        onChange={setChoice}
        options={[
          { value: 'me', label: 'Mine' },
          ...people.map((p) => ({ value: p.id, label: p.name })),
          { value: 'other', label: 'Another person (record id)' },
        ]}
      />
      {choice === 'other' ? (
        <TextField label="Person (record id)" value={typed} onChange={setTyped} />
      ) : null}
      {personId ? (
        <>
          <QueryBoundary
            query={windows}
            label="availability"
            isEmpty={(data) => data.length === 0}
            empty={{
              title: 'No windows',
              description: 'No availability or unavailability is recorded for the next 30 days.',
            }}
            unavailableOffline={['adding and withdrawing windows']}
          >
            {(data) => (
              <ul className="list" aria-label="Availability windows">
                {data.map((w) => (
                  <WindowRow key={w.id} window={w} />
                ))}
              </ul>
            )}
          </QueryBoundary>
          <AddWindow personId={choice === 'me' ? null : personId} />
        </>
      ) : (
        <p className="caption">Choose a person.</p>
      )}
    </section>
  );
}

function WindowRow({ window: w }: { window: Availability }) {
  const withdraw = useApiCommand('post', '/availability/{id}/withdraw', {
    invalidate: [AVAILABILITY_KEY],
  });
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [missing, setMissing] = useState(false);
  const badge = AVAILABILITY_KIND[w.kind];
  const label = `${badge.label}, ${formatRange(w.interval.start, w.interval.end)}`;
  const submit = () => {
    if (!reason.trim()) {
      setMissing(true);
      return;
    }
    void withdraw
      .submit({ path: { id: w.id }, body: { reason: reason.trim(), expectedRevision: w.revision } })
      .catch(() => undefined);
  };
  return (
    <li aria-label={label}>
      <div className="row-text">
        <StatusBadge tone={badge.tone} label={badge.label} />
        <span>{formatRange(w.interval.start, w.interval.end)}</span>
        {w.note ? <span className="caption">{w.note}</span> : null}
        {w.status === 'withdrawn' ? (
          <span className="caption">
            Withdrawn {w.withdrawnAt ? formatInstant(w.withdrawnAt) : ''}: {w.withdrawnReason}
          </span>
        ) : null}
      </div>
      {w.status === 'active' ? (
        <Button
          variant="secondary"
          aria-label={`Withdraw ${label}`}
          onClick={() => setOpen((o) => !o)}
        >
          Withdraw
        </Button>
      ) : null}
      {open ? (
        <form
          className="ops-form"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <TextAreaField
            label="Reason for withdrawing"
            value={reason}
            onChange={setReason}
            required
            error={missing ? 'A reason is required.' : undefined}
          />
          <Button type="submit" busy={withdraw.isProcessing}>
            Confirm withdrawal
          </Button>
        </form>
      ) : null}
      {withdraw.error ? <CommandError error={withdraw.error} onRetry={submit} /> : null}
    </li>
  );
}

function AddWindow({ personId }: { personId: string | null }) {
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [kind, setKind] = useState<'available' | 'unavailable' | ''>('');
  const [note, setNote] = useState('');
  const [missing, setMissing] = useState<Record<string, string>>({});
  const command = useApiCommand('post', '/availability', { invalidate: [AVAILABILITY_KEY] });
  const apiErrors = fieldErrorsOf(command.error);
  const submit = () => {
    const s = instantFromLocalInput(start);
    const e = instantFromLocalInput(end);
    const next: Record<string, string> = {};
    if (!s) next.start = 'Give the start.';
    if (!e) next.end = 'Give the end.';
    if (s && e && s >= e) next.end = 'The end must be after the start.';
    if (!kind) next.kind = 'Choose available or unavailable.';
    setMissing(next);
    if (Object.keys(next).length > 0 || !s || !e || !kind) return;
    void command
      .submit({
        body: {
          ...(personId ? { personId } : {}),
          interval: { start: s, end: e },
          kind,
          ...(note.trim() ? { note: note.trim() } : {}),
        },
      })
      .catch(() => undefined);
  };
  return (
    <form
      className="ops-form"
      aria-label="Add an availability window"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <h4>Add a window</h4>
      <TextField
        label="Starts"
        type="datetime-local"
        value={start}
        onChange={setStart}
        required
        error={missing.start ?? apiErrors['interval.start']}
      />
      <TextField
        label="Ends"
        type="datetime-local"
        value={end}
        onChange={setEnd}
        required
        error={missing.end ?? apiErrors['interval.end'] ?? apiErrors.interval}
      />
      <SelectField
        label="Kind"
        value={kind}
        onChange={(v) => setKind(v as 'available' | 'unavailable' | '')}
        placeholder="Choose"
        options={[
          { value: 'available', label: 'Available' },
          { value: 'unavailable', label: 'Unavailable' },
        ]}
        error={missing.kind}
      />
      <TextField label="Note (optional)" value={note} onChange={setNote} />
      <Button type="submit" busy={command.isProcessing}>
        Add window
      </Button>
      {command.error && Object.keys(apiErrors).length === 0 ? (
        <CommandError error={command.error} onRetry={submit} />
      ) : null}
      {command.data ? (
        <CommandSuccess label={`${AVAILABILITY_KIND[command.data.kind].label} window added`} />
      ) : null}
    </form>
  );
}
