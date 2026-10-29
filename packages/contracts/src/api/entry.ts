import { z } from '../zod';
import { Revision, withCommandMeta } from '../commands';
import { ErrorResponseSchema, openApiRegistry } from '../openapi';
import { PageRequestSchema, pageSchema } from '../pagination';
import { Instant } from '../time';
import { ActorSnapshotSchema } from './facilities';

/**
 * Entry API contract (specification §3.14 SPK-ENTRY-001..008, §4.4 Arrival, §4.5 "Attendance must
 * preserve observations and corrections", §4.8 `POST /v1/attendance-observations` and
 * `POST /v1/releases`, §4.15 offline behaviour, SPK-COND-004, SPK-AT-015/016/018).
 *
 * Facility arrival (visits), session check-in, observed attendance, departure and supervised
 * release are separate records (SPK-ENTRY-001). Organization scope always comes from the
 * principal; every id in a body is resolved inside that organization.
 */

const Reason = z.string().trim().min(1).max(2000);
const Note = z.string().trim().min(1).max(2000);
const DeviceId = z.string().trim().min(1).max(200);
const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a YYYY-MM-DD date');

// ---------------------------------------------------------------------------------------------
// Shared vocabularies (mirrored by the check constraints in migration 0800)
// ---------------------------------------------------------------------------------------------

/** SPK-ENTRY-006 visitor categories; `unclassified` is only used for hardware events (SPK-COND-004). */
export const VisitorCategorySchema = z
  .enum(['participant', 'guardian', 'spectator', 'staff', 'contractor', 'unclassified'])
  .openapi('VisitorCategory');
export type VisitorCategory = z.infer<typeof VisitorCategorySchema>;

export const ObservedStateSchema = z
  .enum(['present', 'absent', 'late', 'left_early'])
  .openapi('ObservedState');
export type ObservedState = z.infer<typeof ObservedStateSchema>;

/** The activity a check-in, observation or release concerns: a catalog session or a scheduling event. */
export const ActivityRefSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('session'), offeringId: z.uuid(), sessionId: z.uuid() }),
    z.object({ type: z.literal('event'), eventId: z.uuid() }),
  ])
  .openapi('ActivityRef');
export type ActivityRef = z.infer<typeof ActivityRefSchema>;

/** The resolved activity as stored on entry records. */
export const ActivityDetailSchema = z
  .object({
    type: z.enum(['session', 'event']),
    id: z.uuid(),
    offeringId: z.uuid().nullable(),
    sessionId: z.uuid().nullable(),
    eventId: z.uuid().nullable(),
  })
  .openapi('ActivityDetail');
export type ActivityDetail = z.infer<typeof ActivityDetailSchema>;

/** SPK-ENTRY-004: every arrival check is an actionable issue with a next permitted action. */
export const ArrivalIssueCodeSchema = z
  .enum([
    'no_participation',
    'enrollment_not_confirmed',
    'missing_acknowledgment',
    'outstanding_balance',
    'balance_unknown',
    'activity_canceled',
    'activity_ended',
    'not_on_site',
  ])
  .openapi('ArrivalIssueCode');
export type ArrivalIssueCode = z.infer<typeof ArrivalIssueCodeSchema>;

export const ArrivalIssueSchema = z
  .object({
    code: ArrivalIssueCodeSchema,
    severity: z.enum(['blocking', 'warning', 'info']),
    message: z.string(),
    nextAction: z.string(),
    reference: z.object({ type: z.string(), id: z.string() }).nullable(),
  })
  .openapi('ArrivalIssue');
export type ArrivalIssue = z.infer<typeof ArrivalIssueSchema>;

// ---------------------------------------------------------------------------------------------
// Passes (SPK-ENTRY-002, SPK-ENTRY-003)
// ---------------------------------------------------------------------------------------------

export const PassHolderSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('person'), personId: z.uuid() }),
    z.object({ kind: z.literal('household'), householdId: z.uuid() }),
  ])
  .openapi('PassHolder');
export type PassHolder = z.infer<typeof PassHolderSchema>;

export const PassSchema = z
  .object({
    id: z.uuid(),
    holderKind: z.enum(['person', 'household']),
    holderPersonId: z.uuid().nullable(),
    holderHouseholdId: z.uuid().nullable(),
    status: z.enum(['active', 'revoked']),
    issuedAt: Instant,
    revokedAt: Instant.nullable(),
    revokedReason: z.string().nullable(),
    revision: Revision,
  })
  .openapi('Pass');
export type Pass = z.infer<typeof PassSchema>;

/**
 * A pass as its holder reads it (ENT-01, SPK-ENTRY-002, SCR-C-05, §4.14): the state and the dates,
 * never the reference. Only the reference's hash is stored, so it cannot be shown again
 * (`referenceAvailable` is always false): a holder who lost it revokes the pass and issues a new
 * one. The staff revocation reason is withheld from customers (null).
 */
export const MyPassSchema = z
  .object({
    id: z.uuid(),
    holderKind: z.enum(['person', 'household']),
    holderPersonId: z.uuid().nullable(),
    status: z.enum(['active', 'revoked']),
    issuedAt: Instant,
    revokedAt: Instant.nullable(),
    revokedReason: z.string().nullable(),
    referenceAvailable: z.literal(false),
    /** For POST /v1/passes/{id}/revoke (expectedRevision). */
    revision: Revision,
  })
  .openapi('MyPass');
export type MyPass = z.infer<typeof MyPassSchema>;

/** The opaque reference is returned once, at issue; only its hash is stored. */
export const IssuedPassSchema = z
  .object({ pass: PassSchema, reference: z.string() })
  .openapi('IssuedPass');
export type IssuedPass = z.infer<typeof IssuedPassSchema>;

export const IssuePassBody = withCommandMeta({ holder: PassHolderSchema }).openapi(
  'IssuePassRequest',
);
export type IssuePassBody = z.infer<typeof IssuePassBody>;

export const RevokePassBody = withCommandMeta({})
  .extend({ reason: Reason, expectedRevision: Revision })
  .openapi('RevokePassRequest');
export type RevokePassBody = z.infer<typeof RevokePassBody>;

export const ScanPassBody = z
  .object({ reference: z.string().trim().min(16).max(200), facilityId: z.uuid() })
  .openapi('ScanPassRequest');
export type ScanPassBody = z.infer<typeof ScanPassBody>;

export const ScanActivitySchema = z
  .object({
    activity: ActivityDetailSchema,
    title: z.string(),
    scheduledStart: Instant,
    scheduledEnd: Instant,
    basis: z.object({
      kind: z.enum(['enrollment', 'session_booking']),
      id: z.uuid(),
      status: z.string(),
    }),
    /** The live check-in, with its revision so a held one can be re-checked directly (ENT-01). */
    checkin: z
      .object({ id: z.uuid(), status: z.enum(['held', 'admitted']), revision: Revision })
      .nullable(),
  })
  .openapi('ScanActivity');
export type ScanActivity = z.infer<typeof ScanActivitySchema>;

export const ScanPersonSchema = z
  .object({
    personId: z.uuid(),
    givenName: z.string(),
    familyName: z.string(),
    kind: z.enum(['adult', 'child']),
    relation: z.enum(['holder', 'household_member', 'dependent']),
    onSite: z.boolean(),
    visitId: z.uuid().nullable(),
    /** For a person pass: whether the holder currently holds `collect` over this person (informational; release re-checks). */
    holderMayCollect: z.boolean().nullable(),
    activities: z.array(ScanActivitySchema),
  })
  .openapi('ScanPerson');
export type ScanPerson = z.infer<typeof ScanPersonSchema>;

/** SPK-ENTRY-003: a scan opens the selection flow and records nobody as present. */
export const PassScanSchema = z
  .object({
    pass: z.object({ id: z.uuid(), holderKind: z.enum(['person', 'household']) }),
    facilityId: z.uuid(),
    scannedAt: Instant,
    window: z.object({ start: Instant, end: Instant }),
    people: z.array(ScanPersonSchema),
    recorded: z.literal('nothing'),
    nextAction: z.string(),
  })
  .openapi('PassScan');
export type PassScan = z.infer<typeof PassScanSchema>;

// ---------------------------------------------------------------------------------------------
// Visits: facility arrival (SPK-ENTRY-001, SPK-ENTRY-006)
// ---------------------------------------------------------------------------------------------

export const ArrivalInputSchema = z
  .object({
    personId: z.uuid().optional(),
    visitorCategory: VisitorCategorySchema.exclude(['unclassified']),
    visitorDescription: z.string().trim().min(1).max(200).optional(),
    partySize: z.number().int().min(1).max(200).optional(),
  })
  .refine((v) => v.personId !== undefined || v.visitorDescription !== undefined, {
    message: 'name a person or describe the visitor',
    path: ['personId'],
  })
  .refine((v) => v.visitorCategory !== 'participant' || v.personId !== undefined, {
    message: 'a participant must be a registered person (SPK-ENTRY-006)',
    path: ['personId'],
  })
  .refine((v) => v.personId === undefined || (v.partySize ?? 1) === 1, {
    message: 'a named person is a party of one',
    path: ['partySize'],
  })
  .openapi('ArrivalInput');
export type ArrivalInput = z.infer<typeof ArrivalInputSchema>;

export const RecordVisitsBody = withCommandMeta({
  facilityId: z.uuid(),
  passId: z.uuid().optional(),
  arrivals: z.array(ArrivalInputSchema).min(1).max(20),
})
  .refine(
    (v) => {
      const ids = v.arrivals.flatMap((a) => (a.personId ? [a.personId] : []));
      return new Set(ids).size === ids.length;
    },
    { message: 'each person arrives once', path: ['arrivals'] },
  )
  .openapi('RecordVisitsRequest');
export type RecordVisitsBody = z.infer<typeof RecordVisitsBody>;

export const VisitSchema = z
  .object({
    id: z.uuid(),
    facilityId: z.uuid(),
    personId: z.uuid().nullable(),
    visitorDescription: z.string().nullable(),
    partySize: z.number().int(),
    visitorCategory: VisitorCategorySchema,
    arrivedAt: Instant,
    passId: z.uuid().nullable(),
    source: z.enum(['desk', 'offline_sync', 'access_control']),
    /** ENT-05: the registered access device an `access_control` arrival came through, if any. */
    accessDeviceId: z.uuid().nullable(),
    status: z.enum(['on_site', 'departed', 'voided']),
    departedAt: Instant.nullable(),
    voidedAt: Instant.nullable(),
    voidReason: z.string().nullable(),
    recordedBy: ActorSnapshotSchema,
    revision: Revision,
  })
  .openapi('Visit');
export type Visit = z.infer<typeof VisitSchema>;

export const RecordedVisitsSchema = z
  .object({ visits: z.array(VisitSchema) })
  .openapi('RecordedVisits');
export type RecordedVisits = z.infer<typeof RecordedVisitsSchema>;

export const VoidVisitBody = withCommandMeta({})
  .extend({ reason: Reason, expectedRevision: Revision })
  .openapi('VoidVisitRequest');
export type VoidVisitBody = z.infer<typeof VoidVisitBody>;

/**
 * Visits of a facility day (`date`, default today in the facility's zone). With `personId` and no
 * `date`, the person's whole visit history at the facility; a person's visits include those
 * recorded under people merged into them (ENT-04, SPK-IAM-007: rows keep their original person id).
 */
export const ListVisitsQuery = PageRequestSchema.extend({
  facilityId: z.uuid(),
  status: z.enum(['on_site', 'departed', 'voided']).optional(),
  date: DateOnly.optional(),
  personId: z.uuid().optional(),
});
export type ListVisitsQuery = z.infer<typeof ListVisitsQuery>;

// ---------------------------------------------------------------------------------------------
// Session check-ins (SPK-ENTRY-003, SPK-ENTRY-004, SPK-ENTRY-006)
// ---------------------------------------------------------------------------------------------

export const CreateSessionCheckinBody = withCommandMeta({
  personId: z.uuid(),
  activity: ActivityRefSchema,
  visitId: z.uuid().optional(),
}).openapi('CreateSessionCheckinRequest');
export type CreateSessionCheckinBody = z.infer<typeof CreateSessionCheckinBody>;

export const SessionCheckinSchema = z
  .object({
    id: z.uuid(),
    facilityId: z.uuid(),
    visitId: z.uuid().nullable(),
    personId: z.uuid(),
    activity: ActivityDetailSchema,
    activityStart: Instant,
    activityEnd: Instant,
    basis: z
      .object({
        kind: z.enum(['enrollment', 'session_booking', 'event_commitment', 'roster_membership']),
        id: z.uuid().nullable(),
      })
      .nullable(),
    status: z.enum(['held', 'admitted', 'withdrawn']),
    issues: z.array(ArrivalIssueSchema),
    checkedInAt: Instant,
    evaluatedAt: Instant,
    admittedAt: Instant.nullable(),
    withdrawnAt: Instant.nullable(),
    withdrawnReason: z.string().nullable(),
    recordedBy: ActorSnapshotSchema,
    revision: Revision,
  })
  .openapi('SessionCheckin');
export type SessionCheckin = z.infer<typeof SessionCheckinSchema>;

export const RecheckSessionCheckinBody = withCommandMeta({})
  .extend({ expectedRevision: Revision })
  .openapi('RecheckSessionCheckinRequest');
export type RecheckSessionCheckinBody = z.infer<typeof RecheckSessionCheckinBody>;

export const WithdrawSessionCheckinBody = withCommandMeta({})
  .extend({ reason: Reason, expectedRevision: Revision })
  .openapi('WithdrawSessionCheckinRequest');
export type WithdrawSessionCheckinBody = z.infer<typeof WithdrawSessionCheckinBody>;

// ---------------------------------------------------------------------------------------------
// Attendance observations (§4.8, SPK-ENTRY-005, §4.5)
// ---------------------------------------------------------------------------------------------

export const RecordAttendanceObservationBody = withCommandMeta({
  personId: z.uuid(),
  activity: ActivityRefSchema,
  observedState: ObservedStateSchema,
  observedAt: Instant.optional(),
  clientObservationId: z.uuid().optional(),
  deviceId: DeviceId.optional(),
})
  .refine((v) => (v.clientObservationId === undefined) === (v.deviceId === undefined), {
    message: 'clientObservationId and deviceId go together',
    path: ['deviceId'],
  })
  .openapi('RecordAttendanceObservationRequest');
export type RecordAttendanceObservationBody = z.infer<typeof RecordAttendanceObservationBody>;

export const AttendanceObservationSchema = z
  .object({
    id: z.uuid(),
    facilityId: z.uuid(),
    personId: z.uuid(),
    activity: ActivityDetailSchema,
    observedState: ObservedStateSchema,
    observedAt: Instant,
    receivedAt: Instant,
    source: z.enum(['online', 'offline_sync']),
    deviceId: z.string().nullable(),
    clientObservationId: z.uuid().nullable(),
    syncBatchId: z.uuid().nullable(),
    snapshotReference: z.string().nullable(),
    snapshotTakenAt: Instant.nullable(),
    flags: z.array(z.enum(['stale_snapshot', 'conflict'])),
    correctsObservationId: z.uuid().nullable(),
    correctionReason: z.string().nullable(),
    recordedBy: ActorSnapshotSchema,
  })
  .openapi('AttendanceObservation');
export type AttendanceObservation = z.infer<typeof AttendanceObservationSchema>;

export const RecordedObservationSchema = z
  .object({
    observation: AttendanceObservationSchema,
    /** True when the client observation id was already recorded: nothing new was written. */
    duplicate: z.boolean(),
    conflict: z
      .object({ exceptionId: z.uuid(), conflictingObservationIds: z.array(z.uuid()) })
      .nullable(),
  })
  .openapi('RecordedObservation');
export type RecordedObservation = z.infer<typeof RecordedObservationSchema>;

export const CorrectAttendanceObservationBody = withCommandMeta({
  observedState: ObservedStateSchema,
})
  .extend({ reason: Reason })
  .openapi('CorrectAttendanceObservationRequest');
export type CorrectAttendanceObservationBody = z.infer<typeof CorrectAttendanceObservationBody>;

/**
 * Attendance of an activity. With `personId`, that person's attendance, including observations
 * recorded under people merged into them (ENT-04, SPK-IAM-007), summarized under the person asked
 * about; history items keep the person id they were recorded under.
 */
export const AttendanceQuery = z.object({
  activityType: z.enum(['session', 'event']),
  activityId: z.uuid(),
  offeringId: z.uuid().optional(),
  personId: z.uuid().optional(),
});
export type AttendanceQuery = z.infer<typeof AttendanceQuery>;

export const AttendanceHistoryItemSchema = AttendanceObservationSchema.extend({
  correctedByObservationId: z.uuid().nullable(),
}).openapi('AttendanceHistoryItem');
export type AttendanceHistoryItem = z.infer<typeof AttendanceHistoryItemSchema>;

export const PersonAttendanceSchema = z
  .object({
    personId: z.uuid(),
    /**
     * The participant's name (ENT-01, SPK-UX-002, SPK-UX-007), read from identity after the
     * attendance read is authorized; null only when identity no longer knows the person.
     */
    givenName: z.string().nullable(),
    familyName: z.string().nullable(),
    displayName: z.string().nullable(),
    /** The single current state, or null when nothing is recorded or the current heads conflict. */
    effectiveState: ObservedStateSchema.nullable(),
    status: z.enum(['recorded', 'conflict']),
    currentObservationIds: z.array(z.uuid()),
    history: z.array(AttendanceHistoryItemSchema),
  })
  .openapi('PersonAttendance');
export type PersonAttendance = z.infer<typeof PersonAttendanceSchema>;

export const ActivityAttendanceSchema = z
  .object({ activity: ActivityDetailSchema, people: z.array(PersonAttendanceSchema) })
  .openapi('ActivityAttendance');
export type ActivityAttendance = z.infer<typeof ActivityAttendanceSchema>;

// ---------------------------------------------------------------------------------------------
// Departures (SPK-ENTRY-001, SPK-ENTRY-008)
// ---------------------------------------------------------------------------------------------

export const RecordDepartureBody = withCommandMeta({
  visitId: z.uuid().optional(),
  facilityId: z.uuid().optional(),
  personId: z.uuid().optional(),
})
  .refine(
    (v) => v.visitId !== undefined || (v.facilityId !== undefined && v.personId !== undefined),
    {
      message: 'name the visit, or the facility and the person',
      path: ['visitId'],
    },
  )
  .openapi('RecordDepartureRequest');
export type RecordDepartureBody = z.infer<typeof RecordDepartureBody>;

export const DepartureSchema = z
  .object({
    id: z.uuid(),
    facilityId: z.uuid(),
    visitId: z.uuid(),
    personId: z.uuid().nullable(),
    departedAt: Instant,
    releaseRecordId: z.uuid().nullable(),
    source: z.enum(['desk', 'offline_sync', 'release']),
    recordedBy: ActorSnapshotSchema,
    receivedAt: Instant,
  })
  .openapi('Departure');
export type Departure = z.infer<typeof DepartureSchema>;

// ---------------------------------------------------------------------------------------------
// Supervised release (§4.8 POST /v1/releases, SPK-ENTRY-007, SPK-AT-016)
// ---------------------------------------------------------------------------------------------

export const CollectorSchema = z
  .union([
    z.object({ personId: z.uuid() }).strict(),
    z.object({ description: z.string().trim().min(1).max(200) }).strict(),
  ])
  .openapi('Collector');
export type Collector = z.infer<typeof CollectorSchema>;

export const RecordReleaseBody = withCommandMeta({
  facilityId: z.uuid(),
  childPersonId: z.uuid(),
  collector: CollectorSchema,
  activity: ActivityRefSchema.optional(),
  /** Staff may withhold a release even when authority is verified (a restriction or concern). */
  decision: z.enum(['release', 'withhold']).default('release'),
  /** Escalate a denial under the approved procedure (DEC-005) instead of a plain denial. */
  escalate: z.boolean().default(false),
  restrictionNotes: Note.optional(),
  escalationNotes: Note.optional(),
  /** Record the departure of the child's open visit together with a release (default true). */
  recordDeparture: z.boolean().default(true),
})
  .refine((v) => v.decision === 'release' || v.restrictionNotes !== undefined, {
    message: 'withholding a verified release needs restriction notes',
    path: ['restrictionNotes'],
  })
  .openapi('RecordReleaseRequest');
export type RecordReleaseBody = z.infer<typeof RecordReleaseBody>;

export const ReleaseRecordSchema = z
  .object({
    id: z.uuid(),
    facilityId: z.uuid(),
    childPersonId: z.uuid(),
    collectorPersonId: z.uuid().nullable(),
    collectorDescription: z.string().nullable(),
    activity: ActivityDetailSchema.nullable(),
    visitId: z.uuid().nullable(),
    verificationMethod: z.enum(['online_relationship_check', 'manual_outage_procedure']),
    verificationOutcome: z.enum(['verified', 'denied', 'escalated', 'manual_outage_procedure']),
    authorityBasis: z.literal('relationship_permission:collect').nullable(),
    /**
     * ENT-02, SPK-ENTRY-007: the identity access grant the verified online check relied on (staff
     * readers only; null for customers, assigned coaches and releases before migration 0804).
     */
    authorityGrantId: z.uuid().nullable(),
    authorityCheckedAt: Instant,
    /** Permissions the collector holds over the child right now (evidence; only `collect` authorizes). */
    collectorPermissions: z.array(z.string()),
    denialReason: z.string().nullable(),
    restrictionNotes: z.string().nullable(),
    escalationNotes: z.string().nullable(),
    escalationExceptionId: z.uuid().nullable(),
    manualProcedureReference: z.string().nullable(),
    postSyncAuthority: z.enum(['held', 'not_held']).nullable(),
    outcome: z.enum(['released', 'not_released']),
    decidedAt: Instant,
    releasedAt: Instant.nullable(),
    staffActor: ActorSnapshotSchema,
    source: z.enum(['online', 'offline_sync']),
    receivedAt: Instant,
  })
  .openapi('ReleaseRecord');
export type ReleaseRecord = z.infer<typeof ReleaseRecordSchema>;

export const RecordedReleaseSchema = z
  .object({ release: ReleaseRecordSchema, departure: DepartureSchema.nullable() })
  .openapi('RecordedRelease');
export type RecordedRelease = z.infer<typeof RecordedReleaseSchema>;

/**
 * ENT-02, SPK-ENTRY-007, SCR-W-09: before a supervised release, an assigned coach (or the pickup
 * desk) identifies the collecting adult by their pass. The reference travels in the body, never
 * the URL. Read-only: nothing is recorded, and the release itself re-checks authority.
 */
export const CollectorCheckBody = z
  .object({
    activity: ActivityRefSchema,
    participantPersonId: z.uuid(),
    passReference: z.string().trim().min(16).max(200),
  })
  .openapi('CollectorCheckRequest');
export type CollectorCheckBody = z.infer<typeof CollectorCheckBody>;

export const CollectorRestrictionSchema = z
  .object({
    code: z.enum(['authority_rechecked_at_release', 'participant_not_on_site', 'not_a_child']),
    message: z.string(),
  })
  .openapi('CollectorRestriction');
export type CollectorRestriction = z.infer<typeof CollectorRestrictionSchema>;

/**
 * `mayCollect` is true only when the pass is active, its holder holds `collect` over the
 * participant now and the participant takes part in the activity; only then is the collector
 * named. Every other answer is the same `mayCollect: false` with no collector, so the check reveals
 * nothing about the pass or its holder (§4.10, §4.14).
 */
export const CollectorCheckSchema = z
  .object({
    mayCollect: z.boolean(),
    collector: z.object({ personId: z.uuid(), displayName: z.string() }).nullable(),
    checkedAt: Instant,
    restrictions: z.array(CollectorRestrictionSchema),
  })
  .openapi('CollectorCheck');
export type CollectorCheck = z.infer<typeof CollectorCheckSchema>;

// ---------------------------------------------------------------------------------------------
// Offline synchronization (§4.15, SPK-AT-018)
// ---------------------------------------------------------------------------------------------

const OfflineItemBase = { clientObservationId: z.uuid(), observedAt: Instant };

export const OfflineItemSchema = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('attendance'),
      ...OfflineItemBase,
      personId: z.uuid(),
      activity: ActivityRefSchema,
      observedState: ObservedStateSchema,
    }),
    z.object({
      kind: z.literal('arrival'),
      ...OfflineItemBase,
      personId: z.uuid(),
      visitorCategory: VisitorCategorySchema.exclude(['unclassified']),
    }),
    z.object({ kind: z.literal('departure'), ...OfflineItemBase, personId: z.uuid() }),
    z.object({
      kind: z.literal('release'),
      ...OfflineItemBase,
      childPersonId: z.uuid(),
      collector: CollectorSchema,
      activity: ActivityRefSchema.optional(),
      manualProcedureReference: z.string().trim().min(1).max(200).optional(),
    }),
  ])
  .openapi('OfflineItem');
export type OfflineItem = z.infer<typeof OfflineItemSchema>;

export const OfflineSyncBody = withCommandMeta({
  deviceId: DeviceId,
  clientBatchId: z.uuid(),
  facilityId: z.uuid(),
  snapshot: z.object({ reference: z.string().trim().min(1).max(200), takenAt: Instant }),
  items: z.array(OfflineItemSchema).min(1).max(500),
})
  .refine((v) => new Set(v.items.map((i) => i.clientObservationId)).size === v.items.length, {
    message: 'client observation ids must be unique within a batch',
    path: ['items'],
  })
  .openapi('OfflineSyncRequest');
export type OfflineSyncBody = z.infer<typeof OfflineSyncBody>;

export const OfflineItemOutcomeSchema = z
  .enum(['accepted', 'accepted_with_conflict', 'duplicate', 'rejected'])
  .openapi('OfflineItemOutcome');
export type OfflineItemOutcome = z.infer<typeof OfflineItemOutcomeSchema>;

export const OfflineItemResultSchema = z
  .object({
    clientObservationId: z.uuid(),
    kind: z.enum(['attendance', 'arrival', 'departure', 'release']),
    outcome: OfflineItemOutcomeSchema,
    reason: z.string().nullable(),
    recordId: z.uuid().nullable(),
    flags: z.array(z.string()),
  })
  .openapi('OfflineItemResult');
export type OfflineItemResult = z.infer<typeof OfflineItemResultSchema>;

export const OfflineSyncBatchSchema = z
  .object({
    id: z.uuid(),
    facilityId: z.uuid(),
    deviceId: z.string(),
    clientBatchId: z.uuid(),
    snapshot: z.object({ reference: z.string(), takenAt: Instant }),
    receivedAt: Instant,
    snapshotAgeSeconds: z.number().int(),
    maxRosterAgeMinutes: z.number().int(),
    stale: z.boolean(),
    counts: z.object({
      items: z.number().int(),
      accepted: z.number().int(),
      acceptedWithConflict: z.number().int(),
      duplicate: z.number().int(),
      rejected: z.number().int(),
      stale: z.number().int(),
    }),
    items: z.array(OfflineItemResultSchema),
    exceptionIds: z.array(z.uuid()),
    operationId: z.uuid().nullable(),
    /** True when this batch had already been received: the stored outcome is returned, nothing is re-applied. */
    replayed: z.boolean(),
  })
  .openapi('OfflineSyncBatch');
export type OfflineSyncBatch = z.infer<typeof OfflineSyncBatchSchema>;

// ---------------------------------------------------------------------------------------------
// Occupancy (SPK-ENTRY-008)
// ---------------------------------------------------------------------------------------------

export const OccupancyQuery = z.object({ date: DateOnly.optional() });
export type OccupancyQuery = z.infer<typeof OccupancyQuery>;

export const OccupancySnapshotSchema = z
  .object({
    id: z.uuid(),
    facilityId: z.uuid(),
    takenAt: Instant,
    window: z.object({ start: Instant, end: Instant }),
    arrivals: z.number().int(),
    departures: z.number().int(),
    recordedOnSite: z.number().int(),
    openFromEarlierDays: z.number().int(),
    reconciled: z.boolean(),
    countedOnSite: z.number().int().nullable(),
    verifiedOccupancy: z.number().int().nullable(),
    discrepancy: z.number().int().nullable(),
    reconciliationNote: z.string().nullable(),
    takenBy: ActorSnapshotSchema,
  })
  .openapi('OccupancySnapshot');
export type OccupancySnapshot = z.infer<typeof OccupancySnapshotSchema>;

export const OccupancySchema = z
  .object({
    facilityId: z.uuid(),
    window: z.object({ start: Instant, end: Instant }),
    evaluatedAt: Instant,
    arrivals: z.object({ people: z.number().int(), visits: z.number().int() }),
    departures: z.object({ people: z.number().int(), visits: z.number().int() }),
    /** Arrivals without a recorded departure: a records figure, never verified occupancy by itself. */
    recordedOnSite: z.number().int(),
    openFromEarlierDays: z.number().int(),
    occupancy: z.object({
      status: z.enum(['unverified', 'verified']),
      verifiedOccupancy: z.number().int().nullable(),
      reconciledAt: Instant.nullable(),
      statement: z.string(),
    }),
    lastSnapshot: OccupancySnapshotSchema.nullable(),
  })
  .openapi('Occupancy');
export type Occupancy = z.infer<typeof OccupancySchema>;

export const TakeOccupancySnapshotBody = withCommandMeta({
  /** A physical head count; only a counted snapshot is reconciled (SPK-ENTRY-008). */
  countedOnSite: z.number().int().min(0).max(100_000).optional(),
  note: Note.optional(),
}).openapi('TakeOccupancySnapshotRequest');
export type TakeOccupancySnapshotBody = z.infer<typeof TakeOccupancySnapshotBody>;

// ---------------------------------------------------------------------------------------------
// Access hardware events (SPK-COND-004; the vendor is not selected, DEC-023)
// ---------------------------------------------------------------------------------------------

export const AccessControlEventBody = z
  .object({
    id: z.string().min(1).max(200),
    type: z.enum(['access.granted', 'access.denied', 'access.unknown']),
    data: z.object({
      organizationId: z.uuid(),
      facilityId: z.uuid(),
      deviceId: DeviceId,
      occurredAt: Instant,
      passReference: z.string().min(16).max(200).optional(),
      personId: z.uuid().optional(),
      visitorCategory: VisitorCategorySchema.optional(),
    }),
  })
  .openapi('AccessControlEvent');
export type AccessControlEventBody = z.infer<typeof AccessControlEventBody>;

// ---------------------------------------------------------------------------------------------
// OpenAPI registration
// ---------------------------------------------------------------------------------------------

const IdParams = z.object({ id: z.uuid() });
const TAG = 'Entry';
const err = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorResponseSchema } },
});
const ok = (description: string, schema: z.ZodType) => ({
  description,
  content: { 'application/json': { schema } },
});
const idempotencyHeader = z.object({ 'Idempotency-Key': z.string().min(8).max(128) });

function command(
  path: string,
  summary: string,
  body: z.ZodType,
  response: z.ZodType,
  status = 201,
  idempotent = true,
) {
  openApiRegistry.registerPath({
    method: 'post',
    path,
    summary,
    tags: [TAG],
    request: {
      params: path.includes('{id}') ? IdParams : undefined,
      headers: idempotent ? idempotencyHeader : undefined,
      body: { content: { 'application/json': { schema: body } } },
    },
    responses: {
      [status]: ok('Command outcome', response),
      400: err('Validation failed'),
      403: err('Access denied or participant authority required'),
      404: err('Not found or not visible'),
      409: err('Conflict (RESOURCE_CONFLICT, STALE_REVISION, INVALID_TRANSITION, IDEMPOTENCY_*)'),
    },
  });
}

function query(
  path: string,
  summary: string,
  request: z.ZodObject<z.ZodRawShape> | null,
  response: z.ZodType,
) {
  openApiRegistry.registerPath({
    method: 'get',
    path,
    summary,
    tags: [TAG],
    request: {
      params: path.includes('{id}') ? IdParams : undefined,
      query: request ?? undefined,
    },
    responses: {
      200: ok('Result', response),
      403: err('Access denied'),
      404: err('Not found or not visible'),
    },
  });
}

command(
  '/passes',
  'Issue an opaque pass to a person or household (SPK-ENTRY-002)',
  IssuePassBody,
  IssuedPassSchema,
);
command('/passes/{id}/revoke', 'Revoke a pass', RevokePassBody, PassSchema, 200);
query(
  '/me/passes',
  'The passes I hold; the reference is never shown again after issue (SPK-ENTRY-002, SCR-C-05)',
  null,
  z.array(MyPassSchema),
);
command(
  '/passes/scan',
  "Scan a pass: resolve the people and today's sessions for selection; records nobody as present (SPK-ENTRY-003)",
  ScanPassBody,
  PassScanSchema,
  200,
  false,
);
command(
  '/visits',
  'Record facility arrivals for the selected people (SPK-ENTRY-001, SPK-ENTRY-006)',
  RecordVisitsBody,
  RecordedVisitsSchema,
);
command(
  '/visits/{id}/void',
  'Void a mistaken arrival (reason kept)',
  VoidVisitBody,
  VisitSchema,
  200,
);
query('/visits', 'List visits of a facility day', ListVisitsQuery, pageSchema(VisitSchema));
command(
  '/session-checkins',
  'Check a person into a session or event with actionable arrival issues (SPK-ENTRY-004)',
  CreateSessionCheckinBody,
  SessionCheckinSchema,
);
command(
  '/session-checkins/{id}/recheck',
  'Re-evaluate a held check-in',
  RecheckSessionCheckinBody,
  SessionCheckinSchema,
  200,
);
command(
  '/session-checkins/{id}/withdraw',
  'Withdraw a check-in (reason kept)',
  WithdrawSessionCheckinBody,
  SessionCheckinSchema,
  200,
);
query('/session-checkins/{id}', 'Read a session check-in', null, SessionCheckinSchema);
command(
  '/attendance-observations',
  'Record an activity-specific attendance observation (§4.8)',
  RecordAttendanceObservationBody,
  RecordedObservationSchema,
);
command(
  '/attendance-observations/{id}/corrections',
  'Correct an observation with a new row that keeps actor, time and reason (SPK-ENTRY-005)',
  CorrectAttendanceObservationBody,
  RecordedObservationSchema,
);
query(
  '/attendance',
  'Attendance of an activity: current state and full history',
  AttendanceQuery,
  ActivityAttendanceSchema,
);
command('/departures', 'Record a departure (SPK-ENTRY-001)', RecordDepartureBody, DepartureSchema);
command(
  '/releases',
  'Record a supervised release after an online check of current pickup authority (§4.8, SPK-ENTRY-007)',
  RecordReleaseBody,
  RecordedReleaseSchema,
);
command(
  '/releases/collector-checks',
  'Identify the collecting adult by pass before a supervised release; read-only, records nothing (SPK-ENTRY-007)',
  CollectorCheckBody,
  CollectorCheckSchema,
  200,
  false,
);
query('/releases/{id}', 'Read a release record', null, ReleaseRecordSchema);
command(
  '/offline-sync',
  'Synchronize queued offline observations once; conflicts preserved for review (§4.15)',
  OfflineSyncBody,
  OfflineSyncBatchSchema,
);
query(
  '/offline-sync/{id}',
  'Read a synchronized offline batch with its per-item outcomes (its submitter or desk readers; §4.15)',
  null,
  OfflineSyncBatchSchema,
);
query(
  '/facilities/{id}/occupancy',
  'Arrivals and departures; verified only when reconciled (SPK-ENTRY-008)',
  OccupancyQuery,
  OccupancySchema,
);
command(
  '/facilities/{id}/occupancy-snapshots',
  'Record an occupancy snapshot; a physical count reconciles it (SPK-ENTRY-008)',
  TakeOccupancySnapshotBody,
  OccupancySnapshotSchema,
);
