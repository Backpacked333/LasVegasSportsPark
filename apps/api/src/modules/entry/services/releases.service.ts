import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  type Principal,
  type RecordedRelease,
  type RecordReleaseBody,
  type ReleaseRecord,
} from '@sportspark/contracts';
import {
  json,
  type GrantPermissionValue,
  type ReleaseOutcomeValue,
  type ReleaseVerificationOutcome,
} from '@sportspark/db';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  GrantPermissions,
  OperationalExceptions,
  Outbox,
  snapshotActor,
  UnitOfWork,
  type Clock,
  type Trx,
} from '../../../kernel';
import {
  AUTHORITY_LOOKUP_PORT,
  PERSON_DIRECTORY_PORT,
  type AuthorityLookupPort,
  type PersonDirectoryPort,
} from '../../identity';
import { EntryActions } from '../entry.actions';
import { EntryEvents } from '../entry.events';
import { ENTRY_POLICY, policyForFacility, type EntryPolicy } from '../entry.policy';
import {
  organizationOf,
  toDeparture,
  toRelease,
  type DepartureRow,
  type ReleaseRow,
} from '../entry.shared';
import { ActivityResolver, type ResolvedActivity } from './activity-resolver';
import { StaffScope } from './staff-scope';
import { VisitsService } from './visits.service';

export interface ReleaseFacts {
  facilityId: string;
  childPersonId: string;
  collectorPersonId: string | null;
  collectorDescription: string | null;
  activity: ResolvedActivity | null;
  verificationMethod: 'online_relationship_check' | 'manual_outage_procedure';
  verificationOutcome: ReleaseVerificationOutcome;
  collectorPermissions: GrantPermissionValue[];
  authorityCheckedAt: Date;
  denialReason: string | null;
  restrictionNotes: string | null;
  escalationNotes: string | null;
  escalationExceptionId: string | null;
  manualProcedureReference: string | null;
  postSyncAuthority: 'held' | 'not_held' | null;
  outcome: ReleaseOutcomeValue;
  decidedAt: Date;
  source: 'online' | 'offline_sync';
  deviceId?: string | null;
  clientObservationId?: string | null;
  syncBatchId?: string | null;
  recordDeparture: boolean;
}

/** Why a collector without `collect` is not released (SPK-ENTRY-007, SPK-AT-016). */
export function denialReasonFor(
  collectorPersonId: string | null,
  permissions: readonly GrantPermissionValue[],
): string {
  if (!collectorPersonId) {
    return 'The collecting person has no verified record, so current pickup authority cannot be established online.';
  }
  const others = permissions.filter((p) => p !== 'collect');
  return others.length > 0
    ? `The collecting person does not hold current pickup (collect) permission for this child. They hold ${others.join(', ')}; schedule visibility and payment permission do not establish pickup authority.`
    : 'The collecting person does not hold current pickup (collect) permission for this child.';
}

/**
 * Supervised release (§4.8 POST /v1/releases, SPK-ENTRY-007, SPK-AT-016, §4.15).
 *
 * Current pickup authority is checked online, inside the command's transaction, at the moment of
 * release, through identity's AUTHORITY_LOOKUP_PORT (`collect` for collector → child: an
 * unrevoked, unsuspended, effective grant on an active relationship). Nothing cached is trusted:
 * not a pass, a roster snapshot, schedule visibility (`view`) or payment permission (`pay`). The
 * permissions the collector does hold are recorded as evidence. Without `collect` the child is
 * not released: the record says denied (or escalated under the procedure, DEC-005) and an
 * operational exception makes sure someone follows up on the child still in care.
 */
@Injectable()
export class ReleasesService {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ENTRY_POLICY) private readonly policy: EntryPolicy,
    @Inject(PERSON_DIRECTORY_PORT) private readonly people: PersonDirectoryPort,
    @Inject(AUTHORITY_LOOKUP_PORT) private readonly authority: AuthorityLookupPort,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly exceptions: OperationalExceptions,
    private readonly resolver: ActivityResolver,
    private readonly scope: StaffScope,
    private readonly visits: VisitsService,
  ) {}

  async record(
    principal: Principal,
    body: RecordReleaseBody,
    correlationId: string | null,
  ): Promise<RecordedRelease> {
    const organizationId = organizationOf(principal);
    const activity = body.activity
      ? await this.resolver.resolve(organizationId, body.activity)
      : null;
    if (activity && activity.facilityId !== body.facilityId) {
      throw errors.validation('The activity does not take place at this facility.', {
        code: 'activity_facility_mismatch',
      });
    }
    if (activity) {
      await this.scope.requireForActivity(
        principal,
        EntryActions.recordRelease,
        EntryActions.recordAssignedRelease,
        activity,
      );
    } else {
      await this.authorization.require(principal, EntryActions.recordRelease, {
        type: 'facility',
        id: body.facilityId,
        organizationId,
        facilityId: body.facilityId,
      });
    }
    return this.uow.run(async ({ trx }) => {
      const facility = await this.resolver.facility(organizationId, body.facilityId, trx);
      const policy = policyForFacility(this.policy, facility.settings);
      await this.requireChild(trx, organizationId, body.childPersonId);
      const collectorPersonId = 'personId' in body.collector ? body.collector.personId : null;
      if (collectorPersonId) {
        const collector = await this.people.findPerson(organizationId, collectorPersonId, trx);
        if (!collector || collector.status !== 'active') {
          throw errors.notFound('person', collectorPersonId);
        }
      }
      const now = this.clock.now();
      const permissions = await this.currentPermissions(
        trx,
        organizationId,
        collectorPersonId,
        body.childPersonId,
      );
      const verified = collectorPersonId !== null && permissions.includes('collect');
      const releaseId = newId();
      let verificationOutcome: ReleaseVerificationOutcome;
      let outcome: ReleaseOutcomeValue;
      let denialReason: string | null = null;
      let exceptionId: string | null = null;
      if (verified) {
        verificationOutcome = 'verified';
        outcome = body.decision === 'release' ? 'released' : 'not_released';
        if (outcome === 'not_released' || body.escalate) {
          exceptionId = await this.raise(trx, organizationId, facility.id, releaseId, policy, {
            category: 'entry.release_withheld',
            severity: 'high',
            title: 'A verified pickup was withheld or escalated by staff',
          });
        }
      } else {
        verificationOutcome =
          body.escalate || policy.escalateDeniedPickups ? 'escalated' : 'denied';
        outcome = 'not_released';
        denialReason = denialReasonFor(collectorPersonId, permissions);
        exceptionId = await this.raise(trx, organizationId, facility.id, releaseId, policy, {
          category:
            verificationOutcome === 'escalated' ? 'entry.pickup_escalated' : 'entry.pickup_denied',
          severity: verificationOutcome === 'escalated' ? 'high' : 'warning',
          title:
            verificationOutcome === 'escalated'
              ? 'Pickup escalated: the collector has no current pickup authority'
              : 'Pickup denied: the child remains in care',
        });
      }
      const { release, departure } = await this.persist(
        trx,
        principal,
        organizationId,
        releaseId,
        {
          facilityId: facility.id,
          childPersonId: body.childPersonId,
          collectorPersonId,
          collectorDescription: 'description' in body.collector ? body.collector.description : null,
          activity,
          verificationMethod: 'online_relationship_check',
          verificationOutcome,
          collectorPermissions: permissions,
          authorityCheckedAt: now,
          denialReason,
          restrictionNotes: body.restrictionNotes ?? null,
          escalationNotes: body.escalationNotes ?? null,
          escalationExceptionId: exceptionId,
          manualProcedureReference: null,
          postSyncAuthority: null,
          outcome,
          decidedAt: now,
          source: 'online',
          recordDeparture: body.recordDeparture,
        },
        correlationId,
        body.reason ?? null,
      );
      return { release: toRelease(release), departure: departure ? toDeparture(departure) : null };
    });
  }

  /** Protected read: pickup staff, or a holder of `view` over the child; otherwise NOT_FOUND. */
  async get(principal: Principal, id: string): Promise<ReleaseRecord> {
    const organizationId = organizationOf(principal);
    const row = await this.uow
      .reader()
      .selectFrom('release_records')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw errors.protectedNotFound('release');
    await this.authorization.require(principal, EntryActions.readRelease, {
      type: 'release_record',
      id,
      organizationId,
      facilityId: row.facility_id,
      subjectPersonIds: [row.child_person_id],
      protected: true,
    });
    return toRelease(row);
  }

  // -------------------------------------------------------------------------------------------
  // Shared with offline synchronization
  // -------------------------------------------------------------------------------------------

  async requireChild(trx: Trx, organizationId: string, childPersonId: string): Promise<void> {
    const child = await this.people.findPerson(organizationId, childPersonId, trx);
    if (!child || child.status !== 'active') throw errors.notFound('person', childPersonId);
    if (child.kind !== 'child') {
      throw errors.validation('Supervised release applies to a child.', { code: 'not_a_child' });
    }
  }

  /** Every permission the collector holds over the child right now (the online check). */
  async currentPermissions(
    trx: Trx,
    organizationId: string,
    collectorPersonId: string | null,
    childPersonId: string,
  ): Promise<GrantPermissionValue[]> {
    if (!collectorPersonId) return [];
    const held: GrantPermissionValue[] = [];
    for (const permission of GrantPermissions) {
      if (
        await this.authority.hasPermission(
          organizationId,
          collectorPersonId,
          childPersonId,
          permission,
          trx,
        )
      ) {
        held.push(permission);
      }
    }
    return held;
  }

  async raise(
    trx: Trx,
    organizationId: string,
    facilityId: string,
    releaseId: string,
    policy: EntryPolicy,
    input: { category: string; severity: 'warning' | 'high' | 'critical'; title: string },
  ): Promise<string> {
    const raised = await this.exceptions.raise(trx, {
      organizationId,
      facilityId,
      category: input.category,
      severity: input.severity,
      title: input.title,
      affectedType: 'release_record',
      affectedId: releaseId,
      ownerQueue: policy.pickupEscalationQueue,
      dedupeKey: `${input.category}:${releaseId}`,
      details: { releaseId, nextAction: 'follow_the_pickup_procedure' },
    });
    return raised.id;
  }

  /** Writes the release, then (when released) the departure of the child's open visit. */
  async persist(
    trx: Trx,
    principal: Principal,
    organizationId: string,
    releaseId: string,
    facts: ReleaseFacts,
    correlationId: string | null,
    reason: string | null,
  ): Promise<{ release: ReleaseRow; departure: DepartureRow | null }> {
    const visit = await this.visits.openVisit(
      trx,
      organizationId,
      facts.facilityId,
      facts.childPersonId,
    );
    const activity = facts.activity;
    const release = await trx
      .insertInto('release_records')
      .values({
        id: releaseId,
        organization_id: organizationId,
        facility_id: facts.facilityId,
        child_person_id: facts.childPersonId,
        collector_person_id: facts.collectorPersonId,
        collector_description: facts.collectorDescription,
        activity_type: activity?.detail.type ?? null,
        activity_id: activity?.detail.id ?? null,
        offering_id: activity?.offeringId ?? null,
        offering_session_id: activity?.detail.type === 'session' ? activity.detail.id : null,
        scheduling_event_id: activity?.schedulingEventId ?? null,
        visit_id: visit?.id ?? null,
        verification_method: facts.verificationMethod,
        verification_outcome: facts.verificationOutcome,
        authority_basis:
          facts.verificationOutcome === 'verified' ? 'relationship_permission:collect' : null,
        authority_checked_at: facts.authorityCheckedAt,
        collector_permissions: facts.collectorPermissions,
        denial_reason: facts.denialReason,
        restriction_notes: facts.restrictionNotes,
        escalation_notes: facts.escalationNotes,
        escalation_exception_id: facts.escalationExceptionId,
        manual_procedure_reference: facts.manualProcedureReference,
        post_sync_authority: facts.postSyncAuthority,
        outcome: facts.outcome,
        decided_at: facts.decidedAt,
        released_at: facts.outcome === 'released' ? facts.decidedAt : null,
        staff_actor: json(snapshotActor(principal)),
        staff_person_id: principal.personId,
        source: facts.source,
        device_id: facts.deviceId ?? null,
        client_observation_id: facts.clientObservationId ?? null,
        sync_batch_id: facts.syncBatchId ?? null,
        received_at: this.clock.now(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.audit.record(trx, {
      organizationId,
      actor: principal,
      action: EntryActions.recordRelease.id,
      targetType: 'release_record',
      targetId: release.id,
      afterRevision: 1,
      reason,
      correlationId,
      details: {
        verificationMethod: release.verification_method,
        verificationOutcome: release.verification_outcome,
        outcome: release.outcome,
        source: release.source,
        postSyncAuthority: release.post_sync_authority,
      },
    });
    await this.outbox.enqueue(trx, EntryEvents.releaseRecorded, {
      organizationId,
      aggregateType: 'release_record',
      aggregateId: release.id,
      payload: {
        releaseId: release.id,
        facilityId: release.facility_id,
        childPersonId: release.child_person_id,
        verificationOutcome: release.verification_outcome,
        outcome: release.outcome,
        source: release.source,
      },
      correlationId,
    });
    let departure: DepartureRow | null = null;
    if (release.outcome === 'released' && facts.recordDeparture && visit) {
      departure = await this.visits.recordDeparture(
        trx,
        principal,
        organizationId,
        {
          visit,
          departedAt: facts.decidedAt,
          source: 'release',
          releaseRecordId: release.id,
        },
        correlationId,
      );
    }
    return { release, departure };
  }
}
