import { describe, expect, it } from 'vitest';
import type { AssistantTurnInput } from '../ports/assistant-provider.port';
import { AssistantProviderError } from '../ports/assistant-provider.port';
import { FakeAssistantProvider } from './fake-assistant.provider';

const input = (prompt: string, turn = 1): AssistantTurnInput => ({
  assistantRequestId: `r-${prompt}`,
  turn,
  prompt,
  attachments: [],
  caller: { kind: 'staff', staffRoles: ['scheduler'] },
  tools: [],
  toolResults: [],
  limits: { remainingTurns: 3, remainingToolCalls: 10 },
});

describe('FakeAssistantProvider (§5.2 deterministic provider)', () => {
  it('plays scripted turns per prompt (case-insensitive), repeating the last step', async () => {
    const fake = new FakeAssistantProvider();
    fake.script('Readiness', [
      { type: 'tool_calls', calls: [{ tool: 'competition.fixture_readiness', arguments: {} }] },
      { type: 'answer', text: 'Ready.' },
    ]);
    expect(await fake.respond(input('explain readiness', 1))).toMatchObject({ type: 'tool_calls' });
    expect(await fake.respond(input('explain readiness', 2))).toEqual({
      type: 'answer',
      text: 'Ready.',
    });
    expect(await fake.respond(input('explain readiness', 3))).toEqual({
      type: 'answer',
      text: 'Ready.',
    });
    expect(fake.inputsFor('r-explain readiness')).toHaveLength(3);
  });

  it('later scripts win, unscripted prompts get a fixed answer, and steps may depend on the input', async () => {
    const fake = new FakeAssistantProvider();
    fake.script(/.*/, [{ type: 'answer', text: 'generic' }]);
    fake.script('special', [(i) => ({ type: 'answer', text: `turn ${i.turn}` })]);
    expect(await fake.respond(input('a special one'))).toEqual({ type: 'answer', text: 'turn 1' });
    expect(await fake.respond(input('other'))).toEqual({ type: 'answer', text: 'generic' });
    fake.reset();
    expect(await fake.respond(input('other'))).toEqual({
      type: 'answer',
      text: 'No scripted answer exists for this request.',
    });
    expect(fake.received).toHaveLength(1);
  });

  it('simulates provider failure and timeout', async () => {
    const fake = new FakeAssistantProvider();
    fake.script('fail', [{ type: 'fail', mode: 'failed' }]);
    fake.script('slow', [{ type: 'fail', mode: 'timeout' }]);
    await expect(fake.respond(input('fail'))).rejects.toMatchObject({ mode: 'failed' });
    const timeout = await fake.respond(input('slow')).catch((e: unknown) => e);
    expect(timeout).toBeInstanceOf(AssistantProviderError);
    expect(timeout).toMatchObject({ mode: 'timeout' });
    expect(() => fake.script('empty', [])).toThrow();
  });

  it('returns copies: a test cannot mutate what the provider recorded or will answer', async () => {
    const fake = new FakeAssistantProvider();
    const step = { type: 'answer' as const, text: 'original' };
    fake.script('copy', [step]);
    const out = await fake.respond(input('copy'));
    (out as { text: string }).text = 'mutated';
    expect(await fake.respond(input('copy'))).toEqual({ type: 'answer', text: 'original' });
  });
});
