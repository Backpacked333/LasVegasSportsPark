import { z } from '@sportspark/contracts';
import { defineModuleSettings, policySetting, type ModuleSettingsOf } from '../../kernel';

/**
 * Competition's settings section (K-15, IF-43): environment variables `COMPETITION_<KEY>`,
 * validated at boot (a malformed value refuses boot).
 */
export const CompetitionSettings = defineModuleSettings('competition', {
  /**
   * SPK-COMP-006 (proposed amendment PA-10): hours a place offered to a waiting team stands before
   * it expires. A policy value pending DEC-104 ("how long an offer stands"). Absent: the proposed
   * default `TEAM_PLACE_OFFER_DEFAULT_HOURS` (competition.policy.ts) applies.
   */
  TEAM_PLACE_OFFER_HOURS: policySetting(z.coerce.number().int().min(1).max(720)),
});
export type CompetitionSettingsValue = ModuleSettingsOf<typeof CompetitionSettings>;
