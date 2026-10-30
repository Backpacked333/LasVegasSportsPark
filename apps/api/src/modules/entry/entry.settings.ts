import { z } from '@sportspark/contracts';
import { defineModuleSettings, technicalSetting, type ModuleSettingsOf } from '../../kernel';

/**
 * Entry module settings (K-15, IF-43): environment variables `ENTRY_<KEY>`, validated at boot (a
 * malformed value refuses to start). Only technical values live here; entry policy values (roster
 * age, balance blocking, outage procedures) stay in `entry.policy.ts` with their pending decisions,
 * and a device's heartbeat timeout is device configuration without a default.
 *
 * - DEVICE_COMMAND_ESCALATE_AFTER_ATTEMPTS (ENT-05): after this many undelivered attempts of one
 *   device command, one `entry.device_command_undelivered` exception asks the facilities operator
 *   to look at the device (technical default 3); delivery keeps retrying.
 * - DEVICE_COMMAND_RETRY_BASE_SECONDS / DEVICE_COMMAND_RETRY_MAX_SECONDS (ENT-05, §4.12): the
 *   retry backoff of an undelivered device command. The first retry has no delay: it goes out on
 *   the next delivery pass that reaches the command, which is a later pass of the same run when the
 *   run makes more than one pass (more commands are due than one pass takes), otherwise the next
 *   run. The retry after attempt n (n ≥ 2) waits base·2^(n−2) seconds, never more than the maximum
 *   (technical defaults 30 and 300), so after its second attempt an unreachable device costs one
 *   send per command per backoff instead of one every pass.
 */
export const EntrySettings = defineModuleSettings('entry', {
  DEVICE_COMMAND_ESCALATE_AFTER_ATTEMPTS: technicalSetting(
    z.coerce.number().int().min(1).max(100),
    3,
  ),
  DEVICE_COMMAND_RETRY_BASE_SECONDS: technicalSetting(z.coerce.number().int().min(1).max(3600), 30),
  DEVICE_COMMAND_RETRY_MAX_SECONDS: technicalSetting(
    z.coerce.number().int().min(1).max(86_400),
    300,
  ),
});
export type EntrySettingsValue = ModuleSettingsOf<typeof EntrySettings>;
