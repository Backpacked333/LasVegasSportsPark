import { newId, systemPrincipal, type Principal } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../testing';
import {
  authHeaderForPerson,
  createAccountFixture,
  createOrganizationPeople,
  createPersonFixture,
  createRelationshipFixture,
  type OrganizationPeople,
} from '../../identity';
import { CommunicationsModule } from '../communications.module';
import { composeAndDispatch } from '../testing/communications-fixtures';
import { withDeclaredPortDoubles } from './support';

const key = () => `k-${newId()}`;

/**
 * Park UI redesign gaps: the live recipient count while composing (SPK-COMMS-006, by channel with
 * opt-outs, no names; channel policy pending DEC-012 / DEC-062) and the inbox badge (SPK-UX-003).
 */
describe('composer audience counts and the inbox unread count', () => {
  let t: TestApp;
  let system: Principal;
  let people: OrganizationPeople;
  let staff: { Authorization: string };
  let parent: { Authorization: string };

  beforeAll(async () => {
    t = await createTestApp({
      configure: withDeclaredPortDoubles,
      imports: [CommunicationsModule],
      principalResolver: 'module',
      clockStart: '2026-10-23T12:00:00Z',
    });
    system = systemPrincipal(t.organizationId, 'test');
    people = await createOrganizationPeople(t, { staffRoles: ['front_desk'] });
    staff = await authHeaderForPerson(t, people.staff.personId);
    parent = await authHeaderForPerson(t, people.adult.personId);
  });
  afterAll(async () => {
    await t.close();
  });

  const count = (body: object, headers = staff) =>
    t.http.post('/v1/notification-audience-counts').set(headers).send(body);

  it('SPK-COMMS-006: the live count resolves the audience now and breaks it down by channel, opt-outs and defaults, without a name', async () => {
    // A second guardian of the same child who switched promotional email off.
    const second = await createPersonFixture(t, { kind: 'adult' });
    await createAccountFixture(t, { personId: second });
    await createRelationshipFixture(t, {
      actorPersonId: second,
      subjectPersonId: people.child.personId,
    });
    const secondHeader = await authHeaderForPerson(t, second);
    const optOut = await t.http
      .patch('/v1/me/communication-preferences')
      .set(secondHeader)
      .set('Idempotency-Key', key())
      .send({ preferences: [{ channel: 'email', category: 'promotional', enabled: false }] });
    expect(optOut.status).toBe(200);

    const promo = await count({
      kind: 'renewal_opportunity',
      audience: { subjectPersonIds: [people.child.personId] },
    });
    expect(promo.status, JSON.stringify(promo.body)).toBe(200);
    expect(promo.body.category).toBe('promotional');
    expect(promo.body.count).toBe(2);
    const byChannel = Object.fromEntries(
      promo.body.channels.map((c: { channel: string }) => [c.channel, c]),
    );
    expect(byChannel.in_app).toMatchObject({ reachable: 2, optedOut: 0 });
    expect(byChannel.email).toMatchObject({ reachable: 1, optedOut: 1, offByDefault: 0 });
    // Promotional push is off by the policy default for both (an engineering placeholder).
    expect(byChannel.push).toMatchObject({ reachable: 0, optedOut: 0, offByDefault: 2 });
    expect(promo.body.pendingDecisions).toEqual(['DEC-012', 'DEC-062']);
    // No recipient name, id or contact detail is returned before a preview.
    const text = JSON.stringify(promo.body);
    expect(text).not.toContain(people.adult.personId);
    expect(text).not.toContain(second);

    // Essential notices keep in-app on for everyone; the opt-out was promotional only.
    const essential = await count({
      kind: 'cancellation',
      audience: { subjectPersonIds: [people.child.personId] },
    });
    expect(essential.body.category).toBe('operational');
    const emailEssential = essential.body.channels.find(
      (c: { channel: string }) => c.channel === 'email',
    );
    expect(emailEssential).toMatchObject({ reachable: 2, optedOut: 0 });
  });

  it('SPK-COMMS-006/007: the count is authorized like a preview, refuses a contradicting category, and is closed to customers', async () => {
    const mismatch = await count({
      kind: 'cancellation',
      category: 'promotional',
      audience: { subjectPersonIds: [people.child.personId] },
    });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.details).toMatchObject({ code: 'CATEGORY_MISMATCH' });
    const byCustomer = await count(
      { kind: 'cancellation', audience: { subjectPersonIds: [people.child.personId] } },
      parent,
    );
    expect(byCustomer.status).toBe(403);
    const explicitProtected = await count({
      kind: 'cancellation',
      protected: true,
      audience: { personIds: [people.adult.personId] },
    });
    expect(explicitProtected.status).toBe(400);
  });

  it('SPK-UX-003: the inbox badge counts delivered notices not yet read', async () => {
    const reader = await createPersonFixture(t, { kind: 'adult' });
    await createAccountFixture(t, { personId: reader });
    const header = await authHeaderForPerson(t, reader);
    const empty = await t.http.get('/v1/me/inbox/unread-count').set(header);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ unread: 0, capped: false, cap: 99 });
    for (const title of ['First notice', 'Second notice']) {
      await composeAndDispatch(t.app, system, {
        kind: 'staff_broadcast',
        category: 'operational',
        audience: { personIds: [reader] },
        title,
        body: 'Body',
      });
    }
    const two = await t.http.get('/v1/me/inbox/unread-count').set(header);
    expect(two.body).toMatchObject({ unread: 2, capped: false });
    const inbox = await t.http.get('/v1/me/inbox').set(header);
    const item = inbox.body.items[0] as { attemptId: string; revision: number };
    const read = await t.http
      .post(`/v1/me/inbox/${item.attemptId}/read`)
      .set(header)
      .set('Idempotency-Key', key())
      .send({ expectedRevision: item.revision });
    expect(read.status).toBe(200);
    const one = await t.http.get('/v1/me/inbox/unread-count').set(header);
    expect(one.body.unread).toBe(1);
  });
});
