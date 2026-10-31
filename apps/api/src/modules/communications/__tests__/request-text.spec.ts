import { newId, systemPrincipal, type Principal } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Response } from 'supertest';
import { UnitOfWork } from '../../../kernel';
import { createTestApp, type TestApp } from '../../../testing';
import {
  authHeaderForPerson,
  createContactPointFixture,
  createOrganizationPeople,
  type OrganizationPeople,
} from '../../identity';
import { CommunicationsModule } from '../communications.module';
import {
  FAKE_MESSAGING_SIGNATURE_HEADER,
  FakeMessagingProvider,
} from '../providers/fake-messaging.provider';
import { NotificationsService } from '../services/notifications.service';
import {
  attemptsOf,
  composeAndDispatch,
  deliverQueued,
  fakeProviders,
  inboxOf,
  type FakeProviders,
} from '../testing/communications-fixtures';
import { withDeclaredPortDoubles } from './support';

const key = () => `k-${newId()}`;
const NUL = '\u0000';

/**
 * R2-TENANCY-INPUT-04 (§4.10 stable errors, §4.9 command input): PostgreSQL `text` and `jsonb`
 * cannot hold U+0000, so a communications request carrying one used to fail at the insert and
 * answer 500 INTERNAL_ERROR ("retry or contact support"), a server fault for input the client
 * must correct. Every communications command now answers 400 VALIDATION_FAILED naming the field.
 * Single-line text (titles, labels, identifiers, tokens) also refuses the other C0 controls and
 * DEL; multi-line text (bodies, reasons, notes) keeps tab, line feed and carriage return. Each
 * command is sent against a real target, so without the check the request reaches the database.
 */
describe('communications request text (R2-TENANCY-INPUT-04, §4.10)', () => {
  let t: TestApp;
  let org: string;
  let system: Principal;
  let fakes: FakeProviders;
  let people: OrganizationPeople;
  let gm: { Authorization: string };
  let parent: { Authorization: string };

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
    parent = await authHeaderForPerson(t, people.adult.personId);
    await createContactPointFixture(t, {
      personId: people.adult.personId,
      kind: 'email',
      value: 'parent@example.test',
      verified: true,
    });
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
  const post = (path: string, header: { Authorization: string }, body: object) =>
    t.http.post(path).set(header).set('Idempotency-Key', key()).send(body);

  /** 400 VALIDATION_FAILED whose details name `path`. */
  function expectRefused(response: Response, path: string): void {
    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(response.body.code).toBe('VALIDATION_FAILED');
    const paths = (response.body.details as { path: string }[]).map((d) => d.path);
    expect(paths).toContain(path);
  }

  /** An in-app inbox item of the parent and the parent's failed email attempt of one notice. */
  async function deliveredNotice(): Promise<{ inboxAttemptId: string; failedEmailId: string }> {
    fakes.email.scriptNext('failed');
    const n = await composeAndDispatch(t.app, system, notice());
    await deliverQueued(t.app);
    const inbox = await inboxOf(t.db, org, people.adult.personId);
    const inApp = inbox.find((a) => a.notification_id === n.id);
    const email = (await attemptsOf(t.db, org, n.id)).find(
      (a) => a.channel === 'email' && a.status === 'failed',
    );
    if (!inApp || !email) throw new Error('the notice was not delivered as expected');
    return { inboxAttemptId: inApp.id, failedEmailId: email.id };
  }

  it('R2-TENANCY-INPUT-04: POST /notifications refuses NUL and control characters in its text, naming the field, and keeps line breaks in the body', async () => {
    const cases: Array<[object, string]> = [
      [{ title: `a${NUL}b` }, 'title'],
      [{ title: 'Two\nlines' }, 'title'],
      [{ title: 'Bell\u0007' }, 'title'],
      [{ title: 'Rub\u007fout' }, 'title'],
      [{ body: `a${NUL}b` }, 'body'],
      [{ body: 'Escape \u001b[31m' }, 'body'],
      [{ subject: { type: `fixture${NUL}`, id: newId() } }, 'subject.type'],
      [{ subject: { type: 'fixture', id: 'a\tb' } }, 'subject.id'],
      [{ detailsBefore: { venue: `Pitch${NUL}1` } }, 'detailsBefore'],
      [{ detailsAfter: { [`key${NUL}`]: 'value' } }, 'detailsAfter'],
      [{ detailsAfter: { rows: [{ deep: [`x${NUL}`] }] } }, 'detailsAfter'],
      [{ reason: `because${NUL}` }, 'reason'],
      [{ policyReferences: ['POL-1', `POL${NUL}2`] }, 'policyReferences.1'],
    ];
    for (const [overrides, path] of cases) {
      expectRefused(await post('/v1/notifications', gm, notice(overrides)), path);
    }
    const accepted = await post(
      '/v1/notifications',
      gm,
      notice({
        title: '  Placement confirmed  ',
        body: 'Line one\r\nLine two\n\tIndented',
        detailsAfter: { venue: 'Pitch 1', note: 'Bring\nboots' },
      }),
    );
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
    expect(accepted.body).toMatchObject({
      title: 'Placement confirmed',
      body: 'Line one\r\nLine two\n\tIndented',
      detailsAfter: { venue: 'Pitch 1', note: 'Bring\nboots' },
    });
    // the refused requests wrote nothing
    const stored = await t.db
      .selectFrom('notifications')
      .select('id')
      .where('organization_id', '=', org)
      .where('created_by_person_id', '=', people.staff.personId)
      .execute();
    expect(stored.map((r) => r.id)).toEqual([accepted.body.id]);
  });

  it('R2-TENANCY-INPUT-04: send, retry, mark read and acknowledge refuse NUL in their text (400, not 500)', async () => {
    const composed = await post('/v1/notifications', gm, notice());
    expect(composed.status).toBe(201);
    expectRefused(
      await post(`/v1/notifications/${composed.body.id}/send`, gm, { reason: `go${NUL}` }),
      'reason',
    );

    const { inboxAttemptId, failedEmailId } = await deliveredNotice();
    expectRefused(
      await post(`/v1/delivery-attempts/${failedEmailId}/retry`, gm, { reason: `fixed${NUL}` }),
      'reason',
    );
    expectRefused(
      await post(`/v1/delivery-attempts/${failedEmailId}/retry`, gm, { reason: 'bell\u0007' }),
      'reason',
    );
    expectRefused(
      await post(`/v1/me/inbox/${inboxAttemptId}/read`, parent, { reason: `seen${NUL}` }),
      'reason',
    );
    expectRefused(
      await post(`/v1/me/inbox/${inboxAttemptId}/acknowledge`, parent, { note: `ok${NUL}` }),
      'note',
    );
    expectRefused(
      await post(`/v1/me/inbox/${inboxAttemptId}/acknowledge`, parent, { note: 'ok\u0001' }),
      'note',
    );
    // the same commands with clean text still work
    const retried = await post(`/v1/delivery-attempts/${failedEmailId}/retry`, gm, {
      reason: 'Mailbox fixed.\nTried again.',
    });
    expect(retried.status, JSON.stringify(retried.body)).toBe(201);
    const acknowledged = await post(`/v1/me/inbox/${inboxAttemptId}/acknowledge`, parent, {
      note: 'Thanks,\nsee you there',
    });
    expect(acknowledged.status, JSON.stringify(acknowledged.body)).toBe(200);
  });

  it('R2-TENANCY-INPUT-04: preferences, calendar feeds and push devices refuse NUL and control characters in their text', async () => {
    expectRefused(
      await t.http
        .patch('/v1/me/communication-preferences')
        .set(parent)
        .set('Idempotency-Key', key())
        .send({
          preferences: [{ channel: 'email', category: 'promotional', enabled: false }],
          reason: `quiet${NUL}`,
        }),
      'reason',
    );

    expectRefused(await post('/v1/me/calendar-feeds', parent, { label: `Family${NUL}` }), 'label');
    expectRefused(await post('/v1/me/calendar-feeds', parent, { label: 'Fam\nily' }), 'label');
    const feed = await post('/v1/me/calendar-feeds', parent, { label: 'Family' });
    expect(feed.status, JSON.stringify(feed.body)).toBe(201);
    expectRefused(
      await post(`/v1/me/calendar-feeds/${feed.body.id}/revoke`, parent, { reason: `lost${NUL}` }),
      'reason',
    );
    expectRefused(
      await post(`/v1/me/calendar-feeds/${feed.body.id}/revoke`, parent, { reason: 'lost\u0008' }),
      'reason',
    );
    const revokedFeed = await post(`/v1/me/calendar-feeds/${feed.body.id}/revoke`, parent, {
      reason: 'Phone lost',
    });
    expect(revokedFeed.status, JSON.stringify(revokedFeed.body)).toBe(200);

    expectRefused(
      await post('/v1/me/push-devices', parent, { platform: 'ios', token: `tok${NUL}en` }),
      'token',
    );
    expectRefused(
      await post('/v1/me/push-devices', parent, {
        platform: 'ios',
        token: `token-${newId()}`,
        appVersion: `1.0${NUL}`,
      }),
      'appVersion',
    );
    const device = await post('/v1/me/push-devices', parent, {
      platform: 'ios',
      token: `token-${newId()}`,
    });
    expect(device.status, JSON.stringify(device.body)).toBe(201);
    expectRefused(
      await post(`/v1/me/push-devices/${device.body.id}/revoke`, parent, { reason: `old${NUL}` }),
      'reason',
    );
    const devices = await t.db
      .selectFrom('push_devices')
      .select(['id', 'status'])
      .where('organization_id', '=', org)
      .where('person_id', '=', people.adult.personId)
      .execute();
    expect(devices).toEqual([{ id: device.body.id, status: 'active' }]);
  });

  it('R2-TENANCY-INPUT-04 / §4.11: a signed provider receipt carrying NUL is refused as 400, not stored', async () => {
    const n = await composeAndDispatch(t.app, system, notice());
    await deliverQueued(t.app);
    const email = (await attemptsOf(t.db, org, n.id)).find((a) => a.channel === 'email');
    const receipt = fakes.email.receipt(
      { attemptId: email?.id as string, organizationId: org },
      'failed',
      { error: `mailbox full${NUL}` },
    ).body;
    for (const [body, path] of [
      [receipt, 'data.error'],
      [{ ...receipt, id: `evt${NUL}` }, 'id'],
      [
        { ...receipt, data: { ...receipt.data, error: null, providerMessageId: `m${NUL}` } },
        'data.providerMessageId',
      ],
    ] as const) {
      const response = await t.http
        .post('/v1/webhooks/messaging/fake-messaging')
        .set(FAKE_MESSAGING_SIGNATURE_HEADER, FakeMessagingProvider.sign(body))
        .send(body);
      expectRefused(response, path);
    }
  });

  it('R2-TENANCY-INPUT-04: in-process composition from stored text is not refused for control characters', async () => {
    // A team or offering name another module stores may hold a carriage return or a control
    // character; the notice built from it is still composed (the ICS feed and clients render it).
    const row = await t.app
      .get(UnitOfWork)
      .run(async ({ trx }) =>
        t.app
          .get(NotificationsService)
          .composeAndQueueIn(
            trx,
            system,
            notice({ title: 'Lions\r vs\u0001 Tigers', subject: { type: 'fixture', id: 'a\tb' } }),
          ),
      );
    expect(row).toMatchObject({ title: 'Lions\r vs\u0001 Tigers', subject_id: 'a\tb' });
  });
});
