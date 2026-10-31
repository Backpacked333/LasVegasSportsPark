import { z } from '@sportspark/contracts';
import {
  defineModuleSettings,
  technicalSetting,
  type ModuleSettingsDefinition,
  type ModuleSettingsOf,
} from '../../kernel';

/**
 * Automation configuration (AUT-02; K-15, IF-43): a section of the kernel configuration, read from
 * the environment variables `AUTOMATION_<KEY>` and validated by `loadConfig` at boot like the
 * kernel's own settings, so a malformed value refuses boot.
 *
 * Two switches decide whether the assistant answers (SPK-AUTO-005, §1.6, §6.5 Package G):
 * - `AUTOMATION_ENABLED` (deployment flag, default `false`): while off, every automation endpoint
 *   answers INTEGRATION_UNAVAILABLE and no other module is affected;
 * - the per-organization capability switch `assistant` (applicability DEC-016; the provider,
 *   DEC-013, is related and never enables it), changed only by a system administrator through
 *   `core.manage_capabilities` with audit. Off (the default for every organization), a new
 *   request, an approval or an apply answers ACCESS_DENIED `CAPABILITY_DISABLED`; reading,
 *   rejecting and settling recommendations and the expiry timer stay available.
 *
 * None of the values below is an operator policy (no price, tax, deposit or eligibility rule):
 * they are technical limits of the module. The two time windows are engineering proposals pending
 * the §6.6 "Support, workload, service objectives" decision (technical lead/operator); the turn and
 * call limits bound provider cost and latency.
 */
const minutes = (min: number) =>
  z.coerce
    .number()
    .int()
    .min(min)
    .max(30 * 24 * 60);

export const AutomationModuleSettings = defineModuleSettings('automation', {
  /**
   * Deployment flag (SPK-AUTO-005). Only `true` or `false`; absent means `false` (the conservative
   * behaviour: the assistant is off). Not `technicalSetting`: its default is the parsed value.
   */
  ENABLED: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default(false),
  /**
   * How long a recommendation stays reviewable before it expires (proposed: 24 hours). Evidence
   * read for a proposal ages; an expired proposal must be asked for again.
   */
  RECOMMENDATION_TTL_MINUTES: technicalSetting(minutes(5), 24 * 60),
  /**
   * Age beyond which a computed or stored result is reported `stale` rather than `recent`
   * (proposed: 24 hours; SPK-AUTO-002 requires freshness, not a threshold).
   */
  EVIDENCE_MAX_AGE_MINUTES: technicalSetting(minutes(1), 24 * 60),
  /** Provider turns per request (proposed: 4). */
  MAX_TURNS: technicalSetting(z.coerce.number().int().min(1).max(10), 4),
  /** Module tool calls per request (proposed: 12). */
  MAX_TOOL_CALLS: technicalSetting(z.coerce.number().int().min(1).max(50), 12),
  /**
   * AUT-03 (§4.12): a request still `processing` this many seconds after it was received is failed
   * with its operation by `automation.fail_stalled_requests` (the process that served it stopped).
   * Technical value, longer than any provider turn; default 900 seconds.
   */
  REQUEST_STALL_SECONDS: technicalSetting(z.coerce.number().int().min(60).max(86_400), 900),
});
export type AutomationModuleSettingsValue = ModuleSettingsOf<typeof AutomationModuleSettings>;

/** The parsed automation settings, as the module's services read them. */
export interface AutomationSettings {
  enabled: boolean;
  recommendationTtlMinutes: number;
  evidenceMaxAgeMinutes: number;
  maxTurns: number;
  maxToolCalls: number;
  requestStallSeconds: number;
}

/**
 * The automation services' settings token: derived from `MODULE_SETTINGS('automation')` in
 * `AutomationModule`; tests override it (`enableAutomation()`).
 */
export const AUTOMATION_SETTINGS = Symbol('AUTOMATION_SETTINGS');

export function toAutomationSettings(section: AutomationModuleSettingsValue): AutomationSettings {
  return {
    enabled: section.ENABLED,
    recommendationTtlMinutes: section.RECOMMENDATION_TTL_MINUTES,
    evidenceMaxAgeMinutes: section.EVIDENCE_MAX_AGE_MINUTES,
    maxTurns: section.MAX_TURNS,
    maxToolCalls: section.MAX_TOOL_CALLS,
    requestStallSeconds: section.REQUEST_STALL_SECONDS,
  };
}

/**
 * Parses the automation section from environment variables alone (tests and tools; the application
 * reads it from the kernel configuration). Same schema and messages as boot.
 */
export function loadAutomationSettings(env: NodeJS.ProcessEnv = process.env): AutomationSettings {
  const definition: ModuleSettingsDefinition<typeof AutomationModuleSettings.schema.shape> =
    AutomationModuleSettings;
  const raw: Record<string, unknown> = {};
  for (const key of Object.keys(definition.schema.shape)) {
    const value = env[`${definition.prefix}${key}`];
    if (value !== undefined && value !== '') raw[key] = value;
  }
  const parsed = definition.schema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (i) => `  ${definition.prefix}${i.path.join('.')}: ${i.message}`,
    );
    throw new Error(`Invalid automation configuration:\n${lines.join('\n')}`);
  }
  return toAutomationSettings(parsed.data);
}

export const DEFAULT_AUTOMATION_SETTINGS: AutomationSettings = loadAutomationSettings({});
