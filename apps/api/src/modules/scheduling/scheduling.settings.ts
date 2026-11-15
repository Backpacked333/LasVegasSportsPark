import { z } from '@sportspark/contracts';
import { defineModuleSettings, technicalSetting, type ModuleSettingsOf } from '../../kernel';

/**
 * Scheduling's settings section (K-15, IF-43): environment variables `SCHEDULING_<KEY>`, validated
 * at boot (a malformed value refuses boot).
 */
export const SchedulingSettings = defineModuleSettings('scheduling', {
  /**
   * SPK-SCHED-010 (proposed amendment PA-06; security review L-3): the days around today, in the
   * facility's time zone, that the public day schedule answers for. A lobby needs today and a
   * public page a short window; without a bound an anonymous caller could read every past and
   * future day of the facility, private bookings' times included. Outside the window the read
   * answers the standard "not available".
   *
   * **Proposed** defaults: yesterday to 14 days ahead. What is public, and for how long ahead, is
   * pending DEC-100; these are technical values an operator can set meanwhile.
   */
  PUBLIC_SCHEDULE_DAYS_BACK: technicalSetting(z.coerce.number().int().min(0).max(31), 1),
  PUBLIC_SCHEDULE_DAYS_AHEAD: technicalSetting(z.coerce.number().int().min(0).max(366), 14),
});
export type SchedulingSettingsValue = ModuleSettingsOf<typeof SchedulingSettings>;
