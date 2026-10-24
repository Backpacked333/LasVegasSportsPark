import { Inject, Injectable } from '@nestjs/common';
import type { AuthorityResolution, ImportEntityTypeValue } from '@sportspark/contracts';
import type { Db } from '@sportspark/db';
import { CLOCK, DATABASE, type Clock } from '../../../kernel';
import { MIGRATION_POLICY, type MigrationPolicy } from '../migration.policy';
import {
  importPrincipal,
  type BatchRow,
  type ExceptionRow,
  type MappingRow,
  type RowRow,
} from '../migration.shared';
import { DEPENDENCY_ORDER } from '../staging/categories';
import { AuthorityService } from './authority.service';
import { rowKey, type PersonRef, type PlanningContext, type RowPlan } from './import-planner';
import { ImportTargets } from './import-targets';

const PERSON_REFERENCE_FIELDS = [
  'actorExternalId',
  'subjectExternalId',
  'debtorExternalId',
  'ownerExternalId',
] as const;

/** External ids of persons a staged row refers to (raw payload, before validation). */
export function referencedPersons(row: RowRow): string[] {
  const payload = row.payload as Record<string, unknown>;
  const out: string[] = [];
  for (const field of PERSON_REFERENCE_FIELDS) {
    const value = payload[field];
    if (typeof value === 'string' && value.trim().length > 0) out.push(value.trim());
  }
  const members = payload['memberExternalIds'];
  if (Array.isArray(members)) {
    for (const m of members) if (typeof m === 'string' && m.trim()) out.push(m.trim());
  } else if (typeof members === 'string') {
    for (const m of members.split(';')) if (m.trim()) out.push(m.trim());
  }
  return out;
}

/** Rows in dependency order (persons before what refers to them), then by sequence. */
export function inDependencyOrder(rows: readonly RowRow[]): RowRow[] {
  const rank = new Map(DEPENDENCY_ORDER.map((t, i) => [t, i] as const));
  return [...rows].sort(
    (a, b) =>
      (rank.get(a.entity_type) ?? 99) - (rank.get(b.entity_type) ?? 99) || a.sequence - b.sequence,
  );
}

const CHUNK = 500;

/**
 * Loads everything the planner needs for one batch: its rows, the mappings of its source, the
 * authority resolution of each category it contains (at the clock), the decided exceptions,
 * existing program names and the persons its rows refer to. Reads only — and outside any
 * transaction, because the owning modules' read services use their root connection.
 */
@Injectable()
export class ImportContextBuilder {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(MIGRATION_POLICY) private readonly policy: MigrationPolicy,
    private readonly authority: AuthorityService,
    private readonly targets: ImportTargets,
  ) {}

  async rowsOf(batch: BatchRow): Promise<RowRow[]> {
    return this.db
      .selectFrom('import_rows')
      .selectAll()
      .where('organization_id', '=', batch.organization_id)
      .where('batch_id', '=', batch.id)
      .orderBy('sequence')
      .execute();
  }

  async mappingsFor(
    organizationId: string,
    sourceSystem: string,
    keys: ReadonlyArray<{ entityType: string; externalId: string }>,
  ): Promise<Map<string, MappingRow>> {
    const byType = new Map<string, Set<string>>();
    for (const k of keys) {
      const set = byType.get(k.entityType) ?? new Set<string>();
      set.add(k.externalId);
      byType.set(k.entityType, set);
    }
    const out = new Map<string, MappingRow>();
    for (const [entityType, ids] of byType) {
      const list = [...ids];
      for (let i = 0; i < list.length; i += CHUNK) {
        const rows = await this.db
          .selectFrom('external_mappings')
          .selectAll()
          .where('organization_id', '=', organizationId)
          .where('source_system', '=', sourceSystem)
          .where('entity_type', '=', entityType as MappingRow['entity_type'])
          .where('external_id', 'in', list.slice(i, i + CHUNK))
          .execute();
        for (const row of rows) out.set(rowKey(row.entity_type, row.external_id), row);
      }
    }
    return out;
  }

  async build(batch: BatchRow, rows: readonly RowRow[]): Promise<PlanningContext> {
    const organizationId = batch.organization_id;
    const now = this.clock.now();
    const rowMap = new Map(rows.map((r) => [rowKey(r.entity_type, r.external_id), r] as const));
    const referenced = new Set<string>();
    for (const row of rows) for (const id of referencedPersons(row)) referenced.add(id);
    const mappings = await this.mappingsFor(organizationId, batch.source_system, [
      ...rows.map((r) => ({ entityType: r.entity_type, externalId: r.external_id })),
      ...[...referenced].map((externalId) => ({ entityType: 'person', externalId })),
    ]);

    const authority = new Map<ImportEntityTypeValue, AuthorityResolution>();
    for (const type of new Set(rows.map((r) => r.entity_type))) {
      authority.set(type, await this.authority.resolve(organizationId, type, {}, now));
    }

    const decided: ExceptionRow[] = await this.db
      .selectFrom('import_exceptions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('batch_id', '=', batch.id)
      .where('status', '=', 'decided')
      .execute();
    const decisions = new Map<string, ExceptionRow[]>();
    for (const d of decided) decisions.set(d.row_id, [...(decisions.get(d.row_id) ?? []), d]);

    const programNames = rows.some((r) => r.entity_type === 'program')
      ? await this.targets.programNames(importPrincipal(organizationId, batch.id))
      : new Map<string, string>();

    // Persons the rows refer to that an earlier batch mapped (their kind and status come from
    // identity); persons staged in this batch are noted as their own rows are planned.
    const persons = new Map<string, PersonRef>();
    for (const externalId of referenced) {
      const mapping = mappings.get(rowKey('person', externalId));
      if (mapping?.status !== 'linked' || !mapping.internal_id) continue;
      let person = await this.targets.findPerson(organizationId, mapping.internal_id);
      // A person merged in SportsPark keeps its source identifier; references reach the survivor
      // (SPK-IAM-007: merging preserves source identifiers and history).
      if (person && person.status === 'merged' && person.canonicalPersonId !== person.id) {
        person = await this.targets.findPerson(organizationId, person.canonicalPersonId);
      }
      persons.set(externalId, {
        internalId: person?.id ?? mapping.internal_id,
        kind: person?.kind ?? null,
        status: person?.status ?? null,
        resolvable: person !== null,
      });
    }

    // Record-specific authority: a mapped program may have its own program-scoped assignment.
    const rowAuthority = new Map<string, AuthorityResolution>();
    for (const row of rows) {
      if (row.entity_type !== 'program') continue;
      const mapping = mappings.get(rowKey('program', row.external_id));
      if (mapping?.status !== 'linked' || !mapping.internal_id) continue;
      rowAuthority.set(
        row.id,
        await this.authority.resolve(
          organizationId,
          'program',
          { programId: mapping.internal_id },
          now,
        ),
      );
    }
    return {
      now,
      policy: this.policy,
      rows: rowMap,
      mappings,
      authority,
      rowAuthority,
      decisions,
      persons,
      programNames,
    };
  }

  /**
   * After a person row is planned (dry run) or executed (apply), the persons it stands for
   * become resolvable — or not — for the rows that refer to it.
   */
  static notePerson(
    ctx: PlanningContext,
    row: RowRow,
    plan: RowPlan,
    internalId: string | null,
    succeeded: boolean,
  ): void {
    if (row.entity_type !== 'person') return;
    const values =
      plan.action.type === 'create' || plan.action.type === 'update' ? plan.action.values : null;
    const mapping = ctx.mappings.get(rowKey('person', row.external_id));
    const existing = ctx.persons.get(row.external_id);
    const payloadKind = (row.payload as { kind?: unknown }).kind;
    const stagedKind = payloadKind === 'adult' || payloadKind === 'child' ? payloadKind : null;
    ctx.persons.set(row.external_id, {
      internalId: internalId ?? existing?.internalId ?? mapping?.internal_id ?? null,
      kind: values?.entityType === 'person' ? values.person.kind : (existing?.kind ?? stagedKind),
      status:
        values?.entityType === 'person'
          ? (values.person.status ?? 'active')
          : (existing?.status ?? 'active'),
      resolvable: succeeded && ['created', 'matched', 'updated'].includes(plan.outcome),
    });
  }
}
