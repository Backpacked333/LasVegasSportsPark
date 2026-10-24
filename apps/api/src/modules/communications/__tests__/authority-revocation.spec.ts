import { newId, systemPrincipal, type Principal } from '@sportspark/contracts';
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
import { NotificationsService } from '../services/notifications.service';
import {
  attemptsOf,
  deliverQueued,
  dispatchOutbox,
  fakeProviders,
  recipientsOf,
  type FakeProviders,
} from '../testing/communications-fixtures';

const key = () => `k-${newId()}`;

/**
 * SPK-AT-017 "Coach loses access while messages are queued": new protected access and unsent
 * dispatch are re-evaluated. Invariant 10: no protected message is dispatched using revoked
 * authority. SPK-IAM-006: revocation affects protected messages still awaiting platform dispatch.
 */
describe('SPK-AT-017 / invariant 10: revoked authority and unsent protected notices', () => {
  let t: TestApp;
  let org: string;
  let system: Principal;
  let fakes: FakeProviders;
  let notifications: NotificationsService;
  let people: OrganizationPeople;
  let staff: { Authorization: string };

  interface Coach {
    personId: string;
    grantId: string;
    email: string;
  }

  beforeAll(async () => {
    t = await createTestApp({
      imports: [CommunicationsModule],
      principalResolver: 'module',
      clockStart: '2026-10-23T12:00:00Z',
    });
    org = t.organizationId;
    system = systemPrincipal(org, 'test');
    fakes = fakeProviders(t.app);
    notifications = t.app.get(NotificationsService);
    people = await createOrganizationPeople(t, { staffRoles: ['program_manager'] });
    await createContactPointFixture(t, {
      personId: people.adult.personId,
      kind: 'email',
      value: 'parent@example.test',
      verified: true,
    });
    staff = await authHeaderForPerson(t, people.staff.personId);
  });
  beforeEach(() => {
    fakes.push.reset();
    fakes.email.reset();
  });
  afterAll(async () => {
    await t.close();
  });

  /** An adult with delegate access (view + receive_messages) over the child, e.g. a coach. */
  async function createCoach(childId = people.child.personId): Promise<Coach> {
    const personId = await createPersonFixture(t, { kind: 'adult' });
    await createAccountFixture(t, { personId });
    // a verified primary identifier is unique per organization: the full id keeps coaches apart
    const email = `coach-${personId}@example.test`;
    await createContactPointFixture(t, { personId, kind: 'email', value: email, verified: true });
    const { grantIds } = await createRelationshipFixture(t, {
      actorPersonId: personId,
      subjectPersonId: childId,
      kind: 'delegate',
      permissions: ['view', 'receive_messages'],
    });
    return { personId, grantId: grantIds.receive_messages as string, email };
  }

  const revokeViaApi = async (grantId: string) => {
    const res = await t.http
      .post(`/v1/access-grants/${grantId}/revoke`)
      .set(staff)
      .set('Idempotency-Key', key())
      .send({ reason: 'coach left the club' });
    expect(res.status).toBe(200);
  };

  const queue = (input: {
    kind: 'youth_feedback' | 'schedule_changed';
    protected: boolean;
    childId?: string;
    title?: string;
  }) =>
    notifications.composeAndQueue(system, {
      kind: input.kind,
      audience: { subjectPersonIds: [input.childId ?? people.child.personId] },
      ...(input.kind === 'schedule_changed' ? { subject: { type: 'event', id: newId() } } : {}),
      title: input.title ?? (input.protected ? 'Private feedback' : 'Practice moved'),
      body: input.protected ? 'Parent-visible feedback about the child.' : 'Now at 5 pm.',
      protected: input.protected,
    });

  const recipientFor = async (notificationId: string, personId: string) =>
    (await recipientsOf(t.db, org, notificationId)).find((r) => r.person_id === personId);

  const attemptsFor = async (notificationId: string, personId: string) => {
    const recipient = await recipientFor(notificationId, personId);
    return (await attemptsOf(t.db, org, notificationId)).filter(
      (a) => a.recipient_id === recipient?.id,
    );
  };

  it('SPK-AT-017: a coach loses access while a protected message is queued → it is not dispatched to the coach and the recipient is marked revoked; a non-protected notice still goes', async () => {
    const coach = await createCoach();
    const protectedNotice = await queue({ kind: 'youth_feedback', protected: true });
    const plainNotice = await queue({ kind: 'schedule_changed', protected: false });
    expect(protectedNotice.status).toBe('queued');
    expect((await recipientFor(protectedNotice.id, coach.personId))?.status).toBe('pending');
    expect((await recipientFor(plainNotice.id, coach.personId))?.status).toBe('pending');

    await revokeViaApi(coach.grantId);
    // the revocation event and both delivery requests are processed in arrival order
    await dispatchOutbox(t.app);

    expect((await notifications.get(system, protectedNotice.id)).status).toBe('dispatched');
    const coachOnProtected = await recipientFor(protectedNotice.id, coach.personId);
    expect(coachOnProtected).toMatchObject({ status: 'revoked' });
    expect(coachOnProtected?.revoked_at).not.toBeNull();
    expect(await attemptsFor(protectedNotice.id, coach.personId)).toHaveLength(0);
    const parentOnProtected = await recipientFor(protectedNotice.id, people.adult.personId);
    expect(parentOnProtected?.status).toBe('authorized');
    expect((await attemptsFor(protectedNotice.id, people.adult.personId)).length).toBeGreaterThan(
      0,
    );

    const coachOnPlain = await recipientFor(plainNotice.id, coach.personId);
    expect(coachOnPlain?.status).toBe('authorized');
    const plainAttempts = await attemptsFor(plainNotice.id, coach.personId);
    expect(plainAttempts.map((a) => `${a.channel}:${a.status}`).sort()).toEqual([
      'email:queued',
      'in_app:delivered',
      'push:queued',
    ]);

    await deliverQueued(t.app);
    const sentToCoach = fakes.email.sent.filter((r) => r.address === coach.email);
    expect(sentToCoach.map((r) => r.notificationId)).toEqual([plainNotice.id]);
    expect(
      fakes.email.sent.some(
        (r) => r.notificationId === protectedNotice.id && r.personId === coach.personId,
      ),
    ).toBe(false);

    const revokedEvents = await t.db
      .selectFrom('outbox_events')
      .select('payload')
      .where('event_type', '=', 'communications.recipient_revoked')
      .where('aggregate_id', '=', protectedNotice.id)
      .execute();
    expect(revokedEvents).toHaveLength(1);
    expect(revokedEvents[0]?.payload).toMatchObject({ personId: coach.personId });
  });

  it('SPK-IAM-006: a revocation after dispatch but before the external hand-off fails the queued attempts and the provider is never called; what was already delivered in-app is not recalled', async () => {
    const coach = await createCoach();
    const notice = await queue({ kind: 'youth_feedback', protected: true });
    await dispatchOutbox(t.app);
    expect((await recipientFor(notice.id, coach.personId))?.status).toBe('authorized');
    let coachAttempts = await attemptsFor(notice.id, coach.personId);
    expect(coachAttempts.map((a) => `${a.channel}:${a.status}`).sort()).toEqual([
      'email:queued',
      'in_app:delivered',
      'push:queued',
    ]);

    await revokeViaApi(coach.grantId);
    await dispatchOutbox(t.app); // identity.access_grant_revoked → re-evaluation
    expect(await recipientFor(notice.id, coach.personId)).toMatchObject({
      status: 'revoked',
      revocation_reason: 'authority_revoked_while_queued',
    });
    coachAttempts = await attemptsFor(notice.id, coach.personId);
    const byChannel = Object.fromEntries(coachAttempts.map((a) => [a.channel, a]));
    expect(byChannel['email']).toMatchObject({
      status: 'failed',
      failure_code: 'RECIPIENT_REVOKED',
    });
    expect(byChannel['push']).toMatchObject({
      status: 'failed',
      failure_code: 'RECIPIENT_REVOKED',
    });
    expect(byChannel['in_app']).toMatchObject({ status: 'delivered' }); // cannot be recalled

    const summary = await deliverQueued(t.app);
    expect(summary.revoked).toBe(0); // nothing of the coach's was claimable any more
    expect(fakes.email.sent.some((r) => r.personId === coach.personId)).toBe(false);
    expect(fakes.email.sent.some((r) => r.personId === people.adult.personId)).toBe(true);
    // no front-desk exception for a revocation: it is not a delivery failure
    const exceptions = await t.db
      .selectFrom('operational_exceptions')
      .select('id')
      .where('affected_id', '=', byChannel['email']?.id as string)
      .execute();
    expect(exceptions).toHaveLength(0);
  });

  it('SPK-COMMS-003: the worker re-checks a protected recipient immediately before the hand-off, even when the revocation event has not been processed yet', async () => {
    const coach = await createCoach();
    const notice = await queue({ kind: 'youth_feedback', protected: true });
    await dispatchOutbox(t.app);
    // the grant disappears without the outbox having delivered the identity event yet
    await t.db
      .updateTable('access_grants')
      .set({
        revoked_at: t.clock.now(),
        revoked_by: JSON.stringify({ kind: 'system' }),
        revocation_reason: 'test',
      })
      .where('id', '=', coach.grantId)
      .execute();
    const summary = await deliverQueued(t.app);
    expect(summary.revoked).toBe(2);
    expect(fakes.email.sent.some((r) => r.personId === coach.personId)).toBe(false);
    expect(fakes.push.sent.some((r) => r.personId === coach.personId)).toBe(false);
    expect(await recipientFor(notice.id, coach.personId)).toMatchObject({
      status: 'revoked',
      revocation_reason: 'authority_revoked_before_handoff',
    });
    const coachAttempts = await attemptsFor(notice.id, coach.personId);
    expect(
      coachAttempts
        .filter((a) => a.channel !== 'in_app')
        .every((a) => a.status === 'failed' && a.failure_code === 'RECIPIENT_REVOKED'),
    ).toBe(true);
    // the parent, whose authority stands, was served
    expect(
      fakes.email.sent.some(
        (r) => r.personId === people.adult.personId && r.notificationId === notice.id,
      ),
    ).toBe(true);
  });

  it('invariant 10: when every recipient lost authority before dispatch the notice is suppressed (authority_revoked) and nothing is attempted', async () => {
    const child = await createPersonFixture(t, { kind: 'child' });
    const coach = await createCoach(child);
    const notice = await queue({ kind: 'youth_feedback', protected: true, childId: child });
    expect(await recipientsOf(t.db, org, notice.id)).toHaveLength(1);
    await revokeViaApi(coach.grantId);
    await dispatchOutbox(t.app);
    const final = await notifications.get(system, notice.id);
    expect(final).toMatchObject({ status: 'suppressed', suppressionReason: 'authority_revoked' });
    expect(await attemptsOf(t.db, org, notice.id)).toHaveLength(0);
    const operation = await t.db
      .selectFrom('operations')
      .select(['status', 'result'])
      .where('id', '=', final.operationId as string)
      .executeTakeFirstOrThrow();
    expect(operation.status).toBe('succeeded');
    expect(operation.result).toMatchObject({ suppressed: 'authority_revoked' });
  });

  it('SPK-IAM-005/006: a temporary restriction from a disputed-access review (identity.access_restricted) is re-evaluated the same way', async () => {
    const coach = await createCoach();
    const notice = await queue({ kind: 'youth_feedback', protected: true });
    // a support operator opens the review and restricts the coach's grants pending a decision
    const support = await createStaffMemberFixture(t, { roles: ['support_operator'] });
    const supportAuth = await authHeaderForPerson(t, support.personId);
    const opened = await t.http
      .post('/v1/access-reviews')
      .set(supportAuth)
      .set('Idempotency-Key', key())
      .send({
        subjectPersonId: people.child.personId,
        reason: 'contested delegate access',
        parties: [{ personId: coach.personId, description: 'coach' }],
      });
    expect(opened.status).toBe(201);
    const restricted = await t.http
      .post(`/v1/access-reviews/${opened.body.id}/decisions`)
      .set(supportAuth)
      .set('Idempotency-Key', key())
      .send({ kind: 'restrict', actorPersonId: coach.personId, expectedRevision: 1 });
    expect(restricted.status).toBe(201);
    await dispatchOutbox(t.app);
    expect(await recipientFor(notice.id, coach.personId)).toMatchObject({ status: 'revoked' });
    expect((await recipientFor(notice.id, people.adult.personId))?.status).toBe('authorized');
    expect(await attemptsFor(notice.id, coach.personId)).toHaveLength(0);
    // the grant was suspended, not revoked: lifting the restriction restores future notices
    const grant = await t.db
      .selectFrom('access_grants')
      .select(['revoked_at', 'suspended_at'])
      .where('id', '=', coach.grantId)
      .executeTakeFirstOrThrow();
    expect(grant.revoked_at).toBeNull();
    expect(grant.suspended_at).not.toBeNull();
  });

  it('a revoked permission other than receive_messages, or a revocation over another child, changes nothing', async () => {
    const coach = await createCoach();
    const { grantIds: viewOnly } = await createRelationshipFixture(t, {
      actorPersonId: coach.personId,
      subjectPersonId: await createPersonFixture(t, { kind: 'child' }),
      permissions: ['view', 'receive_messages'],
    });
    const notice = await queue({ kind: 'youth_feedback', protected: true });
    await revokeViaApi(viewOnly.receive_messages as string); // a different child
    await dispatchOutbox(t.app);
    expect((await recipientFor(notice.id, coach.personId))?.status).toBe('authorized');
    expect((await attemptsFor(notice.id, coach.personId)).length).toBeGreaterThan(0);
  });
});
