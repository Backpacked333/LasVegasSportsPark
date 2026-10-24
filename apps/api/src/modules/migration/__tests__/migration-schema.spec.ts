import { newId } from '@sportspark/contracts';
import { json, seedOrganization } from '@sportspark/db';
import { afterAll, beforeAll, describe, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { createProgramFixture } from '../../catalog';
import { createPersonFixture } from '../../identity';
import {
  createAuthorityAssignmentFixture,
  createExternalMappingFixture,
  createImportBatchFixture,
  stagedPerson,
} from '../testing/migration-fixtures';
import { expectPgError, migrationTestApp } from './support';

const RESTRICT = '23001';
const FOREIGN_KEY = '23503';
const UNIQUE = '23505';
const CHECK = '23514';
const EXCLUSION = '23P01';
const ACTOR = { kind: 'system', actorLabel: 'schema-test' };
const HOUR = 3_600_000;

/**
 * Integrity invariants enforced by the database (migration 1200), proven by writing violating
 * rows directly: the services' checks give earlier feedback but are not the guarantee (§4.7).
 */
describe('migration schema invariants (migration 1200)', () => {
  let t: TestApp;
  let personId: string;

  beforeAll(async () => {
    t = await migrationTestApp();
    personId = await createPersonFixture(t, { kind: 'adult' });
  });
  afterAll(async () => {
    await t.close();
  });

  const at = (hours: number) => new Date(t.clock.now().getTime() + hours * HOUR);
  const assignment = (overrides: Record<string, unknown> = {}) => ({
    id: newId(),
    organization_id: t.organizationId,
    record_category: 'person' as const,
    scope_kind: 'organization' as const,
    facility_id: null,
    program_id: null,
    competition_id: null,
    authoritative_system: 'legacy' as const,
    effective_from: at(0),
    effective_to: null,
    reason: 'schema test',
    policy_references: [],
    approved_by: json(ACTOR),
    approved_by_person_id: null,
    supersedes_assignment_id: null,
    ended_at: null,
    ended_by: null,
    end_reason: null,
    ...overrides,
  });

  it('§4.7 invariant 11: one authority per record category and scope at every instant (exclusion constraint)', async () => {
    await t.db
      .insertInto('authority_assignments')
      .values(assignment({ record_category: 'household', effective_to: at(10) }))
      .execute();
    // Overlapping period, same category and scope, either system: refused.
    await expectPgError(
      t.db
        .insertInto('authority_assignments')
        .values(
          assignment({
            record_category: 'household',
            authoritative_system: 'sportspark',
            effective_from: at(5),
          }),
        )
        .execute(),
      EXCLUSION,
    );
    await expectPgError(
      t.db
        .insertInto('authority_assignments')
        .values(
          assignment({ record_category: 'household', effective_from: at(9), effective_to: at(12) }),
        )
        .execute(),
      EXCLUSION,
    );
    // Adjacent periods hand authority over at one instant; other scopes are independent.
    await t.db
      .insertInto('authority_assignments')
      .values(
        assignment({
          record_category: 'household',
          authoritative_system: 'sportspark',
          effective_from: at(10),
        }),
      )
      .execute();
    await t.db
      .insertInto('authority_assignments')
      .values(
        assignment({
          record_category: 'household',
          scope_kind: 'facility',
          facility_id: t.facilityId,
          effective_from: at(1),
        }),
      )
      .execute();
    await expectPgError(
      t.db
        .insertInto('authority_assignments')
        .values(
          assignment({
            record_category: 'household',
            scope_kind: 'facility',
            facility_id: t.facilityId,
            effective_from: at(2),
            authoritative_system: 'sportspark',
          }),
        )
        .execute(),
      EXCLUSION,
    );
  });

  it('§5.6: schedule authority is never program-scoped; a scope names exactly its own reference', async () => {
    const programId = await createProgramFixture(t, { name: 'Schema scope program' });
    await expectPgError(
      t.db
        .insertInto('authority_assignments')
        .values(
          assignment({
            record_category: 'future_schedule',
            scope_kind: 'program',
            program_id: programId,
          }),
        )
        .execute(),
      CHECK,
    );
    await expectPgError(
      t.db
        .insertInto('authority_assignments')
        .values(
          assignment({ record_category: 'program', scope_kind: 'facility', program_id: programId }),
        )
        .execute(),
      CHECK,
    );
    // A scope in another organization is unreachable (composite foreign key).
    const other = await seedOrganization(t.db);
    await expectPgError(
      t.db
        .insertInto('authority_assignments')
        .values(
          assignment({
            record_category: 'credit',
            scope_kind: 'facility',
            facility_id: other.facilityId,
          }),
        )
        .execute(),
      FOREIGN_KEY,
    );
  });

  it('§4.7 invariant 9: an assignment can only be shortened; nothing else changes and nothing is deleted', async () => {
    const id = await createAuthorityAssignmentFixture(t, {
      recordCategory: 'document',
      authoritativeSystem: 'legacy',
      effectiveTo: at(5),
    });
    await expectPgError(
      t.db
        .updateTable('authority_assignments')
        .set({ effective_to: at(6) })
        .where('id', '=', id)
        .execute(),
      CHECK,
    );
    await expectPgError(
      t.db
        .updateTable('authority_assignments')
        .set({ effective_to: null })
        .where('id', '=', id)
        .execute(),
      CHECK,
    );
    await expectPgError(
      t.db
        .updateTable('authority_assignments')
        .set({ authoritative_system: 'sportspark' })
        .where('id', '=', id)
        .execute(),
      CHECK,
    );
    await expectPgError(
      t.db
        .updateTable('authority_assignments')
        .set({ effective_from: at(1) })
        .where('id', '=', id)
        .execute(),
      CHECK,
    );
    await t.db
      .updateTable('authority_assignments')
      .set({ effective_to: at(4) })
      .where('id', '=', id)
      .execute();
    await expectPgError(
      t.db.deleteFrom('authority_assignments').where('id', '=', id).execute(),
      RESTRICT,
    );
  });

  it('§5.3: external ids map once per source and entity type; a link never changes and never crosses organizations', async () => {
    const mappingId = await createExternalMappingFixture(t, {
      entityType: 'person',
      externalId: 'X-1',
      internalId: personId,
    });
    await expectPgError(
      createExternalMappingFixture(t, {
        entityType: 'person',
        externalId: 'X-1',
        internalId: personId,
      }),
      UNIQUE,
    );
    // The same external id from another source system is a different key.
    await createExternalMappingFixture(t, {
      entityType: 'person',
      externalId: 'X-1',
      internalId: personId,
      sourceSystem: 'other-source',
    });
    const otherPerson = await createPersonFixture(t, { kind: 'adult' });
    await expectPgError(
      t.db
        .updateTable('external_mappings')
        .set({ person_id: otherPerson })
        .where('id', '=', mappingId)
        .execute(),
      CHECK,
    );
    await expectPgError(
      t.db
        .updateTable('external_mappings')
        .set({ external_id: 'X-2' })
        .where('id', '=', mappingId)
        .execute(),
      CHECK,
    );
    await expectPgError(
      t.db.deleteFrom('external_mappings').where('id', '=', mappingId).execute(),
      RESTRICT,
    );
    const other = await seedOrganization(t.db);
    const foreignPerson = await createPersonFixture(t, {
      kind: 'adult',
      organizationId: other.organizationId,
    });
    await expectPgError(
      createExternalMappingFixture(t, {
        entityType: 'person',
        externalId: 'X-9',
        internalId: foreignPerson,
      }),
      FOREIGN_KEY,
    );
    // A mapping's target column must match its entity type.
    const { batchId } = await createImportBatchFixture(t, { rows: [] });
    await expectPgError(
      t.db
        .insertInto('external_mappings')
        .values({
          id: newId(),
          organization_id: t.organizationId,
          source_system: 'legacy-fixture',
          entity_type: 'credit',
          external_id: 'X-3',
          status: 'linked',
          person_id: personId,
          household_id: null,
          relationship_id: null,
          program_id: null,
          obligation_id: null,
          credit_id: null,
          applied_payload_hash: null,
          first_seen_batch_id: batchId,
          last_seen_batch_id: batchId,
          provenance: json({}),
          linked_at: t.clock.now(),
        })
        .execute(),
      CHECK,
    );
  });

  it('§5.4: staged rows are unique per batch and immutable; an outcome is a fact', async () => {
    const { batchId, rowIds } = await createImportBatchFixture(t, {
      rows: [stagedPerson('S-1'), stagedPerson('S-2')],
    });
    await expectPgError(
      createImportBatchFixture(t, { rows: [stagedPerson('S-3'), stagedPerson('S-3')] }),
      UNIQUE,
    );
    await expectPgError(
      t.db
        .updateTable('import_rows')
        .set({ payload: json({ givenName: 'changed' }) })
        .where('id', '=', rowIds[0] as string)
        .execute(),
      CHECK,
    );
    await t.db
      .updateTable('import_rows')
      .set({ outcome: 'skipped', applied_at: t.clock.now() })
      .where('id', '=', rowIds[1] as string)
      .execute();
    await expectPgError(
      t.db
        .updateTable('import_rows')
        .set({ outcome: 'exception' })
        .where('id', '=', rowIds[1] as string)
        .execute(),
      CHECK,
    );
    // A created/matched/updated outcome always names its mapping.
    await expectPgError(
      t.db
        .updateTable('import_rows')
        .set({ outcome: 'created', applied_at: t.clock.now() })
        .where('id', '=', rowIds[0] as string)
        .execute(),
      CHECK,
    );
    await expectPgError(
      t.db.deleteFrom('import_rows').where('batch_id', '=', batchId).execute(),
      RESTRICT,
    );
  });

  it('§4.6 ImportBatch machine, sealed rows and one apply per source system are enforced by the database', async () => {
    const { batchId } = await createImportBatchFixture(t, {
      rows: [stagedPerson('B-1')],
      sourceSystem: 'schema-source',
    });
    await expectPgError(
      t.db
        .updateTable('import_batches')
        .set({ status: 'reviewed', reviewed_at: t.clock.now() })
        .where('id', '=', batchId)
        .execute(),
      CHECK,
    );
    await t.db
      .updateTable('import_batches')
      .set({ status: 'validated', checksum: 'a'.repeat(64), validated_at: t.clock.now() })
      .where('id', '=', batchId)
      .execute();
    await expectPgError(
      t.db.updateTable('import_batches').set({ row_count: 5 }).where('id', '=', batchId).execute(),
      CHECK,
    );
    await expectPgError(
      t.db
        .updateTable('import_batches')
        .set({ checksum: 'b'.repeat(64) })
        .where('id', '=', batchId)
        .execute(),
      CHECK,
    );
    await expectPgError(
      t.db
        .updateTable('import_batches')
        .set({ source_system: 'renamed' })
        .where('id', '=', batchId)
        .execute(),
      CHECK,
    );
    await t.db
      .updateTable('import_batches')
      .set({ status: 'reviewed', reviewed_at: t.clock.now() })
      .where('id', '=', batchId)
      .execute();
    const operation = async () => {
      const id = newId();
      await t.db
        .insertInto('operations')
        .values({
          id,
          organization_id: t.organizationId,
          kind: 'migration.apply_batch',
          status: 'running',
          requested_by: json(ACTOR),
          correlation_id: null,
          input: null,
          result: null,
          error: null,
          completed_at: null,
        })
        .execute();
      return id;
    };
    await t.db
      .updateTable('import_batches')
      .set({
        apply_lock_operation_id: await operation(),
        apply_lock_until: at(1),
        apply_started_at: t.clock.now(),
      })
      .where('id', '=', batchId)
      .execute();
    // Once an apply started, the batch can be neither aborted nor re-validated (§5.8).
    await expectPgError(
      t.db
        .updateTable('import_batches')
        .set({
          status: 'aborted',
          aborted_at: t.clock.now(),
          aborted_by: json(ACTOR),
          abort_reason: 'x',
        })
        .where('id', '=', batchId)
        .execute(),
      CHECK,
    );
    await expectPgError(
      t.db
        .updateTable('import_batches')
        .set({ status: 'validated' })
        .where('id', '=', batchId)
        .execute(),
      CHECK,
    );
    // A second batch of the same source cannot hold the apply lock at the same time.
    const { batchId: second } = await createImportBatchFixture(t, {
      rows: [stagedPerson('B-2')],
      sourceSystem: 'schema-source',
    });
    await t.db
      .updateTable('import_batches')
      .set({ status: 'validated', checksum: 'c'.repeat(64), validated_at: t.clock.now() })
      .where('id', '=', second)
      .execute();
    await t.db
      .updateTable('import_batches')
      .set({ status: 'reviewed', reviewed_at: t.clock.now() })
      .where('id', '=', second)
      .execute();
    await expectPgError(
      t.db
        .updateTable('import_batches')
        .set({
          apply_lock_operation_id: await operation(),
          apply_lock_until: at(1),
          apply_started_at: t.clock.now(),
        })
        .where('id', '=', second)
        .execute(),
      UNIQUE,
    );
    await expectPgError(
      t.db.deleteFrom('import_batches').where('id', '=', second).execute(),
      RESTRICT,
    );
  });

  it('§5.4: only ambiguity is accepted, a decision is final, and one exception exists per row and kind', async () => {
    const { batchId, rowIds } = await createImportBatchFixture(t, { rows: [stagedPerson('E-1')] });
    const exception = (overrides: Record<string, unknown> = {}) => ({
      id: newId(),
      organization_id: t.organizationId,
      batch_id: batchId,
      row_id: rowIds[0] as string,
      kind: 'validation' as const,
      phase: 'validation' as const,
      reasons: json([{ code: 'invalid_payload', message: 'x' }]),
      review_owner_role: 'system_administrator',
      decision: null,
      resolution: null,
      decision_reason: null,
      decided_by: null,
      decided_by_person_id: null,
      decided_at: null,
      withdrawn_at: null,
      ...overrides,
    });
    const id = newId();
    await t.db.insertInto('import_exceptions').values(exception({ id })).execute();
    await expectPgError(t.db.insertInto('import_exceptions').values(exception()).execute(), UNIQUE);
    await expectPgError(
      t.db
        .updateTable('import_exceptions')
        .set({
          status: 'decided',
          decision: 'accept',
          decision_reason: 'x',
          decided_by: json(ACTOR),
          decided_at: t.clock.now(),
        })
        .where('id', '=', id)
        .execute(),
      CHECK,
    );
    await t.db
      .updateTable('import_exceptions')
      .set({
        status: 'decided',
        decision: 'reject',
        decision_reason: 'x',
        decided_by: json(ACTOR),
        decided_at: t.clock.now(),
      })
      .where('id', '=', id)
      .execute();
    await expectPgError(
      t.db
        .updateTable('import_exceptions')
        .set({ decision: 'defer' })
        .where('id', '=', id)
        .execute(),
      CHECK,
    );
    await expectPgError(
      t.db
        .updateTable('import_exceptions')
        .set({
          status: 'open',
          decision: null,
          decision_reason: null,
          decided_by: null,
          decided_at: null,
        })
        .where('id', '=', id)
        .execute(),
      CHECK,
    );
    await expectPgError(
      t.db.deleteFrom('import_exceptions').where('id', '=', id).execute(),
      RESTRICT,
    );
  });

  it('§5.5: discrepancies are append-only facts that always carry their currency; approvals are one per area and need a reason to accept discrepancies', async () => {
    const { batchId } = await createImportBatchFixture(t, { rows: [] });
    const report = (overrides: Record<string, unknown> = {}) => ({
      id: newId(),
      organization_id: t.organizationId,
      batch_id: batchId,
      generated_at: t.clock.now(),
      generated_by: json(ACTOR),
      generated_by_person_id: null,
      status: 'discrepancy' as const,
      levels: json([]),
      discrepancy_count: 1,
      required_areas: ['finance' as const],
      approval_completed_at: null,
      superseded_by_report_id: null,
      ...overrides,
    });
    const reportId = newId();
    await t.db
      .insertInto('reconciliation_reports')
      .values(report({ id: reportId }))
      .execute();
    await expectPgError(
      t.db.insertInto('reconciliation_reports').values(report()).execute(),
      UNIQUE,
    );
    await expectPgError(
      t.db
        .insertInto('reconciliation_reports')
        .values(report({ status: 'balanced' }))
        .execute(),
      CHECK,
    );
    const discrepancy = (overrides: Record<string, unknown> = {}) => ({
      id: newId(),
      organization_id: t.organizationId,
      report_id: reportId,
      level: 'control_totals' as const,
      area: 'finance' as const,
      entity_type: 'credit' as const,
      code: 'amount_mismatch',
      external_id: null,
      internal_id: null,
      expected: json({ amountMinor: 5000 }),
      actual: json({ amountMinor: 4500 }),
      currency: 'USD',
      difference_minor: -500,
      count_difference: null,
      details: json({}),
      ...overrides,
    });
    const dId = newId();
    await t.db
      .insertInto('reconciliation_discrepancies')
      .values(discrepancy({ id: dId }))
      .execute();
    await expectPgError(
      t.db
        .insertInto('reconciliation_discrepancies')
        .values(discrepancy({ currency: null }))
        .execute(),
      CHECK,
    );
    await expectPgError(
      t.db
        .updateTable('reconciliation_discrepancies')
        .set({ difference_minor: 0 })
        .where('id', '=', dId)
        .execute(),
      RESTRICT,
    );
    await expectPgError(
      t.db.deleteFrom('reconciliation_discrepancies').where('id', '=', dId).execute(),
      RESTRICT,
    );
    const approval = (overrides: Record<string, unknown> = {}) => ({
      id: newId(),
      organization_id: t.organizationId,
      report_id: reportId,
      area: 'finance' as const,
      decision: 'approved' as const,
      approver: json(ACTOR),
      approver_person_id: personId,
      approver_role: 'finance_operator',
      reason: null,
      acknowledged_discrepancies: 1,
      decided_at: t.clock.now(),
      ...overrides,
    });
    await expectPgError(
      t.db.insertInto('reconciliation_approvals').values(approval()).execute(),
      CHECK,
    );
    await t.db
      .insertInto('reconciliation_approvals')
      .values(approval({ reason: 'explained' }))
      .execute();
    await expectPgError(
      t.db
        .insertInto('reconciliation_approvals')
        .values(approval({ reason: 'again' }))
        .execute(),
      UNIQUE,
    );
    // The report's evidence is immutable; only its approval status moves, once.
    await expectPgError(
      t.db
        .updateTable('reconciliation_reports')
        .set({ discrepancy_count: 0, status: 'balanced' })
        .where('id', '=', reportId)
        .execute(),
      CHECK,
    );
    await t.db
      .updateTable('reconciliation_reports')
      .set({ approval_status: 'approved', approval_completed_at: t.clock.now() })
      .where('id', '=', reportId)
      .execute();
    await expectPgError(
      t.db
        .updateTable('reconciliation_reports')
        .set({ approval_status: 'rejected' })
        .where('id', '=', reportId)
        .execute(),
      CHECK,
    );
  });
});
