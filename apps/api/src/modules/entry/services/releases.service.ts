import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  type CollectorCheck,
  type CollectorCheckBody,
  type CollectorRestriction,
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
  audienceOf,
  hashPassReference,
  organizationOf,
  toCustomerRelease,
  toDeparture,
  toRelease,
  type DepartureRow,
  type ReleaseRow,
} from '../entry.shared';
import { ActivityResolver, type ResolvedActivity } from './activity-resolver';
import { ArrivalChecks } from './arrival-checks';
import { StaffScope } from './staff-scope';
import { lockEntrySubjects, presenceLockKey } from './subject-locks';
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
  /** ENT-02: the grant a verified online check relied on (IF-46); null otherwise. */
  authorityGrantId?: string | null;
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
    private readonly checks: ArrivalChecks,
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
    let authority: 'desk' | 'assigned' = 'desk';
    if (activity) {
      authority = await this.scope.requireForActivity(
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
      // SPK-ENTRY-007 / §4.14: an assigned coach releases only a child taking part in their
      // activity. Checked before anything about the child or the collector is evaluated, so the
      // command reveals nothing (kind, permissions) about anyone else's child (§4.10).
      if (authority === 'assigned' && activity) {
        if (!(await this.takesPart(trx, organizationId, body.childPersonId, activity))) {
          throw errors.protectedNotFound('person');
        }
      }
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
      // ENT-02, IF-46: the grant behind `collect` right now, under the same effectivity rule; a
      // release is verified only when that grant exists, and it is recorded as the evidence.
      const grant =
        collectorPersonId !== null && permissions.includes('collect')
          ? await this.authority.effectiveGrant(
              organizationId,
              collectorPersonId,
              body.childPersonId,
              'collect',
              now,
              trx,
            )
          : null;
      const verified = grant !== null;
      if (!verified && permissions.includes('collect')) {
        // Authority changed between the two reads: never assert it (SPK-ENTRY-007).
        permissions.splice(permissions.indexOf('collect'), 1);
      }
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
          authorityGrantId: grant?.grantId ?? null,
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
      const recorded = toRelease(release);
      // §4.14 least privilege: the assigned coach learns only whether pickup authority is held,
      // never which other permissions an adult holds over the child. The stored record keeps the
      // full evidence for pickup staff (GET /v1/releases/{id}).
      const response =
        authority === 'assigned'
          ? {
              ...recorded,
              authorityGrantId: null,
              collectorPermissions: recorded.collectorPermissions.filter((p) => p === 'collect'),
              denialReason: release.denial_reason ? denialReasonFor(collectorPersonId, []) : null,
            }
          : recorded;
      return { release: response, departure: departure ? toDeparture(departure) : null };
    });
  }

  /**
   * POST /v1/releases/collector-checks (ENT-02, SPK-ENTRY-007, SPK-ENTRY-003, SPK-COND-004,
   * SCR-W-09). Before a supervised release, the assigned coach (entry.record_assigned_release with
   * an accepted assignment, StaffScope) or the pickup desk (entry.record_release) identifies the
   * collecting adult by their pass. Read-only and not idempotent: nothing is recorded, not even an
   * audit row, and POST /v1/releases re-checks authority when the release is recorded.
   *
   * The collector is named only when the pass is active, its holder (a person, resolved through
   * merges) holds `collect` over the participant now (AUTHORITY_LOOKUP_PORT) and the participant
   * takes part in the activity. Every other case answers the same `mayCollect: false` with no
   * collector: an unknown or revoked pass, a household pass, a holder without `collect`, a
   * participant outside the activity. Holding a pass, or having been let in by a device, never
   * establishes pickup authority (SPK-COND-004).
   */
  async collectorCheck(principal: Principal, body: CollectorCheckBody): Promise<CollectorCheck> {
    const organizationId = organizationOf(principal);
    const activity = await this.resolver.resolve(organizationId, body.activity);
    await this.scope.requireForActivity(
      principal,
      EntryActions.recordRelease,
      EntryActions.recordAssignedRelease,
      activity,
    );
    const checkedAt = this.clock.now();
    return this.uow.run(async ({ trx }) => {
      const restrictions: CollectorRestriction[] = [
        {
          code: 'authority_rechecked_at_release',
          message: 'Pickup authority is checked again when the release is recorded.',
        },
      ];
      const nobody: CollectorCheck = {
        mayCollect: false,
        collector: null,
        checkedAt: checkedAt.toISOString(),
        restrictions,
      };
      const participant = await this.people.findPerson(
        organizationId,
        body.participantPersonId,
        trx,
      );
      if (!participant || participant.status !== 'active') return nobody;
      if (!(await this.takesPart(trx, organizationId, participant.id, activity))) return nobody;
      // The participant is on the activity the caller may release from: its facts are theirs.
      if (participant.kind !== 'child') {
        restrictions.push({
          code: 'not_a_child',
          message: 'Supervised release applies to a child; this participant is not one.',
        });
      }
      const visit = await this.visits.openVisit(
        trx,
        organizationId,
        activity.facilityId,
        participant.id,
      );
      if (!visit) {
        restrictions.push({
          code: 'participant_not_on_site',
          message: 'No open arrival is recorded for this participant at the facility.',
        });
      }
      const pass = await trx
        .selectFrom('passes')
        .select(['status', 'holder_kind', 'holder_person_id'])
        .where('organization_id', '=', organizationId)
        .where('reference_hash', '=', hashPassReference(body.passReference))
        .executeTakeFirst();
      if (!pass || pass.status !== 'active' || !pass.holder_person_id) return nobody;
      const holderId = await this.people.resolveCanonicalPersonId(
        organizationId,
        pass.holder_person_id,
        trx,
      );
      const holder = await this.people.findPerson(organizationId, holderId, trx);
      if (!holder || holder.status !== 'active' || holder.id === participant.id) return nobody;
      const mayCollect = await this.authority.hasPermission(
        organizationId,
        holder.id,
        participant.id,
        'collect',
        trx,
      );
      if (!mayCollect) return nobody;
      const names = await this.people.displayNames(organizationId, [holder.id], trx);
      const name = names.get(holder.id);
      return {
        mayCollect: true,
        collector: { personId: holder.id, displayName: name?.displayName ?? '' },
        checkedAt: checkedAt.toISOString(),
        restrictions,
      };
    });
  }

  /**
   * Protected read: pickup staff, or a holder of `view` over the child; otherwise NOT_FOUND.
   * §4.14 field-level authorization / SPK-IAM-005: only a staff role (or the system) reads the
   * full record; a holder of `view` reads the customer projection (no staff notes, denial
   * details, other adults' permissions, exception or staff identifiers).
   */
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
    const decision = await this.authorization.decide(principal, EntryActions.readRelease, {
      type: 'release_record',
      id,
      organizationId,
      facilityId: row.facility_id,
      subjectPersonIds: [row.child_person_id],
      protected: true,
    });
    if (!decision.allowed) throw errors.protectedNotFound('release');
    return audienceOf(decision.basis) === 'staff' ? toRelease(row) : toCustomerRelease(row);
  }

  // -------------------------------------------------------------------------------------------
  // Shared with offline synchronization
  // -------------------------------------------------------------------------------------------

  /**
   * Whether the child takes part in the activity: a live (held or admitted) check-in into it, or
   * a participation basis (enrollment, session booking, event commitment or roster membership,
   * confirmed or pending). Scopes an assigned coach's releases (SPK-ENTRY-007, §4.14).
   */
  async takesPart(
    trx: Trx,
    organizationId: string,
    childPersonId: string,
    activity: ResolvedActivity,
  ): Promise<boolean> {
    const checkin = await trx
      .selectFrom('session_checkins')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('person_id', '=', childPersonId)
      .where('activity_type', '=', activity.detail.type)
      .where('activity_id', '=', activity.detail.id)
      .where('status', 'in', ['held', 'admitted'])
      .executeTakeFirst();
    if (checkin) return true;
    return (
      (await this.checks.participationBasis(trx, organizationId, childPersonId, activity)) !== null
    );
  }

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

  /**
   * Whether the collector held `collect` over the child at a past instant (the handover time of an
   * offline release, SPK-AT-018): identity's as-of check from the grant, relationship and
   * suspension history. Callers also require it to be held now.
   */
  async heldAt(
    trx: Trx,
    organizationId: string,
    collectorPersonId: string,
    childPersonId: string,
    at: Date,
  ): Promise<boolean> {
    return this.authority.hasPermissionAt(
      organizationId,
      collectorPersonId,
      childPersonId,
      'collect',
      at,
      trx,
    );
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
    // §4.15 / SPK-AT-018: one writer at a time about this child's presence, so the open visit read
    // here, a concurrently synchronized arrival, and a re-sent offline release item all see each
    // other (an offline release item is then a duplicate, never a unique-index failure).
    await lockEntrySubjects(trx, [presenceLockKey(organizationId, facts.childPersonId)]);
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
        authority_grant_id:
          facts.verificationOutcome === 'verified' ? (facts.authorityGrantId ?? null) : null,
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
