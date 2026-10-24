import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  AssistantContextReferenceInput,
  AssistantEvidence,
  AssistantMissingEvidence,
  Principal,
  StaffRole,
} from '@sportspark/contracts';
import { AUTOMATION_SETTINGS, type AutomationSettings } from '../automation.settings';
import { mergeEvidence, mergeMissing, missingEvidence } from '../evidence';
import {
  ASSISTANT_PROVIDER_PORT,
  AssistantProviderError,
  AssistantTurnOutputSchema,
  type AssistantAttachmentData,
  type AssistantProviderPort,
  type AssistantToolResult,
  type InformationalProposal,
  type ParsedAssistantTurnOutput,
} from '../ports/assistant-provider.port';
import { ToolRegistry } from '../tools/tool-registry';
import type { CommandProposal } from '../tools/tool.types';
import { ToolRunner, type ToolExecution } from './tool-runner.service';

export interface EngineInput {
  assistantRequestId: string;
  organizationId: string;
  operationId: string;
  correlationId: string | null;
  prompt: string;
  attachments: AssistantAttachmentData[];
  context: AssistantContextReferenceInput[];
}

export interface ProposedCommand {
  proposal: CommandProposal;
  evidence: AssistantEvidence[];
  invocationId: string;
}

export interface EngineResult {
  status: 'answered' | 'failed';
  text: string | null;
  error: { code: string; message: string } | null;
  turns: number;
  evidence: AssistantEvidence[];
  missing: AssistantMissingEvidence[];
  commands: ProposedCommand[];
  informational: Array<{ proposal: InformationalProposal; evidence: AssistantEvidence[] }>;
  executions: ToolExecution[];
}

/**
 * The assistant loop (SPK-AUTO-001, SPK-AUTO-002, SPK-AUTO-004). Context references are re-read
 * first through the owning modules with the requester's principal; then the provider is asked in
 * turns, outside any transaction (§4.11), and every tool call it asks for is executed by
 * `ToolRunner` under the same principal. Attachments reach the provider marked as data; nothing
 * the provider says can widen what the requester may see or do. The answer carries every
 * supporting record with its freshness and every piece of missing evidence.
 */
@Injectable()
export class AssistantEngine {
  private readonly logger = new Logger(AssistantEngine.name);

  constructor(
    @Inject(ASSISTANT_PROVIDER_PORT) private readonly provider: AssistantProviderPort,
    @Inject(AUTOMATION_SETTINGS) private readonly settings: AutomationSettings,
    private readonly registry: ToolRegistry,
    private readonly runner: ToolRunner,
  ) {}

  get providerName(): string {
    return this.provider.name;
  }

  async run(principal: Principal, input: EngineInput): Promise<EngineResult> {
    const executions: ToolExecution[] = [];
    const results: AssistantToolResult[] = [];
    const extraMissing: AssistantMissingEvidence[] = [];
    let sequence = 0;
    const ctx = {
      assistantRequestId: input.assistantRequestId,
      organizationId: input.organizationId,
      operationId: input.operationId,
      correlationId: input.correlationId,
    };
    const execute = async (
      call: { tool: string; arguments: Record<string, unknown> },
      clientObservedAt: Date | null = null,
    ): Promise<void> => {
      sequence += 1;
      const execution = await this.runner.run(
        principal,
        { ...ctx, clientObservedAt },
        sequence,
        call,
      );
      executions.push(execution);
      results.push(execution.result);
    };

    // 1. Context references: re-read now, with the requester's principal (SPK-AUTO-002 freshness).
    for (const ref of input.context) {
      const tool = this.registry.forContext(ref.type);
      await execute(
        {
          tool: tool.name,
          arguments: tool.contextArgs ? tool.contextArgs(ref.id) : { id: ref.id },
        },
        ref.observedAt ? new Date(ref.observedAt) : null,
      );
    }

    // 2. Provider turns.
    const tools = this.registry.specs();
    const caller = {
      kind: principal.kind === 'staff' ? ('staff' as const) : ('customer' as const),
      staffRoles: [...principal.staffRoles] as StaffRole[],
    };
    let toolCalls = 0;
    for (let turn = 1; turn <= this.settings.maxTurns; turn += 1) {
      let raw: unknown;
      try {
        raw = await this.provider.respond({
          assistantRequestId: input.assistantRequestId,
          turn,
          prompt: input.prompt,
          attachments: input.attachments,
          caller,
          tools,
          toolResults: [...results],
          limits: {
            remainingTurns: this.settings.maxTurns - turn,
            remainingToolCalls: Math.max(0, this.settings.maxToolCalls - toolCalls),
          },
        });
      } catch (error) {
        if (!(error instanceof AssistantProviderError)) throw error;
        return this.finish('failed', turn, executions, extraMissing, {
          code: error.mode === 'timeout' ? 'PROVIDER_TIMEOUT' : 'PROVIDER_FAILED',
          message: error.message,
        });
      }
      const parsed = AssistantTurnOutputSchema.safeParse(raw);
      if (!parsed.success) {
        return this.finish('failed', turn, executions, extraMissing, {
          code: 'PROVIDER_INVALID_OUTPUT',
          message: 'The assistant provider returned an answer in an unexpected form.',
        });
      }
      const output: ParsedAssistantTurnOutput = parsed.data;
      if (output.type === 'answer') {
        return this.finish('answered', turn, executions, extraMissing, null, output);
      }
      for (const call of output.calls) {
        if (toolCalls >= this.settings.maxToolCalls) {
          extraMissing.push(
            missingEvidence(
              'tool_call',
              null,
              null,
              'limit_reached',
              `The assistant reached its limit of ${this.settings.maxToolCalls} module calls; “${call.tool.slice(0, 100)}” was not made.`,
            ),
          );
          continue;
        }
        toolCalls += 1;
        await execute(call);
      }
    }
    return this.finish('failed', this.settings.maxTurns, executions, extraMissing, {
      code: 'TURN_LIMIT_REACHED',
      message: `The assistant did not answer within ${this.settings.maxTurns} turns.`,
    });
  }

  private finish(
    status: 'answered' | 'failed',
    turns: number,
    executions: ToolExecution[],
    extraMissing: AssistantMissingEvidence[],
    error: { code: string; message: string } | null,
    answer?: Extract<ParsedAssistantTurnOutput, { type: 'answer' }>,
  ): EngineResult {
    const evidence = mergeEvidence(executions.flatMap((e) => e.evidence));
    const missing = mergeMissing([...executions.flatMap((e) => e.missing), ...extraMissing]);
    if (status === 'failed') {
      this.logger.warn(`assistant request failed: ${error?.code ?? 'unknown'}`);
    }
    const commands =
      status === 'answered'
        ? executions
            .filter((e) => e.outcome === 'succeeded' && e.proposal)
            .map((e) => ({
              proposal: e.proposal as CommandProposal,
              evidence: e.evidence,
              invocationId: e.invocationId,
            }))
        : [];
    const informational = (answer?.recommendations ?? []).map((proposal) => ({
      proposal,
      evidence: proposal.evidenceRecordIds
        ? evidence.filter((e) => proposal.evidenceRecordIds?.includes(e.recordId))
        : evidence,
    }));
    return {
      status,
      text: answer?.text ?? null,
      error,
      turns,
      evidence,
      missing,
      commands,
      informational,
      executions,
    };
  }
}
