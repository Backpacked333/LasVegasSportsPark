import type { NotificationKindValue, TeamEntryStatus } from '@sportspark/contracts';

export const MESSAGE_SEQUENCE_POLICY = Symbol('MESSAGE_SEQUENCE_POLICY');

/**
 * Message sequence policy (SPK-COMMS-009, proposed amendment PA-05). The values below are assumed
 * defaults, **Proposed**: the set of messages per program (K1), who sends and on which days (K2)
 * and which reminders are automatic (K3) are **Pending decision** (DEC-099). They are
 * configuration, never constants in the services.
 */
export interface MessageSequencePolicy {
  /**
   * The facility-local time of day a step's messages are due at when the step names none (K2:
   * "who sends and on which days" is pending; a step may always choose its own time).
   */
  defaultSendTimeLocal: string;
  /**
   * Whether anything may be sent without a staff confirmation (K3). Assumed default: nothing is.
   * The services send only confirmed messages; the value states the rule the module's tests
   * assert, so making any reminder automatic is a deliberate policy and code change.
   */
  automaticSending: false;
  /** The team entries of a season whose teams receive the season's messages (K1). */
  seasonAudienceEntryStatuses: readonly TeamEntryStatus[];
  /** The notification kind a scheduled message is sent as; its category comes from the template. */
  noticeKind: NotificationKindValue;
  /** Seconds between two passes of the periodic job that sends confirmed messages that are due. */
  sendIntervalSeconds: number;
}

export const DEFAULT_MESSAGE_SEQUENCE_POLICY: MessageSequencePolicy = {
  defaultSendTimeLocal: '09:00',
  automaticSending: false,
  seasonAudienceEntryStatuses: ['approved'],
  // A staff-confirmed message: the policy leaves its category to the template (SPK-COMMS-007).
  noticeKind: 'staff_broadcast',
  sendIntervalSeconds: 300,
};
