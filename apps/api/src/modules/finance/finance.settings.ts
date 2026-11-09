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
 * - FAKE_WEBHOOK_SECRET (§4.14, §5.2): the HMAC secret the fake payment provider signs and
 *   verifies webhooks with on a development or staging host. Unset, the published test constant
 *   (`FAKE_PAYMENTS_WEBHOOK_SECRET`) is used, which anyone who has read the source can sign with:
 *   set it (at least 32 characters) on any host reachable from the internet. Ignored in
 *   production, which never runs the fake (PAYMENT_PROVIDER=fake is refused there).
 */
export const FinanceSettings = defineModuleSettings('finance', {
  ACCOUNTING_SUBMIT_STALE_SECONDS: technicalSetting(
    z.coerce.number().int().min(1).max(86_400),
    300,
  ),
  FAKE_WEBHOOK_SECRET: z.string().min(32).max(200).optional(),
});
export type FinanceSettingsValue = ModuleSettingsOf<typeof FinanceSettings>;
