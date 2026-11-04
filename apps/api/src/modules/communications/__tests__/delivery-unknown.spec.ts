import { newId, systemPrincipal, type Principal } from '@sportspark/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../testing';
import {
  authHeaderForPerson,
  createContactPointFixture,
  createOrganizationPeople,
  createStaffMemberFixture,
  type OrganizationPeople,
} from '../../identity';
import { CommunicationsModule } from '../communications.module';
import { DELIVERY_UNKNOWN_EXCEPTION } from '../services/delivery-worker';
import {
  attemptsOf,
  composeAndDispatch,
  deliverQueued,
  fakeProviders,
  recordReceipt,
  type FakeProviders,
} from '../testing/communications-fixtures';
import { withDeclaredPortDoubles } from './support';

const key = () => `k-${newId()}`;

/**
 * R4-COMMS-AUTOMATION-07, R4-PROVIDER-OUTCOMES-07 (§4.11 "unknown kept explicit until reconciled",
 * §5.11 "operational issues must have owners and supported resolution actions", SPK-COMMS-004,
 * SPK-UX-006): an essential notice whose push/email/SMS hand-off gave no trustworthy outcome is an
 * owned front-desk exception, resolved when a receipt arrives or when staff record what they
 * established; reconciled as failed, the delivery may then be retried.
 */
describe('unknown delivery outcomes have an owner and a resolution action (§4.11, §5.11)', () => {
  let t: TestApp;
  let org: string;
  let system: Principal;
  let fakes: FakeProviders;
  let people: OrganizationPeople;
  let frontDesk: { Authorization: string };
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
    people = await createOrganizationPeople(t, { staffRoles: ['front_desk'] });
    frontDesk = await authHeaderForPerson(t, people.staff.personId);
    const manager = await createStaffMemberFixture(t, { roles: ['general_manager'] });
    gm = await authHeaderForPerson(t, manager.personId);
    await createContactPointFixture(t, {
      personId: people.adult.personId,
      kind: 'email',
      value: 'parent@example.test',
      verified: true,
    });
  });
  beforeEach(() => {
    fakes.email.reset();
    fakes.push.reset();
  });
  afterAll(async () => {
    await t.close();
  });

  /** An essential notice whose email hand-off times out (the fake's unknown scenario). */
  const unknownEmail = async (overrides: object = {}) => {
    fakes.email.scriptNext('unknown');
    const n = await composeAndDispatch(t.app, system, {
      kind: 'cancellation',
      audience: { subjectPersonIds: [people.child.personId] },
      title: 'Canceled: U10 practice',
      body: 'The pitch is closed tonight.',
      ...overrides,
    });
    await deliverQueued(t.app);
    const email = (await attemptsOf(t.db, org, n.id)).find((a) => a.channel === 'email');
    expect(email?.status).toBe('unknown');
    return email!;
  };
  const exceptionsOf = (attemptId: string) =>
    t.db
      .selectFrom('operational_exceptions')
      .selectAll()
      .where('organization_id', '=', org)
      .where('affected_type', '=', 'delivery_attempt')
      .where('affected_id', '=', attemptId)
      .orderBy('opened_at')
      .orderBy('id')
      .execute();
  const reconcile = (attemptId: string, body: object, header = frontDesk) =>
    t.http
      .post(`/v1/delivery-attempts/${attemptId}/reconcile`)
      .set(header)
      .set('Idempotency-Key', key())
      .send(body);

  it('§4.11: an unknown delivery of an essential notice is an open front_desk exception until a receipt resolves it', async () => {
    const email = await unknownEmail();
    const [raised] = await exceptionsOf(email.id);
    expect(raised).toMatchObject({
      category: DELIVERY_UNKNOWN_EXCEPTION,
      owner_queue: 'front_desk',
      status: 'open',
    });

    await recordReceipt(
      t.app,
      fakes.email,
      { attemptId: email.id, organizationId: org },
      'delivered',
    );
    const [after] = await attemptsOf(t.db, org, email.notification_id).then((rows) =>
      rows.filter((a) => a.id === email.id),
    );
    expect(after?.status).toBe('delivered');
    expect(await exceptionsOf(email.id)).toMatchObject([
      { category: DELIVERY_UNKNOWN_EXCEPTION, status: 'resolved' },
    ]);
  });

  it('§5.11: staff reconcile an unknown delivery as failed; the exception is resolved, the failure is raised, and a retry is allowed', async () => {
    const email = await unknownEmail({ title: 'Canceled: U12 practice' });
    // a reader without the action may not record an outcome
    const finance = await createStaffMemberFixture(t, { roles: ['finance_operator'] });
    const denied = await reconcile(
      email.id,
      { outcome: 'failed', evidence: 'n/a' },
      await authHeaderForPerson(t, finance.personId),
    );
    expect(denied.status).toBe(403);
    // evidence is required
    expect((await reconcile(email.id, { outcome: 'failed' })).status).toBe(400);

    const reconciled = await reconcile(email.id, {
      outcome: 'failed',
      evidence: 'The provider console has no message for this address.',
      expectedRevision: email.revision,
    });
    expect(reconciled.status, JSON.stringify(reconciled.body)).toBe(200);
    expect(reconciled.body).toMatchObject({
      id: email.id,
      status: 'failed',
      failureCode: 'PROVIDER_ERROR',
      revision: email.revision + 1,
    });
    const exceptions = await exceptionsOf(email.id);
    expect(exceptions.map((e) => [e.category, e.status])).toEqual([
      [DELIVERY_UNKNOWN_EXCEPTION, 'resolved'],
      ['communications.delivery_failed', 'open'],
    ]);
    const audit = await t.db
      .selectFrom('audit_records')
      .select(['action', 'actor', 'details'])
      .where('organization_id', '=', org)
      .where('target_id', '=', email.id)
      .where('action', '=', 'communications.reconcile_delivery')
      .execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actor).toMatchObject({ personId: people.staff.personId });
    expect(audit[0]?.details).toMatchObject({
      from: 'unknown',
      to: 'failed',
      source: 'operator',
      evidence: 'The provider console has no message for this address.',
    });

    // the recorded fact is not reconciled twice, and a receipt arriving late does not rewrite it
    const again = await reconcile(email.id, { outcome: 'delivered', evidence: 'family says yes' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('INVALID_TRANSITION');
    await recordReceipt(
      t.app,
      fakes.email,
      { attemptId: email.id, organizationId: org },
      'delivered',
    );
    expect(
      (await attemptsOf(t.db, org, email.notification_id)).find((a) => a.id === email.id),
    ).toMatchObject({ status: 'failed', failure_code: 'PROVIDER_ERROR' });

    // now failed, the delivery may be retried (COM-02)
    const retried = await t.http
      .post(`/v1/delivery-attempts/${email.id}/retry`)
      .set(gm)
      .set('Idempotency-Key', key())
      .send({ reason: 'not sent: provider timeout' });
    expect(retried.status, JSON.stringify(retried.body)).toBe(201);
    expect(retried.body).toMatchObject({ retryOfAttemptId: email.id, status: 'queued' });
    await deliverQueued(t.app);
    expect(fakes.email.sent.map((r) => r.attemptId)).toContain(retried.body.id);
  });

  it('§5.11: staff may record that an unknown delivery was in fact delivered; a promotional unknown raises nothing', async () => {
    const email = await unknownEmail({ title: 'Canceled: U14 practice' });
    const reconciled = await reconcile(email.id, {
      outcome: 'delivered',
      evidence: 'The parent confirmed by phone that the email arrived.',
    });
    expect(reconciled.status, JSON.stringify(reconciled.body)).toBe(200);
    expect(reconciled.body).toMatchObject({ status: 'delivered', failureCode: null });
    expect((await exceptionsOf(email.id)).map((e) => [e.category, e.status])).toEqual([
      [DELIVERY_UNKNOWN_EXCEPTION, 'resolved'],
    ]);

    // only an unknown attempt is reconciled
    const notUnknown = await reconcile(email.id, { outcome: 'failed', evidence: 'x' });
    expect(notUnknown.status).toBe(409);

    const promotional = await unknownEmail({
      kind: 'staff_broadcast',
      category: 'promotional',
      audience: { subjectPersonIds: [people.adult.personId] },
      title: 'Summer camp',
      body: 'Book now.',
    });
    expect(await exceptionsOf(promotional.id)).toEqual([]);
  });
});
