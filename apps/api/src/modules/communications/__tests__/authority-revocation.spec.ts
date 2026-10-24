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
import { AudienceResolver } from '../services/audience-resolver';
import { DeliveryWorker } from '../services/delivery-worker';
import { NotificationsService } from '../services/notifications.service';
import { RecipientAddresses } from '../services/recipient-addresses';
import {
  attemptsOf,
  deliverQueued,
  dispatchOutbox,
  fakeProviders,
  recipientsOf,
  type FakeProviders,
} from '../testing/communications-fixtures';

const key = () => `k-${newId()}`;

/** Pauses the next armed call of a patched method until the test opens it. */
class Gate {
  private armed = 0;
  private waiting: Array<() => void> = [];
  private onReached: (() => void) | null = null;

  arm(): Promise<void> {
    this.armed += 1;
    return new Promise((resolve) => (this.onReached = resolve));
  }

  async pass(): Promise<void> {
    if (this.armed === 0) return;
    this.armed -= 1;
    this.onReached?.();
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  open(): void {
    for (const release of this.waiting.splice(0)) release();
  }
}

const settle = <T>(p: Promise<T>) =>
  p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

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

  const coachSends = (coach: Coach, notificationId: string) =>
    [...fakes.push.sent, ...fakes.email.sent].filter(
      (r) => r.personId === coach.personId && r.notificationId === notificationId,
    );

  it('invariant 10 / SPK-COMMS-003: a revocation that commits while the worker is between its address lookup and the hand-off is never handed to the provider, and the record says so truthfully', async () => {
    const coach = await createCoach();
    const notice = await queue({ kind: 'youth_feedback', protected: true });
    await dispatchOutbox(t.app);
    const addresses = t.app.get(RecipientAddresses);
    const original = addresses.resolve.bind(addresses);
    let fired = false;
    addresses.resolve = async (organizationId, personId, channel, db) => {
      if (!fired && personId === coach.personId) {
        fired = true;
        await revokeViaApi(coach.grantId);
        await dispatchOutbox(t.app); // identity.access_grant_revoked → re-evaluation commits
      }
      return original(organizationId, personId, channel, db);
    };
    try {
      await deliverQueued(t.app);
    } finally {
      addresses.resolve = original;
    }
    expect(fired).toBe(true);
    expect(coachSends(coach, notice.id)).toEqual([]);
    expect(await recipientFor(notice.id, coach.personId)).toMatchObject({
      status: 'revoked',
      revocation_reason: 'authority_revoked_while_queued',
    });
    const external = (await attemptsFor(notice.id, coach.personId)).filter(
      (a) => a.channel !== 'in_app',
    );
    expect(external).toHaveLength(2);
    for (const attempt of external) {
      expect(attempt).toMatchObject({
        status: 'failed',
        failure_code: 'RECIPIENT_REVOKED',
        attempted_at: null,
      });
    }
    expect(
      fakes.email.sent.some(
        (r) => r.personId === people.adult.personId && r.notificationId === notice.id,
      ),
    ).toBe(true);
  });

  it('invariant 10 / SPK-COMMS-003: a revocation that lands during the hand-off claim is ordered after it: what reached the provider is recorded as handed over, and nothing failed RECIPIENT_REVOKED was sent', async () => {
    const coach = await createCoach();
    const notice = await queue({ kind: 'youth_feedback', protected: true });
    await dispatchOutbox(t.app);
    const resolver = t.app.get(AudienceResolver);
    const original = resolver.isStillAuthorized.bind(resolver);
    const afterRecheck = new Gate();
    resolver.isStillAuthorized = async (organizationId, recipient, facilityId, trx) => {
      const result = await original(organizationId, recipient, facilityId, trx);
      if (recipient.personId === coach.personId) await afterRecheck.pass();
      return result;
    };
    try {
      const reached = afterRecheck.arm();
      const delivering = settle(t.app.get(DeliveryWorker).runOnce());
      await reached; // the worker's re-check passed inside its claim: the grant still stood
      let reevaluating: ReturnType<typeof settle> | null = null;
      if (t.database.concurrent) {
        // PostgreSQL: the revocation commits beside the open claim (no lock in common) and its
        // re-evaluation then runs into the recipient row the claim holds.
        await revokeViaApi(coach.grantId);
        reevaluating = settle(dispatchOutbox(t.app));
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      afterRecheck.open();
      expect((await delivering).ok).toBe(true);
      if (reevaluating) expect((await reevaluating).ok).toBe(true);
      // PGlite runs one transaction at a time: the revocation is ordered after the worker's pass.
      else await revokeViaApi(coach.grantId);
    } finally {
      resolver.isStillAuthorized = original;
    }
    await dispatchOutbox(t.app);
    await deliverQueued(t.app);

    const sent = coachSends(coach, notice.id);
    const sentIds = new Set(sent.map((r) => r.attemptId));
    expect(sent.length).toBe(sentIds.size);
    expect(sent.length).toBeGreaterThanOrEqual(1); // the claim that committed first was handed over
    // PostgreSQL: the revocation committed before the next claim, so that one was never sent.
    if (t.database.concurrent) expect(sent).toHaveLength(1);
    const external = (await attemptsFor(notice.id, coach.personId)).filter(
      (a) => a.channel !== 'in_app',
    );
    expect(external).toHaveLength(2);
    for (const attempt of external) {
      if (sentIds.has(attempt.id)) {
        expect(attempt.attempted_at).not.toBeNull();
        expect(attempt).toMatchObject({ status: 'provider_accepted', failure_code: null });
      } else {
        expect(attempt).toMatchObject({
          status: 'failed',
          failure_code: 'RECIPIENT_REVOKED',
          attempted_at: null,
        });
      }
    }
  });

  /** An adult who is a subject of the notice and also holds receive_messages over a child. */
  async function createParentAndChild() {
    const parentId = await createPersonFixture(t, { kind: 'adult' });
    await createAccountFixture(t, { personId: parentId });
    const email = `parent-${parentId}@example.test`;
    await createContactPointFixture(t, { personId: parentId, kind: 'email', value: email });
    const childId = await createPersonFixture(t, { kind: 'child' });
    const { grantIds } = await createRelationshipFixture(t, {
      actorPersonId: parentId,
      subjectPersonId: childId,
      permissions: ['view', 'receive_messages'],
    });
    return { parentId, childId, email, grantId: grantIds.receive_messages as string };
  }

  const composeAndSendViaApi = async (body: object) => {
    const composed = await t.http
      .post('/v1/notifications')
      .set(staff)
      .set('Idempotency-Key', key())
      .send({
        kind: 'youth_feedback',
        title: 'Private feedback',
        body: 'For the family.',
        ...body,
      });
    expect(composed.status).toBe(201);
    const sent = await t.http
      .post(`/v1/notifications/${composed.body.id}/send`)
      .set(staff)
      .set('Idempotency-Key', key())
      .send({});
    expect(sent.status).toBe(200);
    return composed.body.id as string;
  };

  it('invariant 10 / SPK-IAM-006 / SPK-COMMS-003: a recipient who is both a subject and the receive_messages holder over another subject is re-checked for every subject, whatever the audience order', async () => {
    // revoked before dispatch
    const before = await createParentAndChild();
    const ids = [
      await composeAndSendViaApi({
        protected: true,
        audience: { subjectPersonIds: [before.parentId, before.childId] },
      }),
      await composeAndSendViaApi({
        protected: true,
        audience: { subjectPersonIds: [before.childId, before.parentId] },
      }),
    ];
    for (const id of ids) {
      expect((await recipientFor(id, before.parentId))?.subject_person_ids.sort()).toEqual(
        [before.parentId, before.childId].sort(),
      );
    }
    await revokeViaApi(before.grantId);
    await dispatchOutbox(t.app);
    // revoked after dispatch, while the email is still unsent
    const after = await createParentAndChild();
    const later = [
      await composeAndSendViaApi({
        protected: true,
        audience: { subjectPersonIds: [after.parentId, after.childId] },
      }),
      await composeAndSendViaApi({
        protected: true,
        audience: { subjectPersonIds: [after.childId, after.parentId] },
      }),
    ];
    await dispatchOutbox(t.app);
    for (const id of later) {
      expect((await recipientFor(id, after.parentId))?.status).toBe('authorized');
    }
    await revokeViaApi(after.grantId);
    await dispatchOutbox(t.app);
    await deliverQueued(t.app);

    for (const id of ids) {
      expect(await recipientFor(id, before.parentId)).toMatchObject({
        status: 'revoked',
        revocation_reason: 'authority_revoked_before_dispatch',
      });
      expect(await attemptsFor(id, before.parentId)).toHaveLength(0);
    }
    for (const id of later) {
      expect(await recipientFor(id, after.parentId)).toMatchObject({
        status: 'revoked',
        revocation_reason: 'authority_revoked_while_queued',
      });
    }
    const emailed = fakes.email.sent.map((r) => r.address);
    expect(emailed).not.toContain(before.email);
    expect(emailed).not.toContain(after.email);
  });

  it('invariant 10 / SPK-AT-017: a protected notice cannot name explicit recipients (their authority could never be re-checked); an unprotected one still can', async () => {
    const named = await createPersonFixture(t, { kind: 'adult' });
    const refused = await t.http
      .post('/v1/notifications')
      .set(staff)
      .set('Idempotency-Key', key())
      .send({
        kind: 'youth_feedback',
        audience: { personIds: [named] },
        title: 'Private feedback',
        body: 'Coach-only notes.',
        protected: true,
      });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { code: 'PROTECTED_EXPLICIT_RECIPIENT' },
    });
    const plain = await t.http
      .post('/v1/notifications')
      .set(staff)
      .set('Idempotency-Key', key())
      .send({
        kind: 'staff_broadcast',
        audience: { personIds: [named] },
        title: 'Field change',
        body: 'Saturday games move to the north pitch.',
        protected: false,
      });
    expect(plain.status).toBe(201);
    // defense in depth for a protected row stored with an explicit basis: it never re-checks true
    const resolver = t.app.get(AudienceResolver);
    expect(
      await resolver.isStillAuthorized(
        org,
        {
          personId: named,
          basis: 'explicit',
          basisDetail: null,
          subjectPersonIds: [],
          audience: {
            subjectPersonIds: [],
            staffRoles: [],
            facilityId: null,
            teamEntryIds: [],
            personIds: [named],
          },
        },
        null,
      ),
    ).toBe(false);
  });

  it('SPK-AT-017: a coach addressed by staff role whose staff membership ends while a protected notice is queued is revoked and never emailed', async () => {
    const coach = await createStaffMemberFixture(t, { roles: ['coach'] });
    const email = `staff-coach-${coach.personId}@example.test`;
    await createContactPointFixture(t, { personId: coach.personId, kind: 'email', value: email });
    const sysadmin = await createStaffMemberFixture(t, { roles: ['system_administrator'] });
    const id = await composeAndSendViaApi({ protected: true, audience: { staffRoles: ['coach'] } });
    expect((await recipientFor(id, coach.personId))?.resolved_basis).toBe('staff_role');
    const ended = await t.http
      .post(`/v1/staff-memberships/${coach.membershipId}/end`)
      .set(await authHeaderForPerson(t, sysadmin.personId))
      .set('Idempotency-Key', key())
      .send({ reason: 'left the club' });
    expect(ended.status).toBe(200);
    await dispatchOutbox(t.app);
    await deliverQueued(t.app);
    expect((await recipientFor(id, coach.personId))?.status).toBe('revoked');
    expect(await attemptsFor(id, coach.personId)).toHaveLength(0);
    expect(fakes.email.sent.some((r) => r.address === email)).toBe(false);
  });

  describe('staff-role recipients are re-checked in the audience facility scope (SPK-COMMS-003, invariant 10)', () => {
    let sysadminAuth: { Authorization: string };
    const addFacility = async () => {
      const id = newId();
      await t.db
        .insertInto('facilities')
        .values({
          id,
          organization_id: org,
          slug: `annex-${id}`,
          name: 'Annex',
          timezone: 'America/Los_Angeles',
          address: null,
        })
        .execute();
      return id;
    };
    const schedulerAt = async (facilityId: string) => {
      const scheduler = await createStaffMemberFixture(t, {
        roles: ['scheduler'],
        facilityIds: [facilityId],
      });
      const email = `scheduler-${scheduler.personId}@example.test`;
      await createContactPointFixture(t, {
        personId: scheduler.personId,
        kind: 'email',
        value: email,
      });
      return { ...scheduler, email };
    };
    const moveTo = async (membershipId: string, facilityId: string) => {
      const moved = await t.http
        .patch(`/v1/staff-memberships/${membershipId}`)
        .set(sysadminAuth)
        .set('Idempotency-Key', key())
        .send({ facilityIds: [facilityId], expectedRevision: 1 });
      expect(moved.status).toBe(200);
    };
    beforeAll(async () => {
      const sysadmin = await createStaffMemberFixture(t, { roles: ['system_administrator'] });
      sysadminAuth = await authHeaderForPerson(t, sysadmin.personId);
    });

    it('a scheduler moved out of the audience facility before dispatch is revoked even when the notice carries no facility tag', async () => {
      const [f2, f3] = [await addFacility(), await addFacility()];
      const scheduler = await schedulerAt(f2);
      const id = await composeAndSendViaApi({
        kind: 'staff_broadcast',
        protected: true,
        audience: { staffRoles: ['scheduler'], facilityId: f2 },
      });
      expect((await recipientFor(id, scheduler.personId))?.status).toBe('pending');
      await moveTo(scheduler.membershipId, f3);
      await dispatchOutbox(t.app);
      await deliverQueued(t.app);
      expect(await recipientFor(id, scheduler.personId)).toMatchObject({
        status: 'revoked',
        revocation_reason: 'authority_revoked_before_dispatch',
      });
      expect(fakes.email.sent.some((r) => r.address === scheduler.email)).toBe(false);
    });

    it('a scheduler moved out of the audience facility after dispatch is revoked by the worker and never emailed', async () => {
      const [f2, f3] = [await addFacility(), await addFacility()];
      const scheduler = await schedulerAt(f2);
      const id = await composeAndSendViaApi({
        kind: 'staff_broadcast',
        protected: true,
        audience: { staffRoles: ['scheduler'], facilityId: f2 },
      });
      await dispatchOutbox(t.app);
      expect((await recipientFor(id, scheduler.personId))?.status).toBe('authorized');
      await moveTo(scheduler.membershipId, f3);
      await deliverQueued(t.app);
      expect(await recipientFor(id, scheduler.personId)).toMatchObject({
        status: 'revoked',
        revocation_reason: 'authority_revoked_before_handoff',
      });
      expect(fakes.email.sent.some((r) => r.address === scheduler.email)).toBe(false);
    });

    it('a staff-role recipient of an organization-wide audience on a facility-tagged notice is not revoked', async () => {
      const f2 = await addFacility();
      const scheduler = await schedulerAt(f2);
      const id = await composeAndSendViaApi({
        kind: 'staff_broadcast',
        protected: true,
        facilityId: t.facilityId,
        audience: { staffRoles: ['scheduler'] },
      });
      await dispatchOutbox(t.app);
      await deliverQueued(t.app);
      expect((await recipientFor(id, scheduler.personId))?.status).toBe('authorized');
      expect(fakes.email.sent.some((r) => r.address === scheduler.email)).toBe(true);
    });
  });

  describe('SPK-IAM-006 / SPK-AT-017: the inbox re-checks a protected notice on every read', () => {
    const inboxIds = async (auth: { Authorization: string }) =>
      (await t.http.get('/v1/me/inbox?limit=100').set(auth)).body.items.map(
        (i: { notificationId: string }) => i.notificationId,
      );
    const inAppOf = async (notificationId: string, personId: string) =>
      (await attemptsFor(notificationId, personId)).find((a) => a.channel === 'in_app');
    const command = (auth: { Authorization: string }, attemptId: string, verb: string) =>
      t.http
        .post(`/v1/me/inbox/${attemptId}/${verb}`)
        .set(auth)
        .set('Idempotency-Key', key())
        .send({});

    it('a recipient revoked while external attempts were unsent no longer sees the protected notice; read and acknowledge are not found; the delivered fact is kept; an unprotected notice is still served', async () => {
      const coach = await createCoach();
      const coachAuth = await authHeaderForPerson(t, coach.personId);
      const parentAuth = await authHeaderForPerson(t, people.adult.personId);
      const secret = await queue({ kind: 'youth_feedback', protected: true, title: 'Secret' });
      const plain = await queue({ kind: 'schedule_changed', protected: false });
      await dispatchOutbox(t.app);
      expect(await inboxIds(coachAuth)).toEqual(expect.arrayContaining([secret.id, plain.id]));
      const coachInApp = await inAppOf(secret.id, coach.personId);

      await revokeViaApi(coach.grantId);
      await dispatchOutbox(t.app);
      expect((await recipientFor(secret.id, coach.personId))?.status).toBe('revoked');
      const visible = await inboxIds(coachAuth);
      expect(visible).not.toContain(secret.id);
      expect(visible).toContain(plain.id);
      expect((await command(coachAuth, coachInApp?.id as string, 'read')).status).toBe(404);
      expect((await command(coachAuth, coachInApp?.id as string, 'acknowledge')).status).toBe(404);
      expect(await inAppOf(secret.id, coach.personId)).toMatchObject({ status: 'delivered' });
      const acks = await t.db
        .selectFrom('notification_acknowledgments')
        .select('id')
        .where('delivery_attempt_id', '=', coachInApp?.id as string)
        .execute();
      expect(acks).toHaveLength(0);

      // the parent, whose authority stands, still sees and acknowledges it
      expect(await inboxIds(parentAuth)).toContain(secret.id);
      const parentInApp = await inAppOf(secret.id, people.adult.personId);
      expect((await command(parentAuth, parentInApp?.id as string, 'acknowledge')).status).toBe(
        200,
      );
    });

    it('a recipient whose attempts were all handed over before the revocation stays authorized in the record, but the inbox stops serving the protected notice', async () => {
      const coach = await createCoach();
      const coachAuth = await authHeaderForPerson(t, coach.personId);
      const secret = await queue({ kind: 'youth_feedback', protected: true, title: 'Handed over' });
      await dispatchOutbox(t.app);
      await deliverQueued(t.app);
      expect(await inboxIds(coachAuth)).toContain(secret.id);
      await revokeViaApi(coach.grantId);
      await dispatchOutbox(t.app);
      expect((await recipientFor(secret.id, coach.personId))?.status).toBe('authorized');
      expect(await inboxIds(coachAuth)).not.toContain(secret.id);
      const coachInApp = await inAppOf(secret.id, coach.personId);
      expect((await command(coachAuth, coachInApp?.id as string, 'read')).status).toBe(404);
    });
  });
});
