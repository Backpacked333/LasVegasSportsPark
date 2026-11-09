import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../testing/test-app';
import { RECOVERY_EXCEPTION_CATEGORY, RecoveryMode } from '../recovery/recovery-mode.service';

/**
 * SPK-AT-028 / §5.8 (recovery runbook §5.3): what `db:restore` recorded about the restore travels
 * into the recovery it starts, so the reliability.recovery_mode exception and the
 * operations.recovery_entered audit record name the restore instant, the operator and the build.
 */
describe('recovery mode reads the restore record (§5.8, SPK-AT-028, runbook §5.3)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close();
  });

  async function recovery(reference: string) {
    const exception = await t.db
      .selectFrom('operational_exceptions')
      .select(['id', 'details'])
      .where('organization_id', '=', t.organizationId)
      .where('category', '=', RECOVERY_EXCEPTION_CATEGORY)
      .where('dedupe_key', '=', `recovery:${reference}`)
      .executeTakeFirstOrThrow();
    const audit = await t.db
      .selectFrom('audit_records')
      .select(['actor', 'reason', 'details'])
      .where('organization_id', '=', t.organizationId)
      .where('action', '=', 'operations.recovery_entered')
      .where('target_id', '=', exception.id)
      .executeTakeFirstOrThrow();
    return { exception, audit };
  }

  it('SPK-AT-028 / §5.8 (runbook §5.3): entering recovery for a recorded restore carries the restore instant, operator and build into the reliability.recovery_mode exception and the operations.recovery_entered audit record', async () => {
    const restoredAt = new Date('2026-11-09T12:00:00.000Z');
    const id = newId();
    await t.db
      .insertInto('database_restores')
      .values({
        id,
        backup_id: 'backup-recorded-1',
        backup_taken_at: new Date('2026-11-09T11:00:00.000Z'),
        migrations_digest: 'd'.repeat(64),
        restored_at: restoredAt,
        restored_by: 'ops@example.test',
        app_version: 'b'.repeat(40),
        schema_current: true,
      })
      .execute();

    expect(await t.app.get(RecoveryMode).enterAll('backup-recorded-1')).toBe(1);
    const { exception, audit } = await recovery('backup-recorded-1');
    const record = {
      id,
      backupTakenAt: '2026-11-09T11:00:00.000Z',
      restoredAt: restoredAt.toISOString(),
      restoredBy: 'ops@example.test',
      appVersion: 'b'.repeat(40),
      schemaCurrent: true,
    };
    expect(exception.details).toMatchObject({
      restoreReference: 'backup-recorded-1',
      restoreRecord: record,
    });
    expect(audit.details).toMatchObject({
      restoreReference: 'backup-recorded-1',
      restoreRecord: record,
    });
    expect(audit.reason).toBe(
      `Database restored (backup-recorded-1) at ${restoredAt.toISOString()} by ops@example.test`,
    );
    expect(audit.actor).toMatchObject({ kind: 'system' });
  });

  it('SPK-AT-028: a restore reference with no record still enters recovery and marks the record missing', async () => {
    expect(await t.app.get(RecoveryMode).enterAll('ticket-4711')).toBe(1);
    const { exception, audit } = await recovery('ticket-4711');
    expect(exception.details).toMatchObject({
      restoreReference: 'ticket-4711',
      restoreRecord: 'missing',
    });
    expect(audit.details).toMatchObject({ restoreRecord: 'missing' });
    expect(audit.reason).toBe('Database restored (ticket-4711)');
    // A restart with the same reference does not re-enter.
    expect(await t.app.get(RecoveryMode).enterAll('ticket-4711')).toBe(0);
  });
});
