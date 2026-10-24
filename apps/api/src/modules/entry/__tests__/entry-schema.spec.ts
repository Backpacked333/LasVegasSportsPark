import { newId } from '@sportspark/contracts';
import { json, seedOrganization } from '@sportspark/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { createOfferingFixture, createOfferingSessionFixture } from '../../catalog';
import { createEnrollmentFixture } from '../../enrollment';
import { createPersonFixture, createStaffMemberFixture } from '../../identity';
import {
  createAttendanceObservationFixture,
  createPassFixture,
  createVisitFixture,
} from '../testing/entry-fixtures';
import { entryTestApp, expectPgError, TODAY } from './support';
import { at } from '../../scheduling';

const RESTRICT = '23001';
const FOREIGN_KEY = '23503';
const UNIQUE = '23505';
const CHECK = '23514';
const ACTOR = { kind: 'system', actorLabel: 'schema-test' };

/**
 * Integrity invariants enforced by the database (migration 0800), proven by writing violating
 * rows directly: the services' checks give earlier feedback but are not the guarantee (§4.7).
 */
describe('entry schema invariants (migration 0800)', () => {
  let t: TestApp;
  let child: string;
  let adult: string;
  let offeringId: string;
  let sessionId: string;
  const session = () => ({ type: 'session' as const, offeringId, sessionId });

  beforeAll(async () => {
    t = await entryTestApp();
    child = await createPersonFixture(t, { kind: 'child' });
    adult = await createPersonFixture(t, { kind: 'adult' });
    const manager = await createStaffMemberFixture(t, { roles: ['program_manager'] });
    offeringId = (await createOfferingFixture(t, { responsibleManagerPersonId: manager.personId }))
      .offeringId;
    sessionId = await createOfferingSessionFixture(t, {
      offeringId,
      scheduledStart: new Date(at(TODAY, '10:00')),
      scheduledEnd: new Date(at(TODAY, '11:00')),
    });
  });
  afterAll(async () => {
    await t.close();
  });

  const observationRow = (overrides: Record<string, unknown> = {}) => ({
    id: newId(),
    organization_id: t.organizationId,
    facility_id: t.facilityId,
    person_id: child,
    activity_type: 'session' as const,
    activity_id: sessionId,
    offering_id: offeringId,
    offering_session_id: sessionId,
    scheduling_event_id: null,
    observed_state: 'present' as const,
    observed_at: t.clock.now(),
    received_at: t.clock.now(),
    source: 'online' as const,
    device_id: null,
    client_observation_id: null,
    sync_batch_id: null,
    snapshot_reference: null,
    snapshot_taken_at: null,
    flags: [],
    corrects_observation_id: null,
    correction_reason: null,
    recorded_by: json(ACTOR),
    recorded_by_person_id: null,
    ...overrides,
  });

  const releaseRow = (overrides: Record<string, unknown> = {}) => ({
    id: newId(),
    organization_id: t.organizationId,
    facility_id: t.facilityId,
    child_person_id: child,
    collector_person_id: adult,
    collector_description: null,
    activity_type: null,
    activity_id: null,
    offering_id: null,
    offering_session_id: null,
    scheduling_event_id: null,
    visit_id: null,
    verification_method: 'online_relationship_check' as const,
    verification_outcome: 'verified' as const,
    authority_basis: 'relationship_permission:collect' as const,
    authority_checked_at: t.clock.now(),
    collector_permissions: ['collect'],
    denial_reason: null,
    restriction_notes: null,
    escalation_notes: null,
    escalation_exception_id: null,
    manual_procedure_reference: null,
    post_sync_authority: null,
    outcome: 'released' as const,
    decided_at: t.clock.now(),
    released_at: t.clock.now(),
    staff_actor: json(ACTOR),
    staff_person_id: null,
    source: 'online' as const,
    device_id: null,
    client_observation_id: null,
    sync_batch_id: null,
    received_at: t.clock.now(),
    ...overrides,
  });

  const checkinRow = (overrides: Record<string, unknown> = {}) => ({
    id: newId(),
    organization_id: t.organizationId,
    facility_id: t.facilityId,
    visit_id: null,
    person_id: child,
    activity_type: 'session' as const,
    activity_id: sessionId,
    offering_id: offeringId,
    offering_session_id: sessionId,
    scheduling_event_id: null,
    activity_start: new Date(at(TODAY, '10:00')),
    activity_end: new Date(at(TODAY, '11:00')),
    basis_kind: null,
    enrollment_id: null,
    session_booking_id: null,
    basis_reference: null,
    status: 'held' as const,
    issues: json([]),
    checked_in_at: t.clock.now(),
    evaluated_at: t.clock.now(),
    admitted_at: null,
    withdrawn_at: null,
    withdrawn_reason: null,
    recorded_by: json(ACTOR),
    recorded_by_person_id: null,
    ...overrides,
  });

  it('SPK-ENTRY-005 / §4.5: attendance observations are append-only — the database refuses UPDATE and DELETE', async () => {
    const id = await createAttendanceObservationFixture(t, {
      personId: child,
      activity: session(),
    });
    await expectPgError(
      t.db
        .updateTable('attendance_observations')
        .set({ observed_state: 'absent' })
        .where('id', '=', id)
        .execute(),
      RESTRICT,
    );
    await expectPgError(
      t.db.deleteFrom('attendance_observations').where('id', '=', id).execute(),
      RESTRICT,
    );
  });

  it('SPK-ENTRY-005: a correction names the same person and activity, carries a reason, and corrects an observation once', async () => {
    const original = await createAttendanceObservationFixture(t, {
      personId: child,
      activity: session(),
      observedState: 'absent',
    });
    await expectPgError(
      t.db
        .insertInto('attendance_observations')
        .values(observationRow({ corrects_observation_id: original }))
        .execute(),
      CHECK,
    );
    await expectPgError(
      t.db
        .insertInto('attendance_observations')
        .values(
          observationRow({
            person_id: adult,
            corrects_observation_id: original,
            correction_reason: 'Wrong person',
          }),
        )
        .execute(),
      FOREIGN_KEY,
    );
    await createAttendanceObservationFixture(t, {
      personId: child,
      activity: session(),
      correctsObservationId: original,
      correctionReason: 'Was present',
    });
    await expectPgError(
      t.db
        .insertInto('attendance_observations')
        .values(
          observationRow({
            corrects_observation_id: original,
            correction_reason: 'Second correction',
          }),
        )
        .execute(),
      UNIQUE,
    );
  });

  it('§4.15: a queued observation carries its batch, client id and snapshot; a client id is recorded once per device', async () => {
    await expectPgError(
      t.db
        .insertInto('attendance_observations')
        .values(
          observationRow({
            source: 'offline_sync',
            device_id: 'tablet',
            client_observation_id: newId(),
          }),
        )
        .execute(),
      CHECK,
    );
    const clientId = newId();
    await t.db
      .insertInto('attendance_observations')
      .values(observationRow({ device_id: 'tablet', client_observation_id: clientId }))
      .execute();
    await expectPgError(
      t.db
        .insertInto('attendance_observations')
        .values(observationRow({ device_id: 'tablet', client_observation_id: clientId }))
        .execute(),
      UNIQUE,
    );
  });

  it('SPK-ENTRY-006 / SPK-ENTRY-001: a person is on site once; a participant is always a real person; departures are one per visit', async () => {
    const person = await createPersonFixture(t, { kind: 'adult' });
    const visitId = await createVisitFixture(t, { personId: person, visitorCategory: 'guardian' });
    await expectPgError(
      createVisitFixture(t, { personId: person, visitorCategory: 'guardian' }),
      UNIQUE,
    );
    await expectPgError(
      createVisitFixture(t, {
        personId: null,
        visitorCategory: 'participant',
        visitorDescription: 'A kid',
      }),
      CHECK,
    );
    const departure = {
      organization_id: t.organizationId,
      facility_id: t.facilityId,
      visit_id: visitId,
      person_id: person,
      departed_at: t.clock.now(),
      release_record_id: null,
      source: 'desk' as const,
      device_id: null,
      client_observation_id: null,
      sync_batch_id: null,
      recorded_by: json(ACTOR),
      recorded_by_person_id: null,
      received_at: t.clock.now(),
    };
    await t.db
      .insertInto('departures')
      .values({ id: newId(), ...departure })
      .execute();
    await expectPgError(
      t.db
        .insertInto('departures')
        .values({ id: newId(), ...departure })
        .execute(),
      UNIQUE,
    );
    await expectPgError(
      t.db.deleteFrom('departures').where('visit_id', '=', visitId).execute(),
      RESTRICT,
    );
    // Visits move on_site → departed | voided only, and their arrival facts never change.
    await t.db
      .updateTable('visits')
      .set({ status: 'departed', departed_at: t.clock.now() })
      .where('id', '=', visitId)
      .execute();
    await expectPgError(
      t.db
        .updateTable('visits')
        .set({ status: 'on_site', departed_at: null })
        .where('id', '=', visitId)
        .execute(),
      CHECK,
    );
    await expectPgError(
      t.db
        .updateTable('visits')
        .set({ visitor_category: 'staff' })
        .where('id', '=', visitId)
        .execute(),
      CHECK,
    );
  });

  it("§4.3: an entry record can never point at another organization's person or facility", async () => {
    const other = await seedOrganization(t.db);
    const foreignPerson = await createPersonFixture(t, {
      kind: 'adult',
      organizationId: other.organizationId,
    });
    await expectPgError(createVisitFixture(t, { personId: foreignPerson }), FOREIGN_KEY);
    await expectPgError(
      createVisitFixture(t, { personId: child, facilityId: other.facilityId }),
      FOREIGN_KEY,
    );
    await expectPgError(
      t.db
        .insertInto('release_records')
        .values(releaseRow({ collector_person_id: foreignPerson }))
        .execute(),
      FOREIGN_KEY,
    );
  });

  it('SPK-ENTRY-007: a child is released only on verified collect authority or an approved outage procedure', async () => {
    await expectPgError(
      t.db
        .insertInto('release_records')
        .values(
          releaseRow({
            verification_outcome: 'denied',
            authority_basis: null,
            collector_permissions: ['pay', 'view'],
            denial_reason: 'No collect',
          }),
        )
        .execute(),
      CHECK,
    );
    // "Verified" without the collect permission recorded (e.g. pay only) is refused.
    await expectPgError(
      t.db
        .insertInto('release_records')
        .values(releaseRow({ collector_permissions: ['pay', 'view'] }))
        .execute(),
      CHECK,
    );
    // A denial always states its reason and never releases.
    await expectPgError(
      t.db
        .insertInto('release_records')
        .values(
          releaseRow({
            verification_outcome: 'denied',
            authority_basis: null,
            outcome: 'not_released',
            released_at: null,
            collector_permissions: [],
          }),
        )
        .execute(),
      CHECK,
    );
    // An online release never uses the outage procedure; an offline one never the online check.
    await expectPgError(
      t.db
        .insertInto('release_records')
        .values(
          releaseRow({
            verification_method: 'manual_outage_procedure',
            verification_outcome: 'manual_outage_procedure',
            authority_basis: null,
            manual_procedure_reference: 'OUTAGE-1',
          }),
        )
        .execute(),
      CHECK,
    );
    const id = newId();
    await t.db.insertInto('release_records').values(releaseRow({ id })).execute();
    await expectPgError(
      t.db
        .updateTable('release_records')
        .set({ outcome: 'not_released', released_at: null })
        .where('id', '=', id)
        .execute(),
      RESTRICT,
    );
  });

  it('a departure that names a release follows a release that released that child', async () => {
    const kid = await createPersonFixture(t, { kind: 'child' });
    const visitId = await createVisitFixture(t, { personId: kid });
    const notReleased = newId();
    await t.db
      .insertInto('release_records')
      .values(
        releaseRow({
          id: notReleased,
          child_person_id: kid,
          verification_outcome: 'denied',
          authority_basis: null,
          collector_permissions: [],
          denial_reason: 'No collect',
          outcome: 'not_released',
          released_at: null,
        }),
      )
      .execute();
    await expectPgError(
      t.db
        .insertInto('departures')
        .values({
          id: newId(),
          organization_id: t.organizationId,
          facility_id: t.facilityId,
          visit_id: visitId,
          person_id: kid,
          departed_at: t.clock.now(),
          release_record_id: notReleased,
          source: 'release',
          device_id: null,
          client_observation_id: null,
          sync_batch_id: null,
          recorded_by: json(ACTOR),
          recorded_by_person_id: null,
          received_at: t.clock.now(),
        })
        .execute(),
      CHECK,
    );
  });

  it("SPK-ENTRY-007 / §4.7 (migration 0802): a departure records the person of the visit it closes — child X's visit can never be closed with child Y's release", async () => {
    const x = await createPersonFixture(t, { kind: 'child' });
    const y = await createPersonFixture(t, { kind: 'child' });
    const xVisit = await createVisitFixture(t, { personId: x });
    const yRelease = newId();
    await t.db
      .insertInto('release_records')
      .values(releaseRow({ id: yRelease, child_person_id: y }))
      .execute();
    const departure = (overrides: Record<string, unknown>) => ({
      id: newId(),
      organization_id: t.organizationId,
      facility_id: t.facilityId,
      visit_id: xVisit,
      person_id: x,
      departed_at: t.clock.now(),
      release_record_id: null,
      source: 'desk' as const,
      device_id: null,
      client_observation_id: null,
      sync_batch_id: null,
      recorded_by: json(ACTOR),
      recorded_by_person_id: null,
      received_at: t.clock.now(),
      ...overrides,
    });
    await expectPgError(
      t.db
        .insertInto('departures')
        .values(departure({ person_id: y, release_record_id: yRelease, source: 'release' }))
        .execute(),
      CHECK,
    );
    // Nor without a release: the departure of X's visit never names someone else, or no one.
    await expectPgError(
      t.db
        .insertInto('departures')
        .values(departure({ person_id: y }))
        .execute(),
      CHECK,
    );
    await expectPgError(
      t.db
        .insertInto('departures')
        .values(departure({ person_id: null }))
        .execute(),
      CHECK,
    );
    await t.db.insertInto('departures').values(departure({})).execute();
    // A described visitor's visit (no person) departs with no person.
    const described = await createVisitFixture(t, {
      personId: null,
      visitorCategory: 'spectator',
    });
    await t.db
      .insertInto('departures')
      .values(departure({ visit_id: described, person_id: null }))
      .execute();
  });

  it('SPK-ENTRY-004 / SPK-ENTRY-006: a check-in is never admitted with a blocking issue or without a participation basis; one live check-in per person and activity', async () => {
    const blocking = [
      {
        code: 'missing_acknowledgment',
        severity: 'blocking',
        message: 'm',
        nextAction: 'n',
        reference: null,
      },
    ];
    const enrollmentFree = await createPersonFixture(t, { kind: 'child' });
    // No participation basis: never admitted (no fabricated enrollment, SPK-ENTRY-006).
    await expectPgError(
      t.db
        .insertInto('session_checkins')
        .values(
          checkinRow({ person_id: enrollmentFree, status: 'admitted', admitted_at: t.clock.now() }),
        )
        .execute(),
      CHECK,
    );
    // A basis must match the activity kind (a roster membership is not a session basis).
    await expectPgError(
      t.db
        .insertInto('session_checkins')
        .values(
          checkinRow({
            person_id: enrollmentFree,
            basis_kind: 'roster_membership',
            basis_reference: newId(),
          }),
        )
        .execute(),
      CHECK,
    );
    const enrolled = await createPersonFixture(t, { kind: 'child' });
    const enrollmentId = await createEnrollmentFixture(t, {
      offeringId,
      participantPersonId: enrolled,
    });
    const id = newId();
    await t.db
      .insertInto('session_checkins')
      .values(
        checkinRow({
          id,
          person_id: enrolled,
          basis_kind: 'enrollment',
          enrollment_id: enrollmentId,
          issues: json(blocking),
        }),
      )
      .execute();
    await expectPgError(
      t.db
        .insertInto('session_checkins')
        .values(checkinRow({ person_id: enrolled }))
        .execute(),
      UNIQUE,
    );
    // Admitting the held row while the blocking issue is still recorded is refused.
    await expectPgError(
      t.db
        .updateTable('session_checkins')
        .set({ status: 'admitted', admitted_at: t.clock.now() })
        .where('id', '=', id)
        .execute(),
      CHECK,
    );
    // Once the issue is cleared the same transition is accepted.
    await t.db
      .updateTable('session_checkins')
      .set({ status: 'admitted', admitted_at: t.clock.now(), issues: json([]) })
      .where('id', '=', id)
      .execute();
    await t.db
      .updateTable('session_checkins')
      .set({ status: 'withdrawn', withdrawn_at: t.clock.now(), withdrawn_reason: 'Left' })
      .where('id', '=', id)
      .execute();
    await expectPgError(
      t.db
        .updateTable('session_checkins')
        .set({ status: 'held', withdrawn_at: null, withdrawn_reason: null })
        .where('id', '=', id)
        .execute(),
      CHECK,
    );
  });

  it('SPK-ENTRY-002: a revoked pass never becomes active again and its reference never changes', async () => {
    const { passId } = await createPassFixture(t, { personId: adult });
    await expectPgError(
      t.db
        .updateTable('passes')
        .set({ reference_hash: 'a'.repeat(64) })
        .where('id', '=', passId)
        .execute(),
      CHECK,
    );
    await t.db
      .updateTable('passes')
      .set({
        status: 'revoked',
        revoked_at: t.clock.now(),
        revoked_by: json(ACTOR),
        revoked_reason: 'Lost',
      })
      .where('id', '=', passId)
      .execute();
    await expectPgError(
      t.db
        .updateTable('passes')
        .set({ status: 'active', revoked_at: null, revoked_by: null, revoked_reason: null })
        .where('id', '=', passId)
        .execute(),
      CHECK,
    );
    await expectPgError(t.db.deleteFrom('passes').where('id', '=', passId).execute(), RESTRICT);
    await expectPgError(
      t.db
        .insertInto('passes')
        .values({
          id: newId(),
          organization_id: t.organizationId,
          holder_kind: 'person',
          holder_person_id: adult,
          holder_household_id: null,
          reference_hash: 'not-a-hash',
          issued_at: t.clock.now(),
          issued_by: json(ACTOR),
          issued_by_person_id: null,
          revoked_at: null,
          revoked_by: null,
          revoked_reason: null,
        })
        .execute(),
      CHECK,
    );
  });

  it('SPK-ENTRY-008: occupancy is verified only on a reconciled snapshot (a physical count)', async () => {
    const snapshot = (overrides: Record<string, unknown>) => ({
      id: newId(),
      organization_id: t.organizationId,
      facility_id: t.facilityId,
      taken_at: t.clock.now(),
      window_start: new Date(at(TODAY, '00:00')),
      window_end: new Date(at('2027-01-17', '00:00')),
      arrivals: 10,
      departures: 4,
      recorded_on_site: 6,
      open_from_earlier_days: 0,
      reconciled: false,
      counted_on_site: null,
      verified_occupancy: null,
      discrepancy: null,
      reconciliation_note: null,
      taken_by: json(ACTOR),
      taken_by_person_id: null,
      ...overrides,
    });
    await expectPgError(
      t.db
        .insertInto('occupancy_snapshots')
        .values(snapshot({ verified_occupancy: 10 }))
        .execute(),
      CHECK,
    );
    await expectPgError(
      t.db
        .insertInto('occupancy_snapshots')
        .values(snapshot({ reconciled: true, verified_occupancy: 6, discrepancy: 0 }))
        .execute(),
      CHECK,
    );
    const id = newId();
    await t.db
      .insertInto('occupancy_snapshots')
      .values(
        snapshot({
          id,
          reconciled: true,
          counted_on_site: 5,
          verified_occupancy: 5,
          discrepancy: -1,
        }),
      )
      .execute();
    await expectPgError(
      t.db
        .updateTable('occupancy_snapshots')
        .set({ verified_occupancy: 6 })
        .where('id', '=', id)
        .execute(),
      RESTRICT,
    );
  });

  it('§4.15: an offline batch is received once per device and client batch id, and its counts add up', async () => {
    const batch = (overrides: Record<string, unknown>) => ({
      id: newId(),
      organization_id: t.organizationId,
      facility_id: t.facilityId,
      device_id: 'tablet-x',
      client_batch_id: newId(),
      snapshot_reference: 'roster-1',
      snapshot_taken_at: t.clock.now(),
      received_at: t.clock.now(),
      snapshot_age_seconds: 0,
      max_roster_age_minutes: 120,
      item_count: 1,
      accepted_count: 1,
      conflict_count: 0,
      duplicate_count: 0,
      rejected_count: 0,
      stale_count: 0,
      stale: false,
      results: json([]),
      exception_ids: [],
      operation_id: null,
      submitted_by: json(ACTOR),
      submitted_by_person_id: null,
      ...overrides,
    });
    const clientBatchId = newId();
    await t.db
      .insertInto('offline_sync_batches')
      .values(batch({ client_batch_id: clientBatchId }))
      .execute();
    await expectPgError(
      t.db
        .insertInto('offline_sync_batches')
        .values(batch({ client_batch_id: clientBatchId }))
        .execute(),
      UNIQUE,
    );
    await expectPgError(
      t.db
        .insertInto('offline_sync_batches')
        .values(batch({ accepted_count: 2 }))
        .execute(),
      CHECK,
    );
    await expectPgError(
      t.db
        .insertInto('offline_sync_batches')
        .values(batch({ stale_count: 1, stale: false }))
        .execute(),
      CHECK,
    );
    // §4.9 (migration 0801): the request fingerprint is a SHA-256 hex digest or absent.
    await expectPgError(
      t.db
        .insertInto('offline_sync_batches')
        .values(batch({ request_fingerprint: 'not-a-digest' }))
        .execute(),
      CHECK,
    );
    await t.db
      .insertInto('offline_sync_batches')
      .values(batch({ request_fingerprint: 'a'.repeat(64) }))
      .execute();
    // An observation pointing at a batch that never commits is refused at commit (deferred key).
    await expectPgError(
      t.db.transaction().execute(async (trx) => {
        await trx
          .insertInto('attendance_observations')
          .values(
            observationRow({
              source: 'offline_sync',
              device_id: 'tablet-y',
              client_observation_id: newId(),
              sync_batch_id: newId(),
              snapshot_reference: 'roster-2',
              snapshot_taken_at: t.clock.now(),
            }),
          )
          .execute();
        await sql`select 1`.execute(trx);
      }),
      FOREIGN_KEY,
    );
  });
});
