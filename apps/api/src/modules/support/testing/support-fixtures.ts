import { newId, type StaffRole } from '@sportspark/contracts';
import {
  json,
  type CaseCategory,
  type CasePriority,
  type Db,
  type RecordReference,
} from '@sportspark/db';
import type { Clock } from '../../../kernel';

/**
 * Support fixtures for downstream module tests (reporting, automation, migration). Rows are
 * written directly through Kysely with the history row the service writes, so the database
 * guarantees (a case is created open, the history is append-only) hold in fixture data too. People
 * come from the identity fixtures; the context is structural (a `TestApp` fits).
 */
export interface SupportFixtureContext {
  db: Db;
  clock: Clock;
  organizationId: string;
}

const FIXTURE_ACTOR = { kind: 'system', actorLabel: 'fixtures' };

/** An open support case (with its opening history entry). */
export async function createCaseFixture(
  ctx: SupportFixtureContext,
  input: {
    category?: CaseCategory;
    priority?: CasePriority;
    title?: string;
    subjectPersonId?: string | null;
    facilityId?: string | null;
    ownerPersonId?: string | null;
    ownerQueue?: string | null;
    relatedRecords?: RecordReference[];
    organizationId?: string;
  } = {},
): Promise<string> {
  const id = newId();
  const organizationId = input.organizationId ?? ctx.organizationId;
  const now = ctx.clock.now();
  await ctx.db.transaction().execute(async (trx) => {
    await trx
      .insertInto('cases')
      .values({
        id,
        organization_id: organizationId,
        facility_id: input.facilityId ?? null,
        category: input.category ?? 'other',
        priority: input.priority ?? 'normal',
        title: input.title ?? 'Fixture case',
        description: null,
        subject_person_id: input.subjectPersonId ?? null,
        subject_household_id: null,
        owner_person_id: input.ownerPersonId ?? null,
        owner_queue: input.ownerQueue ?? 'support_operator',
        related_records: json(input.relatedRecords ?? []),
        origin_access_review_id: null,
        origin_exception_id: null,
        due_at: null,
        resolution_kind: null,
        resolution_summary: null,
        resolved_at: null,
        resolved_by: null,
        closed_at: null,
        opened_by: json(FIXTURE_ACTOR),
        opened_by_person_id: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await trx
      .insertInto('case_events')
      .values({
        id: newId(),
        organization_id: organizationId,
        case_id: id,
        sequence: 1,
        kind: 'status',
        body: null,
        from_status: null,
        to_status: 'open',
        case_action_id: null,
        details: json({ event: 'open', fixture: true }),
        actor: json(FIXTURE_ACTOR),
        actor_person_id: null,
        occurred_at: now,
      })
      .execute();
  });
  return id;
}

/** An active exception queue with its owning roles and service levels. */
export async function createExceptionQueueFixture(
  ctx: SupportFixtureContext,
  input: {
    name: string;
    owningRoles: StaffRole[];
    acknowledgeWithinMinutes?: number | null;
    resolveWithinMinutes?: number | null;
    organizationId?: string;
  },
): Promise<string> {
  const id = newId();
  await ctx.db
    .insertInto('exception_queues')
    .values({
      id,
      organization_id: input.organizationId ?? ctx.organizationId,
      name: input.name,
      description: null,
      owning_roles: input.owningRoles,
      acknowledge_within_minutes: input.acknowledgeWithinMinutes ?? null,
      resolve_within_minutes: input.resolveWithinMinutes ?? null,
      created_by: json(FIXTURE_ACTOR),
    })
    .execute();
  return id;
}
