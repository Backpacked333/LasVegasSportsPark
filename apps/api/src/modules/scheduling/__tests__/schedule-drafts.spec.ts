import { newId, type Principal } from '@sportspark/contracts';
import { seedOrganization } from '@sportspark/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, staffPrincipal, type TestApp } from '../../../testing';
import { FIXTURE_OBLIGATION_IMPL, type FixtureObligationPort } from '../ports';
import { EventsService } from '../services/events.service';
import { SchedulingModule } from '../scheduling.module';
import {
  at,
  createScheduledEvent,
  seedPitchWithHalves,
  teamCommitment,
  type PitchFixture,
} from '../testing/scheduling-fixtures';

const draftNames = new Map<string, string>();

/** Competition stand-in: blocks drafts named "needs-fixtures", records a remaining obligation for "partial". */
const obligations: FixtureObligationPort = {
  verify: async (check) => {
    const name = draftNames.get(check.draftId);
    if (name === 'needs-fixtures') {
      return [
        {
          code: 'missing_fixtures',
          message: '2 fixtures unscheduled',
          owner: 'league_manager',
          deadline: null,
          blocking: true,
        },
      ];
    }
    if (name === 'partial') {
      return [
        {
          code: 'playoffs_pending',
          message: 'Playoff bracket not yet scheduled',
          owner: 'league_manager',
          deadline: '2026-12-01T00:00:00.000Z',
          blocking: false,
        },
      ];
    }
    return [];
  },
};

describe('schedule drafts and publication (SPK-SCHED-005/006, SPK-FIX-005, SPK-AT-008)', () => {
  let t: TestApp;
  let events: EventsService;
  let org: string;
  let facility: string;
  let pitch: PitchFixture;
  let scheduler: Principal;
  let auth: { Authorization: string };

  beforeAll(async () => {
    t = await createTestApp({
      imports: [SchedulingModule],
      clockStart: '2026-10-19T12:00:00Z',
      providers: [{ provide: FIXTURE_OBLIGATION_IMPL, useValue: obligations }],
    });
    events = t.app.get(EventsService);
    org = t.organizationId;
    facility = t.facilityId;
    pitch = await seedPitchWithHalves(t.db, {
      organizationId: org,
      facilityId: facility,
      name: 'Pitch 1',
    });
    scheduler = staffPrincipal(org, ['scheduler']);
    auth = await t.authHeader(scheduler);
  });
  afterAll(async () => {
    await t.close();
  });

  const key = () => `key-${newId()}`;
  const createChange = (
    start: string,
    end: string,
    resourceIds: string[],
    title = 'New game',
    extra: Record<string, unknown> = {},
  ) => ({
    kind: 'create',
    proposed: { kind: 'game', title, scheduledStart: start, scheduledEnd: end, ...extra },
    resourceIds,
  });
  async function openDraft(name: string, changes: unknown[]) {
    const res = await t.http
      .post('/v1/schedule-drafts')
      .set(auth)
      .set('Idempotency-Key', key())
      .send({ facilityId: facility, name, changes });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    draftNames.set(res.body.id, name);
    return res.body as {
      id: string;
      revision: number;
      status: string;
      changes: unknown[];
      baseRevision: { eventRevisions: Record<string, number> };
    };
  }
  const publish = (id: string, k = key(), body: Record<string, unknown> = {}) =>
    t.http.post(`/v1/schedule-drafts/${id}/publish`).set(auth).set('Idempotency-Key', k).send(body);
  const countEvents = async () => (await t.db.selectFrom('events').select('id').execute()).length;

  it('SPK-SCHED-005: opens a draft with author, base revisions and autosave guarded by the draft revision', async () => {
    const existing = await createScheduledEvent(events, {
      organizationId: org,
      facilityId: facility,
      resourceIds: [pitch.northHalfId],
      start: at('2026-11-02', '18:00'),
      end: at('2026-11-02', '19:00'),
      title: 'Existing',
    });
    const draft = await openDraft('autosave', [
      createChange(at('2026-11-02', '19:30'), at('2026-11-02', '20:30'), [pitch.northHalfId]),
      {
        kind: 'move',
        targetEventId: existing.id,
        proposed: {
          scheduledStart: at('2026-11-02', '17:00'),
          scheduledEnd: at('2026-11-02', '18:00'),
        },
      },
    ]);
    expect(draft).toMatchObject({
      status: 'editing',
      revision: 1,
      author: { kind: 'staff', accountId: scheduler.accountId },
      baseRevision: { eventRevisions: { [existing.id]: 1 } },
      validationResults: null,
    });
    expect(draft.changes).toEqual([
      expect.objectContaining({
        sequence: 1,
        kind: 'create',
        targetEventId: null,
        baseEventRevision: null,
      }),
      expect.objectContaining({
        sequence: 2,
        kind: 'move',
        targetEventId: existing.id,
        baseEventRevision: 1,
      }),
    ]);

    t.clock.advance(60_000);
    const saved = await t.http
      .patch(`/v1/schedule-drafts/${draft.id}`)
      .set(auth)
      .set('Idempotency-Key', key())
      .send({
        expectedRevision: 1,
        name: 'autosave v2',
        changes: [
          createChange(at('2026-11-02', '19:30'), at('2026-11-02', '20:30'), [pitch.southHalfId]),
        ],
      });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      revision: 2,
      name: 'autosave v2',
      lastSavedAt: t.clock.now().toISOString(),
    });
    expect(saved.body.changes).toHaveLength(1);

    const stale = await t.http
      .patch(`/v1/schedule-drafts/${draft.id}`)
      .set(auth)
      .set('Idempotency-Key', key())
      .send({ expectedRevision: 1, changes: [] });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVISION');
    const missing = await t.http
      .patch(`/v1/schedule-drafts/${draft.id}`)
      .set(auth)
      .set('Idempotency-Key', key())
      .send({ changes: [] });
    expect(missing.status).toBe(400);
    const badTarget = await t.http
      .patch(`/v1/schedule-drafts/${draft.id}`)
      .set(auth)
      .set('Idempotency-Key', key())
      .send({ expectedRevision: 2, changes: [{ kind: 'cancel', targetEventId: newId() }] });
    expect(badTarget.status).toBe(400);
    expect(badTarget.body.code).toBe('VALIDATION_FAILED');
  });

  it('SPK-SCHED-004: validation reports physical, party and intra-draft conflicts against current records without publishing', async () => {
    const team = newId();
    const existing = await createScheduledEvent(events, {
      organizationId: org,
      facilityId: facility,
      resourceIds: [pitch.pitchId],
      start: at('2026-11-03', '18:00'),
      end: at('2026-11-03', '19:00'),
      title: 'Blocker',
      commitments: [teamCommitment(team)],
    });
    const before = await countEvents();
    const draft = await openDraft('validate', [
      createChange(
        at('2026-11-03', '19:00'),
        at('2026-11-03', '20:00'),
        [pitch.northHalfId],
        'in the cleanup',
      ),
      // only 30 minutes after the team's 19:00 game: the 60-minute rest is not met
      createChange(
        at('2026-11-03', '19:30'),
        at('2026-11-03', '20:30'),
        [pitch.southHalfId],
        'team busy',
        { commitments: [teamCommitment(team)] },
      ),
      createChange(
        at('2026-11-03', '20:00'),
        at('2026-11-03', '21:00'),
        [pitch.pitchId],
        'overlaps change 2',
      ),
    ]);
    const res = await t.http
      .post(`/v1/schedule-drafts/${draft.id}/validate`)
      .set(auth)
      .set('Idempotency-Key', key())
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('editing');
    const issues = res.body.validationResults.issues as Array<{
      code: string;
      changeSequence: number;
      detail?: { conflictingEventIds: string[]; changeSequences?: number[] };
    }>;
    expect(res.body.validationResults.ok).toBe(false);
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'physical_overlap',
          changeSequence: 1,
          detail: expect.objectContaining({ conflictingEventIds: [existing.id] }),
        }),
        expect.objectContaining({
          code: 'insufficient_rest',
          changeSequence: 2,
          detail: expect.objectContaining({ conflictingEventIds: [existing.id] }),
        }),
        expect.objectContaining({
          code: 'intra_draft_overlap',
          detail: expect.objectContaining({ changeSequences: [2, 3] }),
        }),
      ]),
    );
    expect(await countEvents()).toBe(before);
    // a clean draft becomes validated, and editing it returns to editing
    const clean = await openDraft('clean', [
      createChange(at('2026-11-04', '18:00'), at('2026-11-04', '19:00'), [pitch.pitchId]),
    ]);
    const ok = await t.http
      .post(`/v1/schedule-drafts/${clean.id}/validate`)
      .set(auth)
      .set('Idempotency-Key', key())
      .send({});
    expect(ok.body).toMatchObject({
      status: 'validated',
      validationResults: { ok: true, issues: [] },
    });
    const edited = await t.http
      .patch(`/v1/schedule-drafts/${clean.id}`)
      .set(auth)
      .set('Idempotency-Key', key())
      .send({ expectedRevision: ok.body.revision, changes: [] });
    expect(edited.body).toMatchObject({ status: 'editing', validationResults: null });
  });

  it('SPK-SCHED-004: required rest holds between two changes of the same draft, in validation and at publication', async () => {
    const team = newId();
    const draft = await openDraft('rest within the group', [
      createChange(
        at('2026-11-05', '10:00'),
        at('2026-11-05', '11:00'),
        [pitch.northHalfId],
        'first game',
        { commitments: [teamCommitment(team)] },
      ),
      // 30 minutes later on the other half: the 60-minute rest is not met
      createChange(
        at('2026-11-05', '11:30'),
        at('2026-11-05', '12:30'),
        [pitch.southHalfId],
        'second game',
        { commitments: [teamCommitment(team, 'away_team')] },
      ),
    ]);
    const res = await t.http
      .post(`/v1/schedule-drafts/${draft.id}/validate`)
      .set(auth)
      .set('Idempotency-Key', key())
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.validationResults.ok).toBe(false);
    expect(res.body.validationResults.issues).toEqual([
      expect.objectContaining({
        code: 'insufficient_rest',
        changeSequence: 1,
        detail: expect.objectContaining({ changeSequences: [1, 2] }),
      }),
    ]);
    const before = await countEvents();
    const published = await publish(draft.id, key(), { expectedRevision: res.body.revision });
    expect(published.status).toBe(409);
    expect(published.body.code).toBe('RESOURCE_CONFLICT');
    expect(await countEvents()).toBe(before);
  });

  it('SPK-SCHED-006: publication commits creates, moves and cancels in one group with notices, published revisions and an operation', async () => {
    const toMove = await createScheduledEvent(events, {
      organizationId: org,
      facilityId: facility,
      resourceIds: [pitch.northHalfId],
      start: at('2026-11-05', '18:00'),
      end: at('2026-11-05', '19:00'),
      title: 'Move me',
    });
    const toCancel = await createScheduledEvent(events, {
      organizationId: org,
      facilityId: facility,
      resourceIds: [pitch.southHalfId],
      start: at('2026-11-05', '18:00'),
      end: at('2026-11-05', '19:00'),
      title: 'Cancel me',
    });
    const draft = await openDraft('partial', [
      // the new game takes the whole pitch where "Cancel me" and the old "Move me" are: only valid because the group releases them first
      createChange(
        at('2026-11-05', '18:00'),
        at('2026-11-05', '19:00'),
        [pitch.pitchId],
        'New game',
        { commitments: [teamCommitment(newId())] },
      ),
      {
        kind: 'move',
        targetEventId: toMove.id,
        proposed: {
          scheduledStart: at('2026-11-05', '19:30'),
          scheduledEnd: at('2026-11-05', '20:30'),
        },
      },
      {
        kind: 'cancel',
        targetEventId: toCancel.id,
        proposed: { reason: 'merged into the new game' },
      },
    ]);
    const k = key();
    const res = await publish(draft.id, k);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      draftId: draft.id,
      facilityId: facility,
      summary: {
        changes: [
          { sequence: 1, kind: 'create' },
          { sequence: 2, kind: 'move', eventId: toMove.id },
          { sequence: 3, kind: 'cancel', eventId: toCancel.id },
        ],
        remainingObligations: [{ code: 'playoffs_pending', owner: 'league_manager' }],
      },
    });
    expect(res.body.eventIds).toHaveLength(3);
    expect(res.body.noticeEventIds).toHaveLength(3);

    // idempotent replay returns the same publication without publishing again
    const replay = await publish(draft.id, k);
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toEqual(res.body);
    const publications = await t.db
      .selectFrom('publications')
      .select('id')
      .where('draft_id', '=', draft.id)
      .execute();
    expect(publications).toHaveLength(1);

    const view = await t.http.get(`/v1/schedule-drafts/${draft.id}`).set(auth);
    expect(view.body).toMatchObject({
      status: 'published',
      publicationGroupId: res.body.id,
      validationResults: { ok: true },
    });
    expect(view.body.publishedAt).not.toBeNull();

    const moved = await events.getEvent(scheduler, toMove.id);
    expect(moved).toMatchObject({
      revision: 2,
      publishedRevision: 2,
      scheduledStart: at('2026-11-05', '19:30'),
    });
    const canceled = await events.getEvent(scheduler, toCancel.id);
    expect(canceled).toMatchObject({
      status: 'canceled',
      cancelReason: 'merged into the new game',
    });
    const created = await events.getEvent(scheduler, res.body.summary.changes[0].eventId);
    expect(created).toMatchObject({
      status: 'published',
      publishedRevision: 1,
      resourceIds: [pitch.pitchId],
    });
    const activeUnits = await t.db
      .selectFrom('reservation_units')
      .select(['event_id', 'conflict_unit_id'])
      .where('status', '=', 'active')
      .where('event_id', 'in', [toMove.id, toCancel.id, created.id])
      .execute();
    expect(activeUnits.filter((u) => u.event_id === toCancel.id)).toEqual([]);
    expect(activeUnits.filter((u) => u.event_id === created.id)).toHaveLength(2);
    expect(activeUnits.filter((u) => u.event_id === toMove.id)).toHaveLength(1);

    const outbox = await t.db
      .selectFrom('outbox_events')
      .select(['event_type', 'aggregate_id', 'payload', 'operation_id'])
      .where('operation_id', '=', res.body.operationId)
      .execute();
    expect(outbox.map((o) => o.event_type).sort()).toEqual([
      'scheduling.event_changed',
      'scheduling.event_changed',
      'scheduling.event_changed',
      'scheduling.schedule_published',
    ]);
    const moveNotice = outbox.find((o) => o.aggregate_id === toMove.id)?.payload as Record<
      string,
      unknown
    >;
    expect(moveNotice).toMatchObject({
      change: 'moved',
      publicationId: res.body.id,
      before: { scheduledStart: at('2026-11-05', '18:00') },
      after: { scheduledStart: at('2026-11-05', '19:30') },
    });
    const cancelNotice = outbox.find((o) => o.aggregate_id === toCancel.id)?.payload as Record<
      string,
      unknown
    >;
    expect(cancelNotice).toMatchObject({
      change: 'canceled',
      after: null,
      before: { title: 'Cancel me' },
    });
    const published = outbox.find((o) => o.event_type === 'scheduling.schedule_published')
      ?.payload as Record<string, unknown>;
    expect(published).toMatchObject({
      publicationId: res.body.id,
      remainingObligations: [{ code: 'playoffs_pending' }],
    });

    const operation = await t.http.get(`/v1/operations/${res.body.operationId}`).set(auth);
    expect(operation.body).toMatchObject({
      kind: 'scheduling.publish_schedule',
      status: 'succeeded',
      result: { publicationId: res.body.id },
    });
    const audit = await t.db
      .selectFrom('audit_records')
      .select('action')
      .where('target_id', '=', draft.id)
      .orderBy('occurred_at')
      .execute();
    expect(audit.map((a) => a.action)).toEqual([
      'scheduling.draft_created',
      'scheduling.schedule_published',
    ]);
  });

  it('SPK-AT-008 / SPK-SCHED-006: one conflicting change fails the whole publication group and leaves no partial rows', async () => {
    const blocker = await createScheduledEvent(events, {
      organizationId: org,
      facilityId: facility,
      resourceIds: [pitch.southHalfId],
      start: at('2026-11-06', '18:00'),
      end: at('2026-11-06', '19:00'),
      title: 'Blocker',
    });
    const before = await countEvents();
    const draft = await openDraft('atomic', [
      createChange(
        at('2026-11-06', '10:00'),
        at('2026-11-06', '11:00'),
        [pitch.pitchId],
        'Fine on its own',
      ),
      createChange(
        at('2026-11-06', '18:30'),
        at('2026-11-06', '19:30'),
        [pitch.pitchId],
        'Collides with the blocker',
      ),
    ]);
    const res = await publish(draft.id);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'RESOURCE_CONFLICT',
      details: { conflictingEventIds: [blocker.id] },
    });
    expect(res.body.details.issues).toEqual([
      expect.objectContaining({ code: 'physical_overlap', changeSequence: 2 }),
    ]);
    expect(await countEvents()).toBe(before);
    expect(
      await t.db.selectFrom('publications').select('id').where('draft_id', '=', draft.id).execute(),
    ).toEqual([]);
    expect(
      await t.db
        .selectFrom('outbox_events')
        .select('id')
        .where('aggregate_id', '=', draft.id)
        .execute(),
    ).toEqual([]);
    const failed = await t.http.get(`/v1/schedule-drafts/${draft.id}`).set(auth);
    expect(failed.body).toMatchObject({ status: 'failed', validationResults: { ok: false } });
    expect(failed.body.validationResults.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'RESOURCE_CONFLICT' }),
        expect.objectContaining({ code: 'physical_overlap' }),
      ]),
    );
    const ops = await t.db
      .selectFrom('operations')
      .selectAll()
      .where('kind', '=', 'scheduling.publish_schedule')
      .where(sql`input->>'draftId'`, '=', draft.id)
      .execute();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ status: 'failed', error: { code: 'RESOURCE_CONFLICT' } });

    // the author fixes the draft (failed → editing) and publishes successfully
    const fixed = await t.http
      .patch(`/v1/schedule-drafts/${draft.id}`)
      .set(auth)
      .set('Idempotency-Key', key())
      .send({
        expectedRevision: failed.body.revision,
        changes: [
          createChange(
            at('2026-11-06', '10:00'),
            at('2026-11-06', '11:00'),
            [pitch.pitchId],
            'Fine on its own',
          ),
        ],
      });
    expect(fixed.body.status).toBe('editing');
    const ok = await publish(draft.id);
    expect(ok.status).toBe(200);
    expect(await countEvents()).toBe(before + 1);
  });

  it('SPK-SCHED-006 step 2: a stale base revision fails the publication with STALE_REVISION', async () => {
    const event = await createScheduledEvent(events, {
      organizationId: org,
      facilityId: facility,
      resourceIds: [pitch.northHalfId],
      start: at('2026-11-07', '18:00'),
      end: at('2026-11-07', '19:00'),
    });
    const draft = await openDraft('stale', [
      {
        kind: 'resize',
        targetEventId: event.id,
        proposed: { scheduledEnd: at('2026-11-07', '19:30') },
      },
    ]);
    // someone else changes the event after the draft captured revision 1
    await events.moveEvent(scheduler, event.id, {
      scheduledStart: at('2026-11-07', '18:15'),
      scheduledEnd: at('2026-11-07', '19:15'),
    });
    const res = await publish(draft.id);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'STALE_REVISION',
      details: { expectedRevision: 1, currentRevision: 2 },
    });
    const current = await events.getEvent(scheduler, event.id);
    expect(current).toMatchObject({ revision: 2, scheduledEnd: at('2026-11-07', '19:15') });
    const validate = await t.http
      .post(`/v1/schedule-drafts/${draft.id}/validate`)
      .set(auth)
      .set('Idempotency-Key', key())
      .send({});
    expect(validate.body.validationResults.issues).toEqual([
      expect.objectContaining({ code: 'stale_revision', eventId: event.id }),
    ]);
  });

  it('SPK-SCHED-006 step 4: blocking fixture obligations fail the group', async () => {
    const before = await countEvents();
    const draft = await openDraft('needs-fixtures', [
      createChange(at('2026-11-08', '10:00'), at('2026-11-08', '11:00'), [pitch.pitchId]),
    ]);
    const res = await publish(draft.id);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { obligations: [{ code: 'missing_fixtures', blocking: true }] },
    });
    expect(await countEvents()).toBe(before);
  });

  it('SPK-FIX-005: a draft event from the solver is published by a create change targeting it, keeping its identity', async () => {
    const proposed = await createScheduledEvent(events, {
      organizationId: org,
      facilityId: facility,
      resourceIds: [pitch.pitchId],
      start: at('2026-11-09', '18:00'),
      end: at('2026-11-09', '19:00'),
      status: 'draft',
      title: 'Proposed fixture',
    });
    const draft = await openDraft('solver', [
      { kind: 'create', targetEventId: proposed.id, proposed: { title: 'Round 1: A vs B' } },
    ]);
    expect(draft.baseRevision.eventRevisions[proposed.id]).toBe(1);
    const res = await publish(draft.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.eventIds).toEqual([proposed.id]);
    const published = await events.getEvent(scheduler, proposed.id);
    expect(published).toMatchObject({
      status: 'published',
      title: 'Round 1: A vs B',
      revision: 2,
      publishedRevision: 2,
    });
    const units = await t.db
      .selectFrom('reservation_units')
      .select('id')
      .where('event_id', '=', proposed.id)
      .where('status', '=', 'active')
      .execute();
    expect(units).toHaveLength(2);
    const notice = await t.db
      .selectFrom('outbox_events')
      .select('payload')
      .where('aggregate_id', '=', proposed.id)
      .executeTakeFirstOrThrow();
    expect(notice.payload).toMatchObject({
      change: 'published',
      before: null,
      after: { title: 'Round 1: A vs B' },
    });
  });

  it('lifecycle: discard, and terminal drafts refuse further commands', async () => {
    const draft = await openDraft('discard', []);
    const discarded = await t.http
      .post(`/v1/schedule-drafts/${draft.id}/discard`)
      .set(auth)
      .set('Idempotency-Key', key())
      .send({ reason: 'abandoned' });
    expect(discarded.body.status).toBe('discarded');
    const again = await publish(draft.id);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('INVALID_TRANSITION');
    const save = await t.http
      .patch(`/v1/schedule-drafts/${draft.id}`)
      .set(auth)
      .set('Idempotency-Key', key())
      .send({ expectedRevision: discarded.body.revision, changes: [] });
    expect(save.body.code).toBe('INVALID_TRANSITION');
    const list = await t.http
      .get('/v1/schedule-drafts')
      .query({ facilityId: facility, status: 'discarded' })
      .set(auth);
    expect(list.body.map((d: { id: string }) => d.id)).toContain(draft.id);
  });

  it('authorization: a program manager drafts but cannot publish; other organizations see nothing', async () => {
    const programManager = staffPrincipal(org, ['program_manager']);
    const pm = await t.authHeader(programManager);
    const res = await t.http
      .post('/v1/schedule-drafts')
      .set(pm)
      .set('Idempotency-Key', key())
      .send({
        facilityId: facility,
        name: 'pm',
        changes: [
          createChange(at('2026-11-10', '10:00'), at('2026-11-10', '11:00'), [pitch.pitchId]),
        ],
      });
    expect(res.status).toBe(201);
    const denied = await t.http
      .post(`/v1/schedule-drafts/${res.body.id}/publish`)
      .set(pm)
      .set('Idempotency-Key', key())
      .send({});
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('ACCESS_DENIED');
    const frontDesk = await t.authHeader(staffPrincipal(org, ['front_desk']));
    expect((await t.http.get(`/v1/schedule-drafts/${res.body.id}`).set(frontDesk)).status).toBe(
      403,
    );
    const other = await seedOrganization(t.db);
    const otherOrg = await t.authHeader(
      staffPrincipal(other.organizationId, ['system_administrator']),
    );
    expect((await t.http.get(`/v1/schedule-drafts/${res.body.id}`).set(otherOrg)).status).toBe(404);
    const crossOrgPublish = await t.http
      .post(`/v1/schedule-drafts/${res.body.id}/publish`)
      .set(otherOrg)
      .set('Idempotency-Key', key())
      .send({});
    expect(crossOrgPublish.status).toBe(404);
    // a league manager may publish (fixtures use the normal scheduling command, SPK-FIX-005)
    const lm = await t.authHeader(staffPrincipal(org, ['league_manager']));
    const ok = await t.http
      .post(`/v1/schedule-drafts/${res.body.id}/publish`)
      .set(lm)
      .set('Idempotency-Key', key())
      .send({});
    expect(ok.status).toBe(200);
  });
});
