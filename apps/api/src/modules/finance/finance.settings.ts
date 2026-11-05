import { z } from '@sportspark/contracts';
import { defineModuleSettings, technicalSetting, type ModuleSettingsOf } from '../../kernel';

/**
 * Finance module settings (K-15, IF-43): environment variables `FINANCE_<KEY>`, validated at boot
 * (a malformed value refuses to start). Only technical values live here; finance policy values come
 * from approved catalog policy versions (FinancePolicyResolver), never from configuration defaults.
 *
 * - ACCOUNTING_SUBMIT_STALE_SECONDS (FIN-07): a batch still `submitted` this long after it was
 *   handed to the accounting connection is asked about by the reconciliation job, so a process
 *   that stopped after the call never strands it (technical default 300 seconds).
 */
export const FinanceSettings = defineModuleSettings('finance', {
  ACCOUNTING_SUBMIT_STALE_SECONDS: technicalSetting(
    z.coerce.number().int().min(1).max(86_400),
    300,
  ),
});
export type FinanceSettingsValue = ModuleSettingsOf<typeof FinanceSettings>;
