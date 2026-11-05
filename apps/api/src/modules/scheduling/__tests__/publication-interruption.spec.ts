import { newId, type Principal } from '@sportspark/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { UnitOfWork } from '../../../kernel';
import { createTestApp, staffPrincipal, type TestApp } from '../../../testing';
import { FIXTURE_OBLIGATION_IMPL, type FixtureObligationPort } from '../ports';
import { SchedulingModule } from '../scheduling.module';
import { at, seedPitchWithHalves, type PitchFixture } from '../testing/scheduling-fixtures';

/**
 * R4-REPLAY-IDEMPOTENCY-02 (§4.8, §4.9, §4.12, SPK-SCHED-006): a publication's operation exists only
 * with the publication's outcome. A process that stops mid-publication leaves no operation stuck
 * `running` and no committed work on the request's idempotency key, so the same key publishes on
 * retry; a refusal records one `failed` operation that the key names; an error that surfaces after
 * the publication committed records no failure next to the `succeeded` operation.
 */

/** Steps of the publication the test interrupts, keyed by draft id. */
const interruptions = new Map<string, 'crash' | 'fail' | 'lose-ack'>();
let processStopped = false;
let loseCommitAck = false;

/** Competition stand-in, called inside the publication transaction (step 4). */
const obligations: FixtureObligationPort = {
  verify: async (check) => {
    const step = interruptions.get(check.draftId);
    interruptions.delete(check.draftId);
    if (step === 'crash') {
      // The process stops here: this transaction rolls back and nothing after it runs.
      processStopped = true;
      throw new Error('worker stopped mid-publication');
    }
    if (step === 'fail') throw new Error('obligation check failed unexpectedly');
    if (step === 'lose-ack') loseCommitAck = true;
    return [];
  },
};

describe('publication interrupted between steps (R4-REPLAY-IDEMPOTENCY-02, §4.9, SPK-SCHED-006)', () => {
  let t: TestApp;
  let pitch: PitchFixture;
  let scheduler: Principal;
  let auth: { Authorization: string };
  /** What a dead process left behind, read at the moment it stopped. */
  let leftBehind: {
    key: { committed_at: Date | null; operation_id: string | null } | undefined;
    operations: Array<{ id: string; status: string }>;
  } | null = null;
  let crashedKey = '';
  let crashedDraftId = '';

  beforeAll(async () => {
    t = await createTestApp({
      imports: [SchedulingModule],
      clockStart: '2026-10-19T12:00:00Z',
      providers: [{ provide: FIXTURE_OBLIGATION_IMPL, useValue: obligations }],
    });
    pitch = await seedPitchWithHalves(t.db, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      name: 'Pitch 1',
    });
    scheduler = staffPrincipal(t.organizationId, ['scheduler']);
    auth = await t.authHeader(scheduler);

    const uow = t.app.get(UnitOfWork);
    const run = uow.run.bind(uow);
    vi.spyOn(uow, 'run').mockImplementation((async (
      fn: Parameters<UnitOfWork['run']>[0],
      options?: Parameters<UnitOfWork['run']>[1],
    ) => {
      const outermost = uow.current() === undefined;
      if (processStopped && outermost) {
        // A stopped process commits nothing more: record what it left behind, then refuse.
        leftBehind = {
          key: await t.db
            .selectFrom('idempotency_keys')
            .select(['committed_at', 'operation_id'])
            .where('idempotency_key', '=', crashedKey)
            .executeTakeFirst(),
          operations: await operationsOf(crashedDraftId),
        };
        throw new Error('process stopped');
      }
      const result = await run(fn, options);
      if (loseCommitAck && outermost) {
        loseCommitAck = false;
        throw new Error('connection lost after COMMIT');
      }
      return result;
    }) as UnitOfWork['run']);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await t.close();
  });

  const key = () => `key-${newId()}`;
  async function openDraft(name: string, day: string) {
    const res = await t.http
      .post('/v1/schedule-drafts')
      .set(auth)
      .set('Idempotency-Key', key())
      .send({
        facilityId: t.facilityId,
        name,
        changes: [
          {
            kind: 'create',
            proposed: {
              kind: 'game',
              title: name,
              scheduledStart: at(day, '18:00'),
              scheduledEnd: at(day, '19:00'),
            },
            resourceIds: [pitch.pitchId],
          },
        ],
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; revision: number; status: string };
  }
  const publish = (id: string, k: string) =>
    t.http.post(`/v1/schedule-drafts/${id}/publish`).set(auth).set('Idempotency-Key', k).send({});
  async function operationsOf(draftId: string) {
    return t.db
      .selectFrom('operations')
      .select(['id', 'status'])
      .where('organization_id', '=', t.organizationId)
      .where('kind', '=', 'scheduling.publish_schedule')
      .where(sql<string>`input->>'draftId'`, '=', draftId)
      .execute();
  }
  const publicationsOf = (draftId: string) =>
    t.db.selectFrom('publications').select('id').where('draft_id', '=', draftId).execute();

  it('R4-REPLAY-IDEMPOTENCY-02 / §4.12: a process that stops mid-publication leaves no running operation, and the same key publishes on retry', async () => {
    const draft = await openDraft('crash', '2026-11-09');
    crashedDraftId = draft.id;
    crashedKey = key();
    interruptions.set(draft.id, 'crash');

    const crashed = await publish(draft.id, crashedKey);
    processStopped = false;
    expect(crashed.status).toBe(500);

    // At the moment the process stopped: no operation (running or otherwise) and no committed
    // work on the key, so nothing can point a client at an operation that never ends.
    expect(leftBehind).not.toBeNull();
    expect(leftBehind!.operations).toEqual([]);
    expect(leftBehind!.key?.committed_at ?? null).toBeNull();
    expect(leftBehind!.key?.operation_id ?? null).toBeNull();
    expect(await operationsOf(draft.id)).toEqual([]);
    expect(await publicationsOf(draft.id)).toEqual([]);
    const unchanged = await t.http.get(`/v1/schedule-drafts/${draft.id}`).set(auth);
    expect(unchanged.body).toMatchObject({ status: 'editing', revision: draft.revision });

    // The retry with the same key runs the publication instead of answering an unavailable
    // outcome, and the operation it names has ended.
    const retried = await publish(draft.id, crashedKey);
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    const operation = await t.http.get(`/v1/operations/${retried.body.operationId}`).set(auth);
    expect(operation.body).toMatchObject({
      kind: 'scheduling.publish_schedule',
      status: 'succeeded',
      result: { publicationId: retried.body.id },
    });
    expect(await operationsOf(draft.id)).toEqual([
      { id: retried.body.operationId, status: 'succeeded' },
    ]);
  });

  it('R4-REPLAY-IDEMPOTENCY-02 / §4.9: a failure after the publication started records one failed operation that the key and its replay name', async () => {
    const draft = await openDraft('fail', '2026-11-10');
    interruptions.set(draft.id, 'fail');
    const k = key();

    const failed = await publish(draft.id, k);
    expect(failed.status).toBe(500);
    const operationId = failed.body.details?.operationId as string;
    expect(operationId).toEqual(expect.any(String));
    expect(await operationsOf(draft.id)).toEqual([{ id: operationId, status: 'failed' }]);
    const operation = await t.http.get(`/v1/operations/${operationId}`).set(auth);
    expect(operation.body).toMatchObject({
      kind: 'scheduling.publish_schedule',
      status: 'failed',
      error: { code: 'INTERNAL_ERROR' },
    });
    // The operator's cause stays in the log; the reader sees the generic message.
    expect(JSON.stringify(operation.body)).not.toContain('obligation check failed');
    expect(await publicationsOf(draft.id)).toEqual([]);

    const replay = await publish(draft.id, k);
    expect(replay.status).toBe(500);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.details).toMatchObject({ operationId });
    expect(await operationsOf(draft.id)).toHaveLength(1);
  });

  it('R4-REPLAY-IDEMPOTENCY-02 / §4.9: an error after the publication committed records no failed operation beside the succeeded one', async () => {
    const draft = await openDraft('lose-ack', '2026-11-11');
    interruptions.set(draft.id, 'lose-ack');

    const res = await publish(draft.id, key());
    expect(res.status).toBe(500);
    const operations = await operationsOf(draft.id);
    expect(operations).toEqual([{ id: expect.any(String), status: 'succeeded' }]);
    // The stored error names the operation that records the real outcome.
    expect(res.body.details).toMatchObject({ operationId: operations[0]!.id });
    const operation = await t.http.get(`/v1/operations/${operations[0]!.id}`).set(auth);
    expect(operation.body).toMatchObject({ status: 'succeeded' });
    expect(await publicationsOf(draft.id)).toHaveLength(1);
    const published = await t.http.get(`/v1/schedule-drafts/${draft.id}`).set(auth);
    expect(published.body.status).toBe('published');
  });
});
