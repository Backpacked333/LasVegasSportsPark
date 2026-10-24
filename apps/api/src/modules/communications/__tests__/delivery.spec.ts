import { newId, systemPrincipal, type Principal } from '@sportspark/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Inbox } from '../../../kernel';
import { createTestApp, type TestApp } from '../../../testing';
import {
  authHeaderForPerson,
  createAccountFixture,
  createContactPointFixture,
  createOrganizationPeople,
  createPersonFixture,
  createRelationshipFixture,
  type OrganizationPeople,
} from '../../identity';
import { CommunicationsModule } from '../communications.module';
import {
  FAKE_MESSAGING_SIGNATURE_HEADER,
  FakeMessagingProvider,
} from '../providers/fake-messaging.provider';
import {
  attemptsOf,
  composeAndDispatch,
  deliverQueued,
  fakeProviders,
  recordReceipt,
  type FakeProviders,
} from '../testing/communications-fixtures';

const key = () => `k-${newId()}`;

describe('delivery states (SPK-COMMS-004, §4.5 actual delivery states, §4.11 provider calls and receipts)', () => {
  let t: TestApp;
  let org: string;
  let people: OrganizationPeople;
  let system: Principal;
  let fakes: FakeProviders;
  let parent: { Authorization: string };

  beforeAll(async () => {
    t = await createTestApp({
      imports: [CommunicationsModule],
      principalResolver: 'module',
      clockStart: '2026-10-23T12:00:00Z',
    });
    org = t.organizationId;
    system = systemPrincipal(org, 'test');
    fakes = fakeProviders(t.app);
    people = await createOrganizationPeople(t);
    await createContactPointFixture(t, {
      personId: people.adult.personId,
      kind: 'email',
      value: 'parent@example.test',
      verified: true,
    });
    parent = await authHeaderForPerson(t, people.adult.personId);
  });
  beforeEach(() => {
    fakes.push.reset();
    fakes.email.reset();
    fakes.sms.reset();
  });
  afterAll(async () => {
    await t.close();
  });

  const notice = (overrides: object = {}) => ({
    kind: 'placement' as const,
    audience: { subjectPersonIds: [people.child.personId] },
    title: 'Placement confirmed',
    body: 'Your child has been placed on the Lions.',
    ...overrides,
  });

  const attemptsByChannel = async (notificationId: string) => {
    const rows = await attemptsOf(t.db, org, notificationId);
    return Object.fromEntries(rows.map((r) => [r.channel, r]));
  };

  it('SPK-COMMS-004: queued → provider accepted → delivered only on a receipt; a push is never marked delivered without one; duplicate receipts change nothing', async () => {
    const n = await composeAndDispatch(t.app, system, notice());
    expect(n.status).toBe('dispatched');
    let a = await attemptsByChannel(n.id);
    expect(a['in_app']).toMatchObject({ status: 'delivered', provider: 'in_app' });
    expect(a['push']).toMatchObject({ status: 'queued', provider: 'fake-messaging' });
    expect(a['email']).toMatchObject({ status: 'queued' });
    expect(a['sms']).toBeUndefined(); // off by default (DEC-062)

    const summary = await deliverQueued(t.app);
    expect(summary).toMatchObject({ claimed: 2, accepted: 2 });
    expect(fakes.email.sent).toHaveLength(1);
    expect(fakes.email.sent[0]).toMatchObject({ address: 'parent@example.test', channel: 'email' });
    expect(fakes.push.sent[0]).toMatchObject({ address: `person:${people.adult.personId}` });
    a = await attemptsByChannel(n.id);
    expect(a['push']).toMatchObject({
      status: 'provider_accepted',
      provider_message_id: `push-${a['push']?.id}`,
    });
    expect(a['push']?.accepted_at).not.toBeNull();
    expect(a['push']?.delivered_at).toBeNull();
    expect(a['email']?.status).toBe('provider_accepted');
    // nothing is re-sent on the next pass
    expect((await deliverQueued(t.app)).claimed).toBe(0);

    const emailAttempt = a['email'] as { id: string };
    const r1 = await recordReceipt(
      t.app,
      fakes.email,
      { attemptId: emailAttempt.id, organizationId: org },
      'delivered',
      { eventId: 'evt-email-delivered' },
    );
    expect(r1.duplicate).toBe(false);
    a = await attemptsByChannel(n.id);
    expect(a['email']).toMatchObject({ status: 'delivered' });
    expect(a['email']?.delivered_at).not.toBeNull();
    const revision = a['email']?.revision;
    // same provider event id: recorded once, processed once
    const r2 = await recordReceipt(
      t.app,
      fakes.email,
      { attemptId: emailAttempt.id, organizationId: org },
      'delivered',
      { eventId: 'evt-email-delivered' },
    );
    expect(r2.duplicate).toBe(true);
    // a fresh receipt that repeats an older fact is ignored rather than rewriting the state
    await recordReceipt(
      t.app,
      fakes.email,
      { attemptId: emailAttempt.id, organizationId: org },
      'accepted',
    );
    a = await attemptsByChannel(n.id);
    expect(a['email']).toMatchObject({ status: 'delivered', revision });
    // the push is still only accepted: no receipt, no delivery claim
    expect(a['push']?.status).toBe('provider_accepted');
    const deliveredEvents = await t.db
      .selectFrom('outbox_events')
      .select('aggregate_id')
      .where('event_type', '=', 'communications.delivery_delivered')
      .where('aggregate_id', '=', emailAttempt.id)
      .execute();
    expect(deliveredEvents).toHaveLength(1);
  });

  it('a provider rejection is recorded as failed and raises a front-desk exception for an essential notice (SPK-UX-006)', async () => {
    fakes.email.scriptNext('failed');
    const n = await composeAndDispatch(t.app, system, notice());
    await deliverQueued(t.app);
    const a = await attemptsByChannel(n.id);
    expect(a['email']).toMatchObject({ status: 'failed', failure_code: 'PROVIDER_REJECTED' });
    expect(a['email']?.failed_at).not.toBeNull();
    expect(a['push']?.status).toBe('provider_accepted');
    const exception = await t.db
      .selectFrom('operational_exceptions')
      .selectAll()
      .where('category', '=', 'communications.delivery_failed')
      .where('affected_id', '=', a['email']?.id as string)
      .executeTakeFirst();
    expect(exception).toMatchObject({ owner_queue: 'front_desk', status: 'open' });
    // a later receipt cannot resurrect a failed attempt
    await recordReceipt(
      t.app,
      fakes.email,
      { attemptId: a['email']?.id as string, organizationId: org },
      'delivered',
    );
    expect((await attemptsByChannel(n.id))['email']?.status).toBe('failed');
  });

  it('an unknown outcome stays unknown (no retry, no guess) until a receipt from the inbox resolves it', async () => {
    fakes.push.scriptNext('unknown');
    fakes.email.scriptNext('throw');
    const n = await composeAndDispatch(t.app, system, notice());
    const first = await deliverQueued(t.app);
    expect(first).toMatchObject({ claimed: 2, unknown: 2 });
    let a = await attemptsByChannel(n.id);
    expect(a['push']?.status).toBe('unknown');
    expect(a['email']?.status).toBe('unknown');
    expect(a['email']?.error).toMatch(/adapter failed/);
    expect((await deliverQueued(t.app)).claimed).toBe(0);
    expect(fakes.push.sent).toHaveLength(1);

    await recordReceipt(
      t.app,
      fakes.push,
      { attemptId: a['push']?.id as string, organizationId: org },
      'delivered',
    );
    await recordReceipt(
      t.app,
      fakes.email,
      { attemptId: a['email']?.id as string, organizationId: org },
      'accepted',
    );
    a = await attemptsByChannel(n.id);
    expect(a['push']?.status).toBe('delivered');
    expect(a['email']?.status).toBe('provider_accepted');
    await recordReceipt(
      t.app,
      fakes.email,
      { attemptId: a['email']?.id as string, organizationId: org },
      'failed',
      { error: 'mailbox full' },
    );
    a = await attemptsByChannel(n.id);
    expect(a['email']).toMatchObject({
      status: 'failed',
      failure_code: 'PROVIDER_REJECTED',
      error: 'mailbox full',
    });
  });

  it('§4.12: a hand-off interrupted before its outcome was recorded is marked unknown, never sent again blindly', async () => {
    const n = await composeAndDispatch(t.app, system, notice());
    const a = await attemptsByChannel(n.id);
    // simulate a worker that died after marking the call but before recording the result
    await t.db
      .updateTable('delivery_attempts')
      .set({ attempted_at: t.clock.now() })
      .where('id', '=', a['email']?.id as string)
      .execute();
    const summary = await deliverQueued(t.app);
    expect(summary).toMatchObject({ claimed: 2, accepted: 1, unknown: 1 });
    expect(fakes.email.sent).toHaveLength(0);
    expect(fakes.push.sent).toHaveLength(1);
    expect((await attemptsByChannel(n.id))['email']).toMatchObject({ status: 'unknown' });
  });

  it('a person without a contact point for the channel gets a failed attempt (NO_ADDRESS), not a silent skip', async () => {
    const guardian = await createPersonFixture(t, { kind: 'adult' });
    await createAccountFixture(t, { personId: guardian });
    const child = await createPersonFixture(t, { kind: 'child' });
    await createRelationshipFixture(t, {
      actorPersonId: guardian,
      subjectPersonId: child,
      permissions: ['view', 'receive_messages'],
    });
    const n = await composeAndDispatch(
      t.app,
      system,
      notice({ audience: { subjectPersonIds: [child] } }),
    );
    await deliverQueued(t.app);
    const a = await attemptsByChannel(n.id);
    expect(a['email']).toMatchObject({ status: 'failed', failure_code: 'NO_ADDRESS' });
    expect(a['push']?.status).toBe('provider_accepted');
    expect(fakes.email.sent).toHaveLength(0);
  });

  it('§4.11 webhook: a signed receipt is accepted once (202), an unsigned one is refused (401), a duplicate is flagged', async () => {
    const n = await composeAndDispatch(t.app, system, notice());
    await deliverQueued(t.app);
    const a = await attemptsByChannel(n.id);
    const { body, signature } = fakes.email.receipt(
      { attemptId: a['email']?.id as string, organizationId: org },
      'delivered',
    );
    const unsigned = await t.http.post('/v1/webhooks/messaging/fake-messaging').send(body);
    expect(unsigned.status).toBe(401);
    const tampered = await t.http
      .post('/v1/webhooks/messaging/fake-messaging')
      .set(FAKE_MESSAGING_SIGNATURE_HEADER, FakeMessagingProvider.sign({ ...body, id: 'x' }))
      .send(body);
    expect(tampered.status).toBe(401);
    const accepted = await t.http
      .post('/v1/webhooks/messaging/fake-messaging')
      .set(FAKE_MESSAGING_SIGNATURE_HEADER, signature)
      .send(body);
    expect(accepted.status).toBe(202);
    expect(accepted.body).toMatchObject({ duplicate: false });
    const duplicate = await t.http
      .post('/v1/webhooks/messaging/fake-messaging')
      .set(FAKE_MESSAGING_SIGNATURE_HEADER, signature)
      .send(body);
    expect(duplicate.status).toBe(202);
    expect(duplicate.body).toMatchObject({
      duplicate: true,
      inboxEventId: accepted.body.inboxEventId,
    });
    expect((await attemptsByChannel(n.id))['email']?.status).toBe('provider_accepted'); // not yet processed
    await t.app.get(Inbox).runOnce();
    expect((await attemptsByChannel(n.id))['email']?.status).toBe('delivered');
    expect((await t.http.post('/v1/webhooks/messaging/other').send(body)).status).toBe(404);
  });

  it('SPK-UX-003 inbox: in-app notices newest first; read and acknowledge are real states; another person’s notice is not found', async () => {
    const first = await composeAndDispatch(t.app, system, notice({ title: 'First notice' }));
    t.clock.advance(60_000);
    const second = await composeAndDispatch(t.app, system, notice({ title: 'Second notice' }));
    const inbox = await t.http.get('/v1/me/inbox?limit=2').set(parent);
    expect(inbox.status).toBe(200);
    expect(inbox.body.items[0]).toMatchObject({ notificationId: second.id, status: 'delivered' });
    expect(inbox.body.items[1]).toMatchObject({ notificationId: first.id, status: 'delivered' });
    expect(inbox.body.nextCursor).toEqual(expect.any(String));
    const attemptId = inbox.body.items[0].attemptId as string;

    const read = await t.http
      .post(`/v1/me/inbox/${attemptId}/read`)
      .set(parent)
      .set('Idempotency-Key', key())
      .send({});
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ status: 'read' });
    expect(read.body.readAt).toEqual(expect.any(String));
    const unread = await t.http.get('/v1/me/inbox?unreadOnly=true&limit=50').set(parent);
    expect(unread.body.items.map((i: { attemptId: string }) => i.attemptId)).not.toContain(
      attemptId,
    );

    const ack = await t.http
      .post(`/v1/me/inbox/${attemptId}/acknowledge`)
      .set(parent)
      .set('Idempotency-Key', key())
      .send({ note: 'Seen, thanks' });
    expect(ack.status).toBe(200);
    expect(ack.body).toMatchObject({ status: 'acknowledged' });
    const ackAgain = await t.http
      .post(`/v1/me/inbox/${attemptId}/acknowledge`)
      .set(parent)
      .set('Idempotency-Key', key())
      .send({});
    expect(ackAgain.status).toBe(200); // recorded once per recipient
    const acks = await t.db
      .selectFrom('notification_acknowledgments')
      .selectAll()
      .where('delivery_attempt_id', '=', attemptId)
      .execute();
    expect(acks).toHaveLength(1);
    expect(acks[0]).toMatchObject({ via: 'in_app', note: 'Seen, thanks' });
    const readAfterAck = await t.http
      .post(`/v1/me/inbox/${attemptId}/read`)
      .set(parent)
      .set('Idempotency-Key', key())
      .send({});
    expect(readAfterAck.body.status).toBe('acknowledged');

    // acknowledging directly from delivered also records the read instant
    const otherAttempt = inbox.body.items[1].attemptId as string;
    const direct = await t.http
      .post(`/v1/me/inbox/${otherAttempt}/acknowledge`)
      .set(parent)
      .set('Idempotency-Key', key())
      .send({ expectedRevision: 1 });
    expect(direct.body).toMatchObject({ status: 'acknowledged' });
    expect(direct.body.readAt).toEqual(expect.any(String));

    // somebody else's notice does not exist for this principal (§4.10)
    const stranger = await createPersonFixture(t, { kind: 'adult' });
    await createAccountFixture(t, { personId: stranger });
    const strangerAuth = await authHeaderForPerson(t, stranger);
    const denied = await t.http
      .post(`/v1/me/inbox/${attemptId}/read`)
      .set(strangerAuth)
      .set('Idempotency-Key', key())
      .send({});
    expect(denied.status).toBe(404);
    expect((await t.http.get('/v1/me/inbox').set(strangerAuth)).body.items).toEqual([]);
    const stale = await t.http
      .post(`/v1/me/inbox/${otherAttempt}/read`)
      .set(parent)
      .set('Idempotency-Key', key())
      .send({ expectedRevision: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVISION');
  });
});
