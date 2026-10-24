import { Inject, Injectable } from '@nestjs/common';
import {
  decodeCursor,
  encodeCursor,
  errors,
  newId,
  z,
  type AgeBand,
  type CreateProgramInput,
  type ListProgramsQuery,
  type Page,
  type Principal,
  type Program,
  type UpdateProgramInput,
} from '@sportspark/contracts';
import { isUniqueViolation, json, type Db, type ProgramStatus } from '@sportspark/db';
import { sql } from 'kysely';
import {
  assertExpectedRevision,
  AuditWriter,
  AuthorizationService,
  DATABASE,
  Outbox,
  snapshotActor,
  UnitOfWork,
} from '../../../kernel';
import { CatalogActions } from '../catalog.actions';
import { CatalogEvents } from '../catalog.events';
import { organizationOf, toProgram } from '../catalog.shared';
import { ProgramMachine, type ProgramEvent } from '../catalog.state-machines';

const Cursor = z.object({ name: z.string(), id: z.string() });

/** Offering states in which customers see the offering and register against its age band. */
const AGE_BAND_FROZEN_STATES = ['published', 'registration_open', 'registration_paused'] as const;

function sameAgeBand(a: AgeBand, b: AgeBand): boolean {
  return (
    (a.minAgeYears ?? null) === (b.minAgeYears ?? null) &&
    (a.maxAgeYears ?? null) === (b.maxAgeYears ?? null)
  );
}

/** Reusable program definitions, separate from dated offerings (SPK-CAT-001, SPK-YOUTH-001). */
@Injectable()
export class ProgramsService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
  ) {}

  async create(
    principal: Principal,
    body: CreateProgramInput,
    correlationId: string | null,
  ): Promise<Program> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, CatalogActions.managePrograms, {
      type: 'program',
      organizationId,
    });
    return this.uow.run(async ({ trx }) => {
      const id = newId();
      let row;
      try {
        row = await trx
          .insertInto('programs')
          .values({
            id,
            organization_id: organizationId,
            name: body.name,
            description: body.description ?? null,
            activity_type: body.activityType,
            format: body.format ?? null,
            age_band: json(body.ageBand),
            status: body.status,
            created_by: json(snapshotActor(principal)),
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw errors.validation('A program with this name already exists.', { path: 'name' });
        }
        throw error;
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'catalog.program_created',
        targetType: 'program',
        targetId: id,
        afterRevision: row.revision,
        reason: body.reason ?? null,
        correlationId,
      });
      await this.outbox.enqueue(trx, CatalogEvents.programCreated, {
        organizationId,
        aggregateType: 'program',
        aggregateId: id,
        payload: { programId: id, activityType: row.activity_type, status: row.status },
        correlationId,
      });
      return toProgram(row);
    });
  }

  async update(
    principal: Principal,
    id: string,
    body: UpdateProgramInput,
    correlationId: string | null,
  ): Promise<Program> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, CatalogActions.managePrograms, {
      type: 'program',
      id,
      organizationId,
    });
    return this.uow.run(async ({ trx }) => {
      const current = await trx
        .selectFrom('programs')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!current) throw errors.notFound('program', id);
      assertExpectedRevision(body.expectedRevision, current.revision);
      if (current.status === 'archived') {
        throw errors.invalidTransition('Program', 'archived', 'update');
      }
      let status: ProgramStatus = current.status;
      if (body.status !== undefined && body.status !== current.status) {
        const event: ProgramEvent | null =
          body.status === 'active' ? 'activate' : body.status === 'archived' ? 'archive' : null;
        if (!event) throw errors.invalidTransition('Program', current.status, 'revert_to_draft');
        status = ProgramMachine.next(current.status, event);
      }
      // SPK-REG-002: offerings read the program's age band live, and enrollment evaluates age
      // eligibility from it when the eligibility policy sets no age limits. Changing it under a
      // published offering would change eligibility with no policy version, offering revision or
      // event, so it is refused; a new eligibility policy version with explicit age limits is the
      // versioned path.
      const beforeAgeBand = current.age_band as AgeBand;
      const ageBandChanged =
        body.ageBand !== undefined && !sameAgeBand(beforeAgeBand, body.ageBand);
      if (ageBandChanged) {
        // Lock the program's live offerings: a concurrent publication either commits first and is
        // seen here, or waits for this change and publishes under the new age band.
        const live = await trx
          .selectFrom('offerings')
          .select(['id', 'publication_state'])
          .where('organization_id', '=', organizationId)
          .where('program_id', '=', id)
          .where('publication_state', 'in', ['draft', ...AGE_BAND_FROZEN_STATES])
          .orderBy('id')
          .forShare()
          .execute();
        const offeringIds = live
          .filter((o) =>
            (AGE_BAND_FROZEN_STATES as readonly string[]).includes(o.publication_state),
          )
          .map((o) => o.id);
        if (offeringIds.length > 0) {
          throw errors.resourceConflict(
            'The age band of a program cannot change while it has published offerings; give the offering an eligibility policy version with explicit age limits instead (SPK-REG-002).',
            { code: 'PROGRAM_AGE_BAND_IN_USE', offeringIds: offeringIds.slice(0, 20) },
          );
        }
      }
      let updated;
      try {
        updated = await trx
          .updateTable('programs')
          .set({
            name: body.name,
            description: body.description,
            activity_type: body.activityType,
            format: body.format,
            age_band: body.ageBand === undefined ? undefined : json(body.ageBand),
            status,
            revision: current.revision + 1,
          })
          .where('organization_id', '=', organizationId)
          .where('id', '=', id)
          .where('revision', '=', current.revision)
          .returningAll()
          .executeTakeFirstOrThrow();
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw errors.validation('A program with this name already exists.', { path: 'name' });
        }
        throw error;
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'catalog.program_updated',
        targetType: 'program',
        targetId: id,
        beforeRevision: current.revision,
        afterRevision: updated.revision,
        reason: body.reason ?? null,
        correlationId,
        details: {
          ...(status !== current.status ? { status } : {}),
          ...(ageBandChanged ? { ageBand: { before: beforeAgeBand, after: body.ageBand } } : {}),
        },
      });
      await this.outbox.enqueue(trx, CatalogEvents.programUpdated, {
        organizationId,
        aggregateType: 'program',
        aggregateId: id,
        payload: { programId: id, revision: updated.revision, status: updated.status },
        correlationId,
      });
      return toProgram(updated);
    });
  }

  async get(principal: Principal, id: string): Promise<Program> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, CatalogActions.readCatalog, {
      type: 'program',
      id,
      organizationId,
    });
    const row = await this.db
      .selectFrom('programs')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw errors.notFound('program', id);
    return toProgram(row);
  }

  async list(principal: Principal, query: ListProgramsQuery): Promise<Page<Program>> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, CatalogActions.readCatalog, {
      type: 'program',
      organizationId,
    });
    const cursor = decodeCursor(query.cursor, Cursor);
    let q = this.db
      .selectFrom('programs')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .orderBy('name')
      .orderBy('id')
      .limit(query.limit + 1);
    if (query.status) q = q.where('status', '=', query.status);
    if (query.activityType) q = q.where('activity_type', '=', query.activityType);
    if (cursor) q = q.where(sql<boolean>`(name, id) > (${cursor.name}, ${cursor.id}::uuid)`);
    const rows = await q.execute();
    const items = rows.slice(0, query.limit).map(toProgram);
    const last = rows.length > query.limit ? rows[query.limit - 1] : undefined;
    return { items, nextCursor: last ? encodeCursor({ name: last.name, id: last.id }) : null };
  }
}
