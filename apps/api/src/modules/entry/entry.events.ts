import { defineEvent, ObservedStateSchema, VisitorCategorySchema, z } from '@sportspark/contracts';

/**
 * Entry domain events (§4.12). Payloads carry identifiers and states only; names, descriptions,
 * notes and pass references never travel in events (§4.14 child data minimization).
 */
const ActivityType = z.enum(['session', 'event']);

export const EntryEvents = {
  passIssued: defineEvent(
    'entry.pass_issued',
    z.object({ passId: z.uuid(), holderKind: z.enum(['person', 'household']) }),
  ),
  passRevoked: defineEvent('entry.pass_revoked', z.object({ passId: z.uuid() })),
  /** A facility arrival (SPK-ENTRY-001). Never an enrollment, attendance or pickup fact. */
  visitRecorded: defineEvent(
    'entry.visit_recorded',
    z.object({
      visitId: z.uuid(),
      facilityId: z.uuid(),
      personId: z.uuid().nullable(),
      visitorCategory: VisitorCategorySchema,
      partySize: z.number().int(),
      source: z.enum(['desk', 'offline_sync', 'access_control']),
    }),
  ),
  visitClosed: defineEvent(
    'entry.visit_closed',
    z.object({
      visitId: z.uuid(),
      facilityId: z.uuid(),
      status: z.enum(['departed', 'voided']),
    }),
  ),
  sessionCheckinChanged: defineEvent(
    'entry.session_checkin_changed',
    z.object({
      checkinId: z.uuid(),
      facilityId: z.uuid(),
      personId: z.uuid(),
      activityType: ActivityType,
      activityId: z.uuid(),
      status: z.enum(['held', 'admitted', 'withdrawn']),
      previousStatus: z.enum(['held', 'admitted']).nullable(),
      blockingIssueCodes: z.array(z.string()),
    }),
  ),
  attendanceObserved: defineEvent(
    'entry.attendance_observed',
    z.object({
      observationId: z.uuid(),
      facilityId: z.uuid(),
      personId: z.uuid(),
      activityType: ActivityType,
      activityId: z.uuid(),
      observedState: ObservedStateSchema,
      correctsObservationId: z.uuid().nullable(),
      source: z.enum(['online', 'offline_sync']),
      flags: z.array(z.string()),
    }),
  ),
  departureRecorded: defineEvent(
    'entry.departure_recorded',
    z.object({
      departureId: z.uuid(),
      visitId: z.uuid(),
      facilityId: z.uuid(),
      personId: z.uuid().nullable(),
      releaseRecordId: z.uuid().nullable(),
    }),
  ),
  releaseRecorded: defineEvent(
    'entry.release_recorded',
    z.object({
      releaseId: z.uuid(),
      facilityId: z.uuid(),
      childPersonId: z.uuid(),
      verificationOutcome: z.enum(['verified', 'denied', 'escalated', 'manual_outage_procedure']),
      outcome: z.enum(['released', 'not_released']),
      source: z.enum(['online', 'offline_sync']),
    }),
  ),
  offlineBatchSynced: defineEvent(
    'entry.offline_batch_synced',
    z.object({
      batchId: z.uuid(),
      facilityId: z.uuid(),
      deviceId: z.string(),
      accepted: z.number().int(),
      acceptedWithConflict: z.number().int(),
      duplicate: z.number().int(),
      rejected: z.number().int(),
      stale: z.boolean(),
    }),
  ),
  occupancySnapshotTaken: defineEvent(
    'entry.occupancy_snapshot_taken',
    z.object({ snapshotId: z.uuid(), facilityId: z.uuid(), reconciled: z.boolean() }),
  ),
  /**
   * ENT-05, IF-38: an access device was registered, changed, retired, or its health changed
   * (`change` names which, for example registered, updated, retired, online, offline).
   */
  accessDeviceChanged: defineEvent(
    'entry.access_device_changed',
    z.object({ deviceId: z.uuid(), change: z.string().min(1).max(100) }),
  ),
};
