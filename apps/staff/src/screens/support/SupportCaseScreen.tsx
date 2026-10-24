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
 * - A related record or origin exception in recovery is shown beside the case, so resolving the
 *   case is never mistaken for recovering the record. SCR-S-49 recovery state ("not closable as
 *   resolved"): while one is in recovery, a notice beside Resolve and Close names each record and
 *   its state, and resolving or closing needs an explicit acknowledgment, which is sent as the
 *   command's reason for the audit record. The API does not enforce this yet (see the README).
 *   A linked action with an unknown outcome says so and is not repeated.
 * - Offline the case is read-only. A case the viewer may not see is shown as not available.
 */
import type { Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
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
        {item.overdue ? <StatusBadge tone="danger" label="Overdue" /> : null}
      </span>
      {item.description ? <p>{item.description}</p> : null}
      <Facts
        label="Case"
        items={[
          ['Category', item.category],
          [
            'Customer',
            item.subject.personId ? (
              <Link key="subject" to={`/people/${item.subject.personId}`}>
                Open the person record
              </Link>
            ) : (
              'None'
            ),
          ],
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
                {formatDateTime(e.occurredAt)} · {e.actor.actorLabel}
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

function RecoveryNotice({
  records,
  acknowledged,
  onAcknowledge,
  error,
}: {
  records: readonly RecordInRecovery[];
  acknowledged: boolean;
  onAcknowledge: (value: boolean) => void;
  error: string | undefined;
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
    </div>
  );
}

function TransitionPanel({ item }: { item: CaseDetail }) {
  const { online } = useApp();
  const recovery = useCaseRecovery(item);
  const signature = recoverySignature(recovery.inRecovery);
  // The acknowledgment covers exactly the records and states shown; a change asks again.
  const [acknowledgedFor, setAcknowledgedFor] = useState<string | null>(null);
  const acknowledged = recovery.inRecovery.length > 0 && acknowledgedFor === signature;
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
    if (ending && recovery.checking) {
      problems['recovery'] = 'Wait until the related records’ state has loaded.';
    } else if (ending && recovery.inRecovery.length > 0 && !acknowledged) {
      problems['recovery'] =
        'Confirm that the case may end while its related records are still in recovery.';
    }
    setErrors(problems);
    if (Object.keys(problems).length > 0) return;
    const reason =
      ending && recovery.inRecovery.length > 0
        ? `Ended while still in recovery: ${recovery.inRecovery
            .map((r) => `${r.type} ${r.id} (${r.state})`)
            .join(', ')}`.slice(0, 500)
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
          ...(reason ? { reason } : {}),
        },
      })
      .then((next) => {
        setSuccess(`Case updated. State: ${next.status}.`);
        if (event === 'resolve') {
          setKind('');
          setSummary('');
        }
      })
      .catch(() => undefined);
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
      {offersEnding && recovery.inRecovery.length > 0 ? (
        <RecoveryNotice
          records={recovery.inRecovery}
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
