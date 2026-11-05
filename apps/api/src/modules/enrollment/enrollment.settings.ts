import { z } from '@sportspark/contracts';
import { defineModuleSettings, technicalSetting, type ModuleSettingsOf } from '../../kernel';

/**
 * Enrollment's settings section (K-15, IF-43): environment variables `ENROLLMENT_<KEY>`, validated
 * at boot. Technical values only; enrollment's policy values stay in its versioned policies.
 */
export const EnrollmentSettings = defineModuleSettings('enrollment', {
  /**
   * ENR-08 (§4.12, SPK-AT-023): how long a placement assignment's operation may stay `running`
   * before the reconciler resumes it (an assignment commits in one transaction within seconds).
   */
  PLACEMENT_RECONCILE_AFTER_SECONDS: technicalSetting(
    z.coerce.number().int().min(30).max(86_400),
    300,
  ),
});
export type EnrollmentSettingsValue = ModuleSettingsOf<typeof EnrollmentSettings>;
