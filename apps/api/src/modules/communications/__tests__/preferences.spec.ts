import { newId, systemPrincipal, type Principal } from '@sportspark/contracts';
import { isCheckViolation, json } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../testing';
import {
  authHeaderForPerson,
  createContactPointFixture,
  createOrganizationPeople,
  type OrganizationPeople,
} from '../../identity';
import { CommunicationsModule } from '../communications.module';
import { attemptsOf, composeAndDispatch } from '../testing/communications-fixtures';

const key = () => `k-${newId()}`;

describe('communication preferences (SPK-COMMS-007 essential vs promotional, SPK-COMMS-001 channels)', () => {
  let t: TestApp;
  let org: string;
  let system: Principal;
  let people: OrganizationPeople;
  let parent: { Authorization: string };

  beforeAll(async () => {
    t = await createTestApp({
      imports: [CommunicationsModule],
      principalResolver: 'module',
      clockStart: '2026-10-23T12:00:00Z',
    });
    org = t.organizationId;
    system = systemPrincipal(org, 'test');
    people = await createOrganizationPeople(t);
    await createContactPointFixture(t, {
      personId: people.adult.personId,
      kind: 'email',
      value: 'parent@example.test',
      verified: true,
    });
    await createContactPointFixture(t, {
      personId: people.adult.personId,
      kind: 'phone',
      value: '+17025550123',
      verified: true,
    });
    parent = await authHeaderForPerson(t, people.adult.personId);
  });
  afterAll(async () => {
    await t.close();
  });

  const matrix = (body: {
    preferences: Array<{ channel: string; category: string; enabled: boolean }>;
  }) => Object.fromEntries(body.preferences.map((p) => [`${p.category}.${p.channel}`, p.enabled]));

  it('represents operational and promotional choices separately with the proposed defaults; operational in-app is locked on', async () => {
    const res = await t.http.get('/v1/me/communication-preferences').set(parent);
    expect(res.status).toBe(200);
    expect(res.body.personId).toBe(people.adult.personId);
    expect(res.body.preferences).toHaveLength(8);
    expect(matrix(res.body)).toEqual({
      'operational.in_app': true,
      'operational.push': true,
      'operational.email': true,
      'operational.sms': false,
      'promotional.in_app': true,
      'promotional.push': false,
      'promotional.email': true,
      'promotional.sms': false,
    });
    const locked = res.body.preferences.find(
      (p: { category: string; channel: string }) =>
        p.category === 'operational' && p.channel === 'in_app',
    );
    expect(locked).toMatchObject({ locked: true, stored: false });
  });

  it('PATCH stores choices per category; disabling the operational in-app channel is refused by the service and by the database', async () => {
    const updated = await t.http
      .patch('/v1/me/communication-preferences')
      .set(parent)
      .set('Idempotency-Key', key())
      .send({
        preferences: [
          { channel: 'email', category: 'promotional', enabled: false },
          { channel: 'sms', category: 'operational', enabled: true },
        ],
      });
    expect(updated.status).toBe(200);
    expect(matrix(updated.body)).toMatchObject({
      'promotional.email': false,
      'operational.email': true, // untouched: categories are independent
      'operational.sms': true,
      'promotional.sms': false,
    });
    expect(
      updated.body.preferences.find(
        (p: { category: string; channel: string }) =>
          p.category === 'promotional' && p.channel === 'email',
      ),
    ).toMatchObject({ stored: true });

    const refused = await t.http
      .patch('/v1/me/communication-preferences')
      .set(parent)
      .set('Idempotency-Key', key())
      .send({ preferences: [{ channel: 'in_app', category: 'operational', enabled: false }] });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('VALIDATION_FAILED');
    await expect(
      t.db
        .insertInto('communication_preferences')
        .values({
          id: newId(),
          organization_id: org,
          person_id: people.adult.personId,
          channel: 'in_app',
          category: 'operational',
          enabled: false,
          updated_by: json({ kind: 'system' }),
        })
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
    // re-choosing bumps the stored row's revision instead of duplicating it
    await t.http
      .patch('/v1/me/communication-preferences')
      .set(parent)
      .set('Idempotency-Key', key())
      .send({ preferences: [{ channel: 'sms', category: 'operational', enabled: false }] });
    const rows = await t.db
      .selectFrom('communication_preferences')
      .select(['channel', 'category', 'enabled', 'revision'])
      .where('person_id', '=', people.adult.personId)
      .where('channel', '=', 'sms')
      .execute();
    expect(rows).toEqual([
      expect.objectContaining({ category: 'operational', enabled: false, revision: 2 }),
    ]);
  });

  it('dispatch honours the per-category choices: a promotional notice never uses a channel the person declined, an essential one keeps its own set', async () => {
    const promotional = await composeAndDispatch(t.app, system, {
      kind: 'renewal_opportunity',
      category: 'promotional',
      audience: { subjectPersonIds: [people.child.personId] },
      title: 'Spring season registration opens',
      body: 'Renew early for the returning-team discount.',
    });
    const promoAttempts = await attemptsOf(t.db, org, promotional.id);
    expect(promoAttempts.map((a) => a.channel).sort()).toEqual(['in_app']); // email declined, push off by default

    const essential = await composeAndDispatch(t.app, system, {
      kind: 'payment_attention',
      audience: { subjectPersonIds: [people.child.personId] },
      title: 'Payment needs attention',
      body: 'The card on file was declined.',
    });
    const essentialAttempts = await attemptsOf(t.db, org, essential.id);
    expect(essentialAttempts.map((a) => a.channel).sort()).toEqual(['email', 'in_app', 'push']);
  });

  it('a person without a linked account cannot manage preferences (self-only)', async () => {
    const res = await t.http
      .get('/v1/me/communication-preferences')
      .set(
        'Authorization',
        `Bearer ${await t.identityProvider.mint({ subject: newId(), sessionId: null })}`,
      );
    expect(res.status).toBe(401);
  });
});
