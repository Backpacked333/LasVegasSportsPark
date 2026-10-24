/**
 * The operation behind a multi-step command (§4.8, §4.12): result publication (standings
 * recalculation, bracket progression) and placement (roster addition, notice). The operation
 * describes the command, not the record (journeys.md section 3), so its state is shown apart from
 * the record's state. `recovery_required` is the SPK-UX-008 recovery state: a follow-up step was
 * not recorded and an owner must act; it is never shown as success.
 */
import { isTerminalOperationStatus } from '@sportspark/api-client';
import { useApiQuery } from '../../api/useApiQuery';
import { StatusBadge } from '../../ui/StatusBadge';
import { OPERATION_STATUS } from './labels';

export function OperationStatus({ operationId }: { operationId: string | null | undefined }) {
  const operation = useApiQuery({
    path: '/operations/{id}',
    request: { path: { id: operationId ?? '' } },
    enabled: !!operationId,
    refetchInterval: false,
  });
  if (!operationId) return null;
  if (operation.error) {
    return (
      <p className="caption" data-testid="operation-status">
        Operation status not available.
      </p>
    );
  }
  const data = operation.data;
  if (!data) {
    return (
      <p className="caption" aria-busy="true" data-testid="operation-status">
        Checking the operation…
      </p>
    );
  }
  const status = data.status as keyof typeof OPERATION_STATUS;
  const badge = OPERATION_STATUS[status] ?? { tone: 'neutral' as const, label: data.status };
  return (
    <div className="row-text" data-testid="operation-status">
      <span>
        Operation: <StatusBadge tone={badge.tone} label={badge.label} />
      </span>
      {status === 'recovery_required' ? (
        <span role="alert">
          A follow-up step was not recorded. The owner queue has an exception to resolve it; do not
          repeat the command.
        </span>
      ) : null}
      {!isTerminalOperationStatus(data.status) ? (
        <span className="caption">Still in progress. Refresh to see the outcome.</span>
      ) : null}
      {data.error ? (
        <span className="caption">
          {data.error.code}: {data.error.message}
        </span>
      ) : null}
    </div>
  );
}
