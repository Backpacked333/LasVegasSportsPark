import { newId, systemPrincipal } from '@sportspark/contracts';
import { json } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditWriter, OperationsService } from '../../../kernel';
import type { TestApp } from '../../../testing';
import {
  createAssistantRequestFixture,
  createRecommendationFixture,
} from '../testing/automation-fixtures';
import {
  automationTestApp,
  expectPgError,
  otherOrganization,
  staffMember,
  type Actor,
} from './automation';

const CHECK = '23514';
const FOREIGN_KEY = '23503';
const UNIQUE = '23505';
const RESTRICT = '23001';

/**
 * Integrity invariants of migration 1400 proven by writing violating rows directly: the services
 * check first for earlier feedback, but the database is the guarantee (CLAUDE.md "Data rules").
 */
describe('automation schema invariants (migration 1400)', () => {
  let t: TestApp;
  let requester: Actor;
  let reviewer: Actor;
  let other: { organizationId: string; facilityId: string };
  let otherStaff: Actor;

  beforeAll(async () => {
    ({ t } = await automationTestApp());
    requester = await staffMember(t, ['scheduler']);
    reviewer = await staffMember(t, ['scheduler']);
    other = await otherOrganization(t);
    otherStaff = await staffMember(t, ['scheduler'], { organizationId: other.organizationId });
  });
  afterAll(async () => {
    await t.close();
  });

  const snapshot = (actor: Actor, kind = 'staff') => ({
    kind,
    accountId: actor.accountId,
    personId: actor.personId,
    staffRoles: ['scheduler'],
    sessionId: null,
    actorLabel: `${kind}:test`,
  });

  const operation = (organizationId = t.organizationId) =>
    t.db.transaction().execute((trx) =>
      t.app.get(OperationsService).create(trx, {
        organizationId,
        kind: 'test.automation',
        requestedBy: systemPrincipal(organizationId),
        status: 'running',
      }),
    );

  const auditRecord = (organizationId = t.organizationId) =>
    t.db.transaction().execute((trx) =>
      t.app.get(AuditWriter).record(trx, {
        organizationId,
        actor: systemPrincipal(organizationId),
        action: 'test.audit',
        targetType: 'recommendation',
        targetId: newId(),
      }),
    );

  const insertRequest = async (
    values: Partial<{
      requester: Record<string, unknown>;
      status: 'processing' | 'answered' | 'failed';
      operation_id: string;
      organization_id: string;
      response_text: string | null;
    }> = {},
  ) =>
    t.db
      .insertInto('assistant_requests')
      .values({
        id: newId(),
        organization_id: values.organization_id ?? t.organizationId,
        requester: json(values.requester ?? snapshot(requester)),
        requester_account_id: requester.accountId,
        requester_person_id: requester.personId,
        facility_id: null,
        prompt: 'Schema test',
        provider: 'fake-assistant',
        response_text: values.response_text ?? null,
        error: null,
        operation_id: values.operation_id ?? (await operation()),
        received_at: t.clock.now(),
        completed_at: values.status && values.status !== 'processing' ? t.clock.now() : null,
        ...(values.status ? { status: values.status } : {}),
      })
      .returning('id')
      .executeTakeFirstOrThrow();

  const answeredRequest = () =>
    createAssistantRequestFixture(t, {
      requesterAccountId: requester.accountId,
      requesterPersonId: requester.personId,
    });

  const publishCommand = {
    actionId: 'scheduling.publish_schedule' as const,
    input: { draftId: newId() },
    target: { type: 'schedule_draft', id: null, facilityId: null },
  };

  const recommendation = async (
    command: typeof publishCommand | null = publishCommand,
    kind: 'schedule_repair' | 'issue_summary' = command ? 'schedule_repair' : 'issue_summary',
  ) => {
    const request = await answeredRequest();
    const id = await createRecommendationFixture(t, {
      assistantRequestId: request.assistantRequestId,
      requesterAccountId: requester.accountId,
      requesterPersonId: requester.personId,
      kind,
      command,
    });
    return { id, assistantRequestId: request.assistantRequestId };
  };

  const approveRow = (id: string, revision = 2) =>
    t.db
      .updateTable('recommendations')
      .set({
        status: 'approved',
        review_decision: 'approved',
        reviewed_by: json(snapshot(reviewer)),
        reviewed_by_account_id: reviewer.accountId,
        reviewed_by_person_id: reviewer.personId,
        reviewed_at: t.clock.now(),
        revision,
      })
      .where('id', '=', id)
      .execute();

  const claimRow = async (id: string, revision = 3) => {
    const op = await operation();
    await t.db
      .updateTable('recommendations')
      .set({ apply_operation_id: op, apply_started_at: t.clock.now(), revision })
      .where('id', '=', id)
      .execute();
    return op;
  };

  const applyRow = async (
    id: string,
    values: Partial<{
      applied_by_account_id: string;
      applied_audit_record_id: string | null;
      revision: number;
    }> = {},
  ) =>
    t.db
      .updateTable('recommendations')
      .set({
        status: 'applied',
        applied_by: json(snapshot(reviewer)),
        applied_by_account_id: values.applied_by_account_id ?? reviewer.accountId,
        applied_by_person_id: reviewer.personId,
        applied_at: t.clock.now(),
        applied_audit_record_id:
          values.applied_audit_record_id === undefined
            ? await auditRecord()
            : values.applied_audit_record_id,
        revision: values.revision ?? 4,
      })
      .where('id', '=', id)
      .execute();

  it('SPK-AUTO-004 / SPK-AT-026: an assistant request always names a person requester — never a system principal, never an unlabeled snapshot', async () => {
    await expectPgError(
      insertRequest({ requester: { ...snapshot(requester), kind: 'system' } }),
      CHECK,
    );
    await expectPgError(insertRequest({ requester: { actorLabel: 'no kind' } }), CHECK);
    await expectPgError(
      insertRequest({ requester: { kind: 'staff', accountId: requester.accountId } }),
      CHECK,
    );
    await insertRequest();
  });

  it('AssistantRequestMachine: created processing at revision 1; answered and failed are final; the prompt is immutable; each change bumps the revision', async () => {
    await expectPgError(insertRequest({ status: 'answered', response_text: 'x' }), CHECK);
    const { id } = await insertRequest();
    // answered requires a response; failed requires an error.
    await expectPgError(
      t.db
        .updateTable('assistant_requests')
        .set({ status: 'answered', completed_at: t.clock.now(), revision: 2 })
        .where('id', '=', id)
        .execute(),
      CHECK,
    );
    await expectPgError(
      t.db
        .updateTable('assistant_requests')
        .set({ prompt: 'Rewritten', revision: 2 })
        .where('id', '=', id)
        .execute(),
      CHECK,
    );
    await expectPgError(
      t.db
        .updateTable('assistant_requests')
        .set({ status: 'answered', response_text: 'ok', completed_at: t.clock.now() })
        .where('id', '=', id)
        .execute(),
      CHECK,
    );
    await t.db
      .updateTable('assistant_requests')
      .set({ status: 'answered', response_text: 'ok', completed_at: t.clock.now(), revision: 2 })
      .where('id', '=', id)
      .execute();
    await expectPgError(
      t.db
        .updateTable('assistant_requests')
        .set({ status: 'failed', error: json({ code: 'X' }), revision: 3 })
        .where('id', '=', id)
        .execute(),
      CHECK,
    );
    await expectPgError(
      t.db.deleteFrom('assistant_requests').where('id', '=', id).execute(),
      RESTRICT,
    );
  });

  it('§4.3: automation rows never point at another organization’s records', async () => {
    // A request whose operation belongs to another organization.
    await expectPgError(
      insertRequest({ operation_id: await operation(other.organizationId) }),
      FOREIGN_KEY,
    );
    // A recommendation of another organization pointing at this organization's request.
    const request = await answeredRequest();
    await expectPgError(
      createRecommendationFixture(t, {
        assistantRequestId: request.assistantRequestId,
        requesterAccountId: otherStaff.accountId,
        requesterPersonId: otherStaff.personId,
        organizationId: other.organizationId,
      }),
      FOREIGN_KEY,
    );
    // A recommendation claimed by another organization's operation.
    const { id } = await recommendation();
    await approveRow(id);
    const foreignOp = await operation(other.organizationId);
    await expectPgError(
      t.db
        .updateTable('recommendations')
        .set({ apply_operation_id: foreignOp, apply_started_at: t.clock.now(), revision: 3 })
        .where('id', '=', id)
        .execute(),
      FOREIGN_KEY,
    );
  });

  it('SPK-AUTO-003: informational kinds carry no command, consequential kinds carry exactly theirs, and every recommendation starts proposed', async () => {
    const request = await answeredRequest();
    const base = {
      assistantRequestId: request.assistantRequestId,
      requesterAccountId: requester.accountId,
      requesterPersonId: requester.personId,
    };
    await expectPgError(
      createRecommendationFixture(t, { ...base, kind: 'issue_summary', command: publishCommand }),
      CHECK,
    );
    await expectPgError(
      createRecommendationFixture(t, { ...base, kind: 'schedule_repair', command: null }),
      CHECK,
    );
    await expectPgError(
      createRecommendationFixture(t, {
        ...base,
        kind: 'schedule_repair',
        command: { ...publishCommand, actionId: 'communications.send' },
      }),
      CHECK,
    );
    await expectPgError(
      createRecommendationFixture(t, {
        ...base,
        kind: 'communication_draft',
        command: { ...publishCommand, actionId: 'finance.refund' },
      }),
      CHECK,
    );
    const id = await createRecommendationFixture(t, { ...base, kind: 'readiness_explanation' });
    expect(id).toBeTruthy();
    await expectPgError(
      t.db
        .insertInto('recommendations')
        .values({
          id: newId(),
          organization_id: t.organizationId,
          assistant_request_id: request.assistantRequestId,
          facility_id: null,
          kind: 'issue_summary',
          title: 'Born approved',
          summary: 'x',
          command_action_id: null,
          command: null,
          requester: json(snapshot(requester)),
          requester_account_id: requester.accountId,
          requester_person_id: requester.personId,
          status: 'approved',
          proposed_at: t.clock.now(),
          expires_at: new Date(t.clock.now().getTime() + 60_000),
          reviewed_by: json(snapshot(reviewer)),
          reviewed_by_account_id: reviewer.accountId,
          reviewed_by_person_id: reviewer.personId,
          reviewed_at: t.clock.now(),
          review_decision: 'approved',
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
        .execute(),
      CHECK,
    );
  });

  it('SPK-AUTO-003 / SPK-AT-026: a recommendation is applied only after approval, from its claim, by the approving reviewer, with the apply audit record', async () => {
    const { id } = await recommendation();
    // Never straight from proposed.
    await expectPgError(applyRow(id, { revision: 2 }), CHECK);
    // An approval is recorded with its reviewer.
    await expectPgError(
      t.db
        .updateTable('recommendations')
        .set({ status: 'approved', revision: 2 })
        .where('id', '=', id)
        .execute(),
      CHECK,
    );
    await approveRow(id);
    // Not without the coordinating operation's claim.
    await expectPgError(applyRow(id, { revision: 3 }), CHECK);
    await claimRow(id);
    // Not without the audit record of the apply.
    await expectPgError(applyRow(id, { applied_audit_record_id: null }), CHECK);
    // Not by anyone but the approving reviewer.
    await expectPgError(applyRow(id, { applied_by_account_id: requester.accountId }), CHECK);
    await applyRow(id);
    const row = await t.db
      .selectFrom('recommendations')
      .select(['status', 'revision'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ status: 'applied', revision: 4 });
    // Applied is final.
    await expectPgError(
      t.db
        .updateTable('recommendations')
        .set({ status: 'expired', expired_at: t.clock.now(), revision: 5 })
        .where('id', '=', id)
        .execute(),
      CHECK,
    );
  });

  it('RecommendationMachine: rejected and expired are final, a claimed recommendation cannot expire, the proposal and its evidence are immutable, the review is immutable', async () => {
    const rejected = await recommendation();
    await expectPgError(
      t.db
        .updateTable('recommendations')
        .set({
          status: 'rejected',
          review_decision: 'rejected',
          reviewed_by: json(snapshot(reviewer)),
          reviewed_by_account_id: reviewer.accountId,
          reviewed_at: t.clock.now(),
          revision: 2,
        })
        .where('id', '=', rejected.id)
        .execute(),
      CHECK, // a rejection needs its reason
    );
    await t.db
      .updateTable('recommendations')
      .set({
        status: 'rejected',
        review_decision: 'rejected',
        review_reason: 'No',
        reviewed_by: json(snapshot(reviewer)),
        reviewed_by_account_id: reviewer.accountId,
        reviewed_at: t.clock.now(),
        revision: 2,
      })
      .where('id', '=', rejected.id)
      .execute();
    await expectPgError(approveRow(rejected.id, 3), CHECK);

    const claimed = await recommendation();
    await approveRow(claimed.id);
    // The recorded review cannot be rewritten.
    await expectPgError(
      t.db
        .updateTable('recommendations')
        .set({ reviewed_by_account_id: requester.accountId, revision: 3 })
        .where('id', '=', claimed.id)
        .execute(),
      CHECK,
    );
    await claimRow(claimed.id);
    await expectPgError(
      t.db
        .updateTable('recommendations')
        .set({ status: 'expired', expired_at: t.clock.now(), revision: 4 })
        .where('id', '=', claimed.id)
        .execute(),
      CHECK,
    );

    const proposed = await recommendation();
    await expectPgError(
      t.db
        .updateTable('recommendations')
        .set({ evidence: json([{ recordType: 'invented', recordId: 'x' }]), revision: 2 })
        .where('id', '=', proposed.id)
        .execute(),
      CHECK,
    );
    await expectPgError(
      t.db
        .updateTable('recommendations')
        .set({ command: json({ input: { draftId: newId() }, target: {} }), revision: 2 })
        .where('id', '=', proposed.id)
        .execute(),
      CHECK,
    );
    await expectPgError(
      t.db
        .updateTable('recommendations')
        .set({ status: 'expired', expired_at: t.clock.now() })
        .where('id', '=', proposed.id)
        .execute(),
      CHECK, // the revision must bump
    );
    await t.db
      .updateTable('recommendations')
      .set({ status: 'expired', expired_at: t.clock.now(), revision: 2 })
      .where('id', '=', proposed.id)
      .execute();
    await expectPgError(approveRow(proposed.id, 3), CHECK);
    await expectPgError(
      t.db.deleteFrom('recommendations').where('id', '=', proposed.id).execute(),
      RESTRICT,
    );
  });

  it('§4.7 invariant 5: one coordinating operation applies one recommendation', async () => {
    const first = await recommendation();
    const second = await recommendation();
    await approveRow(first.id);
    await approveRow(second.id);
    const op = await claimRow(first.id);
    await expectPgError(
      t.db
        .updateTable('recommendations')
        .set({ apply_operation_id: op, apply_started_at: t.clock.now(), revision: 3 })
        .where('id', '=', second.id)
        .execute(),
      UNIQUE,
    );
  });

  it('SPK-AUTO-004 / SPK-AT-026: tool invocations are append-only and always record the person principal they ran under', async () => {
    const { id: recommendationId, assistantRequestId } = await recommendation();
    const invocation = (
      values: Partial<{
        sequence: number;
        phase: 'assist' | 'apply';
        recommendation_id: string | null;
        principal: Record<string, unknown>;
        outcome: 'succeeded' | 'denied';
        error_code: string | null;
        assistant_request_id: string;
      }> = {},
    ) =>
      t.db
        .insertInto('tool_invocations')
        .values({
          id: newId(),
          organization_id: t.organizationId,
          assistant_request_id: values.assistant_request_id ?? assistantRequestId,
          recommendation_id: values.recommendation_id ?? null,
          sequence: values.sequence ?? 1,
          phase: values.phase ?? 'assist',
          tool: 'identity.person',
          action_id: 'identity.read_person',
          tool_kind: values.phase === 'apply' ? 'command' : 'query',
          principal: json(values.principal ?? snapshot(requester)),
          principal_account_id: requester.accountId,
          principal_person_id: requester.personId,
          outcome: values.outcome ?? 'denied',
          error_code: values.error_code === undefined ? 'NOT_FOUND' : values.error_code,
          error_message: null,
          occurred_at: t.clock.now(),
          correlation_id: null,
          operation_id: null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
    const { id } = await invocation();
    await expectPgError(
      t.db
        .updateTable('tool_invocations')
        .set({ outcome: 'succeeded', error_code: null })
        .where('id', '=', id)
        .execute(),
      RESTRICT,
    );
    await expectPgError(
      t.db.deleteFrom('tool_invocations').where('id', '=', id).execute(),
      RESTRICT,
    );
    await expectPgError(invocation({ sequence: 1 }), UNIQUE);
    await expectPgError(
      invocation({ sequence: 2, principal: { ...snapshot(requester), kind: 'system' } }),
      CHECK,
    );
    await expectPgError(invocation({ sequence: 3, outcome: 'succeeded' }), CHECK);
    await expectPgError(invocation({ sequence: 4, phase: 'apply' }), CHECK);
    // An apply invocation names a recommendation of the same request.
    const elsewhere = await recommendation();
    await expectPgError(
      invocation({ sequence: 5, phase: 'apply', recommendation_id: elsewhere.id }),
      FOREIGN_KEY,
    );
    await invocation({ sequence: 6, phase: 'apply', recommendation_id: recommendationId });
  });
});
