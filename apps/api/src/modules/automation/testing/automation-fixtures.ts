import type { INestApplication } from '@nestjs/common';
import type { TestingModuleBuilder } from '@nestjs/testing';
import { newId, type RecommendationKindValue } from '@sportspark/contracts';
import { json, type Db } from '@sportspark/db';
import type { Clock } from '../../../kernel';
import {
  AUTOMATION_SETTINGS,
  DEFAULT_AUTOMATION_SETTINGS,
  type AutomationSettings,
} from '../automation.settings';
import { ASSISTANT_PROVIDER_PORT } from '../ports/assistant-provider.port';
import { FakeAssistantProvider } from '../providers/fake-assistant.provider';

/**
 * Automation fixtures. Nothing depends on the automation module (SPK-AUTO-005); these exist for
 * tests that exercise it. The context is structural: a `TestApp` from apps/api/src/testing
 * satisfies it.
 */
export interface AutomationFixtureContext {
  db: Db;
  clock: Clock;
  organizationId: string;
}

/** `createTestApp({ configure: enableAutomation() })`: the assistant on, with the fake provider. */
export function enableAutomation(
  overrides: Partial<AutomationSettings> = {},
): (builder: TestingModuleBuilder) => TestingModuleBuilder {
  return (builder) =>
    builder
      .overrideProvider(AUTOMATION_SETTINGS)
      .useValue({ ...DEFAULT_AUTOMATION_SETTINGS, ...overrides, enabled: true })
      .overrideProvider(ASSISTANT_PROVIDER_PORT)
      .useValue(new FakeAssistantProvider());
}

/** The scripted provider of an app built with `enableAutomation()`. */
export function fakeAssistant(app: INestApplication): FakeAssistantProvider {
  const provider = app.get(ASSISTANT_PROVIDER_PORT, { strict: false }) as unknown;
  if (!(provider instanceof FakeAssistantProvider)) {
    throw new Error('the assistant provider is not the FakeAssistantProvider');
  }
  return provider;
}

function snapshot(kind: 'customer' | 'staff', accountId: string, personId: string) {
  return {
    kind,
    accountId,
    personId,
    staffRoles: [],
    sessionId: null,
    actorLabel: `${kind}:fixture`,
  };
}

/**
 * An assistant request written directly, for schema tests and tests that need a recommendation to
 * hang off: `answered` (default) with its succeeded operation, or `processing` with its running
 * operation, as a request whose process stopped mid-request leaves it (AUT-03).
 */
export async function createAssistantRequestFixture(
  ctx: AutomationFixtureContext,
  input: {
    requesterAccountId: string;
    requesterPersonId: string;
    kind?: 'customer' | 'staff';
    status?: 'processing' | 'answered';
    organizationId?: string;
    /** When the request was received (default: now). */
    receivedAt?: Date;
  },
): Promise<{ assistantRequestId: string; operationId: string }> {
  const organizationId = input.organizationId ?? ctx.organizationId;
  const id = newId();
  const operationId = newId();
  const now = input.receivedAt ?? ctx.clock.now();
  const answered = (input.status ?? 'answered') === 'answered';
  const requester = snapshot(
    input.kind ?? 'staff',
    input.requesterAccountId,
    input.requesterPersonId,
  );
  await ctx.db.transaction().execute(async (trx) => {
    await trx
      .insertInto('operations')
      .values({
        id: operationId,
        organization_id: organizationId,
        kind: 'automation.assistant_request',
        status: answered ? 'succeeded' : 'running',
        requested_by: json(requester),
        correlation_id: null,
        input: null,
        result: null,
        error: null,
        completed_at: answered ? now : null,
      })
      .execute();
    await trx
      .insertInto('assistant_requests')
      .values({
        id,
        organization_id: organizationId,
        requester: json(requester),
        requester_account_id: input.requesterAccountId,
        requester_person_id: input.requesterPersonId,
        facility_id: null,
        prompt: 'Fixture request',
        provider: 'fake-assistant',
        response_text: null,
        error: null,
        operation_id: operationId,
        received_at: now,
        completed_at: null,
      })
      .execute();
    if (answered) {
      await trx
        .updateTable('assistant_requests')
        .set({
          status: 'answered',
          response_text: 'Fixture answer',
          completed_at: now,
          revision: 2,
        })
        .where('id', '=', id)
        .execute();
    }
  });
  return { assistantRequestId: id, operationId };
}

/** A proposed recommendation of an assistant request, written directly. */
export async function createRecommendationFixture(
  ctx: AutomationFixtureContext,
  input: {
    assistantRequestId: string;
    requesterAccountId: string;
    requesterPersonId: string;
    kind?: RecommendationKindValue;
    command?: {
      actionId: 'scheduling.publish_schedule' | 'communications.send' | 'finance.refund';
      input: Record<string, unknown>;
      target: { type: string; id: string | null; facilityId: string | null };
    } | null;
    expiresInMinutes?: number;
    organizationId?: string;
  },
): Promise<string> {
  const id = newId();
  const now = ctx.clock.now();
  const kind = input.kind ?? 'issue_summary';
  const command = input.command ?? null;
  await ctx.db
    .insertInto('recommendations')
    .values({
      id,
      organization_id: input.organizationId ?? ctx.organizationId,
      assistant_request_id: input.assistantRequestId,
      facility_id: null,
      kind,
      title: 'Fixture recommendation',
      summary: 'Fixture summary',
      payload: json({}),
      command_action_id: command?.actionId ?? null,
      command: command ? json({ input: command.input, target: command.target }) : null,
      evidence: json([]),
      missing_evidence: json([]),
      requester: json(snapshot('staff', input.requesterAccountId, input.requesterPersonId)),
      requester_account_id: input.requesterAccountId,
      requester_person_id: input.requesterPersonId,
      proposed_at: now,
      expires_at: new Date(now.getTime() + (input.expiresInMinutes ?? 60) * 60_000),
      reviewed_by: null,
      reviewed_by_account_id: null,
      reviewed_by_person_id: null,
      reviewed_at: null,
      review_decision: null,
      review_reason: null,
      apply_operation_id: null,
      apply_started_at: null,
      applied_by: null,
      applied_by_account_id: null,
      applied_by_person_id: null,
      applied_at: null,
      applied_audit_record_id: null,
      applied_command_operation_id: null,
      applied_record_type: null,
      applied_record_id: null,
      last_apply_error: null,
      expired_at: null,
    })
    .execute();
  return id;
}
