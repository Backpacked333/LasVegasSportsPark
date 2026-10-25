import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  type CostInput,
  type ListCostInputsQuery,
  type Principal,
  type RecordCostInputInput,
  type WithdrawCostInputInput,
} from '@sportspark/contracts';
import { isExclusionViolation, json, type CostInputsTable, type Db } from '@sportspark/db';
import { sql, type Selectable, type SqlBool } from 'kysely';
import {
  assertExpectedRevision,
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  Outbox,
  snapshotActor,
  UnitOfWork,
  type Clock,
  type Trx,
  listFacilityScope,
} from '../../../kernel';
import { ReportingActions } from '../reporting.actions';
import { CostInputRecorded, CostInputWithdrawn } from '../reporting.events';
import { CostInputMachine } from '../reporting.machines';
import { actorOf, iso, isoOrNull, organizationOf } from '../reporting.shared';

type CostInputRow = Omit<Selectable<CostInputsTable>, 'effective_from' | 'effective_to'> & {
  effective_from: string;
  effective_to: string | null;
};

/**
 * Agreed cost inputs (SPK-REPORT-004: "profit or contribution margin requires agreed cost inputs;
 * it cannot be inferred from collections alone"; metric dictionary rule E4; DEC-085). A cost per
 * activity hour for a facility or one of its spaces, with its effective dates, the agreement it
 * comes from and the approving actor (the finance operator or general manager recording it).
 * Inputs are facts: they are never edited — an input is withdrawn and a new one recorded — and
 * active inputs for the same scope, basis and currency never overlap (database exclusion).
 */
@Injectable()
export class CostInputsService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly authorization: AuthorizationService,
  ) {}

  async record(
    principal: Principal,
    input: RecordCostInputInput,
    correlationId: string | null,
  ): Promise<CostInput> {
    const organizationId = organizationOf(principal);
    const facility = await this.db
      .selectFrom('facilities')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('id', '=', input.facilityId)
      .executeTakeFirst();
    if (!facility) throw errors.notFound('facility', input.facilityId);
    await this.authorization.require(principal, ReportingActions.manageCostInputs, {
      type: 'cost_input',
      organizationId,
      facilityId: input.facilityId,
    });
    const resourceId = input.resourceId ?? null;
    if (resourceId) {
      const space = await this.db
        .selectFrom('reporting_resource_units_v')
        .select('resource_id')
        .where('organization_id', '=', organizationId)
        .where('facility_id', '=', input.facilityId)
        .where('resource_id', '=', resourceId)
        .executeTakeFirst();
      if (!space) throw errors.notFound('resource', resourceId);
    }
    const effectiveTo = input.effectiveTo ?? null;
    if (effectiveTo !== null && effectiveTo <= input.effectiveFrom) {
      throw errors.validation('effectiveTo must be after effectiveFrom.');
    }
    const id = newId();
    try {
      await this.unitOfWork.run(async ({ trx }) => {
        await trx
          .insertInto('cost_inputs')
          .values({
            id,
            organization_id: organizationId,
            facility_id: input.facilityId,
            resource_id: resourceId,
            basis: input.basis,
            amount_minor: input.amountMinor,
            currency: input.currency,
            effective_from: input.effectiveFrom,
            effective_to: effectiveTo,
            description: input.description,
            approval_reference: input.approvalReference,
            approved_by: json(snapshotActor(principal)),
            approved_by_person_id: principal.personId,
            recorded_at: this.clock.now(),
            withdrawn_at: null,
            withdrawn_by: null,
            withdrawn_reason: null,
          })
          .execute();
        await this.audit.record(trx, {
          organizationId,
          actor: principal,
          action: 'reporting.cost_input_recorded',
          targetType: 'cost_input',
          targetId: id,
          afterRevision: 1,
          reason: input.reason ?? null,
          correlationId,
          details: {
            facilityId: input.facilityId,
            resourceId,
            basis: input.basis,
            amountMinor: input.amountMinor,
            currency: input.currency,
            effectiveFrom: input.effectiveFrom,
            effectiveTo,
            approvalReference: input.approvalReference,
          },
        });
        await this.outbox.enqueue(trx, CostInputRecorded, {
          organizationId,
          aggregateType: 'cost_input',
          aggregateId: id,
          correlationId,
          payload: { costInputId: id, facilityId: input.facilityId, resourceId },
        });
      });
    } catch (error) {
      if (isExclusionViolation(error)) {
        throw errors.resourceConflict(
          'An agreed cost input already covers part of this period for the same scope and currency; withdraw it first.',
          { code: 'cost_input_overlap' },
        );
      }
      throw error;
    }
    return this.view(await this.load(this.db, organizationId, id));
  }

  async withdraw(
    principal: Principal,
    id: string,
    input: WithdrawCostInputInput,
    correlationId: string | null,
  ): Promise<CostInput> {
    const organizationId = organizationOf(principal);
    const updated = await this.unitOfWork.run(async ({ trx }) => {
      const current = await this.load(trx, organizationId, id, true);
      await this.authorization.require(principal, ReportingActions.manageCostInputs, {
        type: 'cost_input',
        id,
        organizationId,
        facilityId: current.facility_id,
      });
      assertExpectedRevision(input.expectedRevision, current.revision);
      const next = CostInputMachine.next(current.status, 'withdraw');
      const result = await trx
        .updateTable('cost_inputs')
        .set({
          status: next,
          withdrawn_at: this.clock.now(),
          withdrawn_by: json(snapshotActor(principal)),
          withdrawn_reason: input.reason,
          revision: current.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', current.revision)
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) === 0) {
        throw errors.staleRevision(input.expectedRevision, current.revision + 1);
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'reporting.cost_input_withdrawn',
        targetType: 'cost_input',
        targetId: id,
        beforeRevision: current.revision,
        afterRevision: current.revision + 1,
        reason: input.reason,
        correlationId,
      });
      await this.outbox.enqueue(trx, CostInputWithdrawn, {
        organizationId,
        aggregateType: 'cost_input',
        aggregateId: id,
        correlationId,
        payload: { costInputId: id },
      });
      return this.load(trx, organizationId, id);
    });
    return this.view(updated);
  }

  async list(principal: Principal, query: ListCostInputsQuery): Promise<CostInput[]> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, ReportingActions.readCostInputs, {
      type: 'cost_input',
      organizationId,
      facilityId: query.facilityId ?? null,
    });
    let q = this.selectRows(this.db)
      .where('organization_id', '=', organizationId)
      .orderBy('effective_from')
      .orderBy('id');
    if (query.facilityId) q = q.where('facility_id', '=', query.facilityId);
    if (!query.includeWithdrawn) q = q.where('status', '=', 'active');
    // §4.3, §4.14: narrowed by the facilities of the roles that hold the read action.
    const scope = listFacilityScope(principal, ReportingActions.readCostInputs);
    if (scope) {
      q =
        scope.length > 0 ? q.where('facility_id', 'in', [...scope]) : q.where(sql<SqlBool>`false`);
    }
    return (await q.execute()).map((r) => this.view(r));
  }

  private selectRows(db: Db | Trx) {
    return db
      .selectFrom('cost_inputs')
      .select([
        'id',
        'organization_id',
        'facility_id',
        'resource_id',
        'basis',
        'amount_minor',
        'currency',
        sql<string>`effective_from::text`.as('effective_from'),
        sql<string | null>`effective_to::text`.as('effective_to'),
        'description',
        'approval_reference',
        'approved_by',
        'approved_by_person_id',
        'recorded_at',
        'status',
        'withdrawn_at',
        'withdrawn_by',
        'withdrawn_reason',
        'revision',
      ]);
  }

  private async load(
    db: Db | Trx,
    organizationId: string,
    id: string,
    lock = false,
  ): Promise<CostInputRow> {
    let q = this.selectRows(db).where('organization_id', '=', organizationId).where('id', '=', id);
    if (lock) q = q.forUpdate();
    const row = await q.executeTakeFirst();
    if (!row) throw errors.notFound('cost input', id);
    return row as unknown as CostInputRow;
  }

  private view(row: Pick<CostInputRow, keyof CostInputRow> | Record<string, unknown>): CostInput {
    const r = row as CostInputRow;
    return {
      id: r.id,
      facilityId: r.facility_id,
      resourceId: r.resource_id,
      basis: r.basis,
      amountMinor: r.amount_minor,
      currency: r.currency,
      effectiveFrom: r.effective_from,
      effectiveTo: r.effective_to,
      description: r.description,
      approvalReference: r.approval_reference,
      approvedBy: actorOf(r.approved_by),
      recordedAt: iso(r.recorded_at),
      status: r.status,
      withdrawnAt: isoOrNull(r.withdrawn_at),
      withdrawnReason: r.withdrawn_reason,
      revision: r.revision,
    };
  }
}
