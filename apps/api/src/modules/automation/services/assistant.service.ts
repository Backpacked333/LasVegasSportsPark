import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  errors,
  newId,
  systemPrincipal,
  type AssistantAttachment,
  type AssistantContextReference,
  type AssistantEvidence,
  type AssistantMissingEvidence,
  type AssistantRequest,
  type CreateAssistantRequestInput,
  type Principal,
} from '@sportspark/contracts';
import { json, type Db } from '@sportspark/db';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  CapabilityService,
  DATABASE,
  OperationsService,
  Outbox,
  UnitOfWork,
  snapshotActor,
  type Clock,
  type PeriodicJobContext,
  type PeriodicJobResult,
  type Trx,
} from '../../../kernel';
import { AutomationActions } from '../automation.actions';
import { AssistantRequestCompleted } from '../automation.events';
import { AssistantRequestMachine } from '../automation.machines';
import { AUTOMATION_SETTINGS, type AutomationSettings } from '../automation.settings';
import {
  actorOf,
  assertEnabled,
  iso,
  isoOrNull,
  organizationOf,
  requirePerson,
  toToolInvocation,
  type AssistantRequestRow,
  type Reader,
} from '../automation.shared';
import type { AssistantAttachmentData } from '../ports/assistant-provider.port';
import { AssistantEngine, type EngineResult } from './assistant-engine.service';
import { RecommendationsService, type NewRecommendation } from './recommendations.service';

/** AUT-03 (§4.12): fails requests left `processing` by a process that stopped mid-request. */
export const FAIL_STALLED_REQUESTS_JOB = 'automation.fail_stalled_requests';

interface StoredAttachment {
  name: string;
  kind: 'text' | 'message' | 'document';
  content: string;
  length: number;
  sha256: string;
}

interface StoredContextReference {
  type: AssistantContextReference['type'];
  id: string;
  observedAt: string | null;
}

/**
 * Assistant requests (SPK-AUTO-001, SPK-AUTO-002, SPK-AUTO-004, SPK-AT-026). The request is
 * recorded first (with its operation and audit record), the assistant then works outside any
 * transaction with the requester's own principal, and the outcome — answer, evidence with
 * freshness, missing evidence, recommendations — is recorded in one transaction at the end.
 * A request is the requester's own protected record: nobody else learns it exists (§4.10).
 */
@Injectable()
export class AssistantService {
  private readonly logger = new Logger(AssistantService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUTOMATION_SETTINGS) private readonly settings: AutomationSettings,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly operations: OperationsService,
    private readonly capabilities: CapabilityService,
    private readonly engine: AssistantEngine,
    private readonly recommendations: RecommendationsService,
  ) {}

  async ask(
    principal: Principal,
    input: CreateAssistantRequestInput,
    correlationId: string | null,
  ): Promise<AssistantRequest> {
    assertEnabled(this.settings);
    const person = requirePerson(principal);
    const organizationId = person.organizationId;
    const id = newId();
    const attachments: StoredAttachment[] = input.attachments.map((a) => ({
      name: a.name,
      kind: a.kind,
      content: a.content,
      length: a.content.length,
      sha256: createHash('sha256').update(a.content, 'utf8').digest('hex'),
    }));
    const context: StoredContextReference[] = input.context.map((c) => ({
      type: c.type,
      id: c.id,
      observedAt: c.observedAt ? iso(c.observedAt) : null,
    }));

    // 1. Record the request, its operation and its audit record.
    const operationId = await this.uow.run(async ({ trx }) => {
      await this.authorization.require(principal, AutomationActions.ask, {
        type: 'assistant_request',
        organizationId,
        facilityId: input.facilityId ?? null,
        subjectPersonIds: [person.personId],
      });
      // AUT-02 (SPK-AUTO-005, §1.6, DEC-016): the organization decides whether it uses the
      // assistant; off (the default), ACCESS_DENIED CAPABILITY_DISABLED and nothing is recorded.
      await this.capabilities.require(organizationId, 'assistant', trx);
      if (input.facilityId) {
        const facility = await trx
          .selectFrom('facilities')
          .select('id')
          .where('organization_id', '=', organizationId)
          .where('id', '=', input.facilityId)
          .executeTakeFirst();
        if (!facility) throw errors.notFound('facility', input.facilityId);
      }
      const opId = await this.operations.create(trx, {
        organizationId,
        kind: 'automation.assistant_request',
        requestedBy: principal,
        correlationId,
        input: {
          assistantRequestId: id,
          attachmentCount: attachments.length,
          contextReferenceCount: context.length,
        },
        status: 'running',
      });
      await trx
        .insertInto('assistant_requests')
        .values({
          id,
          organization_id: organizationId,
          requester: json(snapshotActor(principal)),
          requester_account_id: person.accountId,
          requester_person_id: person.personId,
          facility_id: input.facilityId ?? null,
          prompt: input.prompt,
          attachments: json(attachments),
          context_references: json(context),
          provider: this.engine.providerName,
          response_text: null,
          error: null,
          operation_id: opId,
          received_at: this.clock.now(),
          completed_at: null,
        })
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: AutomationActions.ask.id,
        targetType: 'assistant_request',
        targetId: id,
        afterRevision: 1,
        reason: input.reason ?? null,
        correlationId,
        operationId: opId,
        details: {
          provider: this.engine.providerName,
          attachmentCount: attachments.length,
          // SPK-AUTO-004: imported content is data; nothing in it can instruct or authorize.
          attachmentsTreatedAs: 'data',
          contextReferenceCount: context.length,
          policyReferences: input.policyReferences ?? [],
        },
      });
      return opId;
    });

    // 2. The assistant works with the requester's principal, outside any transaction (§4.11).
    const attachmentData: AssistantAttachmentData[] = attachments.map((a) => ({
      name: a.name,
      kind: a.kind,
      content: a.content,
      treatedAs: 'data',
    }));
    let result: EngineResult;
    try {
      result = await this.engine.run(principal, {
        assistantRequestId: id,
        organizationId,
        operationId,
        correlationId,
        prompt: input.prompt,
        attachments: attachmentData,
        context: input.context,
      });
    } catch (error) {
      this.logger.error(`assistant request ${id} failed unexpectedly: ${String(error)}`);
      result = {
        status: 'failed',
        text: null,
        error: { code: 'INTERNAL_ERROR', message: 'The assistant could not complete the request.' },
        turns: 0,
        evidence: [],
        missing: [],
        commands: [],
        informational: [],
        executions: [],
      };
    }

    // 3. Record the outcome. If it cannot be recorded (a proposal the database refuses), the
    // request and its operation still reach a terminal state (§4.9, §4.11): they fail, with no
    // recommendation, instead of staying processing/running.
    try {
      await this.complete(principal, id, operationId, correlationId, result);
    } catch (error) {
      if (result.status !== 'answered') throw error;
      this.logger.error(`assistant request ${id}: outcome could not be recorded: ${String(error)}`);
      await this.complete(principal, id, operationId, correlationId, {
        ...result,
        status: 'failed',
        text: null,
        commands: [],
        informational: [],
        error: { code: 'INTERNAL_ERROR', message: 'The assistant could not record its outcome.' },
      });
    }
    return this.detail(this.db, organizationId, id);
  }

  async get(principal: Principal, id: string): Promise<AssistantRequest> {
    assertEnabled(this.settings);
    const organizationId = organizationOf(principal);
    const row = await this.load(this.db, organizationId, id);
    if (!row) throw errors.protectedNotFound('assistant request');
    await this.authorization.require(principal, AutomationActions.readRequest, {
      type: 'assistant_request',
      id,
      organizationId,
      subjectPersonIds: [row.requester_person_id],
      protected: true,
    });
    return this.detail(this.db, organizationId, id);
  }

  // -------------------------------------------------------------------------------------------
  // Stalled requests (AUT-03; §4.12 durable, interruption-tolerant background work)
  // -------------------------------------------------------------------------------------------

  /**
   * Periodic job `automation.fail_stalled_requests` (failure owner: system administrator). A
   * request is answered synchronously; if the process serving it stopped, the request stays
   * `processing` with a running operation. Each request still `processing`
   * `AUTOMATION_REQUEST_STALL_SECONDS` after it was received fails with its operation, in its own
   * transaction, under `systemPrincipal(organization, job)`, with audit and the completion event.
   * Nothing was proposed (recommendations are recorded only with an answer), so nothing else
   * changes. Idempotent: a request already final, or locked by the process completing it, is
   * skipped. Runs whatever the deployment flag and the capability say: it only ends this module's
   * own records.
   */
  async failStalled(context: PeriodicJobContext): Promise<PeriodicJobResult> {
    const stallSeconds = this.settings.requestStallSeconds;
    const cutoff = new Date(context.now.getTime() - stallSeconds * 1000);
    const due = await this.db
      .selectFrom('assistant_requests')
      .select(['organization_id', 'id'])
      .where('status', '=', 'processing')
      .where('received_at', '<=', cutoff)
      .orderBy('received_at')
      .orderBy('id')
      .limit(context.batchSize + 1)
      .execute();
    const batch = due.slice(0, context.batchSize);
    let processed = 0;
    for (const request of batch) {
      const failed = await this.uow.run(({ trx }) =>
        this.failOneStalled(trx, request.organization_id, request.id, cutoff, stallSeconds),
      );
      if (failed) processed += 1;
    }
    return { processed, remaining: due.length - batch.length };
  }

  private async failOneStalled(
    trx: Trx,
    organizationId: string,
    id: string,
    cutoff: Date,
    stallSeconds: number,
  ): Promise<boolean> {
    const row = await trx
      .selectFrom('assistant_requests')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .where('status', '=', 'processing')
      .where('received_at', '<=', cutoff)
      .forUpdate()
      .skipLocked()
      .executeTakeFirst();
    if (!row) return false;
    const actor = systemPrincipal(organizationId, FAIL_STALLED_REQUESTS_JOB);
    const status = AssistantRequestMachine.next(row.status, 'fail') as 'failed';
    const error = {
      code: 'REQUEST_STALLED',
      message: 'The assistant did not finish this request. Ask again.',
      details: { stalledAfterSeconds: stallSeconds },
    };
    const now = this.clock.now();
    await trx
      .updateTable('assistant_requests')
      .set({
        status,
        error: json(error),
        completed_at: now,
        revision: row.revision + 1,
      })
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .where('revision', '=', row.revision)
      .executeTakeFirstOrThrow();
    await this.operations.transition(trx, row.operation_id, 'failed', { error });
    const invocations = await trx
      .selectFrom('tool_invocations')
      .select('outcome')
      .where('organization_id', '=', organizationId)
      .where('assistant_request_id', '=', id)
      .where('phase', '=', 'assist')
      .execute();
    const denied = invocations.filter((i) => i.outcome === 'denied').length;
    await this.audit.record(trx, {
      organizationId,
      actor,
      action: 'automation.assistant_request_stalled',
      targetType: 'assistant_request',
      targetId: id,
      beforeRevision: row.revision,
      afterRevision: row.revision + 1,
      operationId: row.operation_id,
      details: {
        status,
        errorCode: error.code,
        receivedAt: iso(row.received_at),
        stalledAfterSeconds: stallSeconds,
        toolInvocations: invocations.length,
      },
    });
    await this.outbox.enqueue(trx, AssistantRequestCompleted, {
      organizationId,
      aggregateType: 'assistant_request',
      aggregateId: id,
      payload: {
        assistantRequestId: id,
        status,
        toolInvocations: invocations.length,
        deniedToolInvocations: denied,
        recommendationIds: [],
      },
      operationId: row.operation_id,
    });
    return true;
  }

  private async complete(
    principal: Principal,
    id: string,
    operationId: string,
    correlationId: string | null,
    result: EngineResult,
  ): Promise<void> {
    const organizationId = organizationOf(principal);
    await this.uow.run(async ({ trx }) => {
      const row = await this.load(trx, organizationId, id, true);
      if (!row) throw errors.internal('assistant request vanished');
      if (row.status !== 'processing') {
        // AUT-03: `automation.fail_stalled_requests` already ended it (this process outlived the
        // stall window); its outcome stands and nothing is proposed after the fact.
        this.logger.warn(`assistant request ${id} was already ${row.status}; outcome not recorded`);
        return;
      }
      const status = AssistantRequestMachine.next(
        row.status,
        result.status === 'answered' ? 'answer' : 'fail',
      ) as 'answered' | 'failed';
      const items: NewRecommendation[] =
        result.status === 'answered'
          ? [
              ...result.commands.map((c) => ({
                kind: c.proposal.kind,
                title: c.proposal.title,
                summary: c.proposal.summary,
                facilityId: c.proposal.facilityId,
                payload: c.proposal.payload,
                command: c.proposal.command,
                evidence: c.evidence,
                missing: c.proposal.missing,
              })),
              ...result.informational.map((i) => ({
                kind: i.proposal.kind,
                title: i.proposal.title,
                summary: i.proposal.summary,
                facilityId: row.facility_id,
                payload: i.proposal.payload,
                command: null,
                evidence: i.evidence,
                missing: result.missing,
              })),
            ]
          : [];
      const recommendationIds = await this.recommendations.createInTrx(trx, row, items, {
        correlationId,
        operationId,
      });
      await trx
        .updateTable('assistant_requests')
        .set({
          status,
          turns: result.turns,
          response_text: result.text,
          evidence: json(result.evidence),
          missing_evidence: json(result.missing),
          error: result.error ? json(result.error) : null,
          completed_at: this.clock.now(),
          revision: row.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', row.revision)
        .executeTakeFirstOrThrow();
      await this.operations.transition(
        trx,
        operationId,
        status === 'answered' ? 'succeeded' : 'failed',
        status === 'answered'
          ? { result: { assistantRequestId: id, recommendationIds } }
          : { error: result.error ?? { code: 'FAILED', message: 'The request failed.' } },
      );
      const denied = result.executions.filter((e) => e.outcome === 'denied').length;
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'automation.assistant_request_completed',
        targetType: 'assistant_request',
        targetId: id,
        beforeRevision: row.revision,
        afterRevision: row.revision + 1,
        correlationId,
        operationId,
        details: {
          status,
          turns: result.turns,
          toolInvocations: result.executions.length,
          deniedToolInvocations: denied,
          recommendationIds,
          missingEvidence: result.missing.length,
          errorCode: result.error?.code ?? null,
        },
      });
      await this.outbox.enqueue(trx, AssistantRequestCompleted, {
        organizationId,
        aggregateType: 'assistant_request',
        aggregateId: id,
        payload: {
          assistantRequestId: id,
          status,
          toolInvocations: result.executions.length,
          deniedToolInvocations: denied,
          recommendationIds,
        },
        correlationId,
        operationId,
      });
    });
  }

  private async load(
    reader: Reader,
    organizationId: string,
    id: string,
    forUpdate = false,
  ): Promise<AssistantRequestRow | undefined> {
    let q = reader
      .selectFrom('assistant_requests')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id);
    if (forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  private async detail(
    reader: Reader,
    organizationId: string,
    id: string,
  ): Promise<AssistantRequest> {
    const row = await this.load(reader, organizationId, id);
    if (!row) throw errors.protectedNotFound('assistant request');
    const [recommendations, invocations] = await Promise.all([
      this.recommendations.rowsForRequest(reader, organizationId, id),
      reader
        .selectFrom('tool_invocations')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('assistant_request_id', '=', id)
        .orderBy('sequence')
        .execute(),
    ]);
    const stored = (row.context_references ?? []) as unknown as StoredContextReference[];
    // Context references are resolved first, in order: invocation n resolves reference n.
    const contextReferences: AssistantContextReference[] = stored.map((ref, index) => {
      const invocation = invocations.find((i) => i.phase === 'assist' && i.sequence === index + 1);
      return {
        type: ref.type,
        id: ref.id,
        observedAt: ref.observedAt,
        resolved: invocation?.outcome === 'succeeded',
      };
    });
    const attachments: AssistantAttachment[] = (
      (row.attachments ?? []) as unknown as StoredAttachment[]
    ).map((a) => ({
      name: a.name,
      kind: a.kind,
      length: a.length,
      sha256: a.sha256,
      treatedAs: 'data',
    }));
    return {
      id: row.id,
      status: row.status,
      prompt: row.prompt,
      facilityId: row.facility_id,
      requester: actorOf(row.requester),
      attachments,
      contextReferences,
      provider: row.provider,
      turns: row.turns,
      response: row.response_text ? { text: row.response_text } : null,
      evidence: (row.evidence ?? []) as unknown as AssistantEvidence[],
      missingEvidence: (row.missing_evidence ?? []) as unknown as AssistantMissingEvidence[],
      // SPK-AUTO-002: a recommendation's evidence carries its freshness at this read.
      recommendations: await this.recommendations.present(reader, recommendations),
      toolInvocations: invocations.map(toToolInvocation),
      error: row.error ?? null,
      operationId: row.operation_id,
      receivedAt: iso(row.received_at),
      completedAt: isoOrNull(row.completed_at),
      revision: row.revision,
    };
  }
}
