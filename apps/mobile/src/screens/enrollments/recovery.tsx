/**
 * Whether a pending enrollment's payment was received and the facility is completing the
 * registration (§4.11 recovery required, SPK-PAY-007; SCR-C-32 "recovery required: labelled on the
 * row and the record"; R3-SCREEN-STATES-04). The list row and the record decide with the same test
 * from the same reads:
 *
 * - every page of the caller's checkouts in recovery (`useRecoveryCheckouts`,
 *   `GET /v1/me/registration-checkouts?status=recovery_required`);
 * - the enrollment's last operation (`GET /v1/operations/{id}`), which also covers a checkout paid
 *   by someone else.
 *
 * Either one naming `recovery_required` is enough. Until both are known (the first page loading, a
 * later page still to come, a failed page or operation read) the answer is `unknown`: the screen
 * then never says the payment is not finished (it may have been received, "do not pay again"),
 * and shows the missing read with its code and "Try again" (`RecoveryReadState`).
 */
import { presentationForError, type ApiError, type Schema } from '@sportspark/api-client';
import type { ApiPagesResult } from '../../api/useApiPages';
import type { Enrollment } from '../../features/money/status';
import { recoveryCheckoutsKnown } from '../../features/registration/in-progress';
import { SectionQueryState } from '../../features/today/Section';
import { QueryErrorView } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';

type Checkout = Schema<'Checkout'>;
type Operation = Schema<'Operation'>;

/** What the caller's checkouts in recovery say, and whether that is all of them. */
export interface RecoveryIndex {
  enrollmentIds: Set<string>;
  basketIds: Set<string>;
  /** Every page was read (or the API does not show this account the list, §4.10). */
  complete: boolean;
}

export function recoveryIndex(
  checkouts: Pick<ApiPagesResult<Checkout>, 'data' | 'error' | 'hasNextPage'>,
): RecoveryIndex {
  const recovering = (checkouts.data ?? []).filter((c) => c.status === 'recovery_required');
  return {
    enrollmentIds: new Set(recovering.flatMap((c) => c.enrollmentIds)),
    basketIds: new Set(recovering.map((c) => c.basketId)),
    complete: recoveryCheckoutsKnown(checkouts),
  };
}

/** The read of an enrollment's last operation, as `useApiQuery` or `useApiRecords` gives it. */
export interface OperationRead {
  data: Pick<Operation, 'status'> | undefined;
  error: ApiError | null;
  refetch: () => unknown;
}

export type EnrollmentRecovery = 'recovery_required' | 'not_in_recovery' | 'unknown';

/** The operation is known: there is none, it was read, or the API does not show it (§4.10). */
function operationKnown(
  enrollment: Pick<Enrollment, 'lastOperationId'>,
  operation: OperationRead | undefined,
): boolean {
  if (enrollment.lastOperationId === null) return true;
  if (operation?.data !== undefined) return true;
  return (
    operation !== undefined &&
    operation.error !== null &&
    presentationForError(operation.error) === 'unavailable'
  );
}

/** The one test the list row and the record use (R3-SCREEN-STATES-04). */
export function pendingEnrollmentRecovery(
  enrollment: Pick<Enrollment, 'id' | 'status' | 'basketId' | 'lastOperationId'>,
  index: RecoveryIndex,
  operation: OperationRead | undefined,
): EnrollmentRecovery {
  if (enrollment.status !== 'pending') return 'not_in_recovery';
  if (
    operation?.data?.status === 'recovery_required' ||
    index.enrollmentIds.has(enrollment.id) ||
    (enrollment.basketId !== null && index.basketIds.has(enrollment.basketId))
  ) {
    return 'recovery_required';
  }
  return index.complete && operationKnown(enrollment, operation) ? 'not_in_recovery' : 'unknown';
}

/** A read worth showing as failed: not "not available" (§4.10). Offline is shown as offline. */
function failed(error: ApiError | null): error is ApiError {
  return error !== null && presentationForError(error) !== 'unavailable';
}

/**
 * A read keeping recovery unknown has failed (the first or a later page of the checkouts in
 * recovery, or an operation read): the list shows `RecoveryReadState` only then, the record also
 * while the reads are on their way.
 */
export function recoveryReadFailed(
  checkouts: Pick<ApiPagesResult<Checkout>, 'data' | 'error' | 'nextPageError'>,
  operations: readonly OperationRead[],
): boolean {
  return (
    (checkouts.data === undefined && failed(checkouts.error)) ||
    failed(checkouts.nextPageError) ||
    operations.some((o) => o.data === undefined && failed(o.error))
  );
}

/**
 * The read that keeps recovery unknown, in its own SPK-UX-008 state: a failed page of the
 * checkouts in recovery (first page: `SectionQueryState`; a later page: its code with "Try again",
 * which asks for that page again and lets the remaining pages follow), a failed operation read
 * with "Try again", or loading while they are on their way. Nothing once they are known.
 */
export function RecoveryReadState({
  checkouts,
  operations,
}: {
  checkouts: ApiPagesResult<Checkout>;
  /** The last operations of the enrollments whose recovery is unknown. */
  operations: readonly OperationRead[];
}) {
  const label = 'whether the payment was received';
  const pendingOperations = operations.filter(
    (o) => o.data === undefined && !(o.error && presentationForError(o.error) === 'unavailable'),
  );
  const failedOperation = pendingOperations.find((o) => o.error !== null);
  if (!recoveryCheckoutsKnown(checkouts)) {
    if (checkouts.data === undefined) return <SectionQueryState read={checkouts} label={label} />;
    if (checkouts.nextPageError) {
      return <QueryErrorView error={checkouts.nextPageError} onRetry={checkouts.loadMore} />;
    }
  }
  if (failedOperation?.error) {
    return (
      <QueryErrorView
        error={failedOperation.error}
        onRetry={() => {
          for (const o of pendingOperations) void o.refetch();
        }}
      />
    );
  }
  if (!recoveryCheckoutsKnown(checkouts) || pendingOperations.length > 0) {
    return <StateView variant="loading" label={label} />;
  }
  return null;
}
