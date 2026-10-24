import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DomainError,
  newId,
  z,
  type AssistantEvidence,
  type AssistantMissingEvidence,
  type Principal,
  type ToolOutcomeValue,
} from '@sportspark/contracts';
import { json } from '@sportspark/db';
import {
  AuditWriter,
  CLOCK,
  Outbox,
  UnitOfWork,
  snapshotActor,
  type Clock,
  type Trx,
} from '../../../kernel';
import { ToolInvocationDenied } from '../automation.events';
import { AUTOMATION_SETTINGS, type AutomationSettings } from '../automation.settings';
import { DENIAL_CODES } from '../automation.shared';
import { evidenceItem, missingEvidence, notAvailableDescription } from '../evidence';
import type { AssistantToolCall, AssistantToolResult } from '../ports/assistant-provider.port';
import { ToolRegistry } from '../tools/tool-registry';
import type { CommandProposal } from '../tools/tool.types';

export interface ToolRunContext {
  assistantRequestId: string;
  organizationId: string;
  operationId: string;
  correlationId: string | null;
  /** For a context reference: when the client last observed the record. */
  clientObservedAt?: Date | null;
}

export interface ToolExecution {
  invocationId: string;
  sequence: number;
  tool: string;
  outcome: ToolOutcomeValue;
  errorCode: string | null;
  result: AssistantToolResult;
  evidence: AssistantEvidence[];
  missing: AssistantMissingEvidence[];
  proposal: CommandProposal | null;
}

export interface ApplyInvocation {
  organizationId: string;
  assistantRequestId: string;
  recommendationId: string;
  tool: string;
  actionId: string;
  reviewer: Principal;
  arguments: Record<string, unknown>;
  outcome: Extract<ToolOutcomeValue, 'succeeded' | 'denied' | 'failed' | 'unknown'>;
  errorCode: string | null;
  errorMessage: string | null;
  resultRefs: Array<{ type: string; id: string }>;
  correlationId: string | null;
  operationId: string;
}

const Rationale = z.string().trim().min(1).max(2000);
const MAX_STORED_ARGUMENT_CHARS = 20_000;
const NOT_AVAILABLE = 'This information is not available to you.';

/** Argument names that identify the record a call targets (for the missing-evidence entry). */
const TARGET_KEYS: ReadonlyArray<[string, string]> = [
  ['personId', 'person'],
  ['paymentAttemptId', 'payment_attempt'],
  ['fixtureId', 'fixture'],
  ['draftId', 'schedule_draft'],
  ['facilityId', 'facility'],
];

function targetOf(
  tool: string,
  args: Record<string, unknown>,
): { type: string; id: string | null } {
  for (const [key, type] of TARGET_KEYS) {
    const value = args[key];
    if (typeof value === 'string' && value.length > 0) return { type, id: value };
  }
  return { type: tool.split('.')[1] ?? 'record', id: null };
}

function storedArguments(args: Record<string, unknown>): Record<string, unknown> {
  const text = JSON.stringify(args);
  return text.length <= MAX_STORED_ARGUMENT_CHARS
    ? args
    : { truncated: true, length: text.length, keys: Object.keys(args).slice(0, 50) };
}

/**
 * Executes the module tools the provider asks for (SPK-AUTO-004). Each call runs with the
 * REQUESTER'S principal through the owning module's exported service, so it is authorized exactly
 * like the same call made directly; the provider's arguments are data, never authority. Every call
 * is logged append-only with the principal and outcome (`tool_invocations`); a denial is also an
 * audit record and an outbox event (SPK-AT-026). Calls run outside any automation transaction (the
 * owning modules open their own); only the log is written in a short transaction of its own.
 */
@Injectable()
export class ToolRunner {
  private readonly logger = new Logger(ToolRunner.name);

  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUTOMATION_SETTINGS) private readonly settings: AutomationSettings,
    private readonly uow: UnitOfWork,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly registry: ToolRegistry,
  ) {}

  async run(
    principal: Principal,
    ctx: ToolRunContext,
    sequence: number,
    call: AssistantToolCall,
  ): Promise<ToolExecution> {
    const observedAt = this.clock.now();
    const tool = this.registry.get(call.tool);
    const { rationale: rawRationale, ...args } = call.arguments;
    const rationale = Rationale.safeParse(rawRationale);
    let outcome: ToolOutcomeValue = 'succeeded';
    let errorCode: string | null = null;
    let message: string | null = null;
    let output: unknown = null;
    let proposal: CommandProposal | null = null;
    const missing: AssistantMissingEvidence[] = [];
    let drafts: CommandProposal['evidence'] = [];

    if (!tool) {
      outcome = 'unsupported';
      errorCode = 'UNSUPPORTED_TOOL';
      message =
        'The assistant cannot use this. Changes such as rosters, permissions and discipline are made by a person through the owning module.';
      missing.push(
        missingEvidence(
          'tool',
          null,
          null,
          'unsupported_request',
          `“${call.tool.slice(0, 100)}” is not a tool the assistant may use.`,
        ),
      );
    } else {
      const parsed = tool.argsSchema.safeParse(args);
      if (!parsed.success) {
        outcome = 'invalid';
        errorCode = 'VALIDATION_FAILED';
        message = `The arguments are invalid (${parsed.error.issues
          .map((i) => i.path.join('.') || '(root)')
          .slice(0, 10)
          .join(', ')}).`;
        missing.push(
          missingEvidence(
            targetOf(tool.name, args).type,
            null,
            tool.name,
            'invalid_request',
            message,
          ),
        );
      } else {
        try {
          if (tool.kind === 'query') {
            const result = await tool.run(principal, parsed.data);
            output = result.output;
            drafts = result.evidence;
            missing.push(...result.missing);
          } else {
            proposal = await tool.propose(
              principal,
              parsed.data,
              rationale.success ? rationale.data : null,
            );
            drafts = proposal.evidence;
            missing.push(...proposal.missing);
            output = {
              status: 'proposed_for_review',
              kind: proposal.kind,
              title: proposal.title,
              note: 'Nothing was executed. A person must approve this recommendation and apply it with their own permissions.',
            };
          }
        } catch (error) {
          const target = targetOf(tool.name, args);
          if (DomainError.is(error) && DENIAL_CODES.has(error.code)) {
            outcome = 'denied';
            errorCode = error.code;
            message = NOT_AVAILABLE;
            missing.push(
              missingEvidence(
                target.type,
                target.id,
                tool.name,
                'not_available',
                notAvailableDescription(target.type),
              ),
            );
          } else {
            outcome = 'failed';
            errorCode = DomainError.is(error) ? error.code : 'INTERNAL_ERROR';
            message = DomainError.is(error) ? error.message : 'The module could not answer.';
            if (!DomainError.is(error)) {
              this.logger.error(`tool ${tool.name} failed: ${String(error)}`);
            }
            missing.push(
              missingEvidence(
                target.type,
                target.id,
                tool.name,
                'source_unavailable',
                `The ${tool.name} call did not succeed (${errorCode}); its information is not included.`,
              ),
            );
          }
        }
      }
    }

    const evidence = drafts.map((d) =>
      evidenceItem(
        call.tool,
        d,
        observedAt,
        this.settings.evidenceMaxAgeMinutes,
        ctx.clientObservedAt ?? null,
      ),
    );
    const invocationId = newId();
    await this.uow.run(async ({ trx }) => {
      await trx
        .insertInto('tool_invocations')
        .values({
          id: invocationId,
          organization_id: ctx.organizationId,
          assistant_request_id: ctx.assistantRequestId,
          recommendation_id: null,
          sequence,
          phase: 'assist',
          tool: call.tool.slice(0, 100),
          action_id: tool ? tool.actionId : null,
          tool_kind: tool ? tool.kind : 'unknown',
          principal: json(snapshotActor(principal)),
          principal_account_id: principal.accountId as string,
          principal_person_id: principal.personId as string,
          arguments: json(storedArguments(call.arguments)),
          outcome,
          error_code: errorCode,
          error_message: outcome === 'succeeded' ? null : (message ?? errorCode),
          result_refs: json(
            evidence.slice(0, 50).map((e) => ({ type: e.recordType, id: e.recordId })),
          ),
          occurred_at: observedAt,
          correlation_id: ctx.correlationId,
          operation_id: ctx.operationId,
        })
        .execute();
      if (outcome === 'denied') {
        await this.recordDenial(trx, {
          organizationId: ctx.organizationId,
          principal,
          assistantRequestId: ctx.assistantRequestId,
          invocationId,
          tool: call.tool,
          actionId: tool?.actionId ?? null,
          errorCode: errorCode ?? 'ACCESS_DENIED',
          phase: 'assist',
          correlationId: ctx.correlationId,
          operationId: ctx.operationId,
        });
      }
    });

    return {
      invocationId,
      sequence,
      tool: call.tool,
      outcome,
      errorCode,
      result: {
        sequence,
        tool: call.tool,
        arguments: call.arguments,
        outcome,
        output: outcome === 'succeeded' ? output : null,
        message,
      },
      evidence,
      missing,
      proposal,
    };
  }

  /** Logs a reviewer's apply of a recommendation (phase `apply`) inside the caller's transaction. */
  async recordApply(trx: Trx, input: ApplyInvocation): Promise<string> {
    // Applies of several recommendations of one request serialize on the request row, so their
    // log sequence numbers never collide (the request itself is final and is not changed).
    await trx
      .selectFrom('assistant_requests')
      .select('id')
      .where('organization_id', '=', input.organizationId)
      .where('id', '=', input.assistantRequestId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const last = await trx
      .selectFrom('tool_invocations')
      .select((eb) => eb.fn.max('sequence').as('n'))
      .where('organization_id', '=', input.organizationId)
      .where('assistant_request_id', '=', input.assistantRequestId)
      .executeTakeFirst();
    const id = newId();
    await trx
      .insertInto('tool_invocations')
      .values({
        id,
        organization_id: input.organizationId,
        assistant_request_id: input.assistantRequestId,
        recommendation_id: input.recommendationId,
        sequence: Number(last?.n ?? 0) + 1,
        phase: 'apply',
        tool: input.tool,
        action_id: input.actionId,
        tool_kind: 'command',
        principal: json(snapshotActor(input.reviewer)),
        principal_account_id: input.reviewer.accountId as string,
        principal_person_id: input.reviewer.personId as string,
        arguments: json(storedArguments(input.arguments)),
        outcome: input.outcome,
        error_code: input.errorCode,
        error_message: input.errorMessage,
        result_refs: json(input.resultRefs),
        occurred_at: this.clock.now(),
        correlation_id: input.correlationId,
        operation_id: input.operationId,
      })
      .execute();
    if (input.outcome === 'denied') {
      await this.recordDenial(trx, {
        organizationId: input.organizationId,
        principal: input.reviewer,
        assistantRequestId: input.assistantRequestId,
        invocationId: id,
        tool: input.tool,
        actionId: input.actionId,
        errorCode: input.errorCode ?? 'ACCESS_DENIED',
        phase: 'apply',
        correlationId: input.correlationId,
        operationId: input.operationId,
      });
    }
    return id;
  }

  private async recordDenial(
    trx: Trx,
    input: {
      organizationId: string;
      principal: Principal;
      assistantRequestId: string;
      invocationId: string;
      tool: string;
      actionId: string | null;
      errorCode: string;
      phase: 'assist' | 'apply';
      correlationId: string | null;
      operationId: string;
    },
  ): Promise<void> {
    await this.audit.record(trx, {
      organizationId: input.organizationId,
      actor: input.principal,
      action: 'automation.tool_invocation_denied',
      targetType: 'assistant_request',
      targetId: input.assistantRequestId,
      correlationId: input.correlationId,
      operationId: input.operationId,
      details: {
        toolInvocationId: input.invocationId,
        tool: input.tool.slice(0, 100),
        actionId: input.actionId,
        errorCode: input.errorCode,
        phase: input.phase,
        proposedBy: input.phase === 'assist' ? 'assistant' : 'reviewer',
      },
    });
    await this.outbox.enqueue(trx, ToolInvocationDenied, {
      organizationId: input.organizationId,
      aggregateType: 'assistant_request',
      aggregateId: input.assistantRequestId,
      payload: {
        assistantRequestId: input.assistantRequestId,
        toolInvocationId: input.invocationId,
        tool: input.tool.slice(0, 100),
        actionId: input.actionId,
        errorCode: input.errorCode,
        phase: input.phase,
      },
      correlationId: input.correlationId,
      operationId: input.operationId,
    });
  }
}
