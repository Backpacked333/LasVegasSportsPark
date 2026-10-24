import { newId, type AssignmentStatus } from '@sportspark/contracts';
import {
  json,
  type AssignmentEngagement,
  type AssignmentKind,
  type AssignmentTargetType,
  type Db,
  type QualificationStatus,
} from '@sportspark/db';
import type { Clock } from '../../../kernel';

/**
 * Workforce fixtures for downstream module tests (entry, communications, reporting, finance).
 * Rows are written directly through Kysely, so the database constraints apply exactly as they do
 * to the services; the shapes mirror what the services write. People come from the identity
 * fixtures and targets from the competition, scheduling or catalog fixtures. A `TestApp`
 * satisfies the context structurally.
 */
export interface WorkforceFixtureContext {
  db: Db;
  clock: Clock;
  organizationId: string;
  facilityId: string;
}

const FIXTURE_ACTOR = { kind: 'system', actorLabel: 'fixtures' };

export async function createQualificationFixture(
  ctx: WorkforceFixtureContext,
  input: {
    personId: string;
    kind: string;
    status?: QualificationStatus;
    validFrom?: Date;
    validTo?: Date | null;
    level?: string | null;
    organizationId?: string;
  },
): Promise<string> {
  const id = newId();
  const now = ctx.clock.now();
  const status = input.status ?? 'verified';
  await ctx.db
    .insertInto('qualifications')
    .values({
      id,
      organization_id: input.organizationId ?? ctx.organizationId,
      person_id: input.personId,
      kind: input.kind,
      level: input.level ?? null,
      evidence_reference: 'fixture-evidence',
      valid_from: input.validFrom ?? new Date(now.getTime() - 365 * 86_400_000),
      valid_to: input.validTo ?? null,
      status,
      verified_by: status === 'verified' ? json(FIXTURE_ACTOR) : null,
      verified_by_person_id: null,
      verified_at: status === 'verified' ? now : null,
      status_reason: status === 'rejected' || status === 'revoked' ? 'fixture' : null,
      status_changed_at: status === 'pending_verification' ? null : now,
      recorded_by: json(FIXTURE_ACTOR),
      recorded_by_person_id: null,
    })
    .execute();
  return id;
}

export async function createAvailabilityFixture(
  ctx: WorkforceFixtureContext,
  input: {
    personId: string;
    start: Date | string;
    end: Date | string;
    kind?: 'available' | 'unavailable';
    note?: string | null;
    organizationId?: string;
  },
): Promise<string> {
  const id = newId();
  await ctx.db
    .insertInto('availability')
    .values({
      id,
      organization_id: input.organizationId ?? ctx.organizationId,
      person_id: input.personId,
      starts_at: new Date(input.start),
      ends_at: new Date(input.end),
      kind: input.kind ?? 'available',
      note: input.note ?? null,
      withdrawn_at: null,
      withdrawn_reason: null,
      recorded_by: json(FIXTURE_ACTOR),
      recorded_by_person_id: null,
    })
    .execute();
  return id;
}

export interface FixtureTarget {
  targetType: AssignmentTargetType;
  targetId: string;
  /** Required for session targets. */
  offeringId?: string | null;
  schedulingEventId?: string | null;
}

function targetColumns(target: FixtureTarget) {
  return {
    target_type: target.targetType,
    target_id: target.targetId,
    fixture_id: target.targetType === 'fixture' ? target.targetId : null,
    scheduling_event_id:
      target.targetType === 'event' ? target.targetId : (target.schedulingEventId ?? null),
    offering_session_id: target.targetType === 'session' ? target.targetId : null,
    offering_id: target.targetType === 'session' ? (target.offeringId ?? null) : null,
  };
}

export async function createRequirementFixture(
  ctx: WorkforceFixtureContext,
  input: FixtureTarget & {
    kind?: AssignmentKind;
    role?: string;
    requiredCount?: number;
    mustBeAccepted?: boolean;
    requiredQualifications?: string[];
    facilityId?: string;
    organizationId?: string;
  },
): Promise<string> {
  const id = newId();
  const columns = targetColumns(input);
  await ctx.db
    .insertInto('assignment_requirements')
    .values({
      id,
      organization_id: input.organizationId ?? ctx.organizationId,
      facility_id: input.facilityId ?? ctx.facilityId,
      ...columns,
      scheduling_event_id: input.targetType === 'event' ? input.targetId : null,
      kind: input.kind ?? 'official',
      role: input.role ?? 'referee',
      required_count: input.requiredCount ?? 1,
      must_be_accepted: input.mustBeAccepted ?? true,
      required_qualifications: input.requiredQualifications ?? [],
      created_by: json(FIXTURE_ACTOR),
    })
    .execute();
  return id;
}

/** An assignment in any state, with the facts each state requires (database checks apply). */
export async function createAssignmentFixture(
  ctx: WorkforceFixtureContext,
  input: FixtureTarget & {
    personId: string;
    scheduledStart: Date | string;
    scheduledEnd: Date | string;
    status?: AssignmentStatus;
    kind?: AssignmentKind;
    role?: string;
    slot?: number;
    engagement?: AssignmentEngagement;
    turnaroundMinutes?: number;
    title?: string;
    facilityId?: string;
    organizationId?: string;
  },
): Promise<string> {
  const id = newId();
  const now = ctx.clock.now();
  const status = input.status ?? 'proposed';
  const end = new Date(input.scheduledEnd);
  const turnaround = input.turnaroundMinutes ?? 0;
  const offered = status !== 'proposed';
  const accepted = status === 'accepted' || status === 'completed';
  await ctx.db
    .insertInto('assignments')
    .values({
      id,
      organization_id: input.organizationId ?? ctx.organizationId,
      facility_id: input.facilityId ?? ctx.facilityId,
      person_id: input.personId,
      kind: input.kind ?? 'official',
      ...targetColumns(input),
      target_title: input.title ?? 'Fixture assignment',
      role: input.role ?? 'referee',
      slot: input.slot ?? 1,
      engagement: input.engagement ?? 'regular',
      status,
      scheduled_start: new Date(input.scheduledStart),
      scheduled_end: end,
      turnaround_minutes: turnaround,
      committed_end: new Date(end.getTime() + turnaround * 60_000),
      replaces_assignment_id: null,
      offered_at: offered ? now : null,
      responded_at: accepted || status === 'declined' ? now : null,
      accepted_at: accepted ? now : null,
      declined_at: status === 'declined' ? now : null,
      decline_reason: null,
      withdrawn_at: status === 'withdrawn' ? now : null,
      withdrawn_reason: status === 'withdrawn' ? 'fixture' : null,
      withdrawn_by: status === 'withdrawn' ? json(FIXTURE_ACTOR) : null,
      completed_at: status === 'completed' ? now : null,
      completed_by: status === 'completed' ? json(FIXTURE_ACTOR) : null,
      access_membership_id: null,
      access_from: null,
      access_until: null,
      created_by: json(FIXTURE_ACTOR),
      created_by_person_id: null,
    })
    .execute();
  return id;
}
