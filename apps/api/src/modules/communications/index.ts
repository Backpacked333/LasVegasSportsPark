export * from './communications.module';
export * from './communications.actions';
export * from './communications.events';
export * from './communications.machines';
export * from './communications.policy';
export * from './ports';
export {
  NotificationsService,
  type ComposeInput,
  type QueueOptions,
} from './services/notifications.service';
export {
  PreferencesService,
  /** IF-40 (COM-04): the import provider's name in the plan; the same service. */
  PreferencesService as CommunicationPreferencesService,
  type ImportedPreference,
  type ImportPreferencesInput,
  type ImportPreferencesResult,
} from './services/preferences.service';
export {
  PushDevicesService,
  toPushDevice,
  PUSH_REVOKED_ACCOUNT_RELINKED,
  PUSH_REVOKED_REREGISTERED,
} from './services/push-devices.service';
export { DeliveryRetryService } from './services/delivery-retry.service';
export {
  ActivityReminders,
  CommunicationsSettings,
  COMPOSE_ACTIVITY_REMINDERS_JOB,
  type CommunicationsSettingsValue,
} from './services/activity-reminders';
export {
  MERGED_PREFERENCE_CONFLICT,
  type PreferenceConflict,
} from './services/person-merge-follow-up';
export { TEAM_AUDIENCE_ROLES } from './services/competition-team-membership';
export { InboxService } from './services/inbox.service';
export { CalendarFeedsService, hashToken } from './services/calendar-feeds.service';
export { CalendarEntriesService } from './services/calendar-entries.service';
export { DeliveryWorker, type DeliverySummary } from './services/delivery-worker';
export { AudienceResolver, type ResolvedRecipient } from './services/audience-resolver';
export { ScheduleNotices, noticeKindFor } from './services/schedule-notices';
export * from './providers/fake-messaging.provider';
export { renderIcs, type IcsEvent } from './calendar/ics';
export * from './testing/communications-fixtures';
