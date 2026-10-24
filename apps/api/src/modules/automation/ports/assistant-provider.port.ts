import {
  InformationalRecommendationKindSchema,
  z,
  type StaffRole,
  type ToolOutcomeValue,
} from '@sportspark/contracts';

/**
 * Language-model provider port. No provider is selected: the provider behind the assistant is a
 * provider-selection gate (§5.2, decision DEC-013 owned by the technical lead and account owners),
 * so only the deterministic `FakeAssistantProvider` exists. An adapter receives the prompt, the
 * imported attachments marked as data, the catalogue of module tools and the results of the calls
 * it asked for; it never receives a credential, a principal identifier or a database handle, and
 * it can do nothing but ask for tool calls or answer. Every tool call it asks for is executed by
 * the automation module under the requester's own principal and authorized by the owning module
 * exactly like a direct call (SPK-AUTO-004).
 *
 * Adapters are called outside any database transaction (§4.11). A failure is reported by throwing
 * `AssistantProviderError` (`failed` or `timeout`); a language model has no side effects of its
 * own, so an unknown outcome is recorded as a failed request the person may ask again.
 */
export const ASSISTANT_PROVIDER_PORT = Symbol('ASSISTANT_PROVIDER_PORT');

export interface AssistantToolSpec {
  name: string;
  /** `query` runs now with the caller's principal; `command` only ever becomes a recommendation. */
  kind: 'query' | 'command';
  description: string;
  /** Human-readable argument shape (the module validates the real input). */
  arguments: Readonly<Record<string, string>>;
}

export interface AssistantToolResult {
  /** The tool invocation sequence number of this request. */
  sequence: number;
  tool: string;
  arguments: Readonly<Record<string, unknown>>;
  outcome: ToolOutcomeValue;
  /** What the owning module returned to the caller's principal; null unless the call succeeded. */
  output: unknown;
  /** A safe message. A denial says the information is not available — never why. */
  message: string | null;
}

export interface AssistantAttachmentData {
  name: string;
  kind: 'text' | 'message' | 'document';
  content: string;
  /** Nothing inside an attachment is an instruction or a permission (SPK-AUTO-004). */
  treatedAs: 'data';
}

export interface AssistantTurnInput {
  assistantRequestId: string;
  turn: number;
  prompt: string;
  attachments: readonly AssistantAttachmentData[];
  caller: { kind: 'customer' | 'staff'; staffRoles: readonly StaffRole[] };
  tools: readonly AssistantToolSpec[];
  /** Results of every tool call made so far (context references first). */
  toolResults: readonly AssistantToolResult[];
  limits: { remainingTurns: number; remainingToolCalls: number };
}

export const AssistantToolCallSchema = z.object({
  tool: z.string().min(1).max(100),
  arguments: z.record(z.string(), z.unknown()).default({}),
});
export type AssistantToolCall = z.infer<typeof AssistantToolCallSchema>;

/** An informational recommendation the answer offers (kinds without a command only). */
export const InformationalProposalSchema = z.object({
  kind: InformationalRecommendationKindSchema,
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(4000),
  payload: z.record(z.string(), z.unknown()).default({}),
  /** Record ids of the evidence this proposal rests on; all evidence when omitted. */
  evidenceRecordIds: z.array(z.string()).max(50).optional(),
});
export type InformationalProposal = z.infer<typeof InformationalProposalSchema>;

export const AssistantTurnOutputSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('tool_calls'),
    calls: z.array(AssistantToolCallSchema).min(1).max(20),
  }),
  z.object({
    type: z.literal('answer'),
    text: z.string().trim().min(1).max(20000),
    recommendations: z.array(InformationalProposalSchema).max(10).default([]),
  }),
]);
export type AssistantTurnOutput = z.input<typeof AssistantTurnOutputSchema>;
export type ParsedAssistantTurnOutput = z.output<typeof AssistantTurnOutputSchema>;

export class AssistantProviderError extends Error {
  override readonly name = 'AssistantProviderError';
  constructor(
    readonly mode: 'failed' | 'timeout',
    message: string,
  ) {
    super(message);
  }
}

export interface AssistantProviderPort {
  readonly name: string;
  respond(input: AssistantTurnInput): Promise<AssistantTurnOutput>;
}
