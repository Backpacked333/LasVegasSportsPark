import { z } from '@sportspark/contracts';
import { defineModuleSettings, policySetting, type ModuleSettingsOf } from '../../kernel';

/**
 * Workforce policy settings (WRK-06; K-15, IF-43; rule K-00 (i)). Each is read from
 * `WORKFORCE_<KEY>` and validated at boot (a malformed value refuses boot). None has a default:
 * the values are pending operator decision DEC-011 / POL-033 ("official qualifications and fees:
 * required qualification evidence, permitted assignments, turnaround, rate basis, approver and
 * export"), and an absent value means the conservative behaviour named on each key.
 */
export const WorkforceSettings = defineModuleSettings('workforce', {
  /**
   * Minutes an official is still held after an assignment ends before the next may start
   * (SPK-STAFF-003). Absent: no turnaround is required; only overlapping assignments are refused
   * (by the `assignments_no_overlap` exclusion constraint).
   */
  OFFICIAL_TURNAROUND_MINUTES: policySetting(z.coerce.number().int().min(0).max(720)),
  /** The same for coaches. Absent: no turnaround; only overlaps are refused. */
  COACH_TURNAROUND_MINUTES: policySetting(z.coerce.number().int().min(0).max(720)),
  /**
   * A required slot left uncovered by a decline or withdrawal raises
   * `workforce.uncovered_assignment` only when the activity starts within this many hours
   * (SPK-STAFF-003, SPK-AT-012). Absent: an uncovered required slot raises its exception at once.
   */
  UNCOVERED_ESCALATION_HOURS: policySetting(z.coerce.number().min(0).max(8760)),
  /**
   * Hours time-bounded access (temporary or substitute work, SPK-STAFF-004) lasts after the
   * activity ends (match report, attendance corrections). Absent: access ends with the activity.
   */
  ACCESS_TRAILING_HOURS: policySetting(z.coerce.number().min(0).max(720)),
  /**
   * Accepted (or completed) official assignments one person may hold per facility-local day.
   * Absent: unchecked. Set: a further acceptance that day answers VALIDATION_FAILED with
   * `OFFICIAL_DAILY_LIMIT`.
   */
  OFFICIAL_MAX_ASSIGNMENTS_PER_DAY: policySetting(z.coerce.number().int().min(1).max(50)),
});
export type WorkforceSettingsValue = ModuleSettingsOf<typeof WorkforceSettings>;
