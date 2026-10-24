import { describe, expect, it } from 'vitest';
import { AssistantRequestMachine, RecommendationMachine } from './automation.machines';

describe('automation lifecycles (§4.6)', () => {
  it('AssistantRequestMachine: processing ends answered or failed, and both are final', () => {
    expect(AssistantRequestMachine.next('processing', 'answer')).toBe('answered');
    expect(AssistantRequestMachine.next('processing', 'fail')).toBe('failed');
    for (const state of ['answered', 'failed'] as const) {
      expect(AssistantRequestMachine.isTerminal(state)).toBe(true);
      expect(() => AssistantRequestMachine.next(state, 'answer')).toThrow(/cannot answer/);
    }
  });

  it('SPK-AUTO-003 RecommendationMachine: approval precedes apply; rejected, applied and expired are final', () => {
    expect(RecommendationMachine.next('proposed', 'approve')).toBe('approved');
    expect(RecommendationMachine.next('proposed', 'reject')).toBe('rejected');
    expect(RecommendationMachine.next('proposed', 'expire')).toBe('expired');
    expect(RecommendationMachine.next('approved', 'apply')).toBe('applied');
    expect(RecommendationMachine.next('approved', 'expire')).toBe('expired');
    expect(RecommendationMachine.can('proposed', 'apply')).toBe(false);
    expect(RecommendationMachine.can('approved', 'approve')).toBe(false);
    expect(RecommendationMachine.can('approved', 'reject')).toBe(false);
    for (const state of ['rejected', 'applied', 'expired'] as const) {
      expect(RecommendationMachine.isTerminal(state)).toBe(true);
      expect(RecommendationMachine.eventsFrom(state)).toEqual([]);
    }
    expect(() => RecommendationMachine.next('proposed', 'apply')).toThrow(
      expect.objectContaining({ code: 'INVALID_TRANSITION' }),
    );
  });
});
