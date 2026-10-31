import { newId, systemPrincipal, type Principal } from '@sportspark/contracts';
import { isCheckViolation, isUniqueViolation, pgErrorCode } from '@sportspark/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../testing';
import {
  authHeaderForPerson,
  createAccountFixture,
  createContactPointFixture,
  createOrganizationPeople,
  createPersonFixture,
  createRelationshipFixture,
  createStaffMemberFixture,
  type OrganizationPeople,
} from '../../identity';
import { CommunicationsModule } from '../communications.module';
import {
  attemptsOf,
  composeAndDispatch,
  deliverQueued,
  dispatchOutbox,
  fakeProviders,
  registerPushDeviceFixture,
  type FakeProviders,
} from '../testing/communications-fixtures';
import { withDeclaredPortDoubles } from './support';

const key = () => `k-${newId()}`;

/**
 * COM-02: retry of a single failed delivery (SPK-COMMS-004, SPK-UX-006, §4.7 invariant 10),
 * recipient display names for staff (SPK-UX-006), and the inbox item's revision and participants
 * (SPK-UX-003).
 */
describe('delivery retry, recipient names and inbox revision (COM-02)', () => {
  let t: TestApp;
  let org: string;
  let system: Principal;
  let fakes: FakeProviders;
  let people: OrganizationPeople;
  let gm: { Authorization: string };

  beforeAll(async () => {
    t = await createTestApp({
      configure: withDeclaredPortDoubles,
      imports: [CommunicationsModule],
      principalResolver: 'module',
      clockStart: '2026-10-23T12:00:00Z',
    });
    org = t.organizationId;
    system = systemPrincipal(org, 'test');
    fakes = fakeProviders(t.app);
    people = await createOrganizationPeople(t, { staffRoles: ['general_manager'] });
    gm = await authHeaderForPerson(t, people.staff.personId);
    await createContactPointFixture(t, {
      personId: people.adult.personId,
      kind: 'email',
      value: 'parent@example.test',
      verified: true,
    });
    await registerPushDeviceFixture(t, { personId: people.adult.personId });
  });
  beforeEach(() => {
    fakes.push.reset();
    fakes.email.reset();
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
  const retry = (attemptId: string, header = gm, body: object = { reason: 'mailbox fixed' }) =>
    t.http
      .post(`/v1/delivery-attempts/${attemptId}/retry`)
      .set(header)
      .set('Idempotency-Key', key())
      .send(body);
  const emailOf = async (notificationId: string) =>
    (await attemptsOf(t.db, org, notificationId)).filter((a) => a.channel === 'email');

  it('SPK-COMMS-004: a failed delivery is retried as a new attempt; an unknown or revoked one is not', async () => {
    fakes.email.scriptNext('failed');
    const n = await composeAndDispatch(t.app, system, notice());
    await deliverQueued(t.app);
    const [failed] = await emailOf(n.id);
    expect(failed).toMatchObject({ status: 'failed', failure_code: 'PROVIDER_REJECTED' });

    // front desk sees the failure but may not retry (general manager, administrator, support)
    const frontDesk = await createStaffMemberFixture(t, { roles: ['front_desk'] });
    const denied = await retry(
      failed?.id as string,
      await authHeaderForPerson(t, frontDesk.personId),
    );
    expect(denied.status).toBe(403);

    const retried = await retry(failed?.id as string);
    expect(retried.status, JSON.stringify(retried.body)).toBe(201);
    expect(retried.body).toMatchObject({
      channel: 'email',
      status: 'queued',
      retryOfAttemptId: failed?.id,
      recipientId: failed?.recipient_id,
      revision: 1,
    });
    // the failed fact is not rewritten
    const afterRetry = await emailOf(n.id);
    expect(afterRetry.find((a) => a.id === failed?.id)).toMatchObject({
      status: 'failed',
      revision: failed?.revision,
    });
    fakes.email.reset();
    expect(await deliverQueued(t.app)).toMatchObject({ claimed: 1, accepted: 1 });
    expect(fakes.email.sent.map((r) => r.attemptId)).toEqual([retried.body.id]);
    const audit = await t.db
      .selectFrom('audit_records')
      .select(['action', 'reason'])
      .where('target_id', '=', retried.body.id)
      .where('action', '=', 'communications.retry_delivery')
      .executeTakeFirst();
    expect(audit).toMatchObject({ reason: 'mailbox fixed' });

    // the same failed attempt is retried once
    const again = await retry(failed?.id as string);
    expect(again.status).toBe(409);
    expect(again.body.details).toMatchObject({ code: 'ALREADY_RETRIED' });

    // an unknown outcome may have reached the person: never retried
    fakes.email.scriptNext('unknown');
    const unknownNotice = await composeAndDispatch(t.app, system, notice({ title: 'Unknown' }));
    await deliverQueued(t.app);
    const [unknown] = await emailOf(unknownNotice.id);
    expect(unknown?.status).toBe('unknown');
    const refused = await retry(unknown?.id as string);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('INVALID_TRANSITION');
    expect(await emailOf(unknownNotice.id)).toHaveLength(1);

    // a recipient whose authority is gone is refused and nothing is queued
    const coach = await createPersonFixture(t, { kind: 'adult' });
    await createAccountFixture(t, { personId: coach });
    await createContactPointFixture(t, {
      personId: coach,
      kind: 'email',
      value: `coach-${coach}@example.test`,
      verified: true,
    });
    const { grantIds } = await createRelationshipFixture(t, {
      actorPersonId: coach,
      subjectPersonId: people.child.personId,
      kind: 'delegate',
      permissions: ['view', 'receive_messages'],
    });
    fakes.email.scriptAddress(`coach-${coach}@example.test`, 'failed');
    const privateNotice = await composeAndDispatch(
      t.app,
      system,
      notice({ kind: 'youth_feedback', title: 'Private feedback', protected: true }),
    );
    await deliverQueued(t.app);
    const coachRecipient = await t.db
      .selectFrom('notification_recipients')
      .select('id')
      .where('notification_id', '=', privateNotice.id)
      .where('person_id', '=', coach)
      .executeTakeFirstOrThrow();
    const coachEmail = (await emailOf(privateNotice.id)).find(
      (a) => a.recipient_id === coachRecipient.id,
    );
    expect(coachEmail).toMatchObject({ status: 'failed', failure_code: 'PROVIDER_REJECTED' });
    const revoked = await t.http
      .post(`/v1/access-grants/${grantIds.receive_messages}/revoke`)
      .set(gm)
      .set('Idempotency-Key', key())
      .send({ reason: 'coach left the club' });
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    await dispatchOutbox(t.app);
    const blocked = await retry(coachEmail?.id as string);
    expect(blocked.status).toBe(409);
    expect(blocked.body).toMatchObject({
      code: 'RESOURCE_CONFLICT',
      details: { code: 'RECIPIENT_REVOKED' },
    });
    expect(
      (await emailOf(privateNotice.id)).filter((a) => a.recipient_id === coachRecipient.id),
    ).toHaveLength(1);
  });

  it('an in-app attempt or a still-queued attempt is not retried; another organization’s attempt is not found', async () => {
    const n = await composeAndDispatch(t.app, system, notice({ title: 'Not failed' }));
    const attempts = await attemptsOf(t.db, org, n.id);
    const inApp = attempts.find((a) => a.channel === 'in_app');
    const queued = attempts.find((a) => a.channel === 'email');
    expect((await retry(inApp?.id as string)).body.code).toBe('INVALID_TRANSITION');
    expect((await retry(queued?.id as string)).body.code).toBe('INVALID_TRANSITION');
    expect((await retry(newId())).status).toBe(404);
    expect((await retry(queued?.id as string, gm, {})).status).toBe(400); // a reason is required
    await deliverQueued(t.app);
  });

  it('SPK-UX-006: staff read each recipient’s name with the actual delivery states', async () => {
    const n = await composeAndDispatch(t.app, system, notice({ title: 'Names' }));
    const res = await t.http.get(`/v1/notifications/${n.id}/deliveries`).set(gm);
    expect(res.status).toBe(200);
    const recipient = res.body.recipients.find(
      (r: { personId: string }) => r.personId === people.adult.personId,
    );
    const person = await t.db
      .selectFrom('persons')
      .select(['given_name', 'family_name'])
      .where('id', '=', people.adult.personId)
      .executeTakeFirstOrThrow();
    expect(recipient.displayName).toBe(`${person.given_name} ${person.family_name}`);
    expect(
      res.body.attempts.every((a: { retryOfAttemptId: unknown }) => a.retryOfAttemptId === null),
    ).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('contactPoints');
    await deliverQueued(t.app);
  });

  it('SPK-UX-003: an inbox item carries its revision and participants; read and acknowledge honour expectedRevision', async () => {
    const n = await composeAndDispatch(t.app, system, notice({ title: 'Revisioned' }));
    const parent = await authHeaderForPerson(t, people.adult.personId);
    const inbox = await t.http.get('/v1/me/inbox?limit=50').set(parent);
    const item = inbox.body.items.find(
      (i: { notificationId: string }) => i.notificationId === n.id,
    );
    expect(item).toMatchObject({
      status: 'delivered',
      revision: 1,
      subjectPersonIds: [people.child.personId],
    });
    const stale = await t.http
      .post(`/v1/me/inbox/${item.attemptId}/read`)
      .set(parent)
      .set('Idempotency-Key', key())
      .send({ expectedRevision: 7 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVISION');
    const read = await t.http
      .post(`/v1/me/inbox/${item.attemptId}/read`)
      .set(parent)
      .set('Idempotency-Key', key())
      .send({ expectedRevision: 1 });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ status: 'read', revision: 2 });
    const staleAck = await t.http
      .post(`/v1/me/inbox/${item.attemptId}/acknowledge`)
      .set(parent)
      .set('Idempotency-Key', key())
      .send({ expectedRevision: 1 });
    expect(staleAck.body.code).toBe('STALE_REVISION');
    const ack = await t.http
      .post(`/v1/me/inbox/${item.attemptId}/acknowledge`)
      .set(parent)
      .set('Idempotency-Key', key())
      .send({ expectedRevision: 2 });
    expect(ack.status).toBe(200);
    expect(ack.body).toMatchObject({ status: 'acknowledged', revision: 3 });
    await deliverQueued(t.app);
  });

  it('the database rejects a second retry of the same failed attempt and a retry of a revoked attempt', async () => {
    fakes.email.scriptNext('failed');
    const n = await composeAndDispatch(t.app, system, notice({ title: 'Schema' }));
    await deliverQueued(t.app);
    const attempts = await attemptsOf(t.db, org, n.id);
    const failed = attempts.find((a) => a.channel === 'email' && a.status === 'failed');
    const push = attempts.find((a) => a.channel === 'push');
    const inApp = attempts.find((a) => a.channel === 'in_app');
    expect(failed && push && inApp).toBeTruthy();
    const insertRetry = (source: { id: string; recipient_id: string }, overrides = {}) =>
      t.db
        .insertInto('delivery_attempts')
        .values({
          id: newId(),
          organization_id: org,
          notification_id: n.id,
          recipient_id: source.recipient_id,
          channel: 'email',
          provider: 'fake-messaging',
          provider_message_id: null,
          status: 'failed',
          queued_at: t.clock.now(),
          ready_at: null,
          locked_until: null,
          attempted_at: null,
          accepted_at: null,
          delivered_at: null,
          failed_at: t.clock.now(),
          read_at: null,
          acknowledged_at: null,
          provider_response: null,
          failure_code: 'PROVIDER_ERROR',
          error: 'test',
          retry_of_attempt_id: source.id,
          ...overrides,
        })
        .execute();
    const rejects = async (run: () => Promise<unknown>) => {
      try {
        await run();
      } catch (error) {
        return error;
      }
      return null;
    };
    // a first retry is accepted (recorded failed here to leave the live-attempt index free)
    await insertRetry(failed as { id: string; recipient_id: string });
    // a second retry of the same failed attempt
    expect(
      isUniqueViolation(
        await rejects(() => insertRetry(failed as { id: string; recipient_id: string })),
      ),
    ).toBe(true);
    // a retry of an attempt that is not failed, or of another channel
    expect(
      isCheckViolation(
        await rejects(() => insertRetry(push as { id: string; recipient_id: string })),
      ),
    ).toBe(true);
    expect(
      isCheckViolation(
        await rejects(() =>
          insertRetry(failed as { id: string; recipient_id: string }, { channel: 'sms' }),
        ),
      ),
    ).toBe(true);
    // a retry of an attempt failed because the recipient lost authority
    const revokedId = newId();
    await t.db
      .insertInto('delivery_attempts')
      .values({
        id: revokedId,
        organization_id: org,
        notification_id: n.id,
        recipient_id: inApp?.recipient_id as string,
        channel: 'sms',
        provider: 'fake-messaging',
        provider_message_id: null,
        status: 'failed',
        queued_at: t.clock.now(),
        ready_at: null,
        locked_until: null,
        attempted_at: null,
        accepted_at: null,
        delivered_at: null,
        failed_at: t.clock.now(),
        read_at: null,
        acknowledged_at: null,
        provider_response: null,
        failure_code: 'RECIPIENT_REVOKED',
        error: 'revoked',
      })
      .execute();
    expect(
      isCheckViolation(
        await rejects(() =>
          insertRetry(
            { id: revokedId, recipient_id: inApp?.recipient_id as string },
            { channel: 'sms' },
          ),
        ),
      ),
    ).toBe(true);
    // a retry naming itself
    const self = newId();
    const selfError = await rejects(() =>
      insertRetry(failed as { id: string; recipient_id: string }, {
        id: self,
        retry_of_attempt_id: self,
      }),
    );
    expect(['23514', '23503']).toContain(pgErrorCode(selfError));
  });
});
