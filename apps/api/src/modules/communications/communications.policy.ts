import type {
  DeliveryChannelValue,
  NotificationCategoryValue,
  NotificationKindValue,
} from '@sportspark/contracts';

export const COMMUNICATIONS_POLICY = Symbol('COMMUNICATIONS_POLICY');

/**
 * Operator-configurable communication policy. The values below are the specification's proposed
 * defaults; channel approval, triggers and the essential/promotional split are pending the
 * operator/privacy owner's decision (SPK-COMMS-001, DEC-012, DEC-062 in
 * docs/package-a/decision-register.md). The mechanism is implemented; the numbers are configuration.
 */
export interface CommunicationsPolicy {
  /** Effective channels per category when a person has stored no preference (SPK-COMMS-007). */
  defaultChannels: Record<NotificationCategoryValue, Record<DeliveryChannelValue, boolean>>;
  /** How long a delivery worker holds a claimed attempt before another worker may retry the claim. */
  deliveryLeaseSeconds: number;
  /** Attempts handed to providers per worker pass. */
  deliveryBatchSize: number;
  /**
   * SPK-COMMS-005: an unsent notice of one of these kinds about a subject becomes obsolete when a
   * newer notice of a `superseding` kind about the same subject is queued.
   */
  supersedableKinds: readonly NotificationKindValue[];
  supersedingKinds: readonly NotificationKindValue[];
  /** Window of entries a calendar feed returns around "now" (SPK-COMMS-008). */
  feedPastDays: number;
  feedFutureDays: number;
  /** PRODID of generated iCalendar documents (no vendor or model names). */
  calendarProductId: string;
}

export const DEFAULT_COMMUNICATIONS_POLICY: CommunicationsPolicy = {
  defaultChannels: {
    // Essential operational notices: in-app always (cannot be disabled), push and email on, SMS off
    // until the operator approves SMS use (SPK-COMMS-001, DEC-062).
    operational: { in_app: true, push: true, email: true, sms: false },
    // Promotional: never pushed by default so marketing cannot obscure today's activity (SPK-UX-003).
    promotional: { in_app: true, push: false, email: true, sms: false },
  },
  deliveryLeaseSeconds: 60,
  deliveryBatchSize: 25,
  supersedableKinds: ['schedule_published', 'schedule_changed'],
  supersedingKinds: ['schedule_changed', 'cancellation'],
  feedPastDays: 30,
  feedFutureDays: 365,
  calendarProductId: '-//Sportspark//Private calendar feed//EN',
};

/** SPK-COMMS-007: the operational in-app channel is the one preference nobody may switch off. */
export function isLockedPreference(
  category: NotificationCategoryValue,
  channel: DeliveryChannelValue,
): boolean {
  return category === 'operational' && channel === 'in_app';
}

export const ALL_CHANNELS: readonly DeliveryChannelValue[] = ['in_app', 'push', 'email', 'sms'];
export const EXTERNAL_CHANNELS: readonly Exclude<DeliveryChannelValue, 'in_app'>[] = [
  'push',
  'email',
  'sms',
];
export const ALL_CATEGORIES: readonly NotificationCategoryValue[] = ['operational', 'promotional'];
