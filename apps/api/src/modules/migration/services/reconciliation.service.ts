import { Inject, Injectable } from '@nestjs/common';
import {
  ControlTotalsSchema,
  CreditImportPayloadSchema,
  DomainError,
  errors,
  HouseholdImportPayloadSchema,
  newId,
  OpenObligationImportPayloadSchema,
  RelationshipEvidenceImportPayloadSchema,
  type ApproveReconciliationInput,
  type GenerateReconciliationInput,
  type ImportEntityTypeValue,
  type ImportExceptionResolution,
  type MigrationDiscrepancy,
  type MigrationReconciliationReport,
  type Principal,
  type ReconciliationAreaValue,
  type ReconciliationLevelValue,
  type StaffRole,
} from '@sportspark/contracts';
import {
  json,
  type Db,
  type MappedEntityType,
  type ReconciliationReportsTable,
} from '@sportspark/db';
import type { Selectable } from 'kysely';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  OperationalExceptions,
  Outbox,
  snapshotActor,
  UnitOfWork,
  type Clock,
} from '../../../kernel';
import { AUTHORITY_LOOKUP_PORT, type AuthorityLookupPort } from '../../identity';
import { MigrationActions } from '../migration.actions';
import { MigrationEvents } from '../migration.events';
import { ReconciliationApprovalMachine } from '../migration.machines';
import { MIGRATION_POLICY, type MigrationPolicy } from '../migration.policy';
import {
  applyCorrelationId,
  importPrincipal,
  iso,
  organizationOf,
  type ExceptionRow,
  type MappingRow,
  type Reader,
  type RowRow,
} from '../migration.shared';
import { areasFor, CATEGORY_RULES } from '../staging/categories';
import { compareControlTotals, stagedAmount } from '../staging/control-totals';
import { ImportBatchesService } from './import-batches.service';
import { ImportContextBuilder } from './import-context';
import { rowKey } from './import-planner';
import { ImportTargets } from './import-targets';

type ReportRow = Selectable<ReconciliationReportsTable>;

interface Draft {
  level: ReconciliationLevelValue;
  area: ReconciliationAreaValue;
  entityType: ImportEntityTypeValue;
  code: string;
  externalId?: string | null;
  internalId?: string | null;
  expected?: Record<string, unknown> | null;
  actual?: Record<string, unknown> | null;
  currency?: string | null;
  differenceMinor?: number | null;
  countDifference?: number | null;
  details?: Record<string, unknown>;
}

const APPLIED = new Set(['created', 'matched', 'updated']);
/** Categories whose applied amounts finance holds (opening balances, §5.5). */
const LOADED_MONEY: ReadonlySet<ImportEntityTypeValue> = new Set(['open_obligation', 'credit']);
/** Categories the owning module audits a creation for, under the mapping's correlation id. */
const AUDITED_CREATIONS: readonly Exclude<MappedEntityType, 'relationship_evidence'>[] = [
  'person',
  'household',
  'program',
  'open_obligation',
  'credit',
];
const LEVELS: readonly ReconciliationLevelValue[] = [
  'control_totals',
  'record_identity',
  'relationships',
  'operational_outcomes',
];

/**
 * Reconciliation of an applied batch at the four levels of §5.5:
 *   1. control totals — declared counts and amounts against what was staged, and declared
 *      opening-balance amounts against what finance holds after the apply (`loaded_total_mismatch`);
 *   2. record identity — every row has an outcome and every mapping reaches an existing record;
 *      a row rejected in review is reported with its source amount (`rejected_in_review`), and a
 *      record an apply created that no mapping links is reported (`unlinked_creation`);
 *   3. relationships — imported relationship evidence is effective authority in identity and
 *      households hold their staged members;
 *   4. operational outcomes — opening obligations and credits hold the approved amounts, an
 *      amount re-valued in review is reported against the source amount (`revalued_in_review`),
 *      and active operational records the owning modules cannot import yet (rosters, seasons,
 *      teams, future schedules, preferences) are reported, never assumed present.
 * So review decisions never make the totals appear correct: finance approves every difference
 * between the source's opening balances and SportsPark's explicitly, with a reason
 * (support-migration-07).
 * Every discrepancy is stored as its own row with its own currency: unrelated discrepancies are
 * never netted to make totals appear correct (§5.5). Each area the batch touches is approved by
 * its owners (§5.5: finance approves opening balances, program and league owners approve active
 * participation, operations approves the schedule); accepting discrepancies needs a reason and
 * leaves them listed.
 */
@Injectable()
export class ReconciliationService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(MIGRATION_POLICY) private readonly policy: MigrationPolicy,
    @Inject(AUTHORITY_LOOKUP_PORT) private readonly authority: AuthorityLookupPort,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly batches: ImportBatchesService,
    private readonly contexts: ImportContextBuilder,
    private readonly targets: ImportTargets,
    private readonly operationalExceptions: OperationalExceptions,
  ) {}

  // -------------------------------------------------------------------------------------------
  // Generation
  // -------------------------------------------------------------------------------------------

  async generate(
    principal: Principal,
    batchId: string,
    input: GenerateReconciliationInput,
    correlationId: string | null,
  ): Promise<MigrationReconciliationReport> {
    const batch = await this.batches.authorized(
      this.db,
      principal,
      batchId,
      MigrationActions.reconcile,
    );
    if (batch.status !== 'applied') {
      throw errors.invalidTransition('ImportBatch', batch.status, 'reconcile');
    }
    const organizationId = batch.organization_id;
    const system = importPrincipal(organizationId, batch.id);
    const rows = await this.contexts.rowsOf(batch);
    const mappingIds = rows.map((r) => r.mapping_id).filter((id): id is string => id !== null);
    const mappingsById = new Map<string, MappingRow>();
    for (let i = 0; i < mappingIds.length; i += 500) {
      const chunk = await this.db
        .selectFrom('external_mappings')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', 'in', mappingIds.slice(i, i + 500))
        .execute();
      for (const m of chunk) mappingsById.set(m.id, m);
    }
    const referenced = new Set<string>();
    for (const row of rows) {
      const p = row.payload as Record<string, unknown>;
      for (const f of ['actorExternalId', 'subjectExternalId']) {
        if (typeof p[f] === 'string') referenced.add(p[f] as string);
      }
      const members = HouseholdImportPayloadSchema.safeParse(p);
      if (row.entity_type === 'household' && members.success) {
        for (const m of members.data.memberExternalIds) referenced.add(m);
      }
    }
    const personMappings = await this.contexts.mappingsFor(
      organizationId,
      batch.source_system,
      [...referenced].map((externalId) => ({ entityType: 'person', externalId })),
    );
    const personIdOf = (externalId: string): string | null => {
      const m = personMappings.get(rowKey('person', externalId));
      return m?.status === 'linked' ? m.internal_id : null;
    };
    const exceptions: ExceptionRow[] = await this.db
      .selectFrom('import_exceptions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('batch_id', '=', batch.id)
      .execute();
    const exceptionsByRow = new Map<string, ExceptionRow[]>();
    for (const e of exceptions)
      exceptionsByRow.set(e.row_id, [...(exceptionsByRow.get(e.row_id) ?? []), e]);
    const decidedAs = (row: RowRow, decision: 'accept' | 'reject'): ExceptionRow | undefined =>
      (exceptionsByRow.get(row.id) ?? []).find((e) => e.decision === decision);
    const decisionDetails = (e: ExceptionRow) => ({
      exceptionId: e.id,
      kind: e.kind,
      decisionReason: e.decision_reason,
      decidedByPersonId: e.decided_by_person_id,
      decidedAt: e.decided_at ? iso(e.decided_at) : null,
    });
    const accepted = (row: RowRow): ImportExceptionResolution =>
      Object.assign(
        {},
        ...(exceptionsByRow.get(row.id) ?? [])
          .filter((e) => e.decision === 'accept')
          .map((e) => (e.resolution ?? {}) as ImportExceptionResolution),
      );

    const drafts: Draft[] = [];
    const checked: Record<ReconciliationLevelValue, number> = {
      control_totals: 0,
      record_identity: 0,
      relationships: 0,
      operational_outcomes: 0,
    };

    // Level 1 — control totals.
    const totals = compareControlTotals(
      ControlTotalsSchema.parse(batch.control_totals),
      rows.map((r) => ({ entityType: r.entity_type, payload: r.payload })),
    );
    checked.control_totals = totals.checked;
    for (const d of totals.discrepancies) {
      const key = d.kind === 'count' ? 'count' : 'amountMinor';
      drafts.push({
        level: 'control_totals',
        area: CATEGORY_RULES[d.entityType].area,
        entityType: d.entityType,
        code: d.code,
        expected: d.expected === null ? null : { [key]: d.expected },
        actual: { [key]: d.actual },
        currency: d.currency,
        differenceMinor: d.kind === 'amount' ? d.difference : null,
        countDifference: d.kind === 'count' ? d.difference : null,
      });
    }

    // Level 2 — record identity.
    for (const row of rows) {
      checked.record_identity += 1;
      const area = CATEGORY_RULES[row.entity_type].area;
      if (row.outcome === 'exception') {
        drafts.push({
          level: 'record_identity',
          area,
          entityType: row.entity_type,
          code: 'unresolved_exception',
          externalId: row.external_id,
          details: { reasons: row.reasons },
        });
        continue;
      }
      if (row.outcome === 'skipped') {
        // A row rejected in review is a difference from the source, never silently dropped
        // (§5.5); other skips (history, not supported, nothing owed) are reported elsewhere.
        const rejected = decidedAs(row, 'reject');
        if (rejected) {
          const money = stagedAmount({
            entityType: row.entity_type,
            payload: row.payload as Record<string, unknown>,
          });
          drafts.push({
            level: 'record_identity',
            area,
            entityType: row.entity_type,
            code: 'rejected_in_review',
            externalId: row.external_id,
            ...(money
              ? {
                  expected: { amountMinor: money.amountMinor },
                  actual: { amountMinor: 0 },
                  currency: money.currency,
                  differenceMinor: -money.amountMinor,
                }
              : {}),
            details: decisionDetails(rejected),
          });
        }
        continue;
      }
      if (!row.outcome || !APPLIED.has(row.outcome)) continue;
      const mapping = row.mapping_id ? mappingsById.get(row.mapping_id) : undefined;
      if (!mapping || mapping.status !== 'linked' || !mapping.internal_id) {
        drafts.push({
          level: 'record_identity',
          area,
          entityType: row.entity_type,
          code: 'mapping_missing',
          externalId: row.external_id,
        });
        continue;
      }
      const exists = await this.internalRecordExists(system, row.entity_type, mapping.internal_id);
      if (!exists) {
        drafts.push({
          level: 'record_identity',
          area,
          entityType: row.entity_type,
          code: 'internal_record_missing',
          externalId: row.external_id,
          internalId: mapping.internal_id,
        });
      }
    }

    // Level 2 (continued) — creations no mapping links: an apply that lost its lock may have
    // created a record the apply that took over did not link (support-migration-05).
    const batchMappings = await this.contexts.mappingsFor(
      organizationId,
      batch.source_system,
      rows
        .filter((r) => (AUDITED_CREATIONS as readonly string[]).includes(r.entity_type))
        .map((r) => ({ entityType: r.entity_type, externalId: r.external_id })),
    );
    for (const entityType of AUDITED_CREATIONS) {
      const mappings = [...batchMappings.values()].filter((m) => m.entity_type === entityType);
      const byCorrelation = new Map(mappings.map((m) => [applyCorrelationId(m.id), m]));
      const ids = [...byCorrelation.keys()];
      for (let i = 0; i < ids.length; i += 500) {
        const creations = await this.targets.creationsFor(
          organizationId,
          entityType,
          ids.slice(i, i + 500),
        );
        for (const creation of creations) {
          const mapping = byCorrelation.get(creation.correlationId) as MappingRow;
          if (mapping.status === 'linked' && mapping.internal_id === creation.targetId) continue;
          drafts.push({
            level: 'record_identity',
            area: CATEGORY_RULES[entityType].area,
            entityType,
            code: 'unlinked_creation',
            externalId: mapping.external_id,
            internalId: creation.targetId,
            details: { mappingId: mapping.id, linkedInternalId: mapping.internal_id },
          });
        }
      }
    }

    // Level 3 — relationships and household membership.
    for (const row of rows) {
      if (row.entity_type === 'relationship_evidence') {
        checked.relationships += 1;
        const staged = RelationshipEvidenceImportPayloadSchema.safeParse(row.payload);
        // Rows left as exceptions are reported once, at level 2.
        if (!staged.success || !row.outcome || !APPLIED.has(row.outcome)) continue;
        const actor = personIdOf(staged.data.actorExternalId);
        const subject = personIdOf(staged.data.subjectExternalId);
        const resolution = accepted(row);
        const permissions = resolution.permissions
          ? staged.data.permissions.filter((p) => resolution.permissions?.includes(p))
          : staged.data.permissions;
        for (const permission of permissions) {
          const effective =
            actor !== null &&
            subject !== null &&
            (await this.authority.hasPermission(organizationId, actor, subject, permission));
          if (!effective) {
            drafts.push({
              level: 'relationships',
              area: 'identity',
              entityType: row.entity_type,
              code: 'permission_not_effective',
              externalId: row.external_id,
              expected: { permission },
              actual: { effective: false },
            });
          }
        }
      } else if (row.entity_type === 'household' && row.outcome && APPLIED.has(row.outcome)) {
        checked.relationships += 1;
        const staged = HouseholdImportPayloadSchema.safeParse(row.payload);
        const mapping = row.mapping_id ? mappingsById.get(row.mapping_id) : undefined;
        if (!staged.success || !mapping?.internal_id) continue;
        let members: Set<string>;
        try {
          const household = await this.targets.household(organizationId, mapping.internal_id);
          members = new Set(household.members.map((m) => m.personId));
        } catch (error) {
          if (DomainError.is(error) && error.code === 'NOT_FOUND') continue;
          throw error;
        }
        for (const externalId of staged.data.memberExternalIds) {
          const personId = personIdOf(externalId);
          if (!personId || !members.has(personId)) {
            drafts.push({
              level: 'relationships',
              area: 'identity',
              entityType: 'household',
              code: 'household_member_missing',
              externalId: row.external_id,
              internalId: mapping.internal_id,
              expected: { memberExternalId: externalId },
              actual: { member: false },
            });
          }
        }
      }
    }

    // Level 4 — operational outcomes.
    const notApplied = new Map<ImportEntityTypeValue, string[]>();
    // What finance holds for this batch's applied opening balances, per (category, currency).
    const loaded = new Map<string, number>();
    const addLoaded = (entityType: ImportEntityTypeValue, currency: string, amount: number) => {
      const k = `${entityType}|${currency}`;
      loaded.set(k, (loaded.get(k) ?? 0) + amount);
    };
    const revalued = (row: RowRow, internalId: string, source: number, currency: string): void => {
      const decision = (exceptionsByRow.get(row.id) ?? []).find(
        (e) =>
          e.decision === 'accept' &&
          (e.resolution as ImportExceptionResolution | null)?.amountMinor !== undefined,
      );
      const approved = accepted(row).amountMinor;
      if (approved === undefined || approved === source) return;
      drafts.push({
        level: 'operational_outcomes',
        area: 'finance',
        entityType: row.entity_type,
        code: 'revalued_in_review',
        externalId: row.external_id,
        internalId,
        expected: { amountMinor: source },
        actual: { amountMinor: approved },
        currency,
        differenceMinor: approved - source,
        details: decision ? decisionDetails(decision) : {},
      });
    };
    for (const row of rows) {
      const rule = CATEGORY_RULES[row.entity_type];
      const mapping = row.mapping_id ? mappingsById.get(row.mapping_id) : undefined;
      if (
        row.entity_type === 'open_obligation' &&
        row.outcome &&
        APPLIED.has(row.outcome) &&
        mapping?.internal_id
      ) {
        checked.operational_outcomes += 1;
        const staged = OpenObligationImportPayloadSchema.safeParse(row.payload);
        if (!staged.success) continue;
        const expected = accepted(row).amountMinor ?? staged.data.amountMinor;
        const obligation = await this.targets.obligation(system, mapping.internal_id);
        this.compareMoney(drafts, row, mapping.internal_id, expected, staged.data.currency, {
          amountMinor: obligation.totals.amountMinor,
          currency: obligation.totals.currency,
        });
        revalued(row, mapping.internal_id, staged.data.amountMinor, staged.data.currency);
        addLoaded(row.entity_type, obligation.totals.currency, obligation.totals.amountMinor);
        if (obligation.status === 'canceled') {
          drafts.push({
            level: 'operational_outcomes',
            area: 'finance',
            entityType: row.entity_type,
            code: 'obligation_canceled',
            externalId: row.external_id,
            internalId: mapping.internal_id,
          });
        }
      } else if (
        row.entity_type === 'credit' &&
        row.outcome &&
        APPLIED.has(row.outcome) &&
        mapping?.internal_id
      ) {
        checked.operational_outcomes += 1;
        const staged = CreditImportPayloadSchema.safeParse(row.payload);
        if (!staged.success) continue;
        const expected = accepted(row).amountMinor ?? staged.data.amountMinor;
        const credit = await this.targets.credit(system, mapping.internal_id);
        this.compareMoney(drafts, row, mapping.internal_id, expected, staged.data.currency, {
          amountMinor: credit.originalMinor,
          currency: credit.currency,
        });
        revalued(row, mapping.internal_id, staged.data.amountMinor, staged.data.currency);
        addLoaded(row.entity_type, credit.currency, credit.originalMinor);
      } else if (rule.class === 'not_supported') {
        checked.operational_outcomes += 1;
        const active = (row.payload as { active?: unknown }).active;
        const isActive =
          row.entity_type === 'future_schedule' || active === true || active === 'true';
        if (isActive)
          notApplied.set(row.entity_type, [
            ...(notApplied.get(row.entity_type) ?? []),
            row.external_id,
          ]);
      }
    }
    for (const [entityType, externalIds] of notApplied) {
      drafts.push({
        level: 'operational_outcomes',
        area: CATEGORY_RULES[entityType].area,
        entityType,
        code: 'active_records_not_applied',
        expected: { count: externalIds.length },
        actual: { count: 0 },
        countDifference: -externalIds.length,
        details: {
          externalIds: externalIds.slice(0, 50),
          reason: CATEGORY_RULES[entityType].skip?.code,
        },
      });
    }

    // Level 1 (continued) — declared opening-balance totals against what finance holds after the
    // apply, per category and currency, never netted (§5.5 "verify control totals and
    // operational outcomes"; support-migration-07).
    for (const line of ControlTotalsSchema.parse(batch.control_totals).amounts) {
      if (!LOADED_MONEY.has(line.entityType)) continue;
      checked.control_totals += 1;
      const held = loaded.get(`${line.entityType}|${line.currency}`) ?? 0;
      if (held === line.totalMinor) continue;
      drafts.push({
        level: 'control_totals',
        area: CATEGORY_RULES[line.entityType].area,
        entityType: line.entityType,
        code: 'loaded_total_mismatch',
        expected: { amountMinor: line.totalMinor },
        actual: { amountMinor: held },
        currency: line.currency,
        differenceMinor: held - line.totalMinor,
      });
    }

    const levels = LEVELS.map((level) => {
      const count = drafts.filter((d) => d.level === level).length;
      return {
        level,
        status: count === 0 ? ('balanced' as const) : ('discrepancy' as const),
        checked: checked[level],
        discrepancyCount: count,
      };
    });
    const requiredAreas = areasFor(new Set(rows.map((r) => r.entity_type)));
    const reportId = newId();
    const now = this.clock.now();

    return this.uow.run(async ({ trx }) => {
      const pending = await trx
        .selectFrom('reconciliation_reports')
        .select(['id', 'revision'])
        .where('organization_id', '=', organizationId)
        .where('batch_id', '=', batch.id)
        .where('approval_status', '=', 'pending')
        .forUpdate()
        .executeTakeFirst();
      if (pending) {
        ReconciliationApprovalMachine.next('pending', 'supersede');
        await trx
          .updateTable('reconciliation_reports')
          .set({
            approval_status: 'superseded',
            superseded_by_report_id: reportId,
            revision: pending.revision + 1,
          })
          .where('id', '=', pending.id)
          .execute();
      }
      await trx
        .insertInto('reconciliation_reports')
        .values({
          id: reportId,
          organization_id: organizationId,
          batch_id: batch.id,
          generated_at: now,
          generated_by: json(snapshotActor(principal)),
          generated_by_person_id: principal.personId,
          status: drafts.length === 0 ? 'balanced' : 'discrepancy',
          levels: json(levels),
          discrepancy_count: drafts.length,
          required_areas: requiredAreas,
          approval_completed_at: null,
          superseded_by_report_id: null,
        })
        .execute();
      for (let i = 0; i < drafts.length; i += 250) {
        await trx
          .insertInto('reconciliation_discrepancies')
          .values(
            drafts.slice(i, i + 250).map((d) => ({
              id: newId(),
              organization_id: organizationId,
              report_id: reportId,
              level: d.level,
              area: d.area,
              entity_type: d.entityType,
              code: d.code,
              external_id: d.externalId ?? null,
              internal_id: d.internalId ?? null,
              expected: d.expected ? json(d.expected) : null,
              actual: d.actual ? json(d.actual) : null,
              currency: d.currency ?? null,
              difference_minor: d.differenceMinor ?? null,
              count_difference: d.countDifference ?? null,
              details: json(d.details ?? {}),
            })),
          )
          .execute();
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: MigrationActions.reconcile.id,
        targetType: 'reconciliation_report',
        targetId: reportId,
        afterRevision: 1,
        reason: input.reason ?? null,
        correlationId,
        details: {
          batchId: batch.id,
          discrepancyCount: drafts.length,
          supersededReportId: pending?.id ?? null,
        },
      });
      await this.outbox.enqueue(trx, MigrationEvents.reconciliationGenerated, {
        organizationId,
        aggregateType: 'reconciliation_report',
        aggregateId: reportId,
        correlationId,
        payload: {
          reportId,
          batchId: batch.id,
          status: drafts.length === 0 ? 'balanced' : 'discrepancy',
          discrepancyCount: drafts.length,
        },
      });
      if (drafts.length > 0) {
        await this.operationalExceptions.raise(trx, {
          organizationId,
          category: 'migration.reconciliation_discrepancy',
          severity: 'high',
          title: `Reconciliation of the ${batch.source_system} import shows ${drafts.length} discrepancies`,
          affectedType: 'reconciliation_report',
          affectedId: reportId,
          ownerQueue: 'migration',
          dedupeKey: `migration.reconciliation:${batch.id}`,
          details: { batchId: batch.id, reportId, discrepancyCount: drafts.length },
        });
      }
      return this.view(trx, organizationId, reportId);
    });
  }

  private compareMoney(
    drafts: Draft[],
    row: RowRow,
    internalId: string,
    expectedMinor: number,
    expectedCurrency: string,
    actual: { amountMinor: number; currency: string },
  ): void {
    if (actual.currency !== expectedCurrency) {
      drafts.push({
        level: 'operational_outcomes',
        area: 'finance',
        entityType: row.entity_type,
        code: 'currency_mismatch',
        externalId: row.external_id,
        internalId,
        expected: { currency: expectedCurrency, amountMinor: expectedMinor },
        actual: { currency: actual.currency, amountMinor: actual.amountMinor },
      });
      return;
    }
    if (actual.amountMinor !== expectedMinor) {
      drafts.push({
        level: 'operational_outcomes',
        area: 'finance',
        entityType: row.entity_type,
        code: 'amount_mismatch',
        externalId: row.external_id,
        internalId,
        expected: { amountMinor: expectedMinor },
        actual: { amountMinor: actual.amountMinor },
        currency: actual.currency,
        differenceMinor: actual.amountMinor - expectedMinor,
      });
    }
  }

  private async internalRecordExists(
    system: Principal,
    entityType: ImportEntityTypeValue,
    internalId: string,
  ): Promise<boolean> {
    const organizationId = system.organizationId as string;
    try {
      switch (entityType) {
        case 'person':
          return (await this.targets.findPerson(organizationId, internalId)) !== null;
        case 'household':
          await this.targets.household(organizationId, internalId);
          return true;
        case 'program':
          await this.targets.program(system, internalId);
          return true;
        case 'open_obligation':
          await this.targets.obligation(system, internalId);
          return true;
        case 'credit':
          await this.targets.credit(system, internalId);
          return true;
        default:
          // Relationships are verified as effective authority at level 3.
          return true;
      }
    } catch (error) {
      if (DomainError.is(error) && error.code === 'NOT_FOUND') return false;
      throw error;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Reads and approvals
  // -------------------------------------------------------------------------------------------

  private async view(
    db: Reader,
    organizationId: string,
    reportId: string,
  ): Promise<MigrationReconciliationReport> {
    const report = (await db
      .selectFrom('reconciliation_reports')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', reportId)
      .executeTakeFirst()) as ReportRow;
    const discrepancies = await db
      .selectFrom('reconciliation_discrepancies')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('report_id', '=', reportId)
      .orderBy('level')
      .orderBy('entity_type')
      .orderBy('code')
      .orderBy('external_id')
      .execute();
    const approvals = await db
      .selectFrom('reconciliation_approvals')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('report_id', '=', reportId)
      .orderBy('decided_at')
      .execute();
    return {
      id: report.id,
      batchId: report.batch_id,
      generatedAt: iso(report.generated_at),
      generatedBy: snapshotOf(report.generated_by),
      status: report.status,
      levels: report.levels as MigrationReconciliationReport['levels'],
      discrepancyCount: report.discrepancy_count,
      requiredAreas: report.required_areas,
      approvalStatus: report.approval_status,
      approvals: approvals.map((a) => ({
        area: a.area,
        decision: a.decision,
        approverPersonId: a.approver_person_id,
        approverRole: a.approver_role as StaffRole,
        reason: a.reason,
        acknowledgedDiscrepancies: a.acknowledged_discrepancies,
        decidedAt: iso(a.decided_at),
      })),
      discrepancies: discrepancies.map((d): MigrationDiscrepancy => ({
        id: d.id,
        level: d.level,
        area: d.area,
        entityType: d.entity_type,
        code: d.code,
        externalId: d.external_id,
        internalId: d.internal_id,
        expected: d.expected ?? null,
        actual: d.actual ?? null,
        currency: d.currency,
        differenceMinor: d.difference_minor === null ? null : Number(d.difference_minor),
        countDifference: d.count_difference,
        details: d.details,
      })),
      supersededByReportId: report.superseded_by_report_id,
      revision: report.revision,
    };
  }

  private async loadAuthorized(
    db: Reader,
    principal: Principal,
    reportId: string,
    action: (typeof MigrationActions)[keyof typeof MigrationActions],
    forUpdate = false,
  ): Promise<ReportRow> {
    const organizationId = organizationOf(principal);
    let q = db
      .selectFrom('reconciliation_reports')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', reportId);
    if (forUpdate) q = q.forUpdate();
    const report = await q.executeTakeFirst();
    if (!report) throw errors.protectedNotFound('reconciliation report');
    await this.authorization.require(principal, action, {
      type: 'reconciliation_report',
      id: reportId,
      organizationId,
      protected: true,
    });
    return report;
  }

  async get(principal: Principal, reportId: string): Promise<MigrationReconciliationReport> {
    const report = await this.loadAuthorized(
      this.db,
      principal,
      reportId,
      MigrationActions.readReconciliation,
    );
    return this.view(this.db, report.organization_id, report.id);
  }

  async listForBatch(
    principal: Principal,
    batchId: string,
  ): Promise<MigrationReconciliationReport[]> {
    const batch = await this.batches.authorized(
      this.db,
      principal,
      batchId,
      MigrationActions.readReconciliation,
    );
    const reports = await this.db
      .selectFrom('reconciliation_reports')
      .select('id')
      .where('organization_id', '=', batch.organization_id)
      .where('batch_id', '=', batch.id)
      .orderBy('generated_at', 'desc')
      .execute();
    const out: MigrationReconciliationReport[] = [];
    for (const r of reports) out.push(await this.view(this.db, batch.organization_id, r.id));
    return out;
  }

  async decide(
    principal: Principal,
    reportId: string,
    input: ApproveReconciliationInput,
    correlationId: string | null,
  ): Promise<MigrationReconciliationReport> {
    return this.uow.run(async ({ trx }) => {
      const report = await this.loadAuthorized(
        trx,
        principal,
        reportId,
        MigrationActions.approveReconciliation,
        true,
      );
      if (input.expectedRevision !== undefined && input.expectedRevision !== report.revision) {
        throw errors.staleRevision(input.expectedRevision, report.revision);
      }
      ReconciliationApprovalMachine.next(
        report.approval_status,
        input.decision === 'approved' ? 'approve' : 'reject',
      );
      if (!report.required_areas.includes(input.area)) {
        throw errors.validation(`This report needs no ${input.area} approval.`, {
          requiredAreas: report.required_areas,
        });
      }
      const approvers = this.policy.areaApprovers[input.area];
      const role = approvers.find((r) => principal.staffRoles.includes(r));
      if (!role || !principal.personId) {
        throw errors.accessDenied(
          `The ${input.area} area is approved by ${approvers.join(', ')} (§5.5).`,
          {
            area: input.area,
          },
        );
      }
      const existing = await trx
        .selectFrom('reconciliation_approvals')
        .select('id')
        .where('organization_id', '=', report.organization_id)
        .where('report_id', '=', report.id)
        .where('area', '=', input.area)
        .executeTakeFirst();
      if (existing) {
        throw errors.resourceConflict('This area of the report is already decided.', {
          code: 'AREA_DECIDED',
        });
      }
      const counted = await trx
        .selectFrom('reconciliation_discrepancies')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('organization_id', '=', report.organization_id)
        .where('report_id', '=', report.id)
        .where('area', '=', input.area)
        .executeTakeFirstOrThrow();
      const areaDiscrepancies = Number(counted.n);
      if (!input.reason && (input.decision === 'rejected' || areaDiscrepancies > 0)) {
        throw errors.validation(
          input.decision === 'rejected'
            ? 'A rejection needs a reason.'
            : 'Accepting discrepancies needs a reason; they stay listed and are never netted (§5.5).',
          { discrepancies: areaDiscrepancies },
        );
      }
      const now = this.clock.now();
      await trx
        .insertInto('reconciliation_approvals')
        .values({
          id: newId(),
          organization_id: report.organization_id,
          report_id: report.id,
          area: input.area,
          decision: input.decision,
          approver: json(snapshotActor(principal)),
          approver_person_id: principal.personId,
          approver_role: role,
          reason: input.reason ?? null,
          acknowledged_discrepancies: areaDiscrepancies,
          decided_at: now,
        })
        .execute();
      const decisions = await trx
        .selectFrom('reconciliation_approvals')
        .select(['area', 'decision'])
        .where('organization_id', '=', report.organization_id)
        .where('report_id', '=', report.id)
        .execute();
      let approvalStatus: 'pending' | 'approved' | 'rejected' = 'pending';
      if (decisions.some((d) => d.decision === 'rejected')) {
        approvalStatus = ReconciliationApprovalMachine.next('pending', 'reject') as 'rejected';
      } else if (
        report.required_areas.every((area) =>
          decisions.some((d) => d.area === area && d.decision === 'approved'),
        )
      ) {
        approvalStatus = ReconciliationApprovalMachine.next('pending', 'approve') as 'approved';
      }
      await trx
        .updateTable('reconciliation_reports')
        .set({
          approval_status: approvalStatus,
          approval_completed_at: approvalStatus === 'pending' ? null : now,
          revision: report.revision + 1,
        })
        .where('id', '=', report.id)
        .where('revision', '=', report.revision)
        .execute();
      await this.audit.record(trx, {
        organizationId: report.organization_id,
        actor: principal,
        action: MigrationActions.approveReconciliation.id,
        targetType: 'reconciliation_report',
        targetId: report.id,
        beforeRevision: report.revision,
        afterRevision: report.revision + 1,
        reason: input.reason ?? null,
        correlationId,
        details: {
          area: input.area,
          decision: input.decision,
          role,
          acknowledgedDiscrepancies: areaDiscrepancies,
          approvalStatus,
        },
      });
      await this.outbox.enqueue(trx, MigrationEvents.reconciliationDecided, {
        organizationId: report.organization_id,
        aggregateType: 'reconciliation_report',
        aggregateId: report.id,
        correlationId,
        payload: {
          reportId: report.id,
          batchId: report.batch_id,
          area: input.area,
          decision: input.decision,
          approvalStatus,
        },
      });
      return this.view(trx, report.organization_id, report.id);
    });
  }
}

function snapshotOf(value: unknown): MigrationReconciliationReport['generatedBy'] {
  const v = (value ?? {}) as Record<string, unknown>;
  return {
    kind: String(v['kind'] ?? 'unknown'),
    accountId: (v['accountId'] as string | null | undefined) ?? null,
    personId: (v['personId'] as string | null | undefined) ?? null,
    staffRoles: Array.isArray(v['staffRoles']) ? (v['staffRoles'] as string[]) : [],
    sessionId: (v['sessionId'] as string | null | undefined) ?? null,
    actorLabel: String(v['actorLabel'] ?? 'unknown'),
  };
}
