import {
  newId,
  type ControlTotals,
  type ImportEntityTypeValue,
  type StaffRole,
  type StagedRow,
} from '@sportspark/contracts';
import { pgErrorCode } from '@sportspark/db';
import { expect } from 'vitest';
import { createTestApp, type TestApp } from '../../../testing';
import { CommunicationsModule } from '../../communications';
import {
  authHeaderForPerson,
  createAccountFixture,
  createPersonFixture,
  createStaffMemberFixture,
} from '../../identity';
import { MigrationModule } from '../migration.module';
import { controlTotalsFor, legacyAuthorityFixture } from '../testing/migration-fixtures';

/** Shared helpers for the migration API tests (not a spec file). */

/** Saturday 2027-01-16, 09:00 in Los Angeles (the test facility's zone). */
export const CLOCK_START = '2027-01-16T17:00:00.000Z';
export const SNAPSHOT_AT = '2027-01-16T08:00:00.000Z';

export const key = (): string => `k-${newId()}`;

/** Every category the module applies; legacy authority over them is the import precondition. */
export const APPLIED_CATEGORIES: readonly ImportEntityTypeValue[] = [
  'person',
  'household',
  'relationship_evidence',
  'program',
  'open_obligation',
  'credit',
];

export function migrationTestApp(options: { clockStart?: string } = {}): Promise<TestApp> {
  return createTestApp({
    // Communications is loaded so that the tests prove no customer notice results from an import.
    imports: [MigrationModule, CommunicationsModule],
    principalResolver: 'module',
    clockStart: options.clockStart ?? CLOCK_START,
  });
}

export interface Actor {
  personId: string;
  header: { Authorization: string };
}

export async function staff(
  t: TestApp,
  roles: StaffRole[],
  options: { organizationId?: string } = {},
): Promise<Actor> {
  const member = await createStaffMemberFixture(t, {
    roles,
    organizationId: options.organizationId,
  });
  return { personId: member.personId, header: await authHeaderForPerson(t, member.personId) };
}

export async function customer(t: TestApp): Promise<Actor> {
  const personId = await createPersonFixture(t, { kind: 'adult' });
  await createAccountFixture(t, { personId });
  return { personId, header: await authHeaderForPerson(t, personId) };
}

export function post(t: TestApp, path: string, actor: Actor, body: object, idempotencyKey = key()) {
  return t.http.post(path).set(actor.header).set('Idempotency-Key', idempotencyKey).send(body);
}

export function get(t: TestApp, path: string, actor: Actor) {
  return t.http.get(path).set(actor.header);
}

export function stageBody(
  rows: readonly StagedRow[],
  overrides: Partial<{
    sourceSystem: string;
    controlTotals: ControlTotals;
    checksum: string;
    rowCount: number;
    snapshotTakenAt: string;
    transformationVersion: string;
  }> = {},
) {
  return {
    sourceSystem: overrides.sourceSystem ?? 'legacy-registration',
    snapshotTakenAt: overrides.snapshotTakenAt ?? SNAPSHOT_AT,
    transformationVersion: overrides.transformationVersion ?? 'staging-v1',
    extraction: { tool: 'export-script', extractedBy: 'migration owner' },
    controlTotals: overrides.controlTotals ?? controlTotalsFor(rows),
    rows,
    ...(overrides.checksum ? { checksum: overrides.checksum } : {}),
    ...(overrides.rowCount !== undefined ? { rowCount: overrides.rowCount } : {}),
  };
}

export async function grantLegacyAuthority(
  t: TestApp,
  categories: readonly ImportEntityTypeValue[] = APPLIED_CATEGORIES,
): Promise<void> {
  await legacyAuthorityFixture(t, categories);
}

/** Stage, validate and return the batch body (expects success). */
export async function stageAndValidate(
  t: TestApp,
  operator: Actor,
  rows: readonly StagedRow[],
  overrides: Parameters<typeof stageBody>[1] = {},
) {
  const staged = await post(t, '/v1/import-batches', operator, stageBody(rows, overrides));
  expect(staged.status, JSON.stringify(staged.body)).toBe(201);
  const validated = await post(t, `/v1/import-batches/${staged.body.id}/validate`, operator, {});
  expect(validated.status, JSON.stringify(validated.body)).toBe(200);
  return validated.body as {
    id: string;
    revision: number;
    status: string;
    plannedCounts: Record<string, number>;
    exceptions: { open: number; decided: number; withdrawn: number };
    sameChecksumBatchIds: string[];
    checksum: string;
  };
}

/** Stage → validate → review → apply a batch without exceptions; returns the applied batch. */
export async function importSnapshot(
  t: TestApp,
  operator: Actor,
  rows: readonly StagedRow[],
  overrides: Parameters<typeof stageBody>[1] = {},
) {
  const validated = await stageAndValidate(t, operator, rows, overrides);
  expect(validated.exceptions.open, JSON.stringify(validated)).toBe(0);
  const reviewed = await post(t, `/v1/import-batches/${validated.id}/review`, operator, {
    expectedRevision: validated.revision,
  });
  expect(reviewed.status, JSON.stringify(reviewed.body)).toBe(200);
  const applied = await post(t, `/v1/import-batches/${validated.id}/apply`, operator, {});
  expect(applied.status, JSON.stringify(applied.body)).toBe(200);
  return applied.body as {
    id: string;
    status: string;
    outcomeCounts: Record<string, number>;
    appliedOperationId: string;
    sameChecksumBatchIds: string[];
    checksum: string;
    revision: number;
  };
}

export async function rowsOf(t: TestApp, operator: Actor, batchId: string) {
  const res = await get(t, `/v1/import-batches/${batchId}/rows?limit=200`, operator);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.items as Array<{
    id: string;
    entityType: string;
    externalId: string;
    plannedOutcome: string | null;
    outcome: string | null;
    internalId: string | null;
    reasons: Array<{ code: string }>;
  }>;
}

export async function exceptionsOf(t: TestApp, operator: Actor, batchId: string) {
  const res = await get(t, `/v1/import-exceptions?batchId=${batchId}&limit=200`, operator);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.items as Array<{
    id: string;
    rowId: string;
    externalId: string;
    kind: string;
    status: string;
    reviewOwnerRole: string;
    revision: number;
    reasons: Array<{ code: string }>;
  }>;
}

export async function countRows(t: TestApp, table: string, organizationId = t.organizationId) {
  const row = await t.db
    .selectFrom(table as 'persons')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('organization_id', '=', organizationId)
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

export async function expectPgError(promise: Promise<unknown>, code: string): Promise<void> {
  let error: unknown;
  try {
    await promise;
  } catch (e) {
    error = e;
  }
  expect(error, `expected PostgreSQL error ${code}`).toBeDefined();
  expect(pgErrorCode(error)).toBe(code);
}
