import { Injectable } from '@nestjs/common';
import {
  AssistantProviderError,
  type AssistantProviderPort,
  type AssistantTurnInput,
  type AssistantTurnOutput,
} from '../ports/assistant-provider.port';

export interface FakeFailure {
  type: 'fail';
  mode: 'failed' | 'timeout';
}

/** One scripted turn: a fixed output, a failure, or a function of what the provider received. */
export type FakeAssistantStep =
  | AssistantTurnOutput
  | FakeFailure
  | ((input: AssistantTurnInput) => AssistantTurnOutput | FakeFailure);

interface Script {
  match: (input: AssistantTurnInput) => boolean;
  steps: FakeAssistantStep[];
}

export const FAKE_ASSISTANT_PROVIDER_NAME = 'fake-assistant';

/**
 * The §5.2 scenarios the fake reproduces deterministically (AUT-01, integration register):
 * `success` (scripted tool calls and answers), `failure` (`{ type: 'fail', mode: 'failed' }`) and
 * `timeout_unknown` (`mode: 'timeout'`; a language model has no side effects, so an unknown
 * outcome is recorded as a failed request the person may ask again). `duplicate` is not listed:
 * the provider has no callback or webhook to deliver twice and the module never re-sends a turn;
 * a replayed request is answered from its idempotency record without a provider call
 * (`assistant.spec.ts`).
 */
export const FAKE_ASSISTANT_SCENARIOS = ['success', 'failure', 'timeout_unknown'] as const;

/**
 * Deterministic stand-in for a language-model provider (no provider is selected, §5.2). Tests
 * script its turns per prompt: tool calls, an answer, a failure or a timeout. It behaves like a
 * model that can be talked into anything — a script may "obey" an instruction hidden in an
 * attachment and ask for a privileged tool call — which is exactly what the automation module
 * must withstand: every call is authorized under the requester's principal (SPK-AUTO-004,
 * SPK-AT-026). It never touches the database and keeps every input it received for assertions.
 * Refused in production by the module's provider factory.
 */
@Injectable()
export class FakeAssistantProvider implements AssistantProviderPort {
  readonly name = FAKE_ASSISTANT_PROVIDER_NAME;
  private scripts: Script[] = [];
  /** Every turn input received, in order (what the "model" saw). */
  readonly received: AssistantTurnInput[] = [];

  /**
   * Scripts the turns for prompts matching `match` (case-insensitive substring, pattern or
   * predicate). Turn `n`
   * uses step `n` (the last step repeats). Later scripts take precedence over earlier ones.
   */
  script(
    match: string | RegExp | ((input: AssistantTurnInput) => boolean),
    steps: FakeAssistantStep[],
  ): void {
    if (steps.length === 0) throw new Error('a script needs at least one step');
    const predicate =
      typeof match === 'string'
        ? (input: AssistantTurnInput) => input.prompt.toLowerCase().includes(match.toLowerCase())
        : match instanceof RegExp
          ? (input: AssistantTurnInput) => match.test(input.prompt)
          : match;
    this.scripts.push({ match: predicate, steps });
  }

  reset(): void {
    this.scripts = [];
    this.received.length = 0;
  }

  /** The inputs received for one assistant request. */
  inputsFor(assistantRequestId: string): AssistantTurnInput[] {
    return this.received.filter((i) => i.assistantRequestId === assistantRequestId);
  }

  async respond(input: AssistantTurnInput): Promise<AssistantTurnOutput> {
    this.received.push(structuredClone(input));
    const script = [...this.scripts].reverse().find((s) => s.match(input));
    if (!script) {
      return { type: 'answer', text: 'No scripted answer exists for this request.' };
    }
    const step = script.steps[Math.min(input.turn, script.steps.length) - 1] as FakeAssistantStep;
    const resolved = typeof step === 'function' ? step(input) : step;
    if (resolved.type === 'fail') {
      throw new AssistantProviderError(
        resolved.mode,
        resolved.mode === 'timeout'
          ? 'The assistant provider did not answer in time.'
          : 'The assistant provider reported an error.',
      );
    }
    return structuredClone(resolved);
  }
}
