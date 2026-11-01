import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../testing/test-app';

/**
 * R3-PERFORMANCE-05 (§5.4 apply recovery, §5.10 workload envelope): the creation-audit lookups by
 * correlation id (migration's import recovery and reconciliation) and by operation id (support's
 * evidence of an operation) are served by partial indexes on audit_records (migration 0016).
 */
describe('audit_records indexes for correlation and operation lookups (R3-PERFORMANCE-05)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ clockStart: '2026-11-02T10:00:00Z' });
  });
  afterAll(async () => {
    await t.close();
  });

  it('§5.10: audit_records has partial indexes on (organization_id, correlation_id) and (organization_id, operation_id)', async () => {
    const rows = await sql<{ indexname: string; indexdef: string }>`
      select indexname, indexdef from pg_indexes
      where tablename = 'audit_records'
        and indexname in ('audit_records_correlation_idx', 'audit_records_operation_idx')
      order by indexname
    `.execute(t.db);
    expect(rows.rows.map((r) => r.indexname)).toEqual([
      'audit_records_correlation_idx',
      'audit_records_operation_idx',
    ]);
    const [correlation, operation] = rows.rows;
    expect(correlation?.indexdef).toMatch(/\(organization_id, correlation_id\)/);
    expect(correlation?.indexdef).toMatch(/WHERE \(correlation_id IS NOT NULL\)/);
    expect(operation?.indexdef).toMatch(/\(organization_id, operation_id\)/);
    expect(operation?.indexdef).toMatch(/WHERE \(operation_id IS NOT NULL\)/);
  });
});
