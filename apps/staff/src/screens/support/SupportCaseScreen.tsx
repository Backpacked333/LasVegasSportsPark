/**
 * SCR-S-49 Support case (SPK-SUPPORT-001, SPK-SUPPORT-002, SPK-SUPPORT-003). One case from
 * `GET /v1/cases/{id}`: owner, category, priority, subject, related records, origin, the history
 * timeline, linked actions and the resolution.
 *
 * - Lifecycle steps are exactly the case's `allowedEvents`; resolving records a resolution kind and
 *   summary. Every change carries the case's expected revision and an idempotency key per intent;
 *   STALE_REVISION offers "Reload" and keeps what was typed.
 * - A note is history only and never a refund, permission change or transfer (SPK-SUPPORT-003);
 *   real actions are the owning module's commands, linked here with their operation as evidence.
 * - A related record or origin exception in recovery is shown beside the case (its own state,
 *   read from its owning module, `AffectedRecordState.tsx`), so resolving the case is never
 *   mistaken for recovering the record. SCR-S-49 recovery state ("not closable as resolved"):
 *   while one is in recovery, a notice beside Resolve and Close names each record and its state,
 *   and resolving or closing needs an explicit acknowledgment with a reason. The API enforces the
 *   same for the case's operations in `recovery_required` (SUP-04: RESOURCE_CONFLICT
 *   `RELATED_RECORD_IN_RECOVERY`, listing them): the refused operations join the notice, and the
 *   acknowledged command sends `acknowledgeOpenRecovery: true` with the reason, which the API
 *   audits. Closing with an action whose outcome is unknown is refused by the API
 *   (`ACTION_OUTCOME_UNKNOWN`), shown with its code. A linked action with an unknown outcome says
 *   so and is not repeated.
 * - How the case was opened (`openedVia`): a customer's own request (SPK-SUPPORT-002) says so; the
 *   customer sees its status, never notes, the owner or internal details. A subject merged into
 *   another record links to the surviving record (SPK-IAM-007). People are named from
 *   `GET /v1/person-names`; times are in the case's facility zone (`GET /v1/facilities`).
 * - The case's audit history is offered to roles that may read the audit log.
 * - Offline the case is read-only. A case the viewer may not see is shown as not available.
 */
import type { Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { PersonName, usePeopleNames } from '../../features/people/names';
import { PersonReferenceField, referenceError } from '../../features/people/PersonReferenceField';
import { useApp } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { CommandError, CommandSuccess, fieldErrorsOf } from '../../ui/CommandFeedback';
import { Facts, SelectField, TextAreaField, TextField } from '../../ui/FormFields';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { RecordRef, isUuid } from '../../ui/RecordRef';
import { StateView } from '../../ui/StateView';
import { StatusBadge, type StatusTone } from '../../ui/StatusBadge';
import { formatDateTime } from '../../ui/time';
import {
  AffectedRecordState,
  useRecordsInRecovery,
  type RecordInRecovery,
} from '../today/AffectedRecordState';
import { AuditHistory } from '../today/AuditHistory';
import { EXCEPTION_STATUS_TONE } from '../today/exception-actions';
import { useFacilityDirectory } from '../today/useFacilityDirectory';
import {
  CASES_KEY,
  CASE_EVENT_LABELS,
  CASE_KEY,
  CASE_PRIORITY_TONE,
  CASE_STATUS_TONE,
  RESOLUTION_KINDS,
  SLUG_PATTERN,
  type CaseEvent,
  type CaseResolutionKind,
} from './support';

type CaseDetail = Schema<'CaseDetail'>;
type CaseAction = Schema<'CaseAction'>;

const ACTION_TONE: Record<CaseAction['status'], StatusTone> = {
  requested: 'pending',
  succeeded: 'success',
  failed: 'danger',
  unknown: 'warning',
};

/** Action ids look like `finance.refund` (the API's registered action ids). */
const ACTION_ID_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

function OriginException({ id }: { id: string }) {
  const exception = useApiQuery({ path: '/exceptions/{id}', request: { path: { id } } });
  return (
    <p>
      Opened for <Link to={`/today/exceptions/${id}`}>an operational exception</Link>
      {exception.data ? (
        <>
          {' '}
          <StatusBadge
            tone={EXCEPTION_STATUS_TONE[exception.data.status]}
            label={`Exception status: ${exception.data.status}`}
          />
        </>
      ) : exception.error ? (
        <span className="caption"> (its state is not available to you)</span>
      ) : null}
    </p>
  );
}

const OPENED_VIA_TEXT: Record<CaseDetail['openedVia'], string> = {
  staff: 'staff',
  customer: 'customer request',
  hook: 'to coordinate an origin record',
};

function Subject({ item }: { item: CaseDetail }) {
  const personId = item.subject.personId;
  const canonical = item.subject.canonicalPersonId;
  const names = usePeopleNames([personId, canonical]);
  if (!personId) return <span>None</span>;
  return (
    <span>
      <PersonName id={personId} names={names} />
      {canonical && canonical !== personId ? (
        <>
          {' '}
          (merged into <PersonName id={canonical} names={names} />)
        </>
      ) : null}
    </span>
  );
}

function CaseFacts({ item }: { item: CaseDetail }) {
  const facilities = useFacilityDirectory();
  const zone = facilities.timezone(item.facilityId);
  return (
    <>
      <span className="actions-row">
        <StatusBadge tone={CASE_STATUS_TONE[item.status]} label={`Status: ${item.status}`} />
        <StatusBadge
          tone={CASE_PRIORITY_TONE[item.priority]}
          label={`Priority: ${item.priority}`}
        />
        {item.openedVia === 'customer' ? (
          <StatusBadge tone="info" label="Customer request" />
        ) : null}
        {item.overdue ? <StatusBadge tone="danger" label="Overdue" /> : null}
      </span>
      {item.openedVia === 'customer' ? (
        <p className="caption">
          The customer opened this request. They see its status, never notes, the owner or internal
          details.
        </p>
      ) : null}
      {item.description ? <p>{item.description}</p> : null}
      <Facts
        label="Case"
        items={[
          ['Category', item.category],
          ['Customer', <Subject key="subject" item={item} />],
          ['Household', item.subject.householdId ?? 'None'],
          ['Facility', facilities.name(item.facilityId) ?? 'Organization-wide'],
          ['Owner queue', item.owner.queue ?? 'None'],
          [
            'Owner person',
            item.owner.personId ? (
              <Link key="owner" to={`/people/${item.owner.personId}`}>
                {item.owner.personId}
              </Link>
            ) : (
              'Unassigned'
            ),
          ],
          ['Due', item.dueAt ? formatDateTime(item.dueAt, zone) : 'No due time'],
          ['Opened by', item.openedBy.actorLabel],
          ['Opened via', OPENED_VIA_TEXT[item.openedVia]],
          ['Opened', formatDateTime(item.createdAt, zone)],
          ['Updated', formatDateTime(item.updatedAt, zone)],
          ['Revision', String(item.revision)],
        ]}
      />
      {item.origin?.type === 'operational_exception' ? (
        <OriginException id={item.origin.id} />
      ) : null}
      {item.origin?.type === 'access_review' ? (
        <p>
          Opened for <Link to={`/people/access-reviews/${item.origin.id}`}>an access review</Link>.
        </p>
      ) : null}
      {item.resolution ? (
        <p>
          Resolution: <strong>{item.resolution.kind}</strong>. {item.resolution.summary}
        </p>
      ) : null}
      <section aria-labelledby="related-title">
        <h3 id="related-title">Related records</h3>
        {item.relatedRecords.length === 0 ? (
          <p>No related records.</p>
        ) : (
          <ul className="list" aria-label="Related records">
            {item.relatedRecords.map((r) => (
              <li key={`${r.type}-${r.id}`}>
                <RecordRef type={r.type} id={r.id} />
                <AffectedRecordState type={r.type} id={r.id} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function CaseHistory({ item }: { item: CaseDetail }) {
  const facilities = useFacilityDirectory();
  const zone = facilities.timezone(item.facilityId);
  return (
    <section className="panel" aria-labelledby="case-history-title">
      <h3 id="case-history-title">History</h3>
      <ol className="list" aria-label="Case history">
        {item.events.map((e) => (
          <li key={e.id}>
            <div className="row-text">
              <span className="row-title">
                {e.kind}
                {e.fromStatus || e.toStatus
                  ? `: ${e.fromStatus ?? '—'} to ${e.toStatus ?? '—'}`
                  : ''}
              </span>
              <span className="caption">
                {formatDateTime(e.occurredAt, zone)} · {e.actor.actorLabel}
                {Array.isArray(e.details['acknowledgedOpenRecovery'])
                  ? ' · ended while related operations were still in recovery (acknowledged)'
                  : ''}
              </span>
              {e.body ? <span>{e.body}</span> : null}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function CaseActions({ item }: { item: CaseDetail }) {
  return (
    <section className="panel" aria-labelledby="case-actions-title">
      <h3 id="case-actions-title">Actions taken</h3>
      {item.actions.length === 0 ? (
        <p>No command has been linked to this case.</p>
      ) : (
        <ul className="list" aria-label="Linked actions">
          {item.actions.map((a) => (
            <li key={a.id}>
              <div className="row-text">
                <span className="row-title">{a.actionId}</span>
                <span className="caption">
                  {a.via} · {a.actor.actorLabel} · {formatDateTime(a.requestedAt)}
                  {a.commandOperationId ? ` · operation ${a.commandOperationId}` : ''}
                </span>
                {a.record ? <RecordRef type={a.record.type} id={a.record.id} /> : null}
                {a.note ? <span>{a.note}</span> : null}
                {a.error ? (
                  <span className="error-text">
                    {a.error.code}. {a.error.message}
                  </span>
                ) : null}
                {a.status === 'unknown' ? (
                  <span className="caption">
                    Outcome unknown: the owning module is being checked. Do not repeat this action.
                  </span>
                ) : null}
              </div>
              <StatusBadge tone={ACTION_TONE[a.status]} label={`Action: ${a.status}`} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function useReload(resets: (() => void)[]) {
  const queryClient = useQueryClient();
  return () => {
    resets.forEach((r) => r());
    void queryClient.invalidateQueries({ queryKey: CASE_KEY });
  };
}

/** Exception states that are still being worked: the origin is not recovered yet. */
const OPEN_EXCEPTION_STATES: ReadonlySet<string> = new Set(['open', 'acknowledged', 'unresolved']);

/** Related records and the origin exception still in recovery (SCR-S-49 recovery state). */
function useCaseRecovery(item: CaseDetail): { inRecovery: RecordInRecovery[]; checking: boolean } {
  const records = useRecordsInRecovery(item.relatedRecords);
  const originId = item.origin?.type === 'operational_exception' ? item.origin.id : null;
  const origin = useApiQuery({
    path: '/exceptions/{id}',
    request: { path: { id: originId ?? '' } },
    enabled: originId !== null,
  });
  const inRecovery = [...records.inRecovery];
  if (originId !== null && origin.data && OPEN_EXCEPTION_STATES.has(origin.data.status)) {
    inRecovery.push({
      label: 'Origin exception',
      type: 'operational_exception',
      id: originId,
      state: origin.data.status,
    });
  }
  return {
    inRecovery,
    checking: records.checking || (originId !== null && origin.isPending),
  };
}

const ENDING_EVENTS: ReadonlySet<CaseEvent> = new Set(['resolve', 'close']);

function recoverySignature(records: readonly RecordInRecovery[]): string {
  return records.map((r) => `${r.type}:${r.id}:${r.state}`).join('|');
}

/** SUP-04: the operations the API listed when it refused to end the case while they recover. */
export function refusedRecoveryOperations(error: unknown): RecordInRecovery[] {
  const e = error as { code?: unknown; details?: unknown } | null | undefined;
  if (!e || e.code !== 'RESOURCE_CONFLICT') return [];
  const details = e.details as { code?: unknown; operations?: unknown } | null | undefined;
  if (details?.code !== 'RELATED_RECORD_IN_RECOVERY' || !Array.isArray(details.operations)) {
    return [];
  }
  return details.operations.flatMap((o: unknown) => {
    const op = o as { operationId?: unknown; kind?: unknown; status?: unknown };
    if (typeof op.operationId !== 'string') return [];
    return [
      {
        label: `Operation ${typeof op.kind === 'string' ? op.kind : ''}`.trim(),
        type: 'operation',
        id: op.operationId,
        state: typeof op.status === 'string' ? op.status : 'recovery_required',
      },
    ];
  });
}

function mergeRecovery(
  a: readonly RecordInRecovery[],
  b: readonly RecordInRecovery[],
): RecordInRecovery[] {
  const seen = new Set(a.map((r) => `${r.type}:${r.id}`));
  return [...a, ...b.filter((r) => !seen.has(`${r.type}:${r.id}`))];
}

function RecoveryNotice({
  records,
  acknowledged,
  onAcknowledge,
  error,
  reason,
  onReason,
  reasonError,
}: {
  records: readonly RecordInRecovery[];
  acknowledged: boolean;
  onAcknowledge: (value: boolean) => void;
  error: string | undefined;
  reason: string;
  onReason: (value: string) => void;
  reasonError: string | undefined;
}) {
  return (
    <div className="notice" role="group" aria-labelledby="case-recovery-title">
      <p id="case-recovery-title">
        <StatusBadge tone="warning" label="Related records still in recovery" />
      </p>
      <ul className="list" aria-label="Records still in recovery">
        {records.map((r) => (
          <li key={`${r.type}-${r.id}`}>
            {r.label} <code>{r.id.slice(0, 8)}</code>: state {r.state}
          </li>
        ))}
      </ul>
      <p className="caption">
        Resolving or closing this case does not recover these records. Recover them in their owning
        module first, or confirm below that the case is ending while they are still in recovery.
      </p>
      <label className="choice">
        <input
          type="checkbox"
          checked={acknowledged}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'case-recovery-error' : undefined}
          onChange={(event) => onAcknowledge(event.target.checked)}
        />
        I understand these records are still in recovery and want to resolve or close the case
        anyway
      </label>
      {error ? (
        <p id="case-recovery-error" className="error-text" role="alert">
          {error}
        </p>
      ) : null}
      {acknowledged ? (
        <TextAreaField
          label="Why the case may end now"
          required
          hint="Kept with the audit record of the acknowledgment."
          value={reason}
          onChange={onReason}
          error={reasonError}
          maxLength={1500}
        />
      ) : null}
    </div>
  );
}

function TransitionPanel({ item }: { item: CaseDetail }) {
  const { online } = useApp();
  const recovery = useCaseRecovery(item);
  // Operations the API reported in recovery when it refused to end the case (SUP-04).
  const [refused, setRefused] = useState<RecordInRecovery[]>([]);
  const inRecovery = mergeRecovery(recovery.inRecovery, refused);
  const signature = recoverySignature(inRecovery);
  // The acknowledgment covers exactly the records and states shown; a change asks again.
  const [acknowledgedFor, setAcknowledgedFor] = useState<string | null>(null);
  const acknowledged = inRecovery.length > 0 && acknowledgedFor === signature;
  const [ackReason, setAckReason] = useState('');
  const offersEnding = item.allowedEvents.some((e) => ENDING_EVENTS.has(e));
  const [kind, setKind] = useState('');
  const [summary, setSummary] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [success, setSuccess] = useState<string | null>(null);
  const [lastEvent, setLastEvent] = useState<CaseEvent | null>(null);
  const transition = useApiCommand('post', '/cases/{id}/transition', {
    invalidate: [CASE_KEY, CASES_KEY],
  });
  const reload = useReload([transition.reset]);
  const apiErrors = fieldErrorsOf(transition.error);
  const run = (event: CaseEvent) => {
    setSuccess(null);
    setLastEvent(event);
    const problems: Record<string, string> = {};
    if (event === 'resolve') {
      if (!kind) problems['kind'] = 'Choose how the case was resolved.';
      if (!summary.trim()) problems['summary'] = 'Summarize the resolution.';
    }
    const ending = ENDING_EVENTS.has(event);
    const acknowledging = ending && inRecovery.length > 0;
    if (ending && recovery.checking) {
      problems['recovery'] = 'Wait until the related records’ state has loaded.';
    } else if (acknowledging && !acknowledged) {
      problems['recovery'] =
        'Confirm that the case may end while its related records are still in recovery.';
    } else if (acknowledging && !ackReason.trim()) {
      problems['ackReason'] = 'Write why the case may end while these records recover.';
    }
    setErrors(problems);
    if (Object.keys(problems).length > 0) return;
    // §4.9: the acknowledgment's reason names what is still in recovery, for the audit record.
    const reason = acknowledging
      ? `${ackReason.trim()}. Still in recovery: ${inRecovery
          .map((r) => `${r.type} ${r.id} (${r.state})`)
          .join(', ')}`.slice(0, 2000)
      : undefined;
    void transition
      .submit({
        path: { id: item.id },
        body: {
          event,
          expectedRevision: item.revision,
          ...(event === 'resolve'
            ? { resolution: { kind: kind as CaseResolutionKind, summary: summary.trim() } }
            : {}),
          ...(acknowledging ? { acknowledgeOpenRecovery: true, reason } : {}),
        },
      })
      .then((next) => {
        setSuccess(`Case updated. State: ${next.status}.`);
        setRefused([]);
        setAckReason('');
        if (event === 'resolve') {
          setKind('');
          setSummary('');
        }
      })
      .catch((error: unknown) => {
        const operations = refusedRecoveryOperations(error);
        if (operations.length > 0) setRefused(operations);
      });
  };
  if (item.allowedEvents.length === 0) {
    return (
      <section className="panel" aria-labelledby="transition-title">
        <h3 id="transition-title">Status</h3>
        <CommandSuccess message={success} />
        <p>This case takes no further status changes.</p>
      </section>
    );
  }
  return (
    <section className="panel" aria-labelledby="transition-title">
      <h3 id="transition-title">Status</h3>
      {item.allowedEvents.includes('resolve') ? (
        <div className="form">
          <SelectField
            label="Resolution"
            placeholder="Choose how it was resolved"
            hint="Needed to resolve. action_taken needs a linked command that succeeded."
            options={RESOLUTION_KINDS}
            value={kind}
            onChange={setKind}
            error={errors['kind'] ?? apiErrors['resolution.kind']}
          />
          <TextAreaField
            label="Resolution summary"
            value={summary}
            onChange={setSummary}
            error={errors['summary'] ?? apiErrors['resolution.summary']}
            maxLength={2000}
          />
        </div>
      ) : null}
      {offersEnding && inRecovery.length > 0 ? (
        <RecoveryNotice
          records={inRecovery}
          acknowledged={acknowledged}
          onAcknowledge={(value) => {
            setAcknowledgedFor(value ? signature : null);
            setErrors((current) => {
              const next = { ...current };
              delete next['recovery'];
              return next;
            });
          }}
          error={errors['recovery']}
          reason={ackReason}
          onReason={setAckReason}
          reasonError={errors['ackReason']}
        />
      ) : offersEnding && recovery.checking ? (
        <p className="caption">Checking whether the related records are still in recovery…</p>
      ) : errors['recovery'] ? (
        <p className="error-text" role="alert">
          {errors['recovery']}
        </p>
      ) : null}
      <div className="actions-row">
        {item.allowedEvents.map((event) => (
          <Button
            key={event}
            variant={event === 'resolve' ? 'primary' : 'secondary'}
            busy={transition.isProcessing}
            disabled={!online}
            onClick={() => run(event)}
          >
            {CASE_EVENT_LABELS[event]}
          </Button>
        ))}
      </div>
      <CommandSuccess message={success} />
      <CommandError
        error={transition.error}
        onRetry={lastEvent ? () => run(lastEvent) : undefined}
        onReload={reload}
      />
    </section>
  );
}

function NotePanel({ item }: { item: CaseDetail }) {
  const { online } = useApp();
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const note = useApiCommand('post', '/cases/{id}/notes', { invalidate: [CASE_KEY] });
  const submit = () => {
    setSuccess(null);
    if (!body.trim()) {
      setError('Write the note.');
      return;
    }
    setError(null);
    void note
      .submit({ path: { id: item.id }, body: { body: body.trim() } })
      .then(() => {
        setSuccess('Note added to the history.');
        setBody('');
      })
      .catch(() => undefined);
  };
  return (
    <section className="panel" aria-labelledby="note-title">
      <h3 id="note-title">Add a note</h3>
      <p className="caption">
        A note is history only. It is never a refund, a permission change or a transfer: run those
        commands where they belong and link them below.
      </p>
      <form
        noValidate
        className="form"
        aria-label="Add a note"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <TextAreaField label="Note" required value={body} onChange={setBody} error={error} />
        <Button type="submit" busy={note.isProcessing} disabled={!online}>
          Add note
        </Button>
      </form>
      <CommandSuccess message={success} />
      <CommandError error={note.error} onRetry={submit} />
    </section>
  );
}

function AssignPanel({ item }: { item: CaseDetail }) {
  const { online } = useApp();
  const [owner, setOwner] = useState(item.owner.personId ?? '');
  const [queue, setQueue] = useState(item.owner.queue ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [success, setSuccess] = useState<string | null>(null);
  const assign = useApiCommand('post', '/cases/{id}/assign', { invalidate: [CASE_KEY, CASES_KEY] });
  const reload = useReload([assign.reset]);
  const submit = () => {
    setSuccess(null);
    const problems: Record<string, string> = {};
    const o = referenceError(owner, false);
    if (o) problems['owner'] = o;
    if (queue && !SLUG_PATTERN.test(queue)) {
      problems['queue'] = 'Use lower-case letters, digits and underscores, starting with a letter.';
    }
    setErrors(problems);
    if (Object.keys(problems).length > 0) return;
    void assign
      .submit({
        path: { id: item.id },
        body: {
          expectedRevision: item.revision,
          ownerPersonId: owner.trim() ? owner.trim().toLowerCase() : null,
          ownerQueue: queue || null,
        },
      })
      .then(() => setSuccess('Owner updated.'))
      .catch(() => undefined);
  };
  return (
    <section className="panel" aria-labelledby="assign-title">
      <h3 id="assign-title">Owner</h3>
      <form
        noValidate
        className="form"
        aria-label="Assign the case"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <PersonReferenceField
          label="Owner (staff person reference)"
          hint="Leave empty to leave the case to its queue."
          value={owner}
          onChange={setOwner}
          error={errors['owner']}
        />
        <TextField label="Queue" value={queue} onChange={setQueue} error={errors['queue']} />
        <Button type="submit" busy={assign.isProcessing} disabled={!online}>
          Save owner
        </Button>
      </form>
      <CommandSuccess message={success} />
      <CommandError error={assign.error} onRetry={submit} onReload={reload} />
    </section>
  );
}

function LinkActionPanel({ item }: { item: CaseDetail }) {
  const { online } = useApp();
  const [actionId, setActionId] = useState('');
  const [operationId, setOperationId] = useState('');
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [success, setSuccess] = useState<string | null>(null);
  const link = useApiCommand('post', '/cases/{id}/actions', { invalidate: [CASE_KEY] });
  const submit = () => {
    setSuccess(null);
    const problems: Record<string, string> = {};
    if (!ACTION_ID_PATTERN.test(actionId.trim())) {
      problems['actionId'] = 'Enter the command’s action id, for example finance.refund.';
    }
    if (!isUuid(operationId)) {
      problems['operationId'] = 'Enter the operation reference the command returned.';
    }
    setErrors(problems);
    if (Object.keys(problems).length > 0) return;
    void link
      .submit({
        path: { id: item.id },
        body: {
          actionId: actionId.trim(),
          operationId: operationId.trim().toLowerCase(),
          ...(note.trim() ? { note: note.trim() } : {}),
        },
      })
      .then((outcome) => setSuccess(`Action linked. State: ${outcome.action.status}.`))
      .catch(() => undefined);
  };
  return (
    <section className="panel" aria-labelledby="link-title">
      <h3 id="link-title">Link a command you ran</h3>
      <p className="caption">
        The command must be yours, and its operation is the evidence. Linking never runs anything.
      </p>
      <form
        noValidate
        className="form"
        aria-label="Link a command"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <TextField
          label="Action id"
          required
          value={actionId}
          onChange={setActionId}
          error={errors['actionId']}
        />
        <TextField
          label="Operation reference"
          required
          value={operationId}
          onChange={setOperationId}
          error={errors['operationId']}
        />
        <TextField label="Note" value={note} onChange={setNote} />
        <Button type="submit" busy={link.isProcessing} disabled={!online}>
          Link command
        </Button>
      </form>
      <CommandSuccess message={success} />
      <CommandError error={link.error} onRetry={submit} />
    </section>
  );
}

function CaseView({ item }: { item: CaseDetail }) {
  const { online } = useApp();
  const facilities = useFacilityDirectory();
  return (
    <>
      <h3>{item.title}</h3>
      <CaseFacts item={item} />
      {!online ? (
        <p className="caption">Offline: this case is read-only until you reconnect.</p>
      ) : null}
      <TransitionPanel item={item} />
      <CaseHistory item={item} />
      <CaseActions item={item} />
      <NotePanel item={item} />
      <AssignPanel item={item} />
      <LinkActionPanel item={item} />
      <AuditHistory
        targetType="support_case"
        targetId={item.id}
        zone={facilities.timezone(item.facilityId)}
      />
    </>
  );
}

function CaseQuery({ id }: { id: string }) {
  const item = useApiQuery({ path: '/cases/{id}', request: { path: { id } } });
  return (
    <QueryBoundary
      query={item}
      label="the support case"
      empty={{ title: '', description: '' }}
      unavailableOffline={['changing the case']}
    >
      {(data) => <CaseView item={data} />}
    </QueryBoundary>
  );
}

export function SupportCaseScreen() {
  const { caseId = '' } = useParams();
  return (
    <section aria-labelledby="case-title">
      <h2 id="case-title">Support case</h2>
      <p>
        <Link to="/admin/cases">Back to support cases</Link>
      </p>
      {isUuid(caseId) ? <CaseQuery id={caseId} /> : <StateView variant="unavailable" />}
    </section>
  );
}
