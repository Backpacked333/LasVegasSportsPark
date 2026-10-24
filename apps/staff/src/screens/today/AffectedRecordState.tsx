/**
 * The current state of a record another module owns, read from that module where the API offers
 * a read (payment attempt, checkout, maintenance task), shown beside an exception (SCR-S-02) or a
 * support case (SCR-S-49) so closing either never looks like the record was fixed (SPK-UX-006,
 * SPK-SUPPORT-003). A record in recovery, or with an unknown outcome, says so. Without a read, or
 * when the viewer may not read it, the screen says where the state is kept.
 */
import { apiQueryKey, type ApiResponse } from '@sportspark/api-client';
import { useQueries } from '@tanstack/react-query';
import { useApiQuery } from '../../api/useApiQuery';
import { useApi } from '../../providers/AppProviders';
import { isUuid } from '../../ui/RecordRef';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';

const RECOVERY_STATES: ReadonlySet<string> = new Set(['recovery_required', 'unknown']);

export function isRecoveryState(state: string): boolean {
  return RECOVERY_STATES.has(state);
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

function Unavailable() {
  return <p className="caption">Its current state is not available to you here.</p>;
}

function PaymentAttemptState({ id }: { id: string }) {
  const q = useApiQuery({ path: '/payments/{id}', request: { path: { id } } });
  if (q.data) return <StateOfRecord label="Payment attempt" state={q.data.status} />;
  if (q.error) return <Unavailable />;
  return <StateView variant="loading" label="the payment attempt" />;
}

function CheckoutState({ id }: { id: string }) {
  const q = useApiQuery({ path: '/registration-checkouts/{id}', request: { path: { id } } });
  if (q.data) return <StateOfRecord label="Checkout" state={q.data.status} />;
  if (q.error) return <Unavailable />;
  return <StateView variant="loading" label="the checkout" />;
}

function MaintenanceTaskState({ id }: { id: string }) {
  const q = useApiQuery({ path: '/maintenance-tasks/{id}', request: { path: { id } } });
  if (q.data) return <StateOfRecord label="Maintenance task" state={q.data.status} />;
  if (q.error) return <Unavailable />;
  return <StateView variant="loading" label="the maintenance task" />;
}

const RECORD_READS: Record<string, { path: string; label: string }> = {
  payment_attempt: { path: '/payments/{id}', label: 'Payment attempt' },
  checkout: { path: '/registration-checkouts/{id}', label: 'Checkout' },
  maintenance_task: { path: '/maintenance-tasks/{id}', label: 'Maintenance task' },
};

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
    queries: readable.map((r) => {
      const read = RECORD_READS[r.type] as { path: string; label: string };
      const request = { path: { id: r.id } };
      return {
        queryKey: apiQueryKey(read.path, request),
        queryFn: ({ signal }: { signal: AbortSignal }) =>
          (
            api.request as (
              method: 'get',
              path: string,
              options: object,
            ) => Promise<ApiResponse<{ status: string }>>
          )('get', read.path, { ...request, signal }),
      };
    }),
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
            label: (RECORD_READS[record.type] as { label: string }).label,
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

/** Record types whose state this client can read today. */
export const READABLE_RECORD_TYPES: ReadonlySet<string> = new Set([
  'payment_attempt',
  'checkout',
  'maintenance_task',
]);

export function AffectedRecordState({ type, id }: { type: string; id: string }) {
  if (!isUuid(id)) {
    return <p className="caption">Its state is kept by its owning module; open it there.</p>;
  }
  switch (type) {
    case 'payment_attempt':
      return <PaymentAttemptState id={id} />;
    case 'checkout':
      return <CheckoutState id={id} />;
    case 'maintenance_task':
      return <MaintenanceTaskState id={id} />;
    default:
      return <p className="caption">Its state is kept by its owning module; open it there.</p>;
  }
}
