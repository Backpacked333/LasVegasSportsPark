import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OperationalExceptions } from '../../../kernel';
import type { TestApp } from '../../../testing';
import {
  createFixtureFixture,
  createSeasonFixture,
  createTeamEntryFixture,
} from '../../competition';
import { createCapturedPaymentFixture, createObligationFixture } from '../../finance';
import { seedPitchWithHalves, at, type PitchFixture } from '../../scheduling';
import type { FakeAssistantProvider } from '../providers/fake-assistant.provider';
import {
  CLOCK_START,
  adultCustomer,
  ask,
  automationTestApp,
  createChange,
  get,
  key,
  openDraft,
  otherOrganization,
  patch,
  post,
  staffMember,
  type Actor,
} from './automation';

/**
 * Assistant requests (SPK-AUTO-001, SPK-AUTO-002, SPK-AUTO-004): the assistant answers with the
 * caller's own principal through the owning modules, names every supporting record with its
 * freshness and keeps missing evidence visible.
 */
describe('assistant requests (SPK-AUTO-001, SPK-AUTO-002, SPK-AUTO-004)', () => {
  let t: TestApp;
  let fake: FakeAssistantProvider;
  let leagueManager: Actor;
  let scheduler: Actor;
  let pitch: PitchFixture;

  beforeAll(async () => {
    ({ t, fake } = await automationTestApp());
    leagueManager = await staffMember(t, ['league_manager']);
    scheduler = await staffMember(t, ['scheduler']);
    pitch = await seedPitchWithHalves(t.db, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      name: 'Pitch A',
    });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(() => {
    fake.reset();
    t.clock.set(CLOCK_START);
  });

  async function fixture(): Promise<string> {
    const season = await createSeasonFixture(t, { status: 'active' });
    const homeCaptain = await adultCustomer(t);
    const awayCaptain = await adultCustomer(t);
    const home = await createTeamEntryFixture(t, {
      seasonId: season.seasonId,
      captainPersonId: homeCaptain.personId,
    });
    const away = await createTeamEntryFixture(t, {
      seasonId: season.seasonId,
      captainPersonId: awayCaptain.personId,
    });
    return createFixtureFixture(t, {
      seasonId: season.seasonId,
      homeEntryId: home.teamEntryId,
      awayEntryId: away.teamEntryId,
    });
  }

  it('SPK-AUTO-001 / SPK-AUTO-002: explains readiness blockers from the fixture read with the caller’s principal, with freshness, and keeps unknown checks visible as missing evidence', async () => {
    const fixtureId = await fixture();
    // Evidence that is genuinely unknown: an open team obligation, whose effect on play awaits the
    // participation policy (POL-017), keeps the finance check `unknown`.
    const { home_entry_id: homeEntryId } = await t.db
      .selectFrom('fixtures')
      .select('home_entry_id')
      .where('id', '=', fixtureId)
      .executeTakeFirstOrThrow();
    await createObligationFixture(t, { debtorTeamEntryId: homeEntryId, amountMinor: 10_000 });
    fake.script('readiness', [
      {
        type: 'tool_calls',
        calls: [{ tool: 'competition.fixture_readiness', arguments: { fixtureId } }],
      },
      (input) => {
        const readiness = input.toolResults[0]?.output as { status: string } | null;
        return {
          type: 'answer',
          text: `The fixture is ${readiness?.status ?? 'not available'}.`,
          recommendations: [
            {
              kind: 'readiness_explanation',
              title: 'Why the fixture is not ready',
              summary: 'It has no published time and field yet.',
            },
          ],
        };
      },
    ]);
    const res = await ask(t, leagueManager, {
      prompt: 'Explain the readiness blockers of this fixture',
    });
    const body = res.body;
    expect(body.status).toBe('answered');
    const readiness = fake.inputsFor(body.id)[1]?.toolResults[0]?.output as {
      fixtureId: string;
      status: string;
      evaluatedAt: string;
      checks: Array<{ name: string; status: string }>;
    };
    expect(readiness.fixtureId).toBe(fixtureId);
    expect(body.response.text).toBe(`The fixture is ${readiness.status}.`);
    // SPK-AUTO-002: the supporting record, when and as of when it was read.
    expect(body.evidence).toContainEqual({
      recordType: 'fixture',
      recordId: fixtureId,
      source: 'competition.fixture_readiness',
      label: `Fixture readiness: ${readiness.status}`,
      observedAt: CLOCK_START,
      asOf: readiness.evaluatedAt,
      ageSeconds: 0,
      freshness: 'live',
      changedSinceClientObservation: null,
    });
    // Missing evidence stays visible: every unknown check is listed, never reported ready.
    const unknownChecks = readiness.checks.filter((c) => c.status === 'unknown');
    expect(unknownChecks.length).toBeGreaterThan(0);
    for (const check of unknownChecks) {
      expect(body.missingEvidence).toContainEqual(
        expect.objectContaining({
          recordType: 'readiness_check',
          recordId: `${fixtureId}:${check.name}`,
          reason: 'unknown_evidence',
        }),
      );
    }
    // The informational recommendation carries the same evidence and no command.
    expect(body.recommendations).toHaveLength(1);
    expect(body.recommendations[0]).toMatchObject({
      kind: 'readiness_explanation',
      consequential: false,
      command: null,
      status: 'proposed',
      apply: { state: 'not_applicable' },
      requester: { accountId: leagueManager.accountId },
    });
    expect(body.recommendations[0].evidence).toEqual(body.evidence);
    // The module call ran under the league manager's own principal and is logged.
    expect(body.toolInvocations).toEqual([
      expect.objectContaining({
        sequence: 1,
        phase: 'assist',
        tool: 'competition.fixture_readiness',
        actionId: 'competition.read_readiness',
        toolKind: 'query',
        outcome: 'succeeded',
        principal: expect.objectContaining({
          kind: 'staff',
          accountId: leagueManager.accountId,
        }),
      }),
    ]);
    // The operation is readable and succeeded; the audit records the request.
    const op = await get(t, `/v1/operations/${body.operationId}`, leagueManager);
    expect(op.body).toMatchObject({ kind: 'automation.assistant_request', status: 'succeeded' });
    const audit = await t.db
      .selectFrom('audit_records')
      .select(['action', 'details'])
      .where('target_id', '=', body.id)
      .orderBy('occurred_at')
      .execute();
    expect(audit.map((a) => a.action)).toEqual([
      'automation.ask',
      'automation.assistant_request_completed',
    ]);
    expect(audit[0]?.details).toMatchObject({
      attachmentsTreatedAs: 'data',
      provider: 'fake-assistant',
    });
  });

  it('SPK-AUTO-002: a context reference is re-read with the requester’s principal and reports whether it changed after the client observed it', async () => {
    const draft = await openDraft(t, scheduler, 'Saturday fix', [
      createChange(at('2027-01-23', '09:00'), at('2027-01-23', '10:00'), [pitch.northHalfId]),
    ]);
    fake.script('draft', [{ type: 'answer', text: 'Here is the draft.' }]);
    t.clock.advance(10 * 60_000);
    const observedBefore = new Date(Date.parse(CLOCK_START) + 5 * 60_000).toISOString();
    const unchanged = await ask(t, scheduler, {
      prompt: 'What is in this draft?',
      context: [{ type: 'schedule_draft', id: draft.id, observedAt: observedBefore }],
    });
    expect(unchanged.body.contextReferences).toEqual([
      { type: 'schedule_draft', id: draft.id, observedAt: observedBefore, resolved: true },
    ]);
    const evidence = unchanged.body.evidence.find(
      (e: { recordType: string }) => e.recordType === 'schedule_draft',
    );
    expect(evidence).toMatchObject({
      recordId: draft.id,
      source: 'scheduling.schedule_draft',
      asOf: CLOCK_START,
      observedAt: new Date(Date.parse(CLOCK_START) + 10 * 60_000).toISOString(),
      ageSeconds: 600,
      freshness: 'live',
      changedSinceClientObservation: false,
    });
    // An unvalidated draft is visible as missing evidence, not assumed conflict-free.
    expect(unchanged.body.missingEvidence).toContainEqual(
      expect.objectContaining({
        recordType: 'schedule_draft_validation',
        recordId: draft.id,
        reason: 'not_evaluated',
      }),
    );
    // The draft changes after the client looked at it: the answer says so.
    const autosave = await patch(t, `/v1/schedule-drafts/${draft.id}`, scheduler, {
      expectedRevision: draft.revision,
      changes: [
        createChange(at('2027-01-23', '11:00'), at('2027-01-23', '12:00'), [pitch.northHalfId]),
      ],
    });
    expect(autosave.status, JSON.stringify(autosave.body)).toBe(200);
    const changed = await ask(t, scheduler, {
      prompt: 'What is in this draft now?',
      context: [{ type: 'schedule_draft', id: draft.id, observedAt: observedBefore }],
    });
    expect(
      changed.body.evidence.find((e: { recordType: string }) => e.recordType === 'schedule_draft'),
    ).toMatchObject({ changedSinceClientObservation: true, ageSeconds: 0 });
    // The provider saw the re-read draft, not the client's copy.
    expect(fake.inputsFor(changed.body.id)[0]?.toolResults[0]).toMatchObject({
      tool: 'scheduling.schedule_draft',
      outcome: 'succeeded',
      output: { id: draft.id, revision: draft.revision + 1 },
    });
  });

  it('SPK-AUTO-002 / §4.10: a context reference the requester may not read is unresolved, logged as denied and reported not available', async () => {
    const stranger = await adultCustomer(t);
    const payment = await createCapturedPaymentFixture(t, {
      payerPersonId: stranger.personId,
      amountMinor: 4200,
    });
    fake.script('this payment', [{ type: 'answer', text: 'I cannot see that payment.' }]);
    const res = await ask(t, scheduler, {
      prompt: 'Explain this payment',
      context: [{ type: 'payment_attempt', id: payment.paymentAttemptId }],
    });
    expect(res.body.contextReferences).toEqual([
      { type: 'payment_attempt', id: payment.paymentAttemptId, observedAt: null, resolved: false },
    ]);
    expect(res.body.toolInvocations[0]).toMatchObject({
      tool: 'finance.payment',
      outcome: 'denied',
      errorCode: 'NOT_FOUND',
    });
    expect(res.body.missingEvidence).toContainEqual(
      expect.objectContaining({
        recordType: 'payment_attempt',
        recordId: payment.paymentAttemptId,
        reason: 'not_available',
      }),
    );
    expect(res.body.evidence).toEqual([]);
    expect(fake.inputsFor(res.body.id)[0]?.toolResults[0]).toMatchObject({
      outcome: 'denied',
      output: null,
      message: 'This information is not available to you.',
    });
  });

  it('SPK-AUTO-001: summarizes today’s unresolved issues in the caller’s queues, each issue a supporting record', async () => {
    const frontDesk = await staffMember(t, ['front_desk']);
    const exceptionId = await t.db.transaction().execute(async (trx) =>
      t.app.get(OperationalExceptions).raise(trx, {
        organizationId: t.organizationId,
        facilityId: t.facilityId,
        category: 'entry.arrival_unresolved',
        severity: 'warning',
        title: 'Unmatched arrival at the front desk',
        affectedType: 'visit',
        affectedId: 'visit-1',
        ownerQueue: 'front_desk',
      }),
    );
    fake.script('today', [
      { type: 'tool_calls', calls: [{ tool: 'support.today_feed', arguments: {} }] },
      (input) => {
        const feed = input.toolResults[0]?.output as { items: Array<{ title: string }> };
        return { type: 'answer', text: feed.items.map((i) => i.title).join('; ') };
      },
    ]);
    const res = await ask(t, frontDesk, { prompt: 'Summarize today’s unresolved issues' });
    expect(res.body.response.text).toContain('Unmatched arrival at the front desk');
    expect(res.body.evidence).toContainEqual(
      expect.objectContaining({
        recordType: 'visit',
        recordId: 'visit-1',
        source: 'support.today_feed',
        label: 'Unmatched arrival at the front desk',
        freshness: 'live',
      }),
    );
    expect(exceptionId.deduplicated).toBe(false);
  });

  it('SPK-AUTO-001 / SPK-AUTO-002: a demand summary names the report with its as-of instant and freshness class', async () => {
    const manager = await staffMember(t, ['general_manager']);
    fake.script('demand', [
      {
        type: 'tool_calls',
        calls: [
          {
            tool: 'reporting.demand_report',
            arguments: { facilityId: t.facilityId, from: '2027-01-01', to: '2027-01-31' },
          },
        ],
      },
      {
        type: 'answer',
        text: 'Demand is steady.',
        recommendations: [{ kind: 'demand_summary', title: 'January demand', summary: 'Steady' }],
      },
    ]);
    const res = await ask(t, manager, { prompt: 'Summarize demand for January' });
    const report = fake.inputsFor(res.body.id)[1]?.toolResults[0]?.output as {
      asOf: string;
      freshness: { class: string };
    };
    expect(res.body.evidence).toEqual([
      expect.objectContaining({
        recordType: 'report',
        recordId: `demand:${t.facilityId}:2027-01-01:2027-01-31`,
        source: 'reporting.demand_report',
        asOf: report.asOf,
        freshness: report.freshness.class === 'F1' ? 'live' : 'recent',
      }),
    ]);
    expect(res.body.recommendations[0]).toMatchObject({ kind: 'demand_summary', command: null });
  });

  it('SPK-AUTO-001: finds relevant approved policies; when none matches the absence is stated', async () => {
    fake.script('policy', [
      {
        type: 'tool_calls',
        calls: [{ tool: 'catalog.policy_versions', arguments: { key: 'no-such-policy' } }],
      },
      { type: 'answer', text: 'No approved policy matches.' },
    ]);
    const res = await ask(t, leagueManager, { prompt: 'Find the refund policy' });
    expect(res.body.toolInvocations[0]).toMatchObject({ outcome: 'succeeded' });
    expect(res.body.missingEvidence).toContainEqual(
      expect.objectContaining({
        recordType: 'policy_version',
        recordId: 'no-such-policy',
        reason: 'not_available',
      }),
    );
  });

  it('a customer may ask for themselves; their request is theirs alone (NOT_FOUND for everyone else, other organizations included)', async () => {
    const customer = await adultCustomer(t);
    fake.script('my schedule', [{ type: 'answer', text: 'You have nothing booked.' }]);
    const res = await ask(t, customer, { prompt: 'What is my schedule?' });
    expect(res.body).toMatchObject({ status: 'answered', requester: { kind: 'customer' } });
    expect((await get(t, `/v1/assistant/requests/${res.body.id}`, customer)).status).toBe(200);
    const otherCustomer = await adultCustomer(t);
    const manager = await staffMember(t, ['general_manager', 'system_administrator']);
    for (const viewer of [otherCustomer, manager, leagueManager]) {
      const denied = await get(t, `/v1/assistant/requests/${res.body.id}`, viewer);
      expect(denied.status).toBe(404);
      expect(denied.body.code).toBe('NOT_FOUND');
    }
    const other = await otherOrganization(t);
    const foreign = await staffMember(t, ['general_manager'], {
      organizationId: other.organizationId,
    });
    expect((await get(t, `/v1/assistant/requests/${res.body.id}`, foreign)).status).toBe(404);
    const anonymous = await t.http.get(`/v1/assistant/requests/${res.body.id}`);
    expect(anonymous.status).toBe(401);
  });

  it('§4.9: the same key and body replay the recorded request without asking the provider again; the same key with another body conflicts', async () => {
    fake.script('replay', [{ type: 'answer', text: 'Once.' }]);
    const k = key();
    const first = await ask(t, leagueManager, { prompt: 'replay me' }, k);
    const turns = fake.received.length;
    const replay = await post(
      t,
      '/v1/assistant/requests',
      leagueManager,
      { prompt: 'replay me' },
      k,
    );
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.id).toBe(first.body.id);
    expect(fake.received.length).toBe(turns);
    const conflict = await post(t, '/v1/assistant/requests', leagueManager, { prompt: 'other' }, k);
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
    const rows = await t.db
      .selectFrom('assistant_requests')
      .select('id')
      .where('prompt', '=', 'replay me')
      .execute();
    expect(rows).toHaveLength(1);
  });

  it('a provider failure or timeout fails the request with its reason, fails the operation and proposes nothing', async () => {
    const fixtureId = await fixture();
    fake.script('fails', [
      {
        type: 'tool_calls',
        calls: [{ tool: 'competition.fixture_readiness', arguments: { fixtureId } }],
      },
      { type: 'fail', mode: 'failed' },
    ]);
    fake.script('times out', [{ type: 'fail', mode: 'timeout' }]);
    const failed = await ask(t, leagueManager, { prompt: 'this one fails' });
    expect(failed.body).toMatchObject({
      status: 'failed',
      response: null,
      error: { code: 'PROVIDER_FAILED' },
      recommendations: [],
    });
    // What was read before the failure is still evidence; the module call is still logged.
    expect(failed.body.toolInvocations).toHaveLength(1);
    expect(failed.body.evidence.length).toBeGreaterThan(0);
    const timedOut = await ask(t, leagueManager, { prompt: 'this one times out' });
    expect(timedOut.body).toMatchObject({ status: 'failed', error: { code: 'PROVIDER_TIMEOUT' } });
    const op = await get(t, `/v1/operations/${timedOut.body.operationId}`, leagueManager);
    expect(op.body).toMatchObject({ status: 'failed', error: { code: 'PROVIDER_TIMEOUT' } });
  });

  it('provider output in an unexpected form, or no answer within the turn limit, fails the request', async () => {
    fake.script('garbled', [{ type: 'answer', text: '' }]);
    const garbled = await ask(t, leagueManager, { prompt: 'garbled output' });
    expect(garbled.body).toMatchObject({
      status: 'failed',
      error: { code: 'PROVIDER_INVALID_OUTPUT' },
    });
    fake.script('loops', [
      { type: 'tool_calls', calls: [{ tool: 'support.today_feed', arguments: {} }] },
    ]);
    const loops = await ask(t, leagueManager, { prompt: 'loops forever' });
    expect(loops.body).toMatchObject({
      status: 'failed',
      turns: 4,
      error: { code: 'TURN_LIMIT_REACHED' },
    });
    expect(loops.body.toolInvocations).toHaveLength(4);
  });

  it('an unknown tool is refused as unsupported and invalid arguments as invalid; both are logged and listed as missing evidence', async () => {
    fake.script('odd tools', [
      {
        type: 'tool_calls',
        calls: [
          { tool: 'competition.resolve_discipline', arguments: { decisionId: 'x' } },
          { tool: 'competition.fixture_readiness', arguments: { fixtureId: 'not-a-uuid' } },
        ],
      },
      { type: 'answer', text: 'Could not do it.' },
    ]);
    const res = await ask(t, leagueManager, { prompt: 'odd tools please' });
    expect(res.body.toolInvocations.map((i: { outcome: string }) => i.outcome)).toEqual([
      'unsupported',
      'invalid',
    ]);
    expect(res.body.toolInvocations[0]).toMatchObject({
      toolKind: 'unknown',
      actionId: null,
      errorCode: 'UNSUPPORTED_TOOL',
    });
    expect(res.body.missingEvidence.map((m: { reason: string }) => m.reason)).toEqual(
      expect.arrayContaining(['unsupported_request', 'invalid_request']),
    );
  });
});

describe('assistant limits (SPK-AUTO-001)', () => {
  it('calls beyond the per-request limit are not made and are listed as missing evidence', async () => {
    const { t, fake } = await automationTestApp({ settings: { maxToolCalls: 2 } });
    try {
      const staff = await staffMember(t, ['league_manager']);
      fake.script('many', [
        {
          type: 'tool_calls',
          calls: [1, 2, 3].map(() => ({ tool: 'support.today_feed', arguments: {} })),
        },
        { type: 'answer', text: 'Done.' },
      ]);
      const res = await ask(t, staff, { prompt: 'many calls' });
      expect(res.body.toolInvocations).toHaveLength(2);
      expect(res.body.missingEvidence).toContainEqual(
        expect.objectContaining({ recordType: 'tool_call', reason: 'limit_reached' }),
      );
      expect(fake.inputsFor(res.body.id)[1]?.limits.remainingToolCalls).toBe(0);
    } finally {
      await t.close();
    }
  });
});
