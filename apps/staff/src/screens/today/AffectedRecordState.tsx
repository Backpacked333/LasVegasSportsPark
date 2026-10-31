/**
 * The current state of a record another module owns, read from that module (its own
 * `GET /v1/<records>/{id}`), shown beside an exception (SCR-S-02) or a support case (SCR-S-49), so
 * closing either never looks like the record was fixed (SPK-UX-006, SPK-SUPPORT-003). A record in
 * recovery, or with an unknown outcome, says so. Without a read for the record type the screen
 * says its state is kept by the owning module; a record the viewer may not read is "not available
 * to you here" (protected NOT_FOUND or ACCESS_DENIED, never whether it exists); any other failure
 * shows its code and "Try again".
 *
 * Stage 3 added reads for bookings, refunds, POS register sessions, accounting batches and more;
 * the table below lists every record type an exception or case names whose owning module answers
 * a single-record read with a `status`.
 */
import {
  apiQueryKey,
  presentationForError,
  type ApiError,
  type ApiResponse,
} from '@sportspark/api-client';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useApi } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { isUuid } from '../../ui/RecordRef';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';

const RECOVERY_STATES: ReadonlySet<string> = new Set(['recovery_required', 'unknown']);

export function isRecoveryState(state: string): boolean {
  return RECOVERY_STATES.has(state);
}

interface RecordRead {
  path: string;
  label: string;
}

const read = (path: string, label: string): RecordRead => ({ path, label });

/** Record type (as exceptions and cases name it) → the owning module's read and a label. */
export const RECORD_READS: Readonly<Record<string, RecordRead>> = {
  payment_attempt: read('/payments/{id}', 'Payment attempt'),
  refund_attempt: read('/refunds/{id}', 'Refund'),
  refund: read('/refunds/{id}', 'Refund'),
  checkout: read('/registration-checkouts/{id}', 'Checkout'),
  obligation: read('/obligations/{id}', 'Obligation'),
  credit: read('/credits/{id}', 'Credit'),
  installment_plan: read('/installment-plans/{id}', 'Installment plan'),
  accounting_export_batch: read('/accounting-export-batches/{id}', 'Accounting export batch'),
  pos_register_session: read('/pos-register-sessions/{id}', 'Register session'),
  pos_sale: read('/pos-sales/{id}', 'Point-of-sale sale'),
  booking: read('/bookings/{id}', 'Booking'),
  enrollment: read('/enrollments/{id}', 'Enrollment'),
  application: read('/applications/{id}', 'Application'),
  placement_request: read('/placement-requests/{id}', 'Placement request'),
  session_booking: read('/session-bookings/{id}', 'Session booking'),
  waitlist_entry: read('/waitlist-entries/{id}', 'Waitlist entry'),
  waitlist_offer: read('/waitlist-offers/{id}', 'Waitlist offer'),
  maintenance_task: read('/maintenance-tasks/{id}', 'Maintenance task'),
  restriction: read('/maintenance-restrictions/{id}', 'Restriction'),
  maintenance_restriction: read('/maintenance-restrictions/{id}', 'Restriction'),
  asset: read('/assets/{id}', 'Asset'),
  closure: read('/closures/{id}', 'Closure'),
  event: read('/events/{id}', 'Event'),
  resource: read('/resources/{id}', 'Resource'),
  season: read('/seasons/{id}', 'Season'),
  fixture: read('/fixtures/{id}', 'Fixture'),
  result_revision: read('/results/{id}', 'Result revision'),
  dispute: read('/disputes/{id}', 'Dispute'),
  incident: read('/incidents/{id}', 'Incident'),
  suspension: read('/suspensions/{id}', 'Suspension'),
  appeal: read('/appeals/{id}', 'Appeal'),
  assignment: read('/assignments/{id}', 'Assignment'),
  import_batch: read('/import-batches/{id}', 'Import batch'),
  reconciliation_report: read('/import-reconciliation-reports/{id}', 'Reconciliation report'),
  recommendation: read('/recommendations/{id}', 'Recommendation'),
  person: read('/people/{id}', 'Person'),
  access_review: read('/access-reviews/{id}', 'Access review'),
  duplicate_candidate: read('/duplicate-candidates/{id}', 'Duplicate candidate'),
  support_case: read('/cases/{id}', 'Support case'),
  operational_exception: read('/exceptions/{id}', 'Exception'),
  operation: read('/operations/{id}', 'Operation'),
};

/** Record types whose state this client can read. */
export const READABLE_RECORD_TYPES: ReadonlySet<string> = new Set(Object.keys(RECORD_READS));

type Api = ReturnType<typeof useApi>;

/** The same query key `useApiQuery` uses for the read, so both share one cache entry. */
function recordQuery(api: Api, recordRead: RecordRead, id: string) {
  const request = { path: { id } };
  return {
    queryKey: apiQueryKey(recordRead.path, request),
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      (
        api.request as (
          method: 'get',
          path: string,
          options: object,
        ) => Promise<ApiResponse<{ status: string }>>
      )('get', recordRead.path, { ...request, signal }),
  };
}

function StateOfRecord({ label, state }: { label: string; state: string }) {
  const recovery = isRecoveryState(state);
  return (
    <p data-testid="affected-record-state">
      {label}: <StatusBadge tone={recovery ? 'danger' : 'neutral'} label={`State: ${state}`} />
      {recovery ? (
        <span className="caption">
          {' '}
          The record itself still needs recovery; closing or resolving here does not change that.
        </span>
      ) : null}
    </p>
  );
}

function ReadFailed({
  label,
  error,
  onRetry,
}: {
  label: string;
  error: ApiError;
  onRetry: () => void;
}) {
  if (presentationForError(error) === 'unavailable') {
    return <p className="caption">Its current state is not available to you here.</p>;
  }
  return (
    <p className="caption" data-testid="affected-record-error">
      The {label.toLowerCase()}’s state could not be read (error code {error.code}).{' '}
      <Button
        variant="secondary"
        onClick={onRetry}
        aria-label={`Read the ${label.toLowerCase()} again`}
      >
        Try again
      </Button>
    </p>
  );
}

function KeptByOwner() {
  return <p className="caption">Its state is kept by its owning module; open it there.</p>;
}

function ReadableRecordState({ recordRead, id }: { recordRead: RecordRead; id: string }) {
  const api = useApi();
  const q = useQuery<ApiResponse<{ status: string }>, ApiError>(recordQuery(api, recordRead, id));
  const state = q.data?.data.status;
  if (typeof state === 'string') return <StateOfRecord label={recordRead.label} state={state} />;
  if (q.error) {
    return <ReadFailed label={recordRead.label} error={q.error} onRetry={() => void q.refetch()} />;
  }
  if (q.data) return <KeptByOwner />;
  return <StateView variant="loading" label={`the ${recordRead.label.toLowerCase()}`} />;
}

export interface RecordInRecovery {
  label: string;
  type: string;
  id: string;
  state: string;
}

/**
 * SCR-S-49 recovery state ("the related record is in recovery: shown, not closable as resolved"):
 * the related records whose own state is recovery or unknown, read through the same cached
 * queries the rows above use (same keys), so the status panel can warn beside Resolve and Close.
 * `checking` is true while any readable record has not loaded yet.
 */
export function useRecordsInRecovery(records: readonly { type: string; id: string }[]): {
  inRecovery: RecordInRecovery[];
  checking: boolean;
} {
  const api = useApi();
  const readable = records.filter((r) => isUuid(r.id) && RECORD_READS[r.type] !== undefined);
  return useQueries({
    queries: readable.map((r) => recordQuery(api, RECORD_READS[r.type] as RecordRead, r.id)),
    combine: (results) => {
      const inRecovery: RecordInRecovery[] = [];
      let checking = false;
      results.forEach((result, index) => {
        const record = readable[index] as { type: string; id: string };
        const state = result.data?.data.status;
        if (state === undefined) {
          if (result.isPending) checking = true;
          return;
        }
        if (isRecoveryState(state)) {
          inRecovery.push({
            label: (RECORD_READS[record.type] as RecordRead).label,
            type: record.type,
            id: record.id,
            state,
          });
        }
      });
      return { inRecovery, checking };
    },
  });
}

export function AffectedRecordState({ type, id }: { type: string; id: string }) {
  const recordRead = RECORD_READS[type];
  if (!isUuid(id) || !recordRead) return <KeptByOwner />;
  return <ReadableRecordState recordRead={recordRead} id={id} />;
}
