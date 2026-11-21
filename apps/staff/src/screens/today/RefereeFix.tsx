/**
 * The fix of a missing referee (or coach) in place (S 1a "Needs action", S 3a drawer, S 1d phone;
 * INTERACTIONS 1a rows 5 to 7; key flow "Fix a missing referee"):
 *
 * - the ranked candidates: `GET /v1/assignments/{id}/replacements` for a declined or withdrawn
 *   assignment, else `GET /v1/assignment-requirements/{id}/candidates` for an open slot; the first
 *   eligible ones are shown with what makes them a good match ("Available · no clash");
 * - who declined and when, and who has been asked, from `GET /v1/assignments` of the target;
 * - Assign: offers the role to that person at once (`POST /v1/assignments`, offer: true). It is
 *   optimistic: the row says ✓ Assigned right away, the issue slides out after 2 s and a toast
 *   offers Undo for 5 s (Undo withdraws the offer, `POST /v1/assignments/{id}/withdraw`). On a
 *   refusal (a clash names the other booking) the row reverts and the toast says what did not
 *   save, with Try again.
 * - Ask: the same offer, kept on the row as ◷ "Asked 8:12"; unanswered after 15 minutes, the issue
 *   rises to the top and turns red (`escalated`).
 *
 * Pending decision (§4.8, recorded in the README): only the assignee accepts an assignment, so
 * "Assign" sends the offer to the person's phone and the slot counts as covered once they accept;
 * a direct assignment by a manager would need a product decision.
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { useApiQuery } from '../../api/useApiQuery';
import { useApp } from '../../providers/AppProviders';
import { Avatar } from '../../ui/Avatar';
import { Button } from '../../ui/Button';
import { SkeletonGroup, Skeleton } from '../../ui/Skeleton';
import { useToast } from '../../ui/Toast';
import { useTodayCommands } from './today-commands';
import { ASK_ESCALATE_MS, shortName, shortTime } from './today-model';

type Candidate = Schema<'ReplacementCandidate'>;

export interface RefereeTarget {
  targetType: 'fixture' | 'event' | 'session';
  targetId: string;
  offeringId?: string | null;
  kind: 'official' | 'coach' | 'supervisor' | 'organizer';
  role: string;
  slot?: number;
  /** A declined or withdrawn assignment of the slot (its replacements read). */
  assignmentId?: string | null;
  /** The open slot's requirement (its candidates read). */
  requirementId?: string | null;
  title: string;
}

/** "Available · no clash" from the candidate's positive reasons. */
export function candidateMeta(candidate: Candidate): string {
  const parts: string[] = [];
  if (candidate.grade) parts.push(`Grade ${candidate.grade}`);
  for (const reason of candidate.reasons) {
    if (reason.code === 'declared_available') parts.push('available');
    if (reason.code === 'no_conflicts') parts.push('free');
    if (reason.code === 'previously_declined') parts.push('declined before');
  }
  const text = parts.join(' · ');
  return text ? text[0]!.toUpperCase() + text.slice(1) : 'No availability declared';
}

export function useTargetAssignments(target: RefereeTarget) {
  return useApiQuery({
    path: '/assignments',
    request: {
      query: { targetType: target.targetType, targetId: target.targetId, limit: 20 },
    },
  });
}

/** The latest declined assignment and the open offers of a target. */
export function assignmentHistory(items: readonly Schema<'StaffAssignment'>[], role: string) {
  const mine = items.filter((a) => a.role === role);
  const declined = mine
    .filter((a) => a.status === 'declined' && a.declinedAt)
    .sort((a, b) => (b.declinedAt ?? '').localeCompare(a.declinedAt ?? ''))[0];
  const offered = mine.filter((a) => a.status === 'offered');
  return { declined, offered };
}

/** An offer of the target nobody answered for 15 minutes (the issue escalates). */
export function isEscalated(offered: readonly Schema<'StaffAssignment'>[], now: Date): boolean {
  return offered.some(
    (a) => a.offeredAt && now.getTime() - new Date(a.offeredAt).getTime() >= ASK_ESCALATE_MS,
  );
}

export function RefereeFix({
  target,
  timeZone,
  limit = 2,
  onAssigned,
  onUndone,
  compact = false,
}: {
  target: RefereeTarget;
  timeZone: string;
  limit?: number;
  /** The offer went out (after the optimistic ✓): the issue may leave the list. */
  onAssigned?: (name: string) => void;
  onUndone?: () => void;
  /** Phone: one row, the button 44 px. */
  compact?: boolean;
}) {
  const { online } = useApp();
  const toast = useToast();
  const commands = useTodayCommands();
  const replacements = useApiQuery({
    path: '/assignments/{id}/replacements',
    request: { path: { id: target.assignmentId ?? '' } },
    enabled: !!target.assignmentId,
  });
  const openSlot = useApiQuery({
    path: '/assignment-requirements/{id}/candidates',
    request: { path: { id: target.requirementId ?? '' } },
    enabled: !target.assignmentId && !!target.requirementId,
  });
  const assignments = useTargetAssignments(target);
  const [optimistic, setOptimistic] = useState<Record<string, 'assigned' | 'asked'>>({});

  const source = target.assignmentId ? replacements : openSlot;
  const candidates = (source.data?.candidates ?? []).filter((c) => c.eligible).slice(0, limit);
  const { offered } = assignmentHistory(assignments.data?.items ?? [], target.role);
  const offeredTo = new Map(offered.map((a) => [a.personId, a]));

  const offer = async (candidate: Candidate, mode: 'assigned' | 'asked') => {
    const name = shortName(candidate.displayName);
    setOptimistic((s) => ({ ...s, [candidate.personId]: mode }));
    const key = `offer:${target.targetType}:${target.targetId}:${candidate.personId}`;
    const body = {
      personId: candidate.personId,
      kind: target.kind,
      role: target.role,
      targetType: target.targetType,
      targetId: target.targetId,
      ...(target.offeringId ? { offeringId: target.offeringId } : {}),
      ...(target.slot ? { slot: target.slot } : {}),
      offer: true,
      reason: mode === 'assigned' ? 'Assigned from Today' : 'Asked from Today',
    };
    try {
      const outcome = await commands.send(key, 'post', '/assignments', { body });
      if (mode === 'assigned') {
        onAssigned?.(name);
        toast.show({
          tone: 'success',
          message: `Assigned ${name} to ${target.title}`,
          onUndo: () => {
            setOptimistic((s) => {
              const { [candidate.personId]: _gone, ...rest } = s;
              return rest;
            });
            onUndone?.();
            void commands
              .send(`withdraw:${outcome.assignment.id}`, 'post', '/assignments/{id}/withdraw', {
                path: { id: outcome.assignment.id },
                body: {
                  expectedRevision: outcome.assignment.revision,
                  reason: 'Undone from Today',
                },
              })
              .catch((cause: { message?: string }) =>
                toast.show({
                  tone: 'error',
                  message: `Undo did not save: ${cause.message ?? 'try again from Staff and officials'}`,
                }),
              );
          },
        });
      } else {
        toast.show({ message: `Asked ${name}. Their phone shows the request.` });
      }
    } catch (cause) {
      setOptimistic((s) => {
        const { [candidate.personId]: _gone, ...rest } = s;
        return rest;
      });
      const error = cause as { message?: string; code?: string };
      toast.show({
        tone: 'error',
        message: `${name} was not ${mode === 'assigned' ? 'assigned' : 'asked'}: ${error.message ?? 'the request failed'}${error.code ? ` (${error.code})` : ''}`,
        action: { label: 'Try again', onClick: () => void offer(candidate, mode) },
        durationMs: 8_000,
      });
    }
  };

  if (source.isPending && (target.assignmentId || target.requirementId)) {
    return (
      <SkeletonGroup label="best matches" className="candidates">
        {Array.from({ length: compact ? 1 : limit }, (_, i) => (
          <div className="candidate" key={i}>
            <Skeleton width={28} height={28} radius={999} />
            <Skeleton width="50%" />
          </div>
        ))}
      </SkeletonGroup>
    );
  }
  if (!target.assignmentId && !target.requirementId) return null;
  if (source.error) {
    return (
      <p className="caption">
        Matches could not be loaded ({source.error.code}).{' '}
        <button type="button" className="link-button" onClick={() => void source.refetch()}>
          Try again
        </button>
      </p>
    );
  }
  if (candidates.length === 0) {
    return <p className="caption">No qualified, free person found. Ask the league office.</p>;
  }
  return (
    <ul
      className="candidates"
      aria-label={`Best matches for ${target.title}`}
      data-compact={compact || undefined}
    >
      {candidates.map((candidate, index) => {
        const name = shortName(candidate.displayName);
        const state = optimistic[candidate.personId];
        const pendingOffer = offeredTo.get(candidate.personId);
        const available = candidate.reasons.some((r) => r.code === 'declared_available');
        const primary = index === 0 && (available || compact);
        return (
          <li className="candidate" key={candidate.personId} data-state={state}>
            <Avatar
              name={candidate.displayName}
              personKey={candidate.personId}
              size={compact ? 36 : 28}
              decorative
            />
            <span className="candidate-text">
              <span className="candidate-name">{name}</span>
              <span className="candidate-meta">{candidateMeta(candidate)}</span>
            </span>
            {state === 'assigned' ? (
              <span className="candidate-done" role="status">
                <span aria-hidden="true">✓</span> Assigned
              </span>
            ) : pendingOffer || state === 'asked' ? (
              <span className="candidate-asked" role="status">
                <span aria-hidden="true">◷</span> Asked{' '}
                {pendingOffer?.offeredAt
                  ? shortTime(pendingOffer.offeredAt, timeZone, true)
                  : 'now'}
              </span>
            ) : (
              <Button
                variant={primary ? 'primary' : 'secondary'}
                className={compact ? 'candidate-button-lg' : 'button-sm'}
                disabled={!online}
                title={online ? undefined : 'Needs a connection'}
                aria-label={`${primary ? 'Assign' : 'Ask'} ${candidate.displayName}`}
                onClick={() => void offer(candidate, primary ? 'assigned' : 'asked')}
              >
                {primary ? 'Assign' : 'Ask'}
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
