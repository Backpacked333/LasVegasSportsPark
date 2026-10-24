/**
 * SCR-C-03 registrations that still need something (SPK-UX-003 "Actions required before
 * participation", "an unresolved registration"): pending enrollments of the signed-in person and
 * of everyone they hold `view` over, each with its last operation so a checkout in
 * `recovery_required` can be pinned above everything (§4.11, journeys.md section 3).
 *
 * The API answers each participant's list under its own authorization; a participant whose list
 * is not available (NOT_FOUND, ACCESS_DENIED) is left out without comment (SPK-IAM-003).
 */
import { presentationForError, type ApiError, type Schema } from '@sportspark/api-client';
import { useMemo } from 'react';
import { useApiReads, viewablePersonIds } from '../../features/today/queries';
import { checkoutStateOf, needsRecovery, type CheckoutState } from '../../features/today/status';

type Enrollment = Schema<'Enrollment'>;
type Operation = Schema<'Operation'>;

export interface PendingRegistration {
  enrollment: Enrollment;
  operation: Operation | null;
  /** The checkout's state from the enrollment's basket and order. */
  checkout: CheckoutState;
}

export interface PendingRegistrations {
  /** Money received, fulfillment incomplete: pinned above everything (§4.11). */
  recovery: PendingRegistration[];
  /** Pending and waiting on the customer (no checkout running): "Actions required". */
  pending: PendingRegistration[];
  /** A checkout is running, was reversed, or its state could not be read: not an action. */
  inProgress: PendingRegistration[];
  /** A failure other than "not available" (shown with its code). */
  error: ApiError | null;
  loading: boolean;
  updatedAt: Date | null;
  refetch: () => void;
}

const PAGE = 20;

export function usePendingRegistrations(me: Schema<'Me'> | undefined): PendingRegistrations {
  const personIds = viewablePersonIds(me);
  const key = personIds.join(',');
  const requests = useMemo(
    () =>
      key
        .split(',')
        .filter(Boolean)
        .map((participantPersonId) => ({
          query: { participantPersonId, status: 'pending' as const, limit: PAGE },
        })),
    [key],
  );
  const lists = useApiReads('/enrollments', requests, me !== undefined);
  const enrollments = lists.flatMap((l) => l.data?.items ?? []);
  const opKey = enrollments
    .flatMap((e) => (e.lastOperationId ? [e.lastOperationId] : []))
    .join(',');
  const opRequests = useMemo(
    () =>
      opKey
        .split(',')
        .filter(Boolean)
        .map((id) => ({ path: { id } })),
    [opKey],
  );
  const ops = useApiReads('/operations/{id}', opRequests, me !== undefined);
  const byId = new Map<string, Operation>();
  for (const o of ops) if (o.data) byId.set(o.data.id, o.data);

  // The checkout's state comes from the records the API links: basket, then its order.
  const basketKey = [...new Set(enrollments.flatMap((e) => (e.basketId ? [e.basketId] : [])))].join(
    ',',
  );
  const basketRequests = useMemo(
    () =>
      basketKey
        .split(',')
        .filter(Boolean)
        .map((id) => ({ path: { id } })),
    [basketKey],
  );
  const baskets = useApiReads('/baskets/{id}', basketRequests, me !== undefined);
  const basketById = new Map<string, { status: string; orderRef: string | null }>();
  const basketFailed = new Set<string>();
  basketRequests.forEach((r, i) => {
    const read = baskets[i];
    if (read?.data) basketById.set(r.path.id, read.data);
    else if (read?.error) basketFailed.add(r.path.id);
  });
  const orderKey = [
    ...new Set([...basketById.values()].flatMap((b) => (b.orderRef ? [b.orderRef] : []))),
  ].join(',');
  const orderRequests = useMemo(
    () =>
      orderKey
        .split(',')
        .filter(Boolean)
        .map((id) => ({ path: { id } })),
    [orderKey],
  );
  const orders = useApiReads('/orders/{id}', orderRequests, me !== undefined);
  const orderById = new Map<string, { fulfillmentStatus: string }>();
  const orderFailed = new Set<string>();
  orderRequests.forEach((r, i) => {
    const read = orders[i];
    if (read?.data) orderById.set(r.path.id, read.data);
    else if (read?.error) orderFailed.add(r.path.id);
  });

  const recovery: PendingRegistration[] = [];
  const pending: PendingRegistration[] = [];
  const inProgress: PendingRegistration[] = [];
  for (const enrollment of enrollments) {
    const operation = enrollment.lastOperationId
      ? (byId.get(enrollment.lastOperationId) ?? null)
      : null;
    const basket = enrollment.basketId ? basketById.get(enrollment.basketId) : undefined;
    const orderId = basket?.orderRef ?? null;
    const checkout = checkoutStateOf(
      basket,
      orderId ? orderById.get(orderId) : undefined,
      (enrollment.basketId !== null && basketFailed.has(enrollment.basketId)) ||
        (orderId !== null && orderFailed.has(orderId)),
    );
    const row = { enrollment, operation, checkout };
    if (needsRecovery(operation) || checkout === 'recovery_required') recovery.push(row);
    else if (checkout === null) pending.push(row);
    else inProgress.push(row);
  }
  const error =
    lists.find((l) => l.error && presentationForError(l.error) !== 'unavailable')?.error ?? null;
  let updatedAt: Date | null = null;
  for (const l of lists)
    if (l.updatedAt && (!updatedAt || l.updatedAt < updatedAt)) updatedAt = l.updatedAt;
  return {
    recovery,
    pending,
    inProgress,
    error,
    loading:
      lists.some((l) => l.isPending) ||
      ops.some((o) => o.isPending) ||
      baskets.some((b) => b.isPending) ||
      orders.some((o) => o.isPending),
    updatedAt,
    refetch: () => {
      for (const l of lists) l.refetch();
    },
  };
}
