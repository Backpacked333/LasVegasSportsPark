import { Inject, Injectable } from '@nestjs/common';
import { tstzrange } from '@sportspark/db';
import { sql } from 'kysely';
import type { Trx } from '../../../kernel';
import { ConflictDetector, SCHEDULING_POLICY, type SchedulingPolicy } from '../../scheduling';
import { addMinutes, overlaps } from '../workforce.shared';

export interface CommitmentConflict {
  code: 'assignment_overlap' | 'insufficient_turnaround' | 'party_overlap' | 'insufficient_rest';
  message: string;
  assignmentIds: string[];
  conflictingEventIds: string[];
}

export interface CommitmentQuery {
  organizationId: string;
  facility: { id: string; timezone: string };
  personId: string;
  scheduledStart: Date;
  scheduledEnd: Date;
  turnaroundMinutes: number;
  /** The target's own scheduling event: the person's commitment to it is not a conflict. */
  schedulingEventId: string | null;
  /** Assignments that do not count (the assignment being checked, one being replaced). */
  ignoreAssignmentIds: string[];
}

/**
 * Overlapping commitments and required turnaround (SPK-STAFF-003), as early, explainable feedback:
 *
 *  1. Accepted assignments of the person whose held interval (scheduled interval plus their
 *     turnaround) meets this one's held interval. The database exclusion constraint
 *     `assignments_no_overlap` is the guarantee; this names the colliding assignments.
 *  2. Person commitments held in the scheduling module (an official or coach committed directly
 *     to an event), through scheduling's exported ConflictDetector with the person rest set to the
 *     turnaround. Scheduling owns those rows and their exclusion constraint; workforce only reads
 *     through scheduling's code.
 */
@Injectable()
export class CommitmentChecker {
  constructor(
    @Inject(SCHEDULING_POLICY) private readonly schedulingPolicy: SchedulingPolicy,
    private readonly detector: ConflictDetector,
  ) {}

  async conflicts(trx: Trx, query: CommitmentQuery): Promise<CommitmentConflict[]> {
    const out: CommitmentConflict[] = [];
    const heldEnd = addMinutes(query.scheduledEnd, query.turnaroundMinutes);
    let others = trx
      .selectFrom('assignments')
      .select(['id', 'scheduled_start', 'scheduled_end'])
      .where('organization_id', '=', query.organizationId)
      .where('person_id', '=', query.personId)
      .where('status', '=', 'accepted')
      .where(sql<boolean>`committed && ${tstzrange(query.scheduledStart, heldEnd)}`);
    if (query.ignoreAssignmentIds.length > 0) {
      others = others.where('id', 'not in', query.ignoreAssignmentIds);
    }
    const rows = await others.orderBy('scheduled_start').execute();
    const overlapping = rows.filter((r) =>
      overlaps(
        new Date(r.scheduled_start),
        new Date(r.scheduled_end),
        query.scheduledStart,
        query.scheduledEnd,
      ),
    );
    const tooClose = rows.filter((r) => !overlapping.includes(r));
    if (overlapping.length > 0) {
      out.push({
        code: 'assignment_overlap',
        message: 'The person already holds an accepted assignment at an overlapping time.',
        assignmentIds: overlapping.map((r) => r.id),
        conflictingEventIds: [],
      });
    }
    if (tooClose.length > 0) {
      out.push({
        code: 'insufficient_turnaround',
        message: 'The person would not have the required turnaround between assignments.',
        assignmentIds: tooClose.map((r) => r.id),
        conflictingEventIds: [],
      });
    }

    const policy: SchedulingPolicy = {
      ...this.schedulingPolicy,
      requiredRestMinutes: {
        ...this.schedulingPolicy.requiredRestMinutes,
        person: query.turnaroundMinutes,
      },
    };
    const detected = await this.detector.detect(
      trx,
      query.organizationId,
      query.facility,
      [
        {
          key: 'assignment',
          eventId: null,
          // Only party checks apply (no resources are proposed); the kind is not evaluated for them.
          kind: 'block',
          format: null,
          scheduledStart: query.scheduledStart,
          scheduledEnd: query.scheduledEnd,
          setupMinutes: 0,
          cleanupMinutes: 0,
          resourceIds: [],
          commitments: [{ partyType: 'person', partyId: query.personId, role: 'staff' }],
        },
      ],
      { policy, ignoreEventIds: query.schedulingEventId ? [query.schedulingEventId] : [] },
    );
    for (const conflict of detected) {
      if (conflict.severity !== 'error') continue;
      const code = conflict.detail.code;
      if (code !== 'party_overlap' && code !== 'insufficient_rest') continue;
      out.push({
        code,
        message:
          code === 'party_overlap'
            ? 'The person is committed to an overlapping scheduled event.'
            : 'The person would not have the required turnaround after a scheduled event.',
        assignmentIds: [],
        conflictingEventIds: conflict.detail.conflictingEventIds,
      });
    }
    return out;
  }
}
