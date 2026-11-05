import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../kernel';
import { TEST_CONFIG_ENV, createTestApp, type TestApp } from '../../../testing';
import { AutomationModule } from '../automation.module';
import { AUTOMATION_SETTINGS } from '../automation.settings';
import type { FakeAssistantProvider } from '../providers/fake-assistant.provider';
import { fakeAssistant } from '../testing/automation-fixtures';
import {
  ASSISTANT_CAPABILITIES,
  CLOCK_START,
  adultCustomer,
  automationTestApp,
  countRows,
  drainOutbox,
  get,
  otherOrganization,
  post,
  staffMember,
  type Actor,
} from './automation';

interface Rec {
  id: string;
  revision: number;
  status: string;
}

const CAPABILITY_DISABLED = {
  code: 'ACCESS_DENIED',
  details: {
    code: 'CAPABILITY_DISABLED',
    capability: 'assistant',
    applicabilityReferences: ['DEC-016'],
  },
};

/**
 * AUT-02 (SPK-AUTO-005, §1.6, §6.5 Package G "reviewable operational assistance"; DEC-016, with the
 * provider DEC-013 related and never enabling): the assistant answers only when the deployment
 * flag AUTOMATION_ENABLED is on and the organization's capability switch `assistant` is on. Off,
 * a new request, an approval or an apply is refused with CAPABILITY_DISABLED; reading, rejecting
 * and settling recommendations and the expiry timer stay available; core operations never depend
 * on either switch.
 */
describe('per-organization assistant switch (AUT-02, SPK-AUTO-005, DEC-016)', () => {
  let t: TestApp;
  let fake: FakeAssistantProvider;
  let other: { organizationId: string; facilityId: string };
  let leagueManager: Actor;

  beforeAll(async () => {
    ({ t, fake } = await automationTestApp());
    other = await otherOrganization(t);
    leagueManager = await staffMember(t, ['league_manager']);
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    fake.reset();
    t.clock.set(CLOCK_START);
    await t.enableCapability('assistant');
  });

  /** A staff notice proposed by the league manager (communications.send). */
  async function proposeNotice(title: string): Promise<Rec> {
    fake.script(title, [
      {
        type: 'tool_calls',
        calls: [
          {
            tool: 'communications.send',
            arguments: {
              kind: 'staff_broadcast',
              category: 'operational',
              audience: { staffRoles: ['front_desk'] },
              title,
              body: 'Please read the posted notice.',
            },
          },
        ],
      },
      { type: 'answer', text: 'Drafted.' },
    ]);
    const res = await post(t, '/v1/assistant/requests', leagueManager, { prompt: title });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.recommendations).toHaveLength(1);
    return res.body.recommendations[0] as Rec;
  }

  it('SPK-AUTO-005: organization A with the capability gets answers while organization B gets CAPABILITY_DISABLED and its core operations still work', async () => {
    const operatorA = await staffMember(t, ['support_operator']);
    const operatorB = await staffMember(t, ['support_operator'], {
      organizationId: other.organizationId,
    });
    const customerB = await adultCustomer(t, { organizationId: other.organizationId });
    fake.script('summarize today', [{ type: 'answer', text: 'Nothing urgent today.' }]);

    const a = await post(t, '/v1/assistant/requests', operatorA, { prompt: 'summarize today' });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(a.body).toMatchObject({
      status: 'answered',
      response: { text: 'Nothing urgent today.' },
    });

    for (const actor of [operatorB, customerB]) {
      const b = await post(t, '/v1/assistant/requests', actor, { prompt: 'summarize today' });
      expect(b.status, JSON.stringify(b.body)).toBe(403);
      expect(b.body).toMatchObject(CAPABILITY_DISABLED);
    }
    // Nothing was recorded for B and the provider never saw B's prompt.
    const requestsB = await t.db
      .selectFrom('assistant_requests')
      .select('id')
      .where('organization_id', '=', other.organizationId)
      .execute();
    expect(requestsB).toEqual([]);
    const operationsB = await t.db
      .selectFrom('operations')
      .select('id')
      .where('organization_id', '=', other.organizationId)
      .where('kind', '=', 'automation.assistant_request')
      .execute();
    expect(operationsB).toEqual([]);
    expect(fake.received).toHaveLength(1);

    // B's core operations do not depend on the assistant.
    const supportCase = await post(t, '/v1/cases', operatorB, {
      category: 'other',
      title: 'The assistant is off here; work continues',
    });
    expect(supportCase.status, JSON.stringify(supportCase.body)).toBe(201);
    expect(supportCase.body).toMatchObject({ status: 'open' });
  });

  it('DEC-016: only a system administrator switches the assistant on for an organization, naming DEC-016 (DEC-013 is related, never enabling); the change is audited', async () => {
    const gmB = await staffMember(t, ['general_manager'], { organizationId: other.organizationId });
    const adminB = await staffMember(t, ['system_administrator'], {
      organizationId: other.organizationId,
    });
    const enable = (actor: Actor, decisionReference: string) =>
      post(t, '/v1/admin/capabilities/assistant/enable', actor, {
        decisionReference,
        reason: 'The complex uses reviewable assistance',
      });
    expect((await enable(gmB, 'DEC-016')).status).toBe(403);
    const related = await enable(adminB, 'DEC-013');
    expect(related.status).toBe(400);
    expect(related.body.details).toMatchObject({ code: 'NOT_AN_APPLICABILITY_DECISION' });
    const enabled = await enable(adminB, 'DEC-016');
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
    expect(enabled.body).toMatchObject({
      capability: 'assistant',
      enabled: true,
      decisionReference: 'DEC-016',
      owningModules: ['automation'],
      relatedDecisions: ['DEC-013'],
    });
    const audit = await t.db
      .selectFrom('audit_records')
      .select(['action', 'actor'])
      .where('organization_id', '=', other.organizationId)
      .where('target_type', '=', 'capability')
      .where('target_id', '=', 'assistant')
      .execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'core.manage_capabilities.enable',
      actor: { accountId: adminB.accountId },
    });

    fake.script('now in B', [{ type: 'answer', text: 'Answered in B.' }]);
    const operatorB = await staffMember(t, ['support_operator'], {
      organizationId: other.organizationId,
    });
    const asked = await post(t, '/v1/assistant/requests', operatorB, { prompt: 'now in B' });
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    expect(asked.body.status).toBe('answered');
    await t.disableCapability('assistant', other.organizationId);
  });

  it('AUT-02: with the capability off, approving and applying are refused while reading, rejecting and the expiry timer stay available', async () => {
    const toReject = await proposeNotice('notice to reject');
    const toApprove = await proposeNotice('notice to approve');
    const approved = await post(t, `/v1/recommendations/${toApprove.id}/approve`, leagueManager, {
      expectedRevision: toApprove.revision,
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const pending = await proposeNotice('notice left pending');
    const notifications = await countRows(t, 'notifications');

    await t.disableCapability('assistant');

    // New commitments are refused and change nothing.
    const approve = await post(t, `/v1/recommendations/${pending.id}/approve`, leagueManager, {
      expectedRevision: pending.revision,
    });
    expect(approve.status).toBe(403);
    expect(approve.body).toMatchObject(CAPABILITY_DISABLED);
    const apply = await post(t, `/v1/recommendations/${toApprove.id}/apply`, leagueManager, {
      expectedRevision: approved.body.revision,
    });
    expect(apply.status).toBe(403);
    expect(apply.body).toMatchObject(CAPABILITY_DISABLED);
    const applyOperations = await t.db
      .selectFrom('operations')
      .select('id')
      .where('kind', '=', 'automation.apply_recommendation')
      .execute();
    expect(applyOperations).toEqual([]);
    expect(await countRows(t, 'notifications')).toBe(notifications);
    const asked = await post(t, '/v1/assistant/requests', leagueManager, { prompt: 'anything' });
    expect(asked.status).toBe(403);
    expect(asked.body).toMatchObject(CAPABILITY_DISABLED);

    // Reads and rejections stay available.
    const read = await get(t, `/v1/recommendations/${pending.id}`, leagueManager);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ status: 'proposed', revision: pending.revision });
    const listed = await get(t, '/v1/recommendations', leagueManager);
    expect(listed.status).toBe(200);
    expect(listed.body.items.map((r: Rec) => r.id)).toEqual(
      expect.arrayContaining([pending.id, toReject.id, toApprove.id]),
    );
    const request = await get(
      t,
      `/v1/assistant/requests/${(read.body as { assistantRequestId: string }).assistantRequestId}`,
      leagueManager,
    );
    expect(request.status).toBe(200);
    const rejected = await post(t, `/v1/recommendations/${toReject.id}/reject`, leagueManager, {
      expectedRevision: toReject.revision,
      reason: 'Not needed this week',
    });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    expect(rejected.body.status).toBe('rejected');

    // The expiry timer still runs.
    t.clock.advance(25 * 3600_000);
    await drainOutbox(t);
    const expired = await get(t, `/v1/recommendations/${toApprove.id}`, leagueManager);
    expect(expired.body.status).toBe('expired');
    expect((await get(t, `/v1/recommendations/${pending.id}`, leagueManager)).body.status).toBe(
      'expired',
    );
  });
});

describe('deployment flag and module settings (AUT-02, SPK-AUTO-005, IF-43)', () => {
  it('IF-43: AUTOMATION_* are module settings of the kernel configuration; a malformed value refuses boot', () => {
    expect(loadConfig({ ...TEST_CONFIG_ENV }).moduleSettings['automation']).toEqual({
      ENABLED: false,
      RECOMMENDATION_TTL_MINUTES: 1440,
      EVIDENCE_MAX_AGE_MINUTES: 1440,
      MAX_TURNS: 4,
      MAX_TOOL_CALLS: 12,
      REQUEST_STALL_SECONDS: 900,
    });
    expect(() => loadConfig({ ...TEST_CONFIG_ENV, AUTOMATION_ENABLED: 'yes' })).toThrow(
      /AUTOMATION_ENABLED/,
    );
    expect(() =>
      loadConfig({ ...TEST_CONFIG_ENV, AUTOMATION_REQUEST_STALL_SECONDS: '10' }),
    ).toThrow(/AUTOMATION_REQUEST_STALL_SECONDS/);
    expect(() => loadConfig({ ...TEST_CONFIG_ENV, AUTOMATION_MAX_TURNS: '0' })).toThrow(
      /AUTOMATION_MAX_TURNS/,
    );
  });

  describe('flag on, read from the configuration', () => {
    let t: TestApp;
    beforeAll(async () => {
      t = await createTestApp({
        imports: [AutomationModule],
        principalResolver: 'module',
        clockStart: CLOCK_START,
        env: { AUTOMATION_ENABLED: 'true', AUTOMATION_MAX_TURNS: '2' },
        capabilities: ASSISTANT_CAPABILITIES,
      });
    });
    afterAll(async () => {
      await t.close();
    });

    it('IF-43: the module answers with the settings the configuration carries', async () => {
      expect(t.app.get(AUTOMATION_SETTINGS)).toMatchObject({ enabled: true, maxTurns: 2 });
      const fake = fakeAssistant(t.app);
      fake.script('configured', [{ type: 'answer', text: 'Configured.' }]);
      const operator = await staffMember(t, ['support_operator']);
      const res = await post(t, '/v1/assistant/requests', operator, { prompt: 'configured' });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(fake.received[0]?.limits).toEqual({ remainingTurns: 1, remainingToolCalls: 12 });
    });
  });

  describe('flag off (the default)', () => {
    let t: TestApp;
    let other: { organizationId: string; facilityId: string };
    beforeAll(async () => {
      t = await createTestApp({
        imports: [AutomationModule],
        principalResolver: 'module',
        clockStart: CLOCK_START,
        capabilities: ASSISTANT_CAPABILITIES,
      });
      other = await otherOrganization(t);
    });
    afterAll(async () => {
      await t.close();
    });

    it('SPK-AUTO-005: with the deployment flag off every organization gets INTEGRATION_UNAVAILABLE, whatever its capability switch', async () => {
      const withCapability = await staffMember(t, ['general_manager']);
      const without = await staffMember(t, ['general_manager'], {
        organizationId: other.organizationId,
      });
      const id = newId();
      for (const actor of [withCapability, without]) {
        for (const call of [
          () => post(t, '/v1/assistant/requests', actor, { prompt: 'hello' }),
          () => get(t, '/v1/recommendations', actor),
          () =>
            post(t, `/v1/recommendations/${id}/settle-apply`, actor, {
              expectedRevision: 1,
              outcome: 'applied',
              evidence: 'Checked',
              reason: 'Reconciled',
            }),
        ]) {
          const res = await call();
          expect(res.status).toBe(503);
          expect(res.body).toMatchObject({
            code: 'INTEGRATION_UNAVAILABLE',
            details: { capability: 'automation', reason: 'disabled' },
          });
        }
      }
      expect(await t.db.selectFrom('assistant_requests').select('id').execute()).toEqual([]);
    });
  });
});
