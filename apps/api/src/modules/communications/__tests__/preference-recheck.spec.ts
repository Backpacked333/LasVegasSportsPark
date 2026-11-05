import { newId, systemPrincipal, type Principal } from '@sportspark/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../testing';
import {
  authHeaderForPerson,
  createContactPointFixture,
  createOrganizationPeople,
  type OrganizationPeople,
} from '../../identity';
import { CommunicationsModule } from '../communications.module';
import {
  attemptsOf,
  composeAndDispatch,
  deliverQueued,
  fakeProviders,
  type FakeProviders,
} from '../testing/communications-fixtures';
import { withDeclaredPortDoubles } from './support';

const key = () => `k-${newId()}`;

/**
 * R4-COMMS-AUTOMATION-05 (SPK-COMMS-007 "essential operational communications and promotional
 * preferences must be separately represented", SPK-COMMS-001): a person's channel choice is read
 * again before every send, not only when dispatch created the attempts. A staff retry is refused
 * on a channel switched off since, and the delivery worker never hands over an attempt on one.
 */
describe('channel preferences are re-checked before every send (SPK-COMMS-007)', () => {
  let t: TestApp;
  let org: string;
  let system: Principal;
  let fakes: FakeProviders;
  let people: OrganizationPeople;
  let gm: { Authorization: string };
  let adult: { Authorization: string };

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
    adult = await authHeaderForPerson(t, people.adult.personId);
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

  const setEmail = async (category: 'operational' | 'promotional', enabled: boolean) => {
    const res = await t.http
      .patch('/v1/me/communication-preferences')
      .set(adult)
      .set('Idempotency-Key', key())
      .send({ preferences: [{ channel: 'email', category, enabled }] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  };
  const emailOf = async (notificationId: string) =>
    (await attemptsOf(t.db, org, notificationId)).filter((a) => a.channel === 'email');
  const retry = (attemptId: string) =>
    t.http
      .post(`/v1/delivery-attempts/${attemptId}/retry`)
      .set(gm)
      .set('Idempotency-Key', key())
      .send({ reason: 'mailbox fixed' });

  it('SPK-COMMS-007: a retry is refused on a channel the person switched off since the original send', async () => {
    fakes.email.scriptNext('failed');
    const n = await composeAndDispatch(t.app, system, {
      kind: 'staff_broadcast',
      category: 'promotional',
      audience: { subjectPersonIds: [people.adult.personId] },
      title: 'Summer camp early bird',
      body: 'Book before Friday.',
    });
    await deliverQueued(t.app);
    const [failed] = await emailOf(n.id);
    expect(failed).toMatchObject({ status: 'failed', failure_code: 'PROVIDER_REJECTED' });

    await setEmail('promotional', false);
    const refused = await retry(failed?.id as string);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.details).toMatchObject({ code: 'CHANNEL_DISABLED', channel: 'email' });
    expect(await emailOf(n.id)).toHaveLength(1);

    // switched on again, the same failed attempt may be retried
    await setEmail('promotional', true);
    const retried = await retry(failed?.id as string);
    expect(retried.status, JSON.stringify(retried.body)).toBe(201);
    fakes.email.reset();
    await deliverQueued(t.app);
    expect(fakes.email.sent.map((r) => r.attemptId)).toEqual([retried.body.id]);
  });

  it('SPK-COMMS-007: a queued attempt on a channel switched off before the hand-off is failed CHANNEL_DISABLED and never handed over', async () => {
    const n = await composeAndDispatch(t.app, system, {
      kind: 'placement',
      audience: { subjectPersonIds: [people.child.personId] },
      title: 'Placement confirmed',
      body: 'Your child has been placed on the Lions.',
    });
    const [queued] = await emailOf(n.id);
    expect(queued?.status).toBe('queued');

    await setEmail('operational', false);
    await deliverQueued(t.app);
    expect(await emailOf(n.id)).toMatchObject([
      { id: queued?.id, status: 'failed', failure_code: 'CHANNEL_DISABLED' },
    ]);
    expect(fakes.email.sent.map((r) => r.attemptId)).not.toContain(queued?.id);
    // the person's own choice is not a failed urgent communication (SPK-UX-006)
    const exceptions = await t.db
      .selectFrom('operational_exceptions')
      .select('id')
      .where('organization_id', '=', org)
      .where('affected_id', '=', queued?.id as string)
      .execute();
    expect(exceptions).toEqual([]);
    // nor is it retried while the channel stays off
    const refused = await retry(queued?.id as string);
    expect(refused.status).toBe(409);
    expect(refused.body.details).toMatchObject({ code: 'CHANNEL_DISABLED' });
    await setEmail('operational', true);
  });
});
