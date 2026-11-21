import { defineEvent, z } from '@sportspark/contracts';

/**
 * Competition domain events of the coach's team sheet (migration 0475, §4.12). Identifiers only:
 * no names or contacts (§4.14).
 */
export const LineupEvents = {
  /**
   * A side's lineup was shared with its families (SPK-CAP-001). Communications delivers one notice
   * per family once it subscribes; until then the share is recorded and nothing is sent.
   */
  lineupShared: defineEvent(
    'competition.lineup_shared',
    z.object({
      lineupId: z.uuid(),
      fixtureId: z.uuid(),
      teamEntryId: z.uuid(),
      formation: z.string(),
      starterPersonIds: z.array(z.uuid()),
      revision: z.number().int(),
    }),
  ),
  /** A side recorded or corrected its game log (SPK-UX-007, SPK-RESULT-001). */
  gameLogRecorded: defineEvent(
    'competition.game_log_recorded',
    z.object({
      gameLogId: z.uuid(),
      fixtureId: z.uuid(),
      teamEntryId: z.uuid(),
      homeScore: z.number().int(),
      awayScore: z.number().int(),
      revision: z.number().int(),
    }),
  ),
};
