import { newId, systemPrincipal } from '@sportspark/contracts';
import { seedOrganization } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { customerPrincipal, staffPrincipal } from '../../testing/principals';
import { createTestApp, type TestApp } from '../../testing/test-app';
import { AuditReader } from '../audit/audit-reader';
import { AuditWriter } from '../audit/audit.writer';
import { UnitOfWork } from '../database/unit-of-work';
import { Inbox } from '../inbox/inbox';

describe('audit-log and provider-event reads (K-08, §4.14, §4.12)', () => {
  let t: TestApp;
  let other: { organizationId: string };
  const target = newId();
  const actor = staffPrincipal('00000000-0000-7000-8000-000000000000', ['general_manager']);

  beforeAll(async () => {
    t = await createTestApp({ clockStart: '2026-11-02T10:00:00Z' });
    other = await seedOrganization(t.db);
    const uow = t.app.get(UnitOfWork);
    const audit = t.app.get(AuditWriter);
    const manager = { ...actor, organizationId: t.organizationId };
    for (let i = 0; i < 3; i += 1) {
      await uow.run(({ trx }) =>
        audit.record(trx, {
          organizationId: t.organizationId,
          actor: manager,
          action: 'kerneltest.override',
          targetType: 'probe',
          targetId: target,
          reason: `override ${i}`,
          beforeRevision: i + 1,
          afterRevision: i + 2,
          correlationId: `corr-${i}`,
        }),
      );
      t.clock.advance(1000);
    }
    await uow.run(async ({ trx }) => {
      await audit.record(trx, {
        organizationId: t.organizationId,
        actor: systemPrincipal(t.organizationId, 'kernel.test'),
        action: 'kerneltest.system',
        targetType: 'probe',
        targetId: newId(),
      });
      await audit.record(trx, {
        organizationId: other.organizationId,
        actor: { ...actor, organizationId: other.organizationId },
        action: 'kerneltest.override',
        targetType: 'probe',
        targetId: target,
      });
    });
  });
  afterAll(async () => {
    await t?.close();
  });

  it('§4.14: a general manager reads privileged actions by actor and target; a front desk gets ACCESS_DENIED', async () => {
    const gm = await t.authHeader(staffPrincipal(t.organizationId, ['general_manager']));
    const byActor = await t.http
      .get(`/v1/audit-records?actorPersonId=${actor.personId}&limit=2`)
      .set(gm);
    expect(byActor.status).toBe(200);
    expect(byActor.body.items.map((r: { reason: string }) => r.reason)).toEqual([
      'override 2',
      'override 1',
    ]);
    expect(byActor.body.items[0]).toMatchObject({
      action: 'kerneltest.override',
      targetType: 'probe',
      targetId: target,
      beforeRevision: 3,
      afterRevision: 4,
      correlationId: 'corr-2',
      actor: { kind: 'staff', personId: actor.personId, staffRoles: ['general_manager'] },
    });
    const next = await t.http
      .get(
        `/v1/audit-records?actorPersonId=${actor.personId}&limit=2&cursor=${byActor.body.nextCursor}`,
      )
      .set(gm);
    expect(next.body.items.map((r: { reason: string }) => r.reason)).toEqual(['override 0']);
    expect(next.body.nextCursor).toBeNull();

    const byTarget = await t.http
      .get(`/v1/audit-records?targetType=probe&targetId=${target}`)
      .set(gm);
    // Never another organization's record.
    expect(byTarget.body.items).toHaveLength(3);
    const byCorrelation = await t.http.get('/v1/audit-records?correlationId=corr-1').set(gm);
    expect(byCorrelation.body.items.map((r: { reason: string }) => r.reason)).toEqual([
      'override 1',
    ]);

    const desk = await t.authHeader(staffPrincipal(t.organizationId, ['front_desk']));
    const refused = await t.http.get('/v1/audit-records').set(desk);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('ACCESS_DENIED');
    const customer = await t.authHeader(customerPrincipal(t.organizationId));
    expect((await t.http.get('/v1/audit-records').set(customer)).status).toBe(403);
  });

  it('reading the audit log is itself audited', async () => {
    const reader = staffPrincipal(t.organizationId, ['system_administrator']);
    const res = await t.http
      .get('/v1/audit-records?action=kerneltest.override')
      .set(await t.authHeader(reader))
      .set('X-Correlation-Id', 'audit-read-0001');
    expect(res.status).toBe(200);
    const reads = await t.db
      .selectFrom('audit_records')
      .selectAll()
      .where('organization_id', '=', t.organizationId)
      .where('action', '=', 'core.view_audit')
      .where('correlation_id', '=', 'audit-read-0001')
      .execute();
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ target_type: 'audit_log', target_id: t.organizationId });
    expect(reads[0]?.details).toMatchObject({
      filters: { action: 'kerneltest.override' },
      returned: 3,
    });
    expect((reads[0]?.actor as { personId: string }).personId).toBe(reader.personId);
  });

  it('AuditReader.forTarget returns one record’s history, newest first, never another organization’s', async () => {
    const reader = t.app.get(AuditReader);
    const history = await reader.forTarget(t.organizationId, 'probe', target);
    expect(history.map((r) => r.reason)).toEqual(['override 2', 'override 1', 'override 0']);
    expect(await reader.forTarget(t.organizationId, 'probe', target, { limit: 1 })).toHaveLength(1);
    expect(
      await reader.forTarget(t.organizationId, 'probe', target, { actions: ['kerneltest.none'] }),
    ).toEqual([]);
    expect(await reader.forTarget(other.organizationId, 'probe', target)).toHaveLength(1);
  });

  it('§4.12, §4.14: provider events of the organization are listed without their payloads', async () => {
    const inbox = t.app.get(Inbox);
    await inbox.record({
      provider: 'fake-payments',
      providerEventId: 'evt-1',
      eventType: 'payment.succeeded',
      payload: { cardholder: 'secret-name' },
      organizationId: t.organizationId,
      signatureVerified: true,
    });
    t.clock.advance(1000);
    await inbox.record({
      provider: 'fake-messaging',
      providerEventId: 'evt-2',
      eventType: 'delivery.receipt',
      payload: {},
      organizationId: t.organizationId,
      signatureVerified: false,
    });
    await inbox.record({
      provider: 'fake-payments',
      providerEventId: 'evt-3',
      eventType: 'payment.succeeded',
      payload: {},
      organizationId: other.organizationId,
      signatureVerified: true,
    });
    await inbox.record({
      provider: 'fake-payments',
      providerEventId: 'evt-4',
      eventType: 'payment.succeeded',
      payload: {},
      organizationId: null,
      signatureVerified: true,
    });
    const finance = await t.authHeader(staffPrincipal(t.organizationId, ['finance_operator']));
    const res = await t.http.get('/v1/provider-events').set(finance);
    expect(res.status).toBe(200);
    expect(res.body.items.map((e: { providerEventId: string }) => e.providerEventId)).toEqual([
      'evt-2',
      'evt-1',
    ]);
    expect(JSON.stringify(res.body)).not.toContain('secret-name');
    expect(res.body.items[0]).toMatchObject({
      provider: 'fake-messaging',
      signatureVerified: false,
      status: 'received',
      attempts: 0,
    });
    expect(Object.keys(res.body.items[0]).sort()).toEqual(
      [
        'id',
        'provider',
        'providerEventId',
        'eventType',
        'signatureVerified',
        'status',
        'attempts',
        'lastError',
        'receivedAt',
        'processedAt',
      ].sort(),
    );
    const filtered = await t.http.get('/v1/provider-events?provider=fake-payments').set(finance);
    expect(filtered.body.items).toHaveLength(1);
    const desk = await t.authHeader(staffPrincipal(t.organizationId, ['front_desk']));
    expect((await t.http.get('/v1/provider-events').set(desk)).status).toBe(403);
  });
});
