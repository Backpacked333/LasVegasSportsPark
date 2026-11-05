import { Injectable } from '@nestjs/common';
import type { DomainEvent, EventPayload } from '@sportspark/contracts';
import { sql } from 'kysely';
import { OperationalExceptions, type HandlerContext } from '../../../kernel';
import type { IdentityEvents } from '../../identity';
import { MERGED_PERSON_OVERLAP } from '../workforce.policy';

type PersonsMerged = EventPayload<typeof IdentityEvents.personsMerged>;

/**
 * Person merge follow-up (WRK-05; SPK-IAM-007, SPK-STAFF-001/003, §4.2, IF-21): workforce never
 * rewrites a person id in its assignments, qualifications or availability (they are historical
 * facts; reads resolve merges through the person directory instead, see MergedPersons). The one
 * invariant a merge can break is "a person holds no two overlapping accepted assignments"
 * (`assignments_no_overlap` is per person id, so it cannot see the survivor and the merged person
 * as one): when their accepted assignments' held intervals (turnaround included) overlap, one
 * `workforce.merged_person_overlap` exception per merge goes to the scheduler queue naming every
 * overlapping pair, and a scheduler decides which to withdraw. Idempotent by merge id: a replay,
 * or a second delivery of the same merge, raises nothing new.
 */
@Injectable()
export class PersonMergeFollowUp {
  constructor(private readonly exceptions: OperationalExceptions) {}

  async onPersonsMerged(event: DomainEvent<PersonsMerged>, ctx: HandlerContext): Promise<void> {
    const { mergeId, survivorPersonId, mergedPersonId } = event.payload;
    const organizationId = event.organizationId;
    if (survivorPersonId === mergedPersonId) return;
    const earlier = await this.exceptions.list(
      organizationId,
      {
        category: MERGED_PERSON_OVERLAP,
        affectedType: 'person',
        affectedId: survivorPersonId,
        limit: 200,
      },
      ctx.trx,
    );
    if (earlier.items.some((e) => detailsOf(e.details)['mergeId'] === mergeId)) return;

    const pairs = await ctx.trx
      .selectFrom('assignments as s')
      .innerJoin('assignments as m', (join) =>
        join.onRef('m.organization_id', '=', 's.organization_id'),
      )
      .select([
        's.id as survivorAssignmentId',
        'm.id as mergedAssignmentId',
        's.facility_id as facilityId',
        's.scheduled_start as survivorStart',
        'm.scheduled_start as mergedStart',
      ])
      .where('s.organization_id', '=', organizationId)
      .where('s.person_id', '=', survivorPersonId)
      .where('s.status', '=', 'accepted')
      .where('m.person_id', '=', mergedPersonId)
      .where('m.status', '=', 'accepted')
      .where(sql<boolean>`s.committed && m.committed`)
      .orderBy('s.scheduled_start')
      .orderBy('s.id')
      .orderBy('m.id')
      .execute();
    if (pairs.length === 0) return;

    const facilityIds = new Set(pairs.map((p) => p.facilityId));
    const earliest = pairs
      .flatMap((p) => [new Date(p.survivorStart), new Date(p.mergedStart)])
      .reduce((a, b) => (a.getTime() <= b.getTime() ? a : b));
    const assignmentIds = [
      ...new Set(pairs.flatMap((p) => [p.survivorAssignmentId, p.mergedAssignmentId])),
    ].sort();
    await this.exceptions.raise(ctx.trx, {
      organizationId,
      facilityId: facilityIds.size === 1 ? (pairs[0]?.facilityId ?? null) : null,
      category: MERGED_PERSON_OVERLAP,
      severity: 'high',
      title: `Merged person holds ${pairs.length} overlapping accepted assignment pair(s)`,
      affectedType: 'person',
      affectedId: survivorPersonId,
      ownerQueue: 'scheduler',
      deadlineAt: earliest,
      dedupeKey: `${MERGED_PERSON_OVERLAP}:${mergeId}`,
      details: {
        mergeId,
        survivorPersonId,
        mergedPersonId,
        assignmentIds,
        overlaps: pairs.map((p) => ({
          survivorAssignmentId: p.survivorAssignmentId,
          mergedAssignmentId: p.mergedAssignmentId,
        })),
        requiredAction:
          'Withdraw one assignment of each overlapping pair and offer its slot to a replacement.',
      },
    });
  }
}

function detailsOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}
