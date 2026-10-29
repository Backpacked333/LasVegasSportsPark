import { Inject, Injectable } from '@nestjs/common';
import type { DomainEvent, EventPayload } from '@sportspark/contracts';
import { OperationalExceptions, type Trx } from '../../../kernel';
import type { CatalogEvents } from '../../catalog';
import {
  PERSON_DIRECTORY_PORT,
  type IdentityEvents,
  type PersonDirectoryPort,
} from '../../identity';
import type { EventChanged } from '../../scheduling';
import { ENTRY_POLICY, type EntryPolicy } from '../entry.policy';
import { CheckinsService } from './checkins.service';

/** ENT-04: the person-merge follow-up exception (front desk; no pass is revoked automatically). */
export const MERGED_DUPLICATE_PASS = 'entry.merged_duplicate_pass';

type SessionCanceled = EventPayload<typeof CatalogEvents.sessionCanceled>;
type EventChangedPayload = EventPayload<typeof EventChanged>;
type PersonsMerged = EventPayload<typeof IdentityEvents.personsMerged>;

/**
 * Entry's reactions to other modules' facts (§4.12: idempotent under replay, every write through
 * the handler's transaction). Entry never writes another module's records (§4.2); it only changes
 * its own check-ins and raises its own exceptions.
 */
@Injectable()
export class EntryFollowUps {
  constructor(
    @Inject(ENTRY_POLICY) private readonly policy: EntryPolicy,
    @Inject(PERSON_DIRECTORY_PORT) private readonly people: PersonDirectoryPort,
    private readonly checkins: CheckinsService,
    private readonly exceptions: OperationalExceptions,
  ) {}

  /** ENT-03 `entry.withdraw_on_session_canceled` (catalog.session_canceled, SPK-AT-009). */
  async sessionCanceled(trx: Trx, event: DomainEvent<SessionCanceled>): Promise<void> {
    await this.checkins.withdrawForCanceledActivity(
      trx,
      event.organizationId,
      'session',
      event.payload.sessionId,
      'entry.withdraw_on_session_canceled',
      event.correlationId ?? null,
    );
  }

  /** ENT-03 `entry.withdraw_on_event_canceled` (scheduling.event_changed with change `canceled`). */
  async eventChanged(trx: Trx, event: DomainEvent<EventChangedPayload>): Promise<void> {
    if (event.payload.change !== 'canceled') return;
    await this.checkins.withdrawForCanceledActivity(
      trx,
      event.organizationId,
      'event',
      event.payload.eventId,
      'entry.withdraw_on_event_canceled',
      event.correlationId ?? null,
    );
  }

  /**
   * ENT-04 `entry.follow_person_merge` (identity.persons_merged, SPK-IAM-007, SPK-ENTRY-002). Pass
   * rows keep their original holder (passes are entry's records, never rewritten). When the
   * survivor and the merged person each still hold an active person pass, the front desk is asked
   * once per merge to keep one and revoke the other; nothing is revoked automatically (the holder
   * may be carrying either). Idempotent by mergeId: an exception already raised for the merge, in
   * any state, is never raised again.
   */
  async personsMerged(trx: Trx, event: DomainEvent<PersonsMerged>): Promise<void> {
    const { mergeId, survivorPersonId, mergedPersonId } = event.payload;
    const organizationId = event.organizationId;
    const active = await trx
      .selectFrom('passes')
      .select(['id', 'holder_person_id'])
      .where('organization_id', '=', organizationId)
      .where('holder_kind', '=', 'person')
      .where('status', '=', 'active')
      .where('holder_person_id', 'in', [survivorPersonId, mergedPersonId])
      .orderBy('issued_at')
      .orderBy('id')
      .execute();
    const survivorPasses = active.filter((p) => p.holder_person_id === survivorPersonId);
    const mergedPasses = active.filter((p) => p.holder_person_id === mergedPersonId);
    if (survivorPasses.length === 0 || mergedPasses.length === 0) return;
    const earlier = await this.exceptions.list(
      organizationId,
      { category: MERGED_DUPLICATE_PASS, affectedType: 'person_merge', affectedId: mergeId },
      trx,
    );
    if (earlier.items.length > 0) return;
    // The survivor must still be known (a later merge may have moved it on): name the canonical one.
    const canonical = await this.people.resolveCanonicalPersonId(
      organizationId,
      survivorPersonId,
      trx,
    );
    await this.exceptions.raise(trx, {
      organizationId,
      category: MERGED_DUPLICATE_PASS,
      severity: 'warning',
      title: 'Merged people each hold an active pass; keep one and revoke the other',
      affectedType: 'person_merge',
      affectedId: mergeId,
      ownerQueue: this.policy.facilityOperationsQueue,
      dedupeKey: `${MERGED_DUPLICATE_PASS}:${mergeId}`,
      details: {
        mergeId,
        survivorPersonId: canonical,
        mergedPersonId,
        passIds: active.map((p) => p.id),
        nextAction: 'revoke_the_pass_the_person_no_longer_carries',
      },
    });
  }
}
