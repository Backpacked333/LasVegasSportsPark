import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PeriodicJobRegistry } from '../../../kernel';
import type { TestApp } from '../../../testing';
import type { FakeAssistantProvider } from '../providers/fake-assistant.provider';
import { AssistantEngine } from '../services/assistant-engine.service';
import { AssistantService, FAIL_STALLED_REQUESTS_JOB } from '../services/assistant.service';
import { createAssistantRequestFixture } from '../testing/automation-fixtures';
import {
  CLOCK_START,
  automationTestApp,
  get,
  otherOrganization,
  post,
  staffMember,
  type Actor,
} from './automation';

const START = new Date(CLOCK_START).getTime();
const at = (seconds: number) => new Date(START + seconds * 1000);

/**
 * AUT-03 (§4.12 durable, interruption-tolerant background work with a failure owner; §4.9 every
 * operation reaches a terminal state): `POST /v1/assistant/requests` answers synchronously, so a
 * process that stops mid-request leaves the request `processing` with a running operation. The
 * periodic job `automation.fail_stalled_requests` fails each such request with its operation once
 * it is older than AUTOMATION_REQUEST_STALL_SECONDS (900 by default), one transaction each.
 */
describe('stalled assistant requests (AUT-03, §4.12)', () => {
  let t: TestApp;
  let fake: FakeAssistantProvider;
  let requester: Actor;

  beforeAll(async () => {
    ({ t, fake } = await automationTestApp());
    requester = await staffMember(t, ['support_operator']);
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(() => {
    fake.reset();
    t.clock.set(CLOCK_START);
  });

  const stalledRequest = (receivedAt: Date, organizationId?: string, actor = requester) =>
    createAssistantRequestFixture(t, {
      requesterAccountId: actor.accountId,
      requesterPersonId: actor.personId,
      status: 'processing',
      receivedAt,
      organizationId,
    });
  const requestRow = (id: string) =>
    t.db
      .selectFrom('assistant_requests')
      .select(['status', 'error', 'completed_at', 'revision'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  const operationRow = (id: string) =>
    t.db
      .selectFrom('operations')
      .select(['status', 'error'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  const runJob = async () => {
    const [summary] = await t.runPeriodicJobs([FAIL_STALLED_REQUESTS_JOB]);
    expect(summary).toMatchObject({ ran: true, failed: false });
    return summary?.processed ?? 0;
  };

  it('AUT-03: a request stalled in processing is failed by the job once', async () => {
    const job = t.app.get(PeriodicJobRegistry).get(FAIL_STALLED_REQUESTS_JOB);
    expect(job).toMatchObject({ intervalSeconds: 300, failureOwner: 'system_administrator' });

    const other = await otherOrganization(t);
    const otherRequester = await staffMember(t, ['support_operator'], {
      organizationId: other.organizationId,
    });
    const stalled = await stalledRequest(at(0));
    const stalledElsewhere = await stalledRequest(at(0), other.organizationId, otherRequester);
    const recent = await stalledRequest(at(600));

    t.clock.set(at(899));
    expect(await runJob()).toBe(0);
    expect((await requestRow(stalled.assistantRequestId)).status).toBe('processing');

    t.clock.set(at(900));
    expect(await runJob()).toBe(2);
    expect(await requestRow(stalled.assistantRequestId)).toMatchObject({
      status: 'failed',
      error: { code: 'REQUEST_STALLED', details: { stalledAfterSeconds: 900 } },
      revision: 2,
    });
    expect(new Date((await requestRow(stalled.assistantRequestId)).completed_at!)).toEqual(at(900));
    expect(await operationRow(stalled.operationId)).toMatchObject({
      status: 'failed',
      error: { code: 'REQUEST_STALLED' },
    });
    expect((await requestRow(stalledElsewhere.assistantRequestId)).status).toBe('failed');
    expect((await operationRow(stalledElsewhere.operationId)).status).toBe('failed');
    // Younger than the stall window: untouched.
    expect((await requestRow(recent.assistantRequestId)).status).toBe('processing');
    expect((await operationRow(recent.operationId)).status).toBe('running');

    // The requester reads the outcome; the system job is the audited actor; the event is raised.
    const read = await get(t, `/v1/assistant/requests/${stalled.assistantRequestId}`, requester);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      status: 'failed',
      error: { code: 'REQUEST_STALLED' },
      recommendations: [],
      completedAt: at(900).toISOString(),
    });
    const audit = await t.db
      .selectFrom('audit_records')
      .select(['actor', 'details'])
      .where('action', '=', 'automation.assistant_request_stalled')
      .where('target_id', '=', stalled.assistantRequestId)
      .execute();
    expect(audit).toEqual([
      expect.objectContaining({
        actor: expect.objectContaining({ kind: 'system', actorLabel: FAIL_STALLED_REQUESTS_JOB }),
        details: expect.objectContaining({ status: 'failed', errorCode: 'REQUEST_STALLED' }),
      }),
    ]);
    const events = await t.db
      .selectFrom('outbox_events')
      .select('payload')
      .where('event_type', '=', 'automation.assistant_request_completed')
      .where('aggregate_id', '=', stalled.assistantRequestId)
      .execute();
    expect(events.map((e) => e.payload)).toEqual([
      expect.objectContaining({ status: 'failed', recommendationIds: [] }),
    ]);

    // Once: a later run finds nothing more to do for these requests.
    t.clock.set(at(1200));
    expect(await runJob()).toBe(0);
    t.clock.set(at(1500));
    expect(await runJob()).toBe(1);
    expect((await requestRow(recent.assistantRequestId)).status).toBe('failed');
    const audits = await t.db
      .selectFrom('audit_records')
      .select('id')
      .where('action', '=', 'automation.assistant_request_stalled')
      .where('target_id', '=', stalled.assistantRequestId)
      .execute();
    expect(audits).toHaveLength(1);
  });

  it('AUT-03: two sweeps racing over one stalled request fail it once (PGlite and PostgreSQL)', async () => {
    const stalled = await stalledRequest(at(0));
    t.clock.set(at(3600));
    const service = t.app.get(AssistantService);
    const context = { now: t.clock.now(), batchSize: 50 };
    const results = await Promise.all([service.failStalled(context), service.failStalled(context)]);
    expect(results.reduce((n, r) => n + r.processed, 0)).toBe(1);
    expect((await requestRow(stalled.assistantRequestId)).revision).toBe(2);
    const audits = await t.db
      .selectFrom('audit_records')
      .select('id')
      .where('action', '=', 'automation.assistant_request_stalled')
      .where('target_id', '=', stalled.assistantRequestId)
      .execute();
    expect(audits).toHaveLength(1);
  });

  it('AUT-03: a request failed as stalled keeps that outcome when its process finishes later; nothing is proposed after the fact', async () => {
    fake.script('slow notice', [
      {
        type: 'tool_calls',
        calls: [
          {
            tool: 'communications.send',
            arguments: {
              kind: 'staff_broadcast',
              category: 'operational',
              audience: { staffRoles: ['front_desk'] },
              title: 'Slow notice',
              body: 'Arrives too late.',
            },
          },
        ],
      },
      { type: 'answer', text: 'Drafted late.' },
    ]);
    const manager = await staffMember(t, ['league_manager']);
    const engine = t.app.get(AssistantEngine);
    const original = engine.run.bind(engine);
    const spy = vi.spyOn(engine, 'run').mockImplementationOnce(async (principal, input) => {
      const result = await original(principal, input);
      // The process outlives the stall window: the sweep ends the request first.
      t.clock.advance(901_000);
      const swept = await t.app
        .get(AssistantService)
        .failStalled({ now: t.clock.now(), batchSize: 50 });
      expect(swept.processed).toBe(1);
      return result;
    });
    try {
      const res = await post(t, '/v1/assistant/requests', manager, { prompt: 'slow notice' });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body).toMatchObject({
        status: 'failed',
        error: { code: 'REQUEST_STALLED' },
        response: null,
        recommendations: [],
      });
      const recommendations = await t.db
        .selectFrom('recommendations')
        .select('id')
        .where('assistant_request_id', '=', res.body.id)
        .execute();
      expect(recommendations).toEqual([]);
      expect((await operationRow(res.body.operationId)).status).toBe('failed');
    } finally {
      spy.mockRestore();
    }
  });
});
