import { newId } from '@sportspark/contracts';
import { json, type Db, type ObservedStateValue, type VisitorCategoryValue } from '@sportspark/db';
import type { Clock } from '../../../kernel';
import { hashPassReference, newPassReference } from '../entry.shared';

/**
 * Entry fixtures for downstream module tests (reporting, support, communications). Rows are
 * written directly through Kysely so they are fast and need no HTTP; the shapes mirror what the
 * services write and every database constraint of migration 0800 applies. People come from the
 * identity fixtures, sessions from catalog and events from scheduling; the context is structural
 * (a `TestApp` fits).
 */
export interface EntryFixtureContext {
  db: Db;
  clock: Clock;
  organizationId: string;
  facilityId: string;
}

const FIXTURE_ACTOR = { kind: 'system', actorLabel: 'fixtures' };

/** An active pass; the opaque reference is returned so tests can scan it. */
export async function createPassFixture(
  ctx: EntryFixtureContext,
  input: { personId?: string; householdId?: string; organizationId?: string },
): Promise<{ passId: string; reference: string }> {
  if (!input.personId === !input.householdId) {
    throw new Error('createPassFixture needs exactly one of personId or householdId');
  }
  const id = newId();
  const reference = newPassReference();
  await ctx.db
    .insertInto('passes')
    .values({
      id,
      organization_id: input.organizationId ?? ctx.organizationId,
      holder_kind: input.personId ? 'person' : 'household',
      holder_person_id: input.personId ?? null,
      holder_household_id: input.householdId ?? null,
      reference_hash: hashPassReference(reference),
      issued_at: ctx.clock.now(),
      issued_by: json(FIXTURE_ACTOR),
      issued_by_person_id: null,
      revoked_at: null,
      revoked_by: null,
      revoked_reason: null,
    })
    .execute();
  return { passId: id, reference };
}

/** An open (on-site) desk visit. */
export async function createVisitFixture(
  ctx: EntryFixtureContext,
  input: {
    personId?: string | null;
    visitorDescription?: string;
    partySize?: number;
    visitorCategory?: VisitorCategoryValue;
    arrivedAt?: Date;
    facilityId?: string;
    organizationId?: string;
  },
): Promise<string> {
  const id = newId();
  const now = ctx.clock.now();
  await ctx.db
    .insertInto('visits')
    .values({
      id,
      organization_id: input.organizationId ?? ctx.organizationId,
      facility_id: input.facilityId ?? ctx.facilityId,
      person_id: input.personId ?? null,
      visitor_description: input.personId ? null : (input.visitorDescription ?? 'Visitor'),
      party_size: input.partySize ?? 1,
      visitor_category: input.visitorCategory ?? 'participant',
      arrived_at: input.arrivedAt ?? now,
      pass_id: null,
      source: 'desk',
      device_id: null,
      client_observation_id: null,
      sync_batch_id: null,
      access_event_ref: null,
      departed_at: null,
      voided_at: null,
      void_reason: null,
      recorded_by: json(FIXTURE_ACTOR),
      recorded_by_person_id: null,
      received_at: now,
    })
    .execute();
  return id;
}

/** An online attendance observation for a catalog session or a scheduling event. */
export async function createAttendanceObservationFixture(
  ctx: EntryFixtureContext,
  input: {
    personId: string;
    activity:
      | { type: 'session'; offeringId: string; sessionId: string; eventId?: string | null }
      | { type: 'event'; eventId: string };
    observedState?: ObservedStateValue;
    observedAt?: Date;
    correctsObservationId?: string;
    correctionReason?: string;
    facilityId?: string;
    organizationId?: string;
  },
): Promise<string> {
  const id = newId();
  const now = ctx.clock.now();
  const activity = input.activity;
  await ctx.db
    .insertInto('attendance_observations')
    .values({
      id,
      organization_id: input.organizationId ?? ctx.organizationId,
      facility_id: input.facilityId ?? ctx.facilityId,
      person_id: input.personId,
      activity_type: activity.type,
      activity_id: activity.type === 'session' ? activity.sessionId : activity.eventId,
      offering_id: activity.type === 'session' ? activity.offeringId : null,
      offering_session_id: activity.type === 'session' ? activity.sessionId : null,
      scheduling_event_id:
        activity.type === 'session' ? (activity.eventId ?? null) : activity.eventId,
      observed_state: input.observedState ?? 'present',
      observed_at: input.observedAt ?? now,
      received_at: now,
      source: 'online',
      device_id: null,
      client_observation_id: null,
      sync_batch_id: null,
      snapshot_reference: null,
      snapshot_taken_at: null,
      flags: [],
      corrects_observation_id: input.correctsObservationId ?? null,
      correction_reason: input.correctionReason ?? null,
      recorded_by: json(FIXTURE_ACTOR),
      recorded_by_person_id: null,
    })
    .execute();
  return id;
}
