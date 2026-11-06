import { defineEvent, PlayerPositionSchema, z } from '@sportspark/contracts';

/**
 * Competition domain events for placement and field-side work (§4.12). Payloads carry
 * identifiers only: no names, ratings or contact details (§4.14, SPK-PLACE-005).
 */
export const FieldEvents = {
  /** A staff player profile was recorded or changed (SPK-PLACE-002). The rating stays out. */
  playerProfileRecorded: defineEvent(
    'competition.player_profile_recorded',
    z.object({
      profileId: z.uuid(),
      seasonId: z.uuid(),
      personId: z.uuid(),
      position: PlayerPositionSchema.nullable(),
      revision: z.number().int(),
    }),
  ),
  /** A player was marked present or absent at the field, or the mark cleared (SPK-UX-007). */
  fixtureAttendanceRecorded: defineEvent(
    'competition.fixture_attendance_recorded',
    z.object({
      markId: z.uuid(),
      fixtureId: z.uuid(),
      teamEntryId: z.uuid(),
      personId: z.uuid(),
      state: z.enum(['present', 'absent', 'cleared']),
    }),
  ),
  /**
   * League staff reminded a fixture's captains that its result is missing (SPK-RESULT-001).
   * Communications delivers one notice per recipient; until it subscribes, the reminder is
   * recorded and nothing is sent.
   */
  resultReminderRequested: defineEvent(
    'competition.result_reminder_requested',
    z.object({
      reminderId: z.uuid(),
      fixtureId: z.uuid(),
      teamEntryIds: z.array(z.uuid()),
      recipientPersonIds: z.array(z.uuid()),
      message: z.string().nullable(),
      facilityId: z.uuid().nullable(),
    }),
  ),
};
