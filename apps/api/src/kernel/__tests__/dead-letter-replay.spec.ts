import { newId, systemPrincipal } from '@sportspark/contracts';
import { seedOrganization } from '@sportspark/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { staffPrincipal } from '../../testing/principals';
import { createTestApp, type TestApp } from '../../testing/test-app';
import { UnitOfWork } from '../database/unit-of-work';
import { OperationalExceptions } from '../exceptions/operational-exceptions.service';
import { Inbox } from '../inbox/inbox';
import { EventHandlerRegistry } from '../outbox/event-handler.registry';
import { Outbox } from '../outbox/outbox';
import { OutboxDispatcher } from '../outbox/outbox-dispatcher';

const key = () => `k-${newId()}`;

/**
 * R3-OPERATIONS-03 (§5.11 "operational issues must have owners and supported resolution actions",
 * §4.12 "workers must tolerate interruption and replay", SPK-UX-006): a dead letter is re-run
 * through an audited, permissioned command, only the handlers that failed run again, and its
 * exception is resolved by the worker once the follow-up happened, never by hand before.
 */
describe('dead-letter replay (R3-OPERATIONS-03, §5.11, §4.12)', () => {
  let t: TestApp;
  let uow: UnitOfWork;
  let outbox: Outbox;
  let dispatcher: OutboxDispatcher;
  let inbox: Inbox;
  let exceptions: OperationalExceptions;
  let broken = true;
  const ran: string[] = [];

  beforeAll(async () => {
    t = await createTestApp();
    uow = t.app.get(UnitOfWork);
    outbox = t.app.get(Outbox);
    dispatcher = t.app.get(OutboxDispatcher);
    inbox = t.app.get(Inbox);
    exceptions = t.app.get(OperationalExceptions);
    const registry = t.app.get(EventHandlerRegistry);
    registry.on('test.checkout_paid', 'test.record_receipt', async (event) => {
      ran.push(`receipt:${event.id}`);
    });
    registry.on(
      'test.checkout_paid',
      'test.finalize_checkout',
      async (event) => {
        ran.push(`finalize:${event.id}`);
        if (broken) throw new Error('finalization bug');
      },
      { failureOwner: 'finance_operator' },
    );
    inbox.on('fake-replay', 'apply', async (event) => {
      ran.push(`inbox:${event.providerEventId}`);
      if (broken) throw new Error('provider evidence handler bug');
    });
  });
  afterAll(async () => {
    await t?.close();
  });

  const deadLetteredOutboxEvent = async () => {
    broken = true;
    const event = await uow.run((ctx) =>
      outbox.enqueue(ctx.trx, 'test.checkout_paid', {
        organizationId: t.organizationId,
        aggregateType: 'checkout',
        aggregateId: newId(),
        payload: {},
        maxAttempts: 1,
      }),
    );
    expect(await dispatcher.runOnce()).toMatchObject({ dead: 1 });
    return event.id;
  };
  const exceptionFor = (dedupeKey: string) =>
    t.db
      .selectFrom('operational_exceptions')
      .selectAll()
      .where('dedupe_key', '=', dedupeKey)
      .orderBy('opened_at', 'desc')
      .executeTakeFirstOrThrow();
  const replay = async (
    path: string,
    principal = staffPrincipal(t.organizationId, ['finance_operator']),
  ) =>
    t.http
      .post(path)
      .set(await t.authHeader(principal))
      .set('Idempotency-Key', key())
      .send({ reason: 'Finalization fix deployed in build 1.4.2' });

  it('R3-OPERATIONS-03 / §5.11: the failure owner replays a dead-lettered outbox event; only the failed handler runs again and the exception is resolved once it is dispatched', async () => {
    const id = await deadLetteredOutboxEvent();
    const opened = await exceptionFor(`outbox:${id}`);
    expect(opened).toMatchObject({ status: 'open', owner_queue: 'finance_operator' });

    const res = await replay(`/v1/outbox-events/${id}/replay`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id,
      source: 'outbox',
      status: 'pending',
      attempts: 0,
      replayCount: 1,
      exceptionId: opened.id,
    });
    const row = await t.db
      .selectFrom('outbox_events')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'pending', attempts: 0, replay_count: 1 });
    const audit = await t.db
      .selectFrom('audit_records')
      .select(['action', 'reason'])
      .where('target_type', '=', 'outbox_event')
      .where('target_id', '=', id)
      .execute();
    expect(audit).toEqual([
      { action: 'core.dead_letter_replayed', reason: 'Finalization fix deployed in build 1.4.2' },
    ]);
    // The follow-up has not happened yet: the exception stays open.
    expect((await exceptionFor(`outbox:${id}`)).status).toBe('open');

    broken = false;
    expect(await dispatcher.runOnce()).toMatchObject({ dispatched: 1 });
    expect(ran.filter((r) => r.endsWith(id))).toEqual([
      `receipt:${id}`,
      `finalize:${id}`,
      `finalize:${id}`,
    ]);
    expect((await exceptionFor(`outbox:${id}`)).status).toBe('resolved');

    // A settled event is not replayed again.
    const again = await replay(`/v1/outbox-events/${id}/replay`);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'INVALID_TRANSITION' });
  });

  it('R3-OPERATIONS-03: a replay that fails again is dead-lettered into the same open exception', async () => {
    const id = await deadLetteredOutboxEvent();
    const opened = await exceptionFor(`outbox:${id}`);
    expect((await replay(`/v1/outbox-events/${id}/replay`)).status).toBe(200);
    expect(await dispatcher.runOnce()).toMatchObject({ dead: 1 });
    const after = await exceptionFor(`outbox:${id}`);
    expect(after).toMatchObject({ id: opened.id, status: 'open' });
    broken = false;
  });

  it('R3-OPERATIONS-03 / §4.10: only the owning queue, the general manager or system administration may replay; another organization reads not found', async () => {
    const id = await deadLetteredOutboxEvent();
    const frontDesk = await replay(
      `/v1/outbox-events/${id}/replay`,
      staffPrincipal(t.organizationId, ['front_desk']),
    );
    expect(frontDesk.status).toBe(403);
    const other = await seedOrganization(t.db, { slug: `other-${newId().slice(-8)}` });
    const stranger = await replay(
      `/v1/outbox-events/${id}/replay`,
      staffPrincipal(other.organizationId, ['system_administrator']),
    );
    expect(stranger.status).toBe(404);
    const manager = await replay(
      `/v1/outbox-events/${id}/replay`,
      staffPrincipal(t.organizationId, ['general_manager']),
    );
    expect(manager.status).toBe(200);
    broken = false;
    expect(await dispatcher.runOnce()).toMatchObject({ dispatched: 1 });
  });

  it('R3-OPERATIONS-03: a dead letter cannot be resolved by hand while its follow-up has not happened; it can be closed with a reason', async () => {
    const id = await deadLetteredOutboxEvent();
    const exception = await exceptionFor(`outbox:${id}`);
    const manager = staffPrincipal(t.organizationId, ['general_manager']);
    await expect(
      uow.run(({ trx }) =>
        exceptions.transition(trx, manager, exception.id, 'resolved', { reason: 'looked at it' }),
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
      details: { code: 'dead_letter_replay_required', eventId: id, eventStatus: 'dead' },
    });
    // Replayed but not yet dispatched: still not resolvable by hand (even by the system).
    expect((await replay(`/v1/outbox-events/${id}/replay`, manager)).status).toBe(200);
    await expect(
      uow.run(({ trx }) =>
        exceptions.transition(
          trx,
          systemPrincipal(t.organizationId, 'test'),
          exception.id,
          'resolved',
          {},
        ),
      ),
    ).rejects.toMatchObject({ details: { code: 'dead_letter_replay_required' } });
    await uow.run(({ trx }) =>
      exceptions.transition(trx, manager, exception.id, 'closed', {
        reason: 'The checkout was refunded by hand; the follow-up is no longer wanted',
      }),
    );
    expect((await exceptionFor(`outbox:${id}`)).status).toBe('closed');
    broken = false;
    expect(await dispatcher.runOnce()).toMatchObject({ dispatched: 1 });
  });

  it('R3-OPERATIONS-03: an operator who closes the dead-letter exception while the worker settles the replayed event does not roll the dispatch back (PGlite and TEST_DATABASE_URL)', async () => {
    const id = await deadLetteredOutboxEvent();
    const exception = await exceptionFor(`outbox:${id}`);
    const manager = staffPrincipal(t.organizationId, ['general_manager']);
    expect((await replay(`/v1/outbox-events/${id}/replay`, manager)).status).toBe(200);
    broken = false;
    let lockTaken!: () => void;
    const taken = new Promise<void>((resolve) => {
      lockTaken = resolve;
    });
    // The operator's close holds the exception row until the worker waits on it (PostgreSQL); under
    // PGlite the two transactions run one after the other.
    const closing = uow.run(async ({ trx }) => {
      await exceptions.transition(trx, manager, exception.id, 'closed', {
        reason: 'Refunded by hand; the follow-up is no longer wanted',
      });
      lockTaken();
      if (!t.database.concurrent) return;
      const self = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(trx);
      const pid = self.rows[0]!.pid;
      // Polled on another connection: a transaction keeps its first view of pg_stat_activity.
      for (let poll = 0; poll < 250; poll += 1) {
        const blocked = await sql<{ n: number }>`
          select count(*)::int as n from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))
        `.execute(t.db);
        if ((blocked.rows[0]?.n ?? 0) > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error('the worker never waited on the exception row');
    });
    await taken;
    const [summary] = await Promise.all([dispatcher.runOnce(), closing]);
    expect(summary).toMatchObject({ dispatched: 1 });
    expect(
      await t.db
        .selectFrom('outbox_events')
        .select('status')
        .where('id', '=', id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'dispatched' });
    expect((await exceptionFor(`outbox:${id}`)).status).toBe('closed');
  });

  it('R3-OPERATIONS-03 / §4.11: a dead-lettered provider event is replayed by system administration and its exception resolved once processed', async () => {
    broken = true;
    const { id } = await inbox.record({
      provider: 'fake-replay',
      providerEventId: `evt_${newId()}`,
      eventType: 'payment.succeeded',
      payload: {},
      organizationId: t.organizationId,
      signatureVerified: true,
    });
    await t.db.updateTable('inbox_events').set({ max_attempts: 1 }).where('id', '=', id).execute();
    expect(await inbox.runOnce()).toMatchObject({ dead: 1 });
    expect((await exceptionFor(`inbox:${id}`)).status).toBe('open');
    // The finance operator does not own the inbox queue.
    expect((await replay(`/v1/provider-events/${id}/replay`)).status).toBe(403);
    const admin = staffPrincipal(t.organizationId, ['system_administrator']);
    const res = await replay(`/v1/provider-events/${id}/replay`, admin);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ source: 'inbox', status: 'received', replayCount: 1 });
    broken = false;
    expect(await inbox.runOnce()).toMatchObject({ processed: 1 });
    expect((await exceptionFor(`inbox:${id}`)).status).toBe('resolved');
    expect(
      await t.db
        .selectFrom('inbox_events')
        .select(['status', 'attempts', 'replay_count'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'processed', attempts: 1, replay_count: 1 });
  });
});
