import { z } from '@sportspark/contracts';

/**
 * Automation configuration. The assistant is an optional capability (§1.6 conditional
 * capabilities, DEC-016 owned by the product owner): it is OFF unless `AUTOMATION_ENABLED=true`,
 * and while it is off every automation endpoint answers INTEGRATION_UNAVAILABLE and no other
 * module is affected (SPK-AUTO-005). The remaining values are engineering proposals the
 * specification leaves to operators; each is configurable here and cited with its decision.
 */
export interface AutomationSettings {
  enabled: boolean;
  /**
   * How long a recommendation stays reviewable before it expires (proposed: 24 hours). Evidence
   * read for a proposal ages; an expired proposal must be asked for again. Pending the support and
   * service-objective decision (§6.6 "Support, workload, service objectives", technical
   * lead/operator).
   */
  recommendationTtlMinutes: number;
  /**
   * Age beyond which a computed or stored result is reported `stale` rather than `recent`
   * (proposed: 24 hours; SPK-AUTO-002 requires freshness, not a threshold). Same pending decision.
   */
  evidenceMaxAgeMinutes: number;
  /** Provider turns per request (proposed: 4) and module tool calls per request (proposed: 12). */
  maxTurns: number;
  maxToolCalls: number;
}

export const AUTOMATION_SETTINGS = Symbol('AUTOMATION_SETTINGS');

export const DEFAULT_AUTOMATION_SETTINGS: AutomationSettings = {
  enabled: false,
  recommendationTtlMinutes: 24 * 60,
  evidenceMaxAgeMinutes: 24 * 60,
  maxTurns: 4,
  maxToolCalls: 12,
};

const AutomationEnvSchema = z.object({
  AUTOMATION_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  AUTOMATION_RECOMMENDATION_TTL_MINUTES: z.coerce
    .number()
    .int()
    .min(5)
    .max(30 * 24 * 60)
    .default(DEFAULT_AUTOMATION_SETTINGS.recommendationTtlMinutes),
  AUTOMATION_EVIDENCE_MAX_AGE_MINUTES: z.coerce
    .number()
    .int()
    .min(1)
    .max(30 * 24 * 60)
    .default(DEFAULT_AUTOMATION_SETTINGS.evidenceMaxAgeMinutes),
  AUTOMATION_MAX_TURNS: z.coerce
    .number()
    .int()
    .min(1)
    .max(10)
    .default(DEFAULT_AUTOMATION_SETTINGS.maxTurns),
  AUTOMATION_MAX_TOOL_CALLS: z.coerce
    .number()
    .int()
    .min(1)
    .max(50)
    .default(DEFAULT_AUTOMATION_SETTINGS.maxToolCalls),
});

/** Reads the automation settings from the environment (the kernel configuration does not carry them). */
export function loadAutomationSettings(env: NodeJS.ProcessEnv = process.env): AutomationSettings {
  const parsed = AutomationEnvSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid automation configuration:\n${lines.join('\n')}`);
  }
  const v = parsed.data;
  return {
    enabled: v.AUTOMATION_ENABLED,
    recommendationTtlMinutes: v.AUTOMATION_RECOMMENDATION_TTL_MINUTES,
    evidenceMaxAgeMinutes: v.AUTOMATION_EVIDENCE_MAX_AGE_MINUTES,
    maxTurns: v.AUTOMATION_MAX_TURNS,
    maxToolCalls: v.AUTOMATION_MAX_TOOL_CALLS,
  };
}
