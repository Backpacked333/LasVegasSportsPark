import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  FIELD_PREPARATION_ITEMS,
  newId,
  type ActorSnapshot,
  type FieldPreparation,
  type FieldPreparationDay,
  type FieldPreparationItem,
  type ListFieldPreparationsQuery,
  type MarkFieldReadyInput,
  type Principal,
  type RecordFieldPreparationInput,
} from '@sportspark/contracts';
import { json, type Db, type FieldPreparationsTable } from '@sportspark/db';
import { sql, type Selectable } from 'kysely';
import {
  assertExpectedRevision,
  AuditWriter,
  AuthorizationService,
  executorFor,
  Outbox,
  snapshotActor,
  UnitOfWork,
  type Clock,
} from '../../../kernel';
import { CLOCK, DATABASE } from '../../../kernel/tokens';
import { addDays, localDateOf, ResourcesService } from '../../scheduling';
import { FacilitiesActions } from '../facilities.actions';
import { FieldMarkedReady } from '../facilities.events';
import { FieldPreparationMachine } from '../facilities.state-machines';
import {
  FacilitiesReader,
  iso,
  isoOrNull,
  organizationOf,
  type DbHandle,
} from './facilities-reader';

type PreparationRow = Selectable<FieldPreparationsTable> & { day: string };

function toView(row: PreparationRow): FieldPreparation {
  return {
    id: row.id,
    facilityId: row.facility_id,
    resourceId: row.resource_id,
    date: row.day,
    checkedItems: FIELD_PREPARATION_ITEMS.filter((i) => row.checked_items.includes(i)),
    status: row.status,
    readyAt: isoOrNull(row.ready_at),
    readyBy: (row.ready_by as unknown as ActorSnapshot | null) ?? null,
    updatedBy: row.updated_by as unknown as ActorSnapshot,
    revision: row.revision,
    updatedAt: iso(row.updated_at),
  };
}

/** Every checklist item ticked. */
export function preparationComplete(items: readonly FieldPreparationItem[]): boolean {
  return FIELD_PREPARATION_ITEMS.every((i) => items.includes(i));
}

/**
 * The field crew's daily pitch preparation (migration 0975; SPK-FAC-001, SPK-READY-001 field
 * readiness, SPK-UX-006; staff redesign Phase 8 "Field crew · Fields"). One record per pitch and
 * facility-local day: the crew ticks the checklist (lines, goals anchored, nets, corner flags) and
 * marks the pitch ready once every item is ticked (FieldPreparationMachine `mark_ready`; the
 * database refuses a ready record that misses an item). Unticking an item of a ready pitch reopens
 * it (`reopen`). Reads need `facilities.view_maintenance` (Today's field check for the desk and
 * the managers), writes `facilities.prepare_field`. A day is today or tomorrow in the facility's
 * time zone (the crew may prepare the evening before), never another (SPK-SCHED-008).
 */
@Injectable()
export class FieldPreparationsService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly reader: FacilitiesReader,
    private readonly resources: ResourcesService,
  ) {}

  /** `GET /v1/field-preparations?facilityId=&date=`. */
  async list(
    principal: Principal,
    query: ListFieldPreparationsQuery,
  ): Promise<FieldPreparationDay> {
    const organizationId = organizationOf(principal);
    const db = executorFor(this.db);
    const facility = await this.reader.loadFacility(db, organizationId, query.facilityId);
    await this.authorization.require(principal, FacilitiesActions.viewMaintenance, {
      type: 'facility',
      id: facility.id,
      organizationId,
      facilityId: facility.id,
    });
    const date = query.date ?? localDateOf(facility.timezone, this.clock.now());
    const rows = await this.select(db)
      .where('organization_id', '=', organizationId)
      .where('facility_id', '=', facility.id)
      .where('local_date', '=', date)
      .orderBy('created_at')
      .execute();
    return {
      facilityId: facility.id,
      date,
      timezone: facility.timezone,
      checklist: [...FIELD_PREPARATION_ITEMS],
      items: rows.map(toView),
    };
  }

  /** `POST /v1/field-preparations`: tick or untick the checklist (creating the day's record). */
  async record(
    principal: Principal,
    input: RecordFieldPreparationInput,
    correlationId?: string,
  ): Promise<FieldPreparation> {
    const organizationId = organizationOf(principal);
    const facility = await this.reader.loadFacility(
      executorFor(this.db),
      organizationId,
      input.facilityId,
    );
    const target = {
      type: 'facility',
      id: facility.id,
      organizationId,
      facilityId: facility.id,
    };
    await this.authorization.require(principal, FacilitiesActions.prepareField, target);
    const resource = await this.resources.getResource(principal, input.resourceId);
    if (resource.facilityId !== facility.id) {
      throw errors.validation('The pitch belongs to another facility.', {
        code: 'resource_other_facility',
        resourceId: resource.id,
      });
    }
    if (resource.kind !== 'pitch') {
      throw errors.validation('Only a whole pitch is prepared; its halves share its record.', {
        code: 'not_a_pitch',
        resourceId: resource.id,
        kind: resource.kind,
      });
    }
    this.assertDay(facility.timezone, input.date);
    const checked = FIELD_PREPARATION_ITEMS.filter((i) => input.checkedItems.includes(i));
    return this.uow.run(async ({ trx }) => {
      const current = await this.select(trx)
        .where('organization_id', '=', organizationId)
        .where('resource_id', '=', resource.id)
        .where('local_date', '=', input.date)
        .forUpdate()
        .executeTakeFirst();
      const actor = json(snapshotActor(principal));
      let row: PreparationRow;
      if (!current) {
        const id = newId();
        await trx
          .insertInto('field_preparations')
          .values({
            id,
            organization_id: organizationId,
            facility_id: facility.id,
            resource_id: resource.id,
            local_date: input.date,
            checked_items: checked,
            updated_by: actor,
          })
          .execute();
        row = await this.load(trx, organizationId, id);
      } else {
        if (input.expectedRevision === undefined) {
          throw errors.validation(
            'expectedRevision is required once the pitch is being prepared.',
            {
              code: 'expected_revision_required',
              preparationId: current.id,
              revision: current.revision,
            },
          );
        }
        assertExpectedRevision(input.expectedRevision, current.revision);
        // Unticking an item of a ready pitch reopens it (FieldPreparationMachine `reopen`).
        const reopen = current.status === 'ready' && !preparationComplete(checked);
        const status = reopen
          ? FieldPreparationMachine.next(current.status, 'reopen')
          : current.status;
        await trx
          .updateTable('field_preparations')
          .set({
            checked_items: checked,
            status,
            ...(reopen ? { ready_at: null, ready_by: null, ready_by_person_id: null } : {}),
            updated_by: actor,
            revision: current.revision + 1,
          })
          .where('organization_id', '=', organizationId)
          .where('id', '=', current.id)
          .where('revision', '=', current.revision)
          .execute();
        row = await this.load(trx, organizationId, current.id);
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: FacilitiesActions.prepareField.id,
        targetType: 'field_preparation',
        targetId: row.id,
        beforeRevision: current?.revision ?? null,
        afterRevision: row.revision,
        reason: input.reason ?? null,
        correlationId: correlationId ?? null,
        details: {
          resourceId: row.resource_id,
          date: row.day,
          checkedItems: checked,
          previousItems: current ? current.checked_items : [],
          reopened: current?.status === 'ready' && row.status !== 'ready',
        },
      });
      return toView(row);
    });
  }

  /** `POST /v1/field-preparations/{id}/ready`: every item ticked → ready. */
  async markReady(
    principal: Principal,
    preparationId: string,
    input: MarkFieldReadyInput,
    correlationId?: string,
  ): Promise<FieldPreparation> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const current = await this.select(trx)
        .where('organization_id', '=', organizationId)
        .where('id', '=', preparationId)
        .forUpdate()
        .executeTakeFirst();
      if (!current) throw errors.notFound('field_preparation', preparationId);
      await this.authorization.require(principal, FacilitiesActions.prepareField, {
        type: 'field_preparation',
        id: current.id,
        organizationId,
        facilityId: current.facility_id,
      });
      assertExpectedRevision(input.expectedRevision, current.revision);
      const status = FieldPreparationMachine.next(current.status, 'mark_ready');
      const missing = FIELD_PREPARATION_ITEMS.filter((i) => !current.checked_items.includes(i));
      if (missing.length > 0) {
        throw errors.eligibility('Tick every item of the checklist before marking it ready.', {
          code: 'checklist_incomplete',
          missingItems: missing,
        });
      }
      const now = this.clock.now();
      await trx
        .updateTable('field_preparations')
        .set({
          status,
          ready_at: now,
          ready_by: json(snapshotActor(principal)),
          ready_by_person_id: principal.personId,
          updated_by: json(snapshotActor(principal)),
          revision: current.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', current.id)
        .where('revision', '=', current.revision)
        .execute();
      const row = await this.load(trx, organizationId, current.id);
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'facilities.field_marked_ready',
        targetType: 'field_preparation',
        targetId: row.id,
        beforeRevision: current.revision,
        afterRevision: row.revision,
        reason: input.reason ?? null,
        correlationId: correlationId ?? null,
        details: { resourceId: row.resource_id, date: row.day },
      });
      await this.outbox.enqueue(trx, FieldMarkedReady, {
        organizationId,
        aggregateType: 'field_preparation',
        aggregateId: row.id,
        payload: {
          preparationId: row.id,
          facilityId: row.facility_id,
          resourceId: row.resource_id,
          date: row.day,
        },
        correlationId: correlationId ?? null,
      });
      return toView(row);
    });
  }

  /** Today or tomorrow in the facility's zone (SPK-SCHED-008); any other day is refused. */
  private assertDay(timezone: string, date: string): void {
    const today = localDateOf(timezone, this.clock.now());
    if (date !== today && date !== addDays(today, 1)) {
      throw errors.validation('A pitch is prepared for today or tomorrow only.', {
        code: 'date_out_of_range',
        date,
        today,
      });
    }
  }

  private select(db: DbHandle) {
    return db
      .selectFrom('field_preparations')
      .selectAll()
      .select(sql<string>`to_char(local_date, 'YYYY-MM-DD')`.as('day'));
  }

  private async load(db: DbHandle, organizationId: string, id: string): Promise<PreparationRow> {
    return this.select(db)
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  }
}
