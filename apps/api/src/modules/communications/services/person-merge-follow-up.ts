import { Inject, Injectable } from '@nestjs/common';
import { systemPrincipal, type DomainEvent, type EventPayload } from '@sportspark/contracts';
import { json } from '@sportspark/db';
import { AuditWriter, CLOCK, OperationalExceptions, type Clock, type Trx } from '../../../kernel';
import {
  PERSON_DIRECTORY_PORT,
  type IdentityEvents,
  type PersonDirectoryPort,
} from '../../identity';
import { isLockedPreference } from '../communications.policy';

type PersonsMergedPayload = EventPayload<typeof IdentityEvents.personsMerged>;

/** The exception a merge with disagreeing explicit preferences raises (support queue). */
export const MERGED_PREFERENCE_CONFLICT = 'communications.merged_preference_conflict';

export interface PreferenceConflict {
  channel: string;
  category: string;
  /** The explicit choices found, survivor's first when present. */
  values: Array<{ personId: string; enabled: boolean }>;
  /** What applies until the person chooses again: the most protective choice. */
  resolved: false;
}

/**
 * `communications.follow_person_merge` on `identity.persons_merged` (COM-05; SPK-IAM-007,
 * SPK-COMMS-003, SPK-COMMS-007, §4.2, IF-21). Rewrites nothing: the survivor's inbox and preference
 * reads already include the merged person's rows (personIdsResolvingTo). The handler records the
 * merge once per merge id with the survivor's stored preference revisions (so a later choice of
 * the survivor's own wins), and when the two persons' explicit choices for one category and
 * channel disagree it raises one `communications.merged_preference_conflict` exception for
 * support: the most protective choice (opted out) applies meanwhile, and the mandatory in-app
 * notice is never in conflict. Queued attempts keep their dispatch and hand-off re-checks;
 * account-bound push devices and calendar feeds follow `identity.account_relinked` (COM-01). A
 * replayed event finds its record and does nothing.
 */
@Injectable()
export class PersonMergeFollowUp {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PERSON_DIRECTORY_PORT) private readonly persons: PersonDirectoryPort,
    private readonly audit: AuditWriter,
    private readonly exceptions: OperationalExceptions,
  ) {}

  async onPersonsMerged(
    trx: Trx,
    event: DomainEvent<PersonsMergedPayload>,
  ): Promise<{ followed: boolean; conflicts: number }> {
    const organizationId = event.organizationId;
    const { mergeId, survivorPersonId, mergedPersonId } = event.payload;
    const already = await trx
      .selectFrom('communication_merge_follow_ups')
      .select('merge_id')
      .where('organization_id', '=', organizationId)
      .where('merge_id', '=', mergeId)
      .executeTakeFirst();
    if (already) return { followed: false, conflicts: 0 };
    // Everyone whose rows the survivor now reads: the survivor, the merged person and anyone
    // merged into either before (identity's merge chain).
    const resolving = await this.persons.personIdsResolvingTo(
      organizationId,
      survivorPersonId,
      trx,
    );
    const ids = [...new Set([survivorPersonId, mergedPersonId, ...resolving])];
    const rows = await trx
      .selectFrom('communication_preferences')
      .select(['person_id', 'channel', 'category', 'enabled', 'revision'])
      .where('organization_id', '=', organizationId)
      .where('person_id', 'in', ids)
      .orderBy('category')
      .orderBy('channel')
      .orderBy('person_id')
      .execute();
    const conflicts: PreferenceConflict[] = [];
    const keys = [...new Set(rows.map((r) => `${r.category}.${r.channel}`))].sort();
    for (const k of keys) {
      const forKey = rows.filter((r) => `${r.category}.${r.channel}` === k);
      const first = forKey[0];
      if (!first || isLockedPreference(first.category, first.channel)) continue;
      if (new Set(forKey.map((r) => r.enabled)).size < 2) continue;
      conflicts.push({
        channel: first.channel,
        category: first.category,
        values: [...forKey]
          .sort((a, b) =>
            a.person_id === survivorPersonId ? -1 : b.person_id === survivorPersonId ? 1 : 0,
          )
          .map((r) => ({ personId: r.person_id, enabled: r.enabled })),
        resolved: false,
      });
    }
    const inserted = await trx
      .insertInto('communication_merge_follow_ups')
      .values({
        organization_id: organizationId,
        merge_id: mergeId,
        survivor_person_id: survivorPersonId,
        merged_person_id: mergedPersonId,
        survivor_preferences: json(
          rows
            .filter((r) => r.person_id === survivorPersonId)
            .map((r) => ({ channel: r.channel, category: r.category, revision: r.revision })),
        ),
        conflicts: json(conflicts as unknown as Array<Record<string, unknown>>),
        followed_at: this.clock.now(),
      })
      .onConflict((oc) => oc.columns(['organization_id', 'merge_id']).doNothing())
      .returning('merge_id')
      .executeTakeFirst();
    if (!inserted) return { followed: false, conflicts: 0 };
    const actor = systemPrincipal(organizationId, 'communications.follow_person_merge');
    await this.audit.record(trx, {
      organizationId,
      actor,
      action: 'communications.follow_person_merge',
      targetType: 'person',
      targetId: survivorPersonId,
      correlationId: event.correlationId,
      details: {
        mergeId,
        mergedPersonId,
        conflicts: conflicts.map((c) => `${c.category}.${c.channel}`),
      },
    });
    if (conflicts.length > 0) {
      await this.exceptions.raise(trx, {
        organizationId,
        facilityId: null,
        category: MERGED_PREFERENCE_CONFLICT,
        severity: 'warning',
        title: `Merged person has ${conflicts.length} conflicting communication preference(s); the most protective choice applies`,
        affectedType: 'person',
        affectedId: survivorPersonId,
        ownerQueue: 'support_operator',
        dedupeKey: `communications:merged_preference_conflict:${mergeId}`,
        details: {
          mergeId,
          survivorPersonId,
          mergedPersonId,
          conflicts: conflicts.map((c) => ({ channel: c.channel, category: c.category })),
        },
      });
    }
    return { followed: true, conflicts: conflicts.length };
  }
}
