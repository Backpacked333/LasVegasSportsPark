import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  systemPrincipal,
  type ListMetricDefinitionsQuery,
  type MetricDefinition,
  type MetricDefinitionHistory,
  type Principal,
} from '@sportspark/contracts';
import type { Db } from '@sportspark/db';
import { sql } from 'kysely';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  Outbox,
  UnitOfWork,
  type Clock,
  type Trx,
} from '../../../kernel';
import { ReportingActions } from '../reporting.actions';
import { MetricDefinitionVersioned } from '../reporting.events';
import { MetricDefinitionMachine } from '../reporting.machines';
import { definitionHash, METRICS, type MetricSpec } from '../reporting.metrics';
import { organizationOf, toMetricDefinition, type MetricDefinitionRow } from '../reporting.shared';

/**
 * Metric definitions (SPK-REPORT-001). The TypeScript registry (reporting.metrics.ts) is the
 * source; each organization receives the registry's definitions as rows the first time it reports
 * (lazily, idempotently). A definition row is never edited: when a registry entry changes, its hash
 * changes and the active version is superseded by a new one (MetricDefinitionMachine), so every
 * stored report run keeps citing the definition it was produced under (SPK-REPORT-007).
 */
@Injectable()
export class MetricDefinitionsService {
  /** Organizations already seeded with a given registry (per process; re-seeding is idempotent). */
  private readonly seeded = new Map<string, string>();

  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly authorization: AuthorizationService,
  ) {}

  static registryHash(registry: readonly MetricSpec[]): string {
    return createHash('sha256')
      .update(registry.map((m) => `${m.key}:${definitionHash(m)}`).join('\n'))
      .digest('hex');
  }

  /** Brings the organization's definitions in line with the registry (new versions where changed). */
  async ensureSeeded(
    organizationId: string,
    registry: readonly MetricSpec[] = METRICS,
  ): Promise<void> {
    const registryHash = MetricDefinitionsService.registryHash(registry);
    if (this.seeded.get(organizationId) === registryHash) return;
    await this.unitOfWork.run(async ({ trx }) => {
      const active = await trx
        .selectFrom('metric_definitions')
        .select(['id', 'metric_key', 'version', 'definition_hash', 'status'])
        .where('organization_id', '=', organizationId)
        .where('status', '=', 'active')
        .forUpdate()
        .execute();
      const activeByKey = new Map(active.map((a) => [a.metric_key, a]));
      const now = this.clock.now();
      for (const spec of registry) {
        const hash = definitionHash(spec);
        const current = activeByKey.get(spec.key);
        if (current?.definition_hash === hash) continue;
        if (current) {
          const next = MetricDefinitionMachine.next(current.status, 'supersede');
          await trx
            .updateTable('metric_definitions')
            .set({ status: next, superseded_at: now, revision: (eb) => eb('revision', '+', 1) })
            .where('organization_id', '=', organizationId)
            .where('id', '=', current.id)
            .where('status', '=', 'active')
            .execute();
        }
        const latest = await trx
          .selectFrom('metric_definitions')
          .select((eb) => eb.fn.max('version').as('version'))
          .where('organization_id', '=', organizationId)
          .where('metric_key', '=', spec.key)
          .executeTakeFirst();
        const id = newId();
        const version = Number(latest?.version ?? 0) + 1;
        const inserted = await this.insert(trx, organizationId, spec, hash, id, version, now);
        if (inserted && current) {
          await this.audit.record(trx, {
            organizationId,
            actor: systemPrincipal(organizationId, 'reporting.metric_registry'),
            action: 'reporting.metric_definition_versioned',
            targetType: 'metric_definition',
            targetId: id,
            beforeRevision: null,
            afterRevision: 1,
            details: { metricKey: spec.key, version, supersededDefinitionId: current.id },
          });
          await this.outbox.enqueue(trx, MetricDefinitionVersioned, {
            organizationId,
            aggregateType: 'metric_definition',
            aggregateId: id,
            payload: {
              metricKey: spec.key,
              version,
              metricDefinitionId: id,
              supersededDefinitionId: current.id,
            },
          });
        }
      }
    });
    this.seeded.set(organizationId, registryHash);
  }

  private async insert(
    trx: Trx,
    organizationId: string,
    spec: MetricSpec,
    hash: string,
    id: string,
    version: number,
    now: Date,
  ): Promise<boolean> {
    const row = await trx
      .insertInto('metric_definitions')
      .values({
        id,
        organization_id: organizationId,
        metric_key: spec.key,
        version,
        name: spec.name,
        report_keys: [...spec.reports],
        business_question: spec.businessQuestion,
        grain: spec.grain,
        numerator: spec.numerator,
        denominator: spec.denominator,
        time_basis: spec.timeBasis,
        exclusions: [...spec.exclusions],
        dimensions: [...spec.dimensions],
        currency: spec.currency,
        freshness: spec.freshness,
        access_scope: spec.accessScope,
        unit: spec.unit,
        requirement_ids: [...spec.requirementIds],
        pending_decisions: [...(spec.pendingDecisions ?? [])],
        definition_hash: hash,
        recorded_at: now,
        superseded_at: null,
      })
      // A concurrent seed of the same registry inserted it first: one active version either way.
      .onConflict((oc) => oc.doNothing())
      .returning('id')
      .executeTakeFirst();
    return row !== undefined;
  }

  /** The active definitions of these metrics, in the order given. */
  async activeFor(
    organizationId: string,
    keys: readonly string[],
    db: Db | Trx = this.unitOfWork.reader(),
  ): Promise<MetricDefinitionRow[]> {
    if (keys.length === 0) return [];
    const rows = await db
      .selectFrom('metric_definitions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('status', '=', 'active')
      .where('metric_key', 'in', [...keys])
      .execute();
    const byKey = new Map(rows.map((r) => [r.metric_key, r]));
    return keys.map((key) => {
      const row = byKey.get(key);
      if (!row) throw errors.internal(`metric definition ${key} is not seeded`);
      return row;
    });
  }

  async list(principal: Principal, query: ListMetricDefinitionsQuery): Promise<MetricDefinition[]> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, ReportingActions.readMetricDefinitions, {
      type: 'metric_definition',
      organizationId,
    });
    await this.ensureSeeded(organizationId);
    let q = this.db
      .selectFrom('metric_definitions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('status', '=', 'active')
      .orderBy('metric_key');
    if (query.report) q = q.where(sql<boolean>`${query.report} = any(report_keys)`);
    return (await q.execute()).map(toMetricDefinition);
  }

  async history(principal: Principal, metricKey: string): Promise<MetricDefinitionHistory> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, ReportingActions.readMetricDefinitions, {
      type: 'metric_definition',
      id: metricKey,
      organizationId,
    });
    await this.ensureSeeded(organizationId);
    const rows = await this.db
      .selectFrom('metric_definitions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('metric_key', '=', metricKey)
      .orderBy('version', 'desc')
      .execute();
    const active = rows.find((r) => r.status === 'active');
    if (!active) throw errors.notFound('metric definition', metricKey);
    return { active: toMetricDefinition(active), versions: rows.map(toMetricDefinition) };
  }
}
