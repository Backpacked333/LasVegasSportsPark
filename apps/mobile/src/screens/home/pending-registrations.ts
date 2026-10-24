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
import { needsRecovery } from '../../features/today/status';

type Enrollment = Schema<'Enrollment'>;
type Operation = Schema<'Operation'>;

export interface PendingRegistration {
  enrollment: Enrollment;
  operation: Operation | null;
}

export interface PendingRegistrations {
  recovery: PendingRegistration[];
  pending: PendingRegistration[];
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

  const recovery: PendingRegistration[] = [];
  const pending: PendingRegistration[] = [];
  for (const enrollment of enrollments) {
    const operation = enrollment.lastOperationId
      ? (byId.get(enrollment.lastOperationId) ?? null)
      : null;
    (needsRecovery(operation) ? recovery : pending).push({ enrollment, operation });
  }
  const error =
    lists.find((l) => l.error && presentationForError(l.error) !== 'unavailable')?.error ?? null;
  let updatedAt: Date | null = null;
  for (const l of lists)
    if (l.updatedAt && (!updatedAt || l.updatedAt < updatedAt)) updatedAt = l.updatedAt;
  return {
    recovery,
    pending,
    error,
    loading: lists.some((l) => l.isPending) || ops.some((o) => o.isPending),
    updatedAt,
    refetch: () => {
      for (const l of lists) l.refetch();
    },
  };
}
