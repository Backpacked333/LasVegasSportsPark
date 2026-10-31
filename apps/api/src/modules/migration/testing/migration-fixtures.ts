import {
  newId,
  type AuthoritativeSystemValue,
  type ControlTotals,
  type GrantPermissionValue,
  type ImportEntityTypeValue,
  type StagedRow,
} from '@sportspark/contracts';
import { json, type Db, type MappedEntityType } from '@sportspark/db';
import type { Clock } from '../../../kernel';
import { MAPPING_COLUMN, NO_TARGETS, TEAM_ENTRY_COLUMN } from '../migration.shared';
import { payloadHash } from '../staging/checksum';

/**
 * Migration fixtures for downstream module tests. They write rows directly (fast, no HTTP); the
 * context is structural so a `TestApp` from apps/api/src/testing satisfies it.
 */
export interface MigrationFixtureContext {
  db: Db;
  clock: Clock;
  organizationId: string;
}

const SYSTEM_ACTOR = { kind: 'system', actorLabel: 'fixtures' };

/** Records which system is authoritative for a category (default: organization scope, from now). */
export async function createAuthorityAssignmentFixture(
  ctx: MigrationFixtureContext,
  input: {
    recordCategory: ImportEntityTypeValue;
    authoritativeSystem: AuthoritativeSystemValue;
    facilityId?: string;
    programId?: string;
    competitionId?: string;
    effectiveFrom?: Date;
    effectiveTo?: Date | null;
    organizationId?: string;
  },
): Promise<string> {
  const id = newId();
  const scopeKind = input.facilityId
    ? 'facility'
    : input.programId
      ? 'program'
      : input.competitionId
        ? 'competition'
        : 'organization';
  await ctx.db
    .insertInto('authority_assignments')
    .values({
      id,
      organization_id: input.organizationId ?? ctx.organizationId,
      record_category: input.recordCategory,
      scope_kind: scopeKind,
      facility_id: input.facilityId ?? null,
      program_id: input.programId ?? null,
      competition_id: input.competitionId ?? null,
      authoritative_system: input.authoritativeSystem,
      effective_from: input.effectiveFrom ?? ctx.clock.now(),
      effective_to: input.effectiveTo ?? null,
      reason: 'fixture',
      policy_references: [],
      approved_by: json(SYSTEM_ACTOR),
      approved_by_person_id: null,
      supersedes_assignment_id: null,
      ended_at: null,
      ended_by: null,
      end_reason: null,
    })
    .execute();
  return id;
}

/** Legacy authority for every listed category: the precondition of importing them (§5.6). */
export async function legacyAuthorityFixture(
  ctx: MigrationFixtureContext,
  categories: readonly ImportEntityTypeValue[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const recordCategory of categories) {
    ids.push(
      await createAuthorityAssignmentFixture(ctx, {
        recordCategory,
        authoritativeSystem: 'legacy',
      }),
    );
  }
  return ids;
}

// ---------------------------------------------------------------------------------------------
// Staged row builders (neutral staging contract, staging-v1)
// ---------------------------------------------------------------------------------------------

export function stagedPerson(
  externalId: string,
  payload: Partial<{
    givenName: string;
    familyName: string;
    dateOfBirth: string;
    kind: 'adult' | 'child';
    email: string;
    phone: string;
    status: 'active' | 'inactive';
  }> = {},
): StagedRow {
  return {
    entityType: 'person',
    externalId,
    payload: {
      givenName: 'Given',
      familyName: `Family-${externalId}`,
      dateOfBirth: '1984-03-02',
      ...payload,
    },
  };
}

export function stagedHousehold(
  externalId: string,
  name: string,
  memberExternalIds: string[],
): StagedRow {
  return { entityType: 'household', externalId, payload: { name, memberExternalIds } };
}

export function stagedRelationship(
  externalId: string,
  payload: {
    actorExternalId: string;
    subjectExternalId: string;
    kind?: 'guardian' | 'delegate' | 'caregiver';
    permissions?: GrantPermissionValue[];
    basis?: 'documented' | 'inferred' | 'self_reported';
  },
): StagedRow {
  return {
    entityType: 'relationship_evidence',
    externalId,
    payload: {
      kind: 'guardian',
      permissions: ['view', 'register', 'pay', 'receive_messages', 'complete_forms'],
      basis: 'documented',
      ...payload,
    },
  };
}

export function stagedObligation(
  externalId: string,
  payload: {
    debtorExternalId: string;
    amountMinor: number;
    currency?: string;
    dueAt?: string;
    description?: string;
    originalAmountMinor?: number;
    paidMinor?: number;
    disputed?: boolean;
  },
): StagedRow {
  return {
    entityType: 'open_obligation',
    externalId,
    payload: {
      currency: 'USD',
      dueAt: '2027-02-01T00:00:00.000Z',
      description: `Opening balance ${externalId}`,
      ...payload,
    },
  };
}

export function stagedCredit(
  externalId: string,
  payload: { ownerExternalId: string; amountMinor: number; currency?: string; expiresAt?: string },
): StagedRow {
  return { entityType: 'credit', externalId, payload: { currency: 'USD', ...payload } };
}

// MIG-02: operational categories created through the owning modules' import commands.

export function stagedSeason(
  externalId: string,
  payload: {
    competitionId: string;
    ruleSetId: string;
    name?: string;
    startsOn?: string;
    endsOn?: string;
    status?: 'draft' | 'open' | 'active' | 'completed' | 'archived';
  },
): StagedRow {
  return {
    entityType: 'season',
    externalId,
    payload: {
      name: `Season ${externalId}`,
      startsOn: '2027-01-04',
      endsOn: '2027-04-30',
      status: 'active',
      ...payload,
    },
  };
}

export function stagedTeam(
  externalId: string,
  payload: Partial<{ name: string; primaryColor: string; status: 'active' | 'inactive' }> = {},
): StagedRow {
  return {
    entityType: 'team',
    externalId,
    payload: { record: 'team', name: `Team ${externalId}`, ...payload },
  };
}

export function stagedTeamEntry(
  externalId: string,
  payload: {
    teamExternalId: string;
    seasonExternalId: string;
    status?: 'applied' | 'approved';
    appliedAt?: string;
    approvedAt?: string;
    captainExternalId?: string;
    divisionId?: string;
  },
): StagedRow {
  const status = payload.status ?? 'approved';
  return {
    entityType: 'team',
    externalId,
    payload: {
      record: 'entry',
      appliedAt: '2026-12-01T18:00:00.000Z',
      ...(status === 'approved' ? { approvedAt: '2026-12-05T18:00:00.000Z' } : {}),
      ...payload,
      status,
    },
  };
}

export function stagedRoster(
  externalId: string,
  payload: {
    entryExternalId: string;
    personExternalId: string;
    status?: 'active' | 'guest' | 'substitute';
    effectiveFrom?: string;
    effectiveTo?: string;
    jerseyNumber?: number;
  },
): StagedRow {
  return {
    entityType: 'roster',
    externalId,
    payload: { status: 'active', effectiveFrom: '2026-12-05T18:00:00.000Z', ...payload },
  };
}

export function stagedEvent(
  externalId: string,
  payload: {
    facilityId: string;
    resourceIds: string[];
    scheduledStart: string;
    scheduledEnd: string;
    kind?: string;
    title?: string;
  },
): StagedRow {
  return {
    entityType: 'future_schedule',
    externalId,
    payload: { kind: 'game', title: `Event ${externalId}`, ...payload },
  };
}

export function stagedPreferences(
  externalId: string,
  payload: {
    personExternalId: string;
    preferences: Array<{
      channel: 'in_app' | 'push' | 'email' | 'sms';
      category: 'operational' | 'promotional';
      enabled: boolean;
    }>;
  },
): StagedRow {
  return { entityType: 'communication_preference', externalId, payload };
}

/** Control totals that match the staged rows exactly (counts per type, amounts per currency). */
export function controlTotalsFor(rows: readonly StagedRow[]): ControlTotals {
  const counts: Record<string, number> = {};
  const amounts = new Map<
    string,
    {
      entityType: ControlTotals['amounts'][number]['entityType'];
      currency: string;
      totalMinor: number;
    }
  >();
  for (const row of rows) {
    counts[row.entityType] = (counts[row.entityType] ?? 0) + 1;
    const field = row.entityType === 'order' ? 'totalMinor' : 'amountMinor';
    if (['open_obligation', 'credit', 'refund', 'order'].includes(row.entityType)) {
      const amount = Number(row.payload[field]);
      const currency = String(row.payload['currency'] ?? 'USD');
      const key = `${row.entityType}|${currency}`;
      const entry = amounts.get(key) ?? {
        entityType: row.entityType as ControlTotals['amounts'][number]['entityType'],
        currency,
        totalMinor: 0,
      };
      entry.totalMinor += amount;
      amounts.set(key, entry);
    }
  }
  return { counts, amounts: [...amounts.values()] };
}

/** A received batch with staged rows, written directly (staging only; no validation). */
export async function createImportBatchFixture(
  ctx: MigrationFixtureContext,
  input: {
    rows: readonly StagedRow[];
    sourceSystem?: string;
    controlTotals?: ControlTotals;
    organizationId?: string;
  },
): Promise<{ batchId: string; rowIds: string[] }> {
  const organizationId = input.organizationId ?? ctx.organizationId;
  const batchId = newId();
  const now = ctx.clock.now();
  await ctx.db
    .insertInto('import_batches')
    .values({
      id: batchId,
      organization_id: organizationId,
      source_system: input.sourceSystem ?? 'legacy-fixture',
      snapshot_taken_at: now,
      received_at: now,
      transformation_version: 'fixture-v1',
      declared_checksum: null,
      declared_row_count: null,
      checksum: null,
      control_totals: json(input.controlTotals ?? controlTotalsFor(input.rows)),
      row_count: input.rows.length,
      validated_at: null,
      validated_by: null,
      reviewed_at: null,
      reviewed_by: null,
      review_reason: null,
      apply_started_at: null,
      apply_lock_operation_id: null,
      apply_lock_until: null,
      applied_operation_id: null,
      applied_at: null,
      applied_by: null,
      aborted_at: null,
      aborted_by: null,
      abort_reason: null,
      submitted_by: json(SYSTEM_ACTOR),
      submitted_by_person_id: null,
    })
    .execute();
  const rowIds: string[] = [];
  let sequence = 0;
  for (const row of input.rows) {
    const id = newId();
    sequence += 1;
    rowIds.push(id);
    await ctx.db
      .insertInto('import_rows')
      .values({
        id,
        organization_id: organizationId,
        batch_id: batchId,
        sequence,
        entity_type: row.entityType,
        external_id: row.externalId,
        payload: json(row.payload),
        payload_hash: payloadHash(row.payload),
        planned_outcome: null,
        outcome: null,
        mapping_id: null,
        applied_at: null,
      })
      .execute();
  }
  return { batchId, rowIds };
}

/** Mapped types created through an import command: their mapping always carries a reservation. */
const RESERVED_TYPES: ReadonlySet<MappedEntityType> = new Set([
  'season',
  'team',
  'roster',
  'future_schedule',
  'communication_preference',
]);

/** A linked external mapping to an existing internal record (creates a fixture batch if needed). */
export async function createExternalMappingFixture(
  ctx: MigrationFixtureContext,
  input: {
    entityType: MappedEntityType;
    externalId: string;
    internalId: string;
    /** For `team`: the internal record is a team entry rather than a team. */
    teamEntry?: boolean;
    sourceSystem?: string;
    batchId?: string;
    organizationId?: string;
  },
): Promise<string> {
  const organizationId = input.organizationId ?? ctx.organizationId;
  const sourceSystem = input.sourceSystem ?? 'legacy-fixture';
  const batchId =
    input.batchId ??
    (await createImportBatchFixture(ctx, { rows: [], sourceSystem, organizationId })).batchId;
  const id = newId();
  await ctx.db
    .insertInto('external_mappings')
    .values({
      id,
      organization_id: organizationId,
      source_system: sourceSystem,
      entity_type: input.entityType,
      external_id: input.externalId,
      status: 'linked',
      ...NO_TARGETS,
      [input.teamEntry ? TEAM_ENTRY_COLUMN : MAPPING_COLUMN[input.entityType]]: input.internalId,
      reserved_record_id: RESERVED_TYPES.has(input.entityType) ? input.internalId : null,
      applied_payload_hash: null,
      first_seen_batch_id: batchId,
      last_seen_batch_id: batchId,
      provenance: json({ fixture: true }),
      linked_at: ctx.clock.now(),
    })
    .execute();
  return id;
}
