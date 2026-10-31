import { Injectable } from '@nestjs/common';
import { OperationalExceptions, type Trx } from '../../../kernel';

/** One kind of record whose live rows a partial unique index keeps to one per person and key. */
interface LiveRecordQuery {
  type: string;
  /** What makes two records of the type equivalent (the index's key, besides the person). */
  rows(
    trx: Trx,
    organizationId: string,
    personId: string,
  ): Promise<Array<{ id: string; key: string }>>;
}

/**
 * Person merge follow-up (ENR-07; SPK-IAM-007, §4.7 invariant 2, SPK-AT-004). Identity merges a
 * duplicate person into a survivor without rewriting anyone's history (IF-21), so after a merge the
 * survivor may hold two live records the partial unique indexes would never have let one person
 * hold: two active enrollments with one equivalence key, two live entries in one waitlist, two
 * live bookings of one session, two scheduled trials of one trial offering, two live placement
 * requests for one season. Each such pair raises one owned exception for program management
 * (`enrollment.merged_duplicate_entitlement`, deduplicated by the merge and the pair) with both
 * record ids; nothing is canceled or rewritten automatically — which one stays is a person's
 * decision (refund or credit consequences are finance's, DEC-009). The customer lists already
 * read through personIdsResolvingTo, so the survivor sees both. Makeup and package entitlements
 * carry no uniqueness rule (several are legitimate) and are not paired.
 */
@Injectable()
export class MergeFollowUp {
  private readonly queries: readonly LiveRecordQuery[] = [
    {
      type: 'enrollment',
      rows: async (trx, organizationId, personId) =>
        (
          await trx
            .selectFrom('enrollments')
            .select(['id', 'equivalence_key'])
            .where('organization_id', '=', organizationId)
            .where('participant_person_id', '=', personId)
            .where('status', 'in', ['pending', 'confirmed'])
            .where('equivalence_key', 'is not', null)
            .orderBy('id')
            .execute()
        ).map((r) => ({ id: r.id, key: r.equivalence_key as string })),
    },
    {
      type: 'waitlist_entry',
      rows: async (trx, organizationId, personId) =>
        (
          await trx
            .selectFrom('waitlist_entries')
            .select(['id', 'pool_id'])
            .where('organization_id', '=', organizationId)
            .where('participant_person_id', '=', personId)
            .where('status', 'in', ['waiting', 'offered'])
            .orderBy('id')
            .execute()
        ).map((r) => ({ id: r.id, key: r.pool_id })),
    },
    {
      type: 'session_booking',
      rows: async (trx, organizationId, personId) =>
        (
          await trx
            .selectFrom('session_bookings')
            .select(['id', 'session_id'])
            .where('organization_id', '=', organizationId)
            .where('participant_person_id', '=', personId)
            .where('status', 'in', ['pending', 'confirmed'])
            .orderBy('id')
            .execute()
        ).map((r) => ({ id: r.id, key: r.session_id })),
    },
    {
      type: 'trial_participation',
      rows: async (trx, organizationId, personId) =>
        (
          await trx
            .selectFrom('trial_participations')
            .select(['id', 'offering_id'])
            .where('organization_id', '=', organizationId)
            .where('participant_person_id', '=', personId)
            .where('status', '=', 'scheduled')
            .orderBy('id')
            .execute()
        ).map((r) => ({ id: r.id, key: r.offering_id })),
    },
    {
      type: 'placement_request',
      rows: async (trx, organizationId, personId) =>
        (
          await trx
            .selectFrom('placement_requests')
            .select(['id', 'season_id'])
            .where('organization_id', '=', organizationId)
            .where('participant_person_id', '=', personId)
            .where('status', 'in', ['unassigned', 'proposed', 'assigned'])
            .orderBy('id')
            .execute()
        ).map((r) => ({ id: r.id, key: r.season_id })),
    },
  ];

  constructor(private readonly exceptions: OperationalExceptions) {}

  /** Handler body of `enrollment.follow_person_merge`; idempotent by merge (dedupe keys). */
  async onPersonsMerged(
    trx: Trx,
    organizationId: string,
    merge: { mergeId: string; survivorPersonId: string; mergedPersonId: string },
  ): Promise<number> {
    let raised = 0;
    for (const query of this.queries) {
      const survivor = await query.rows(trx, organizationId, merge.survivorPersonId);
      const merged = await query.rows(trx, organizationId, merge.mergedPersonId);
      for (const kept of survivor) {
        for (const duplicate of merged.filter((m) => m.key === kept.key)) {
          const outcome = await this.exceptions.raise(trx, {
            organizationId,
            category: 'enrollment.merged_duplicate_entitlement',
            severity: 'warning',
            title: `Merged person holds two equivalent ${query.type.replaceAll('_', ' ')}s`,
            affectedType: query.type,
            affectedId: kept.id,
            ownerQueue: 'program_manager',
            dedupeKey: `merged_duplicate:${merge.mergeId}:${kept.id}:${duplicate.id}`,
            details: {
              mergeId: merge.mergeId,
              survivorPersonId: merge.survivorPersonId,
              mergedPersonId: merge.mergedPersonId,
              recordType: query.type,
              survivorRecordId: kept.id,
              mergedRecordId: duplicate.id,
            },
          });
          if (!outcome.deduplicated) raised += 1;
        }
      }
    }
    return raised;
  }
}
