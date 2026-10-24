import { newId, systemPrincipal, type Principal } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, idempotencyStoreContains, type TestApp } from '../../../testing';
import {
  authHeaderForPerson,
  createAccountFixture,
  createOrganizationPeople,
  createPersonFixture,
  type OrganizationPeople,
} from '../../identity';
import {
  EventsService,
  SchedulingModule,
  at,
  createScheduledEvent,
  personCommitment,
  seedPitchWithHalves,
  type PitchFixture,
} from '../../scheduling';
import { CommunicationsModule } from '../communications.module';
import { dispatchOutbox } from '../testing/communications-fixtures';

const key = () => `k-${newId()}`;

describe('private calendar feeds (SPK-COMMS-008 stable identities and revocable authorization, SPK-IAM-006)', () => {
  let t: TestApp;
  let org: string;
  let system: Principal;
  let events: EventsService;
  let pitch: PitchFixture;
  let people: OrganizationPeople;
  let parent: { Authorization: string };

  beforeAll(async () => {
    t = await createTestApp({
      imports: [CommunicationsModule, SchedulingModule],
      principalResolver: 'module',
      clockStart: '2026-10-23T12:00:00Z',
    });
    org = t.organizationId;
    system = systemPrincipal(org, 'test');
    events = t.app.get(EventsService);
    pitch = await seedPitchWithHalves(t.db, { organizationId: org, facilityId: t.facilityId });
    people = await createOrganizationPeople(t);
    parent = await authHeaderForPerson(t, people.adult.personId);
  });
  afterAll(async () => {
    await t.close();
  });

  const createFeed = (auth: { Authorization: string }, body: object = {}) =>
    t.http.post('/v1/me/calendar-feeds').set(auth).set('Idempotency-Key', key()).send(body);
  const fetchFeed = (path: string) => t.http.get(path);

  it('returns stable UIDs for the owner and in-scope people, updates on changes, shows cancellations, and never lists the token again', async () => {
    const created = await createFeed(parent, {
      label: 'Family calendar',
      subjectPersonIds: [people.child.personId],
    });
    expect(created.status).toBe(201);
    expect(created.body.token).toEqual(expect.any(String));
    expect(created.body.path).toBe(`/v1/calendar-feeds/${created.body.token}.ics`);
    expect(created.body.scope).toEqual({ subjectPersonIds: [people.child.personId] });
    const listed = await t.http.get('/v1/me/calendar-feeds').set(parent);
    expect(listed.body.feeds).toHaveLength(1);
    expect(listed.body.feeds[0]).not.toHaveProperty('token');
    expect(JSON.stringify(listed.body)).not.toContain(created.body.token);
    const stored = await t.db
      .selectFrom('calendar_feeds')
      .select('token_hash')
      .where('id', '=', created.body.id)
      .executeTakeFirstOrThrow();
    expect(stored.token_hash).not.toBe(created.body.token);

    const empty = await fetchFeed(created.body.path);
    expect(empty.status).toBe(200);
    expect(empty.headers['content-type']).toMatch(/text\/calendar/);
    expect(empty.text).toContain('BEGIN:VCALENDAR');
    expect(empty.text).not.toContain('BEGIN:VEVENT');

    const game = await createScheduledEvent(events, {
      organizationId: org,
      facilityId: t.facilityId,
      resourceIds: [pitch.pitchId],
      start: at('2026-11-07', '10:00'),
      end: at('2026-11-07', '11:00'),
      title: 'U10 Lions vs Tigers',
      commitments: [personCommitment(people.child.personId, 'participant')],
    });
    const unrelated = await createScheduledEvent(events, {
      organizationId: org,
      facilityId: t.facilityId,
      resourceIds: [pitch.northHalfId],
      start: at('2026-11-08', '10:00'),
      end: at('2026-11-08', '11:00'),
      title: 'Somebody else',
      commitments: [personCommitment(newId(), 'participant')],
    });
    await dispatchOutbox(t.app);
    let feed = await fetchFeed(created.body.path);
    expect(feed.text).toContain(`UID:${game.id}`);
    expect(feed.text).toContain('SUMMARY:U10 Lions vs Tigers');
    expect(feed.text).toContain('DTSTART:20261107T180000Z');
    expect(feed.text).toContain('STATUS:CONFIRMED');
    expect(feed.text).toContain('SEQUENCE:0');
    expect(feed.text).not.toContain(`UID:${unrelated.id}`);

    const moved = await events.moveEvent(system, game.id, {
      scheduledStart: at('2026-11-07', '12:00'),
      scheduledEnd: at('2026-11-07', '13:00'),
      expectedRevision: game.revision,
    });
    await dispatchOutbox(t.app);
    feed = await fetchFeed(created.body.path);
    expect(feed.text).toContain(`UID:${game.id}`); // same identity after the move
    expect(feed.text).toContain('DTSTART:20261107T200000Z');
    expect(feed.text).toContain('SEQUENCE:1');

    await events.cancelEvent(system, game.id, {
      reason: 'Weather',
      expectedRevision: moved.revision,
    });
    await dispatchOutbox(t.app);
    feed = await fetchFeed(created.body.path);
    expect(feed.text).toContain(`UID:${game.id}`);
    expect(feed.text).toContain('STATUS:CANCELLED');
    expect(feed.text).toContain('SEQUENCE:2');

    const row = await t.db
      .selectFrom('calendar_feeds')
      .select(['access_count', 'last_accessed_at'])
      .where('id', '=', created.body.id)
      .executeTakeFirstOrThrow();
    expect(row.access_count).toBe(4);
    expect(row.last_accessed_at).not.toBeNull();
  });

  it('SPK-IAM-003/006: including a person requires view over them (otherwise not found), and losing view removes them from the feed on the next fetch', async () => {
    const stranger = await createPersonFixture(t, { kind: 'adult' });
    await createAccountFixture(t, { personId: stranger });
    const strangerAuth = await authHeaderForPerson(t, stranger);
    const denied = await createFeed(strangerAuth, { subjectPersonIds: [people.child.personId] });
    expect(denied.status).toBe(404);
    expect(denied.body.code).toBe('NOT_FOUND');
    const own = await createFeed(strangerAuth, {});
    expect(own.status).toBe(201);

    const family = await createFeed(parent, { subjectPersonIds: [people.child.personId] });
    const practice = await createScheduledEvent(events, {
      organizationId: org,
      facilityId: t.facilityId,
      resourceIds: [pitch.southHalfId],
      start: at('2026-11-10', '17:00'),
      end: at('2026-11-10', '18:00'),
      title: 'U10 practice',
      commitments: [personCommitment(people.child.personId, 'participant')],
    });
    await dispatchOutbox(t.app);
    expect((await fetchFeed(family.body.path)).text).toContain(`UID:${practice.id}`);
    await t.db
      .updateTable('access_grants')
      .set({
        revoked_at: t.clock.now(),
        revoked_by: JSON.stringify({ kind: 'system' }),
        revocation_reason: 'test',
      })
      .where('id', '=', people.guardianGrants.view as string)
      .execute();
    const after = await fetchFeed(family.body.path);
    expect(after.status).toBe(200); // the feed itself still exists for the owner's own activities
    expect(after.text).not.toContain(`UID:${practice.id}`);
  });

  it('revocation stops future access: the token answers not found, a revoked feed cannot be revoked twice, and only the owner may revoke', async () => {
    const created = await createFeed(parent, { label: 'Phone' });
    expect((await fetchFeed(created.body.path)).status).toBe(200);
    const stranger = await createPersonFixture(t, { kind: 'adult' });
    await createAccountFixture(t, { personId: stranger });
    const strangerAuth = await authHeaderForPerson(t, stranger);
    const notOwner = await t.http
      .post(`/v1/me/calendar-feeds/${created.body.id}/revoke`)
      .set(strangerAuth)
      .set('Idempotency-Key', key())
      .send({});
    expect(notOwner.status).toBe(404);
    const stale = await t.http
      .post(`/v1/me/calendar-feeds/${created.body.id}/revoke`)
      .set(parent)
      .set('Idempotency-Key', key())
      .send({ expectedRevision: 9 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVISION');
    const revoked = await t.http
      .post(`/v1/me/calendar-feeds/${created.body.id}/revoke`)
      .set(parent)
      .set('Idempotency-Key', key())
      .send({ reason: 'lost phone', expectedRevision: 1 });
    expect(revoked.status).toBe(200);
    expect(revoked.body).toMatchObject({ revokedAt: expect.any(String), revision: 2 });
    const gone = await fetchFeed(created.body.path);
    expect(gone.status).toBe(404);
    expect(gone.body.code).toBe('NOT_FOUND');
    const again = await t.http
      .post(`/v1/me/calendar-feeds/${created.body.id}/revoke`)
      .set(parent)
      .set('Idempotency-Key', key())
      .send({});
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('INVALID_TRANSITION');
    expect((await fetchFeed('/v1/calendar-feeds/not-a-real-token.ics')).status).toBe(404);
    const revokedEvent = await t.db
      .selectFrom('outbox_events')
      .select('id')
      .where('event_type', '=', 'communications.calendar_feed_revoked')
      .where('aggregate_id', '=', created.body.id)
      .execute();
    expect(revokedEvent).toHaveLength(1);
  });

  it('§4.14 / SPK-COMMS-008: the feed token never rests in the idempotency store; a replay withholds it', async () => {
    const idempotencyKey = key();
    const send = () =>
      t.http
        .post('/v1/me/calendar-feeds')
        .set(parent)
        .set('Idempotency-Key', idempotencyKey)
        .send({ label: 'Replay check' });
    const created = await send();
    expect(created.status).toBe(201);
    expect(await idempotencyStoreContains(t.db, created.body.token as string)).toBe(false);
    const replay = await send();
    expect(replay.status).toBe(409);
    expect(replay.body).toMatchObject({
      code: 'IDEMPOTENCY_SECRET_WITHHELD',
      details: { resourceId: created.body.id },
    });
    expect(JSON.stringify(replay.body)).not.toContain(created.body.token as string);
    // the stored token cannot be redeemed from the store: only the original response had it
    expect((await fetchFeed(created.body.path as string)).status).toBe(200);
  });
});
