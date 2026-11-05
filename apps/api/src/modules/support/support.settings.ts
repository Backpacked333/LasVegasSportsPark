import { z } from '@sportspark/contracts';
import { defineModuleSettings, technicalSetting, type ModuleSettingsOf } from '../../kernel';

/**
 * Support's technical settings (K-15): environment variables `SUPPORT_<KEY>`, validated at boot.
 * None of them is an operator policy value (those are in `support.policy.ts`, pending DEC-015).
 */
export const SupportSettings = defineModuleSettings('support', {
  /**
   * SUP-04: a helper request (a refund requested from a case) still `requested` this many seconds
   * after its intent is swept by `support.settle_stale_case_actions`: the owning module's outcome
   * is read and recorded, or one `support.case_action_stale` exception is raised. Technical value
   * (longer than a provider call's timeout); default 900 seconds.
   */
  STALE_ACTION_SECONDS: technicalSetting(
    z.coerce
      .number()
      .int()
      .min(60)
      .max(7 * 86_400),
    900,
  ),
});
export type SupportSettingsValue = ModuleSettingsOf<typeof SupportSettings>;
