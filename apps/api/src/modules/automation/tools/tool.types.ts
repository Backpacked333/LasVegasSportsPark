import type {
  ActionId,
  AssistantMissingEvidence,
  ContextReferenceType,
  Principal,
  RecommendationCommand,
  z,
} from '@sportspark/contracts';
import type { EvidenceDraft } from '../evidence';

/**
 * Module tools the assistant may use (SPK-AUTO-001). Each wraps one exported service of the owning
 * module and is run with the principal of the person concerned — the requester while answering,
 * the reviewer while applying — so the owning module's authorization decides exactly as for a
 * direct call (SPK-AUTO-004). A tool never reads another module's tables.
 */
export interface QueryResult {
  /** What the owning module returned to this principal; shown to the provider. */
  output: unknown;
  evidence: EvidenceDraft[];
  missing: AssistantMissingEvidence[];
}

export interface QueryTool<A = unknown> {
  kind: 'query';
  name: string;
  /** The owning module's action that governs the read (for the log and the catalogue). */
  actionId: ActionId;
  description: string;
  argumentsDoc: Readonly<Record<string, string>>;
  argsSchema: z.ZodType<A>;
  /** Context references of this type are resolved through this tool. */
  contextType?: ContextReferenceType;
  contextArgs?: (id: string) => Record<string, unknown>;
  run(principal: Principal, args: A): Promise<QueryResult>;
}

export type CommandRecommendationKind =
  'schedule_repair' | 'communication_draft' | 'financial_exception_explanation';

/** What a proposed command becomes: a reviewable recommendation; nothing is executed. */
export interface CommandProposal {
  kind: CommandRecommendationKind;
  title: string;
  summary: string;
  facilityId: string | null;
  payload: Record<string, unknown>;
  command: RecommendationCommand;
  evidence: EvidenceDraft[];
  missing: AssistantMissingEvidence[];
}

export interface ApplyContext {
  correlationId: string | null;
  /** The reviewer's reason and policy references, passed to the owning module's command. */
  reason: string | null;
  policyReferences: readonly string[];
  /** When the apply started (bounds the search for effects of a failed command). */
  startedAt: Date;
  /**
   * What an earlier failed apply of the same recommendation left behind (`ApplyFailure.carried`,
   * e.g. the draft a repair opened), so a retry continues from it instead of repeating that step
   * (§4.11: follow-up work is neither lost nor duplicated). Null on a first apply.
   */
  carried: Readonly<Record<string, unknown>> | null;
}

/**
 * Thrown by a command tool's `apply` when the owning module's error — or its normal return — does
 * not tell the whole story (SPK-AUTO-003, §4.11): the outcome is already known (`failed`: nothing
 * took effect; `unknown`: it may have), the record the owning module made for it, and what a
 * retry must continue from. `error` is what the reviewer is told.
 */
export class ApplyFailure extends Error {
  constructor(
    readonly error: unknown,
    readonly options: {
      outcome?: 'failed' | 'unknown';
      record?: { type: string; id: string };
      carried?: Record<string, unknown>;
    } = {},
  ) {
    super(error instanceof Error ? error.message : String(error));
    this.name = 'ApplyFailure';
  }
}

export interface AppliedCommand {
  commandOperationId: string | null;
  record: { type: string; id: string };
  result: Record<string, unknown>;
}

export interface CommandTool<A = unknown> {
  kind: 'command';
  name: string;
  actionId: RecommendationCommand['actionId'];
  description: string;
  argumentsDoc: Readonly<Record<string, string>>;
  argsSchema: z.ZodType<A>;
  /**
   * Authorizes the proposal exactly like a direct call: reads the target through the owning
   * module with the requester's principal and checks the command's own action on the real target.
   * Throws the owning module's error when the requester could not run the command themselves.
   */
  propose(principal: Principal, args: A, rationale: string | null): Promise<CommandProposal>;
  /** Runs the owning module's normal command with the reviewer's principal (outside transactions). */
  apply(
    reviewer: Principal,
    input: Record<string, unknown>,
    ctx: ApplyContext,
  ): Promise<AppliedCommand>;
  /**
   * After the command raised a domain error: whether the owning module nevertheless recorded an
   * effect of this apply (then the outcome is unknown, never failed).
   */
  effectRecordedDespiteError?(
    reviewer: Principal,
    input: Record<string, unknown>,
    ctx: ApplyContext,
  ): Promise<boolean>;
}

/** A tool whose argument type is checked by its own schema at run time. */
export type AnyQueryTool = QueryTool<unknown>;
export type AnyCommandTool = CommandTool<unknown>;
export type AnyTool = AnyQueryTool | AnyCommandTool;

/** Erases the argument type: the registry parses arguments with `argsSchema` before running. */
export function queryTool<A>(tool: QueryTool<A>): AnyQueryTool {
  return {
    ...tool,
    argsSchema: tool.argsSchema as z.ZodType<unknown>,
    run: (principal, args) => tool.run(principal, args as A),
  };
}

export function commandTool<A>(tool: CommandTool<A>): AnyCommandTool {
  return {
    ...tool,
    argsSchema: tool.argsSchema as z.ZodType<unknown>,
    propose: (principal, args, rationale) => tool.propose(principal, args as A, rationale),
  };
}
