import {
  Inject,
  Module,
  type OnModuleDestroy,
  type OnModuleInit,
  type Provider,
} from '@nestjs/common';
import { DeliveryReceiptSchema, type EventPayload } from '@sportspark/contracts';
import { ModuleRef } from '@nestjs/core';
import {
  APP_CONFIG,
  BackgroundWorkers,
  EventHandlerRegistry,
  INTEGRATION_REGISTRY,
  Inbox,
  PeriodicJobRegistry,
  lazyPort,
  moduleSettings,
  providerSelection,
  type AppConfig,
  type IntegrationRegistryPort,
  type ProviderSelector,
} from '../../kernel';
import { CatalogEvents, CatalogModule } from '../catalog';
import {
  CHANGE_NOTICE_CHECK_IMPL,
  CompetitionEvents,
  CompetitionModule,
  FieldEvents,
  MatchEvents,
} from '../competition';
import { IdentityEvents, IdentityModule } from '../identity';
import {
  ClosureImpactContributors,
  EventChanged,
  SchedulePublished,
  SchedulingModule,
} from '../scheduling';
import { DeliveryRequested } from './communications.events';
import { COMMUNICATIONS_POLICY, DEFAULT_COMMUNICATIONS_POLICY } from './communications.policy';
import { CalendarFeedController } from './controllers/calendar-feed.controller';
import { DeliveryAttemptsController } from './controllers/delivery-attempts.controller';
import { MeCommunicationsController } from './controllers/me.controller';
import {
  AudienceCountsController,
  NotificationsController,
} from './controllers/notifications.controller';
import { MessageSequencesController } from './controllers/message-sequences.controller';
import { MessagingWebhooksController } from './controllers/webhooks.controller';
import {
  CHANNEL_PROVIDERS,
  noSessionAudience,
  SESSION_AUDIENCE_IMPL,
  SESSION_AUDIENCE_PORT,
  TEAM_MEMBERSHIP_PORT,
  type ChannelProviderPort,
  type SessionAudiencePort,
} from './ports';
import {
  FAKE_MESSAGING_PROVIDER,
  FakeEmailProvider,
  FakePushProvider,
  FakeSmsProvider,
} from './providers/fake-messaging.provider';
import { ActivityReminders } from './services/activity-reminders';
import { AudienceResolver } from './services/audience-resolver';
import { CalendarEntriesService } from './services/calendar-entries.service';
import { CalendarFeedsService } from './services/calendar-feeds.service';
import { CompetitionTeamMembership } from './services/competition-team-membership';
import { ChangeNoticeCheck } from './services/change-notice-check';
import { CompetitionNotices } from './services/competition-notices';
import { TeamWaitingNotices } from './services/team-waiting-notices';
import { DeliveryReconciliationService } from './services/delivery-reconciliation.service';
import { DeliveryRetryService } from './services/delivery-retry.service';
import { DeliveryWorker } from './services/delivery-worker';
import { InboxService } from './services/inbox.service';
import { NotificationsService } from './services/notifications.service';
import { MergedPersons } from './services/merged-persons';
import { PersonMergeFollowUp } from './services/person-merge-follow-up';
import { PreferencesService } from './services/preferences.service';
import { PushDevicesService } from './services/push-devices.service';
import { RecipientAddresses } from './services/recipient-addresses';
import { ScheduleNotices } from './services/schedule-notices';
import { MessageScheduleService } from './sequences/message-schedule.service';
import {
  DEFAULT_MESSAGE_SEQUENCE_POLICY,
  MESSAGE_SEQUENCE_POLICY,
} from './sequences/message-sequences.policy';
import { MessageSequencesService } from './sequences/message-sequences.service';
import { MessageTemplatesService } from './sequences/message-templates.service';
import { ScheduledMessageSender } from './sequences/scheduled-message-sender';
import { SubjectFactsReader } from './sequences/subject-facts';

/** The selector that chooses each external channel's adapter (§5.2). */
const CHANNEL_SELECTORS: Record<'push' | 'email' | 'sms', ProviderSelector> = {
  push: 'MESSAGING_PUSH_PROVIDER',
  email: 'MESSAGING_EMAIL_PROVIDER',
  sms: 'MESSAGING_SMS_PROVIDER',
};

const providers: Provider[] = [
  { provide: COMMUNICATIONS_POLICY, useValue: DEFAULT_COMMUNICATIONS_POLICY },
  // K-15, IF-43: the communication policy's settings without defaults (DEC-012).
  moduleSettings('communications'),
  // Provider-selection gate (§5.2, DEC-020): one deterministic fake per external channel.
  FakePushProvider,
  FakeEmailProvider,
  FakeSmsProvider,
  // MESSAGING_<CHANNEL>_PROVIDER (§5.2, DEC-020): `fake` outside production only (the
  // configuration refuses it in production); with `none` the channel has no provider, so no
  // notice is approved for it (NotificationsService) and nothing is sent on it.
  {
    provide: CHANNEL_PROVIDERS,
    inject: [APP_CONFIG, FakePushProvider, FakeEmailProvider, FakeSmsProvider],
    useFactory: (config: AppConfig, ...fakes: ChannelProviderPort[]): ChannelProviderPort[] =>
      fakes.filter((fake) => providerSelection(config, CHANNEL_SELECTORS[fake.channel]) === 'fake'),
  },
  // Team audiences and calendar scopes read the competition module's effective roster (§4.2).
  CompetitionTeamMembership,
  { provide: TEAM_MEMBERSHIP_PORT, useExisting: CompetitionTeamMembership },
  // SPK-AT-009: participants of the catalog sessions behind a scheduling event (enrollment).
  {
    provide: SESSION_AUDIENCE_PORT,
    inject: [ModuleRef],
    useFactory: (moduleRef: ModuleRef): SessionAudiencePort =>
      lazyPort(moduleRef, SESSION_AUDIENCE_IMPL, noSessionAudience, null),
  },
  AudienceResolver,
  MergedPersons,
  RecipientAddresses,
  PreferencesService,
  NotificationsService,
  DeliveryWorker,
  InboxService,
  CalendarEntriesService,
  CalendarFeedsService,
  ScheduleNotices,
  PushDevicesService,
  DeliveryRetryService,
  DeliveryReconciliationService,
  CompetitionNotices,
  TeamWaitingNotices,
  PersonMergeFollowUp,
  ActivityReminders,
  // Fixture readiness "Material change notifications" (SPK-READY-001): this module's delivery
  // evidence for the schedule-change notice.
  ChangeNoticeCheck,
  { provide: CHANGE_NOTICE_CHECK_IMPL, useExisting: ChangeNoticeCheck },
  // SPK-COMMS-009 (proposed amendment PA-05, capability message_sequences): templates, sequences
  // and the message schedule of a season or an offering. The assumed defaults are policy content
  // (DEC-099 pending).
  { provide: MESSAGE_SEQUENCE_POLICY, useValue: DEFAULT_MESSAGE_SEQUENCE_POLICY },
  SubjectFactsReader,
  MessageScheduleService,
  MessageTemplatesService,
  MessageSequencesService,
  ScheduledMessageSender,
];

/**
 * CommunicationsModule (specification §3.18 SPK-COMMS-001..008, §4.4 Communications, §4.5
 * "Messages must represent actual delivery states", §4.7 invariant 10, SPK-IAM-006, SPK-AT-017,
 * SPK-UX-003/006). Owns notifications, recipients, delivery attempts, preferences,
 * acknowledgments, calendar feeds and its own calendar-entry projection. Recipients come from
 * identity's current permissions and staff directory and from competition's effective roster;
 * contact points are read through identity's exported service. See README.md.
 */
@Module({
  imports: [IdentityModule, SchedulingModule, CompetitionModule, CatalogModule],
  providers,
  controllers: [
    NotificationsController,
    AudienceCountsController,
    DeliveryAttemptsController,
    MeCommunicationsController,
    CalendarFeedController,
    MessagingWebhooksController,
    MessageSequencesController,
  ],
  exports: [
    NotificationsService,
    PreferencesService,
    InboxService,
    CalendarFeedsService,
    CalendarEntriesService,
    DeliveryWorker,
    AudienceResolver,
    ScheduleNotices,
    PushDevicesService,
    DeliveryRetryService,
    DeliveryReconciliationService,
    ActivityReminders,
    MessageScheduleService,
    MessageTemplatesService,
    MessageSequencesService,
    ScheduledMessageSender,
    MESSAGE_SEQUENCE_POLICY,
    CHANNEL_PROVIDERS,
    TEAM_MEMBERSHIP_PORT,
    COMMUNICATIONS_POLICY,
    FakePushProvider,
    FakeEmailProvider,
    FakeSmsProvider,
  ],
})
export class CommunicationsModule implements OnModuleInit, OnModuleDestroy {
  constructor(
    private readonly backgroundWorkers: BackgroundWorkers,
    private readonly registry: EventHandlerRegistry,
    private readonly inbox: Inbox,
    private readonly notifications: NotificationsService,
    private readonly scheduleNotices: ScheduleNotices,
    private readonly worker: DeliveryWorker,
    private readonly impactContributors: ClosureImpactContributors,
    private readonly pushDevices: PushDevicesService,
    private readonly competitionNotices: CompetitionNotices,
    private readonly teamWaitingNotices: TeamWaitingNotices,
    private readonly mergeFollowUp: PersonMergeFollowUp,
    private readonly reminders: ActivityReminders,
    private readonly messageSchedule: MessageScheduleService,
    private readonly scheduledMessageSender: ScheduledMessageSender,
    private readonly periodicJobs: PeriodicJobRegistry,
    @Inject(INTEGRATION_REGISTRY) private readonly integrations: IntegrationRegistryPort,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    // §5.1, §5.2 (COM-01, K-09, DEC-020): the channel adapters this module runs, all deterministic
    // fakes refused in production; failed and unknown deliveries of essential notices reach the
    // front desk's queue, which reconciles unknown ones (POST /delivery-attempts/{id}/reconcile).
    // A channel whose selector is `none` runs no adapter, so none is registered for it.
    for (const channel of ['push', 'email', 'sms'] as const) {
      if (providerSelection(this.config, CHANNEL_SELECTORS[channel]) !== 'fake') continue;
      this.integrations.register({
        id: `communications.${channel}_provider`,
        gate: 'messaging',
        port: 'CHANNEL_PROVIDERS',
        adapter: { name: FAKE_MESSAGING_PROVIDER, kind: 'fake' },
        productionAllowed: false,
        scenarios: ['success', 'failure', 'timeout_unknown', 'duplicate'],
        reconciliationOwner: 'front_desk',
      });
    }
    // COM-06 (SPK-CAP-001 "remind", K-06): composes nothing until the lead time is configured.
    this.periodicJobs.register(this.reminders.job());
    // SPK-COMMS-009 (proposed amendment PA-05): sends confirmed messages of sequences that are
    // due; nothing unconfirmed, and nothing while message sequences are turned off.
    this.periodicJobs.register(this.scheduledMessageSender.job());
    // SPK-SCHED-009 "messages": a closure preview names the unsent notices about affected events.
    this.impactContributors.register(
      'communications.pending_notices',
      (db, organizationId, events) =>
        this.scheduleNotices.closureImpact(db, organizationId, events),
    );
    // §4.1, §4.12: the provider-facing poll loop belongs to the worker process (worker.ts starts
    // every registered background worker); request-serving API processes never run it. Tests
    // drive `runOnce()` directly.
    this.backgroundWorkers.register({
      name: 'communications.delivery_worker',
      start: () => this.worker.start(),
      stop: () => this.worker.stop(),
    });
    // Dispatch (SPK-COMMS-003): the transactional half of `communications.delivery_requested`
    // re-checks every recipient against current authority and creates the delivery attempts; the
    // provider hand-off happens in DeliveryWorker OUTSIDE any transaction (§4.11), nudged after
    // commit and otherwise picked up by its poll loop.
    this.registry.on<EventPayload<typeof DeliveryRequested>>(
      DeliveryRequested.type,
      'communications.dispatch_notification',
      async (event, ctx) => {
        await this.notifications.dispatch(
          ctx.trx,
          event.organizationId,
          event.payload.notificationId,
          event.correlationId,
        );
        this.worker.kick();
      },
      { failureOwner: 'front_desk' },
    );
    // Schedule publication, change and cancellation notices with old and new details (SPK-COMMS-005).
    this.registry.on<EventPayload<typeof EventChanged>>(
      EventChanged.type,
      'communications.schedule_change_notice',
      (event, ctx) => this.scheduleNotices.onEventChanged(ctx.trx, event),
      { failureOwner: 'front_desk' },
    );
    this.registry.on<EventPayload<typeof SchedulePublished>>(
      SchedulePublished.type,
      'communications.schedule_published_summary',
      (event, ctx) => this.scheduleNotices.onSchedulePublished(ctx.trx, event),
      { failureOwner: 'front_desk' },
    );
    // SPK-IAM-006 / SPK-AT-017: a lost grant re-evaluates protected notices still awaiting dispatch.
    this.registry.on<EventPayload<typeof IdentityEvents.accessGrantRevoked>>(
      IdentityEvents.accessGrantRevoked.type,
      'communications.reevaluate_revoked_grant',
      async (event, ctx) => {
        if (event.payload.permission !== 'receive_messages') return;
        await this.notifications.reevaluateRecipients(
          ctx.trx,
          event.organizationId,
          event.payload.actorPersonId,
          event.payload.subjectPersonId,
          event.correlationId,
        );
      },
      { failureOwner: 'front_desk' },
    );
    this.registry.on<EventPayload<typeof IdentityEvents.accessRestricted>>(
      IdentityEvents.accessRestricted.type,
      'communications.reevaluate_restricted_access',
      async (event, ctx) => {
        for (const actorPersonId of event.payload.actorPersonIds) {
          await this.notifications.reevaluateRecipients(
            ctx.trx,
            event.organizationId,
            actorPersonId,
            event.payload.subjectPersonId,
            event.correlationId,
          );
        }
      },
      { failureOwner: 'front_desk' },
    );
    // SPK-AT-025, SPK-IAM-006 (COM-01): a recovered account's devices receive nothing more. §4.12:
    // only the devices of the old sign-in, as of the relink instant (the event's occurredAt), not
    // one the recovered sign-in registered before this follow-up ran. This relies on identity
    // stamping occurredAt in the relink transaction and on synchronized API clocks
    // (PushDevicesService.revokeForAccount, README COM-01).
    this.registry.on<EventPayload<typeof IdentityEvents.accountRelinked>>(
      IdentityEvents.accountRelinked.type,
      'communications.revoke_push_on_relink',
      async (event, ctx) => {
        await this.pushDevices.revokeForAccount(
          ctx.trx,
          event.organizationId,
          event.payload.accountId,
          new Date(event.occurredAt),
          event.correlationId,
        );
      },
      { failureOwner: 'support_operator' },
    );
    // SPK-IAM-007 (COM-05): the survivor reads the merged person's rows; conflicts go to support.
    this.registry.on<EventPayload<typeof IdentityEvents.personsMerged>>(
      IdentityEvents.personsMerged.type,
      'communications.follow_person_merge',
      async (event, ctx) => {
        await this.mergeFollowUp.onPersonsMerged(ctx.trx, event);
      },
      { failureOwner: 'support_operator' },
    );
    // SPK-COMMS-002 notices about competition facts (COM-03, COM-06; IF-22).
    this.registry.on<EventPayload<typeof CompetitionEvents.teamInvitationCreated>>(
      CompetitionEvents.teamInvitationCreated.type,
      'communications.notify_team_invitation',
      (event, ctx) => this.competitionNotices.onTeamInvitationCreated(ctx.trx, event),
      { failureOwner: 'league_manager' },
    );
    this.registry.on<EventPayload<typeof MatchEvents.resultPublished>>(
      MatchEvents.resultPublished.type,
      'communications.notify_result_published',
      (event, ctx) => this.competitionNotices.onResultPublished(ctx.trx, event),
      { failureOwner: 'league_manager' },
    );
    this.registry.on<EventPayload<typeof MatchEvents.incidentReported>>(
      MatchEvents.incidentReported.type,
      'communications.notify_injury_report',
      (event, ctx) => this.competitionNotices.onIncidentReported(ctx.trx, event),
      { failureOwner: 'program_manager' },
    );
    this.registry.on<EventPayload<typeof CompetitionEvents.availabilityRequested>>(
      CompetitionEvents.availabilityRequested.type,
      'communications.notify_availability_request',
      (event, ctx) => this.competitionNotices.onAvailabilityRequested(ctx.trx, event),
      { failureOwner: 'league_manager' },
    );
    this.registry.on<EventPayload<typeof FieldEvents.resultReminderRequested>>(
      FieldEvents.resultReminderRequested.type,
      'communications.notify_result_reminder',
      (event, ctx) => this.competitionNotices.onResultReminderRequested(ctx.trx, event),
      { failureOwner: 'league_manager' },
    );
    // SPK-COMP-006 (QA M-5, M-7): the captain and co-captains hear about a place offered to their
    // waiting team, about what became of the offer, and when the team joins or leaves the list.
    this.registry.on<EventPayload<typeof CompetitionEvents.teamPlaceOffered>>(
      CompetitionEvents.teamPlaceOffered.type,
      'communications.notify_team_place_offered',
      (event, ctx) => this.teamWaitingNotices.onTeamPlaceOffered(ctx.trx, event),
      { failureOwner: 'league_manager' },
    );
    this.registry.on<EventPayload<typeof CompetitionEvents.teamPlaceOfferResolved>>(
      CompetitionEvents.teamPlaceOfferResolved.type,
      'communications.notify_team_place_offer_resolved',
      (event, ctx) => this.teamWaitingNotices.onTeamPlaceOfferResolved(ctx.trx, event),
      { failureOwner: 'league_manager' },
    );
    this.registry.on<EventPayload<typeof CompetitionEvents.teamEntryStatusChanged>>(
      CompetitionEvents.teamEntryStatusChanged.type,
      'communications.notify_team_waiting_status',
      (event, ctx) => this.teamWaitingNotices.onTeamEntryStatusChanged(ctx.trx, event),
      { failureOwner: 'league_manager' },
    );
    // SPK-COMMS-009 (proposed amendment PA-05, capability message_sequences). A new season or a
    // published offering gets its message schedule from the sequences that apply (nothing while
    // the switch is off; one message per step and record, so a replay creates nothing twice).
    // The other four keep existing messages truthful: a moved date moves the due time and asks
    // for confirmation again, an archived record cancels what was not sent. None of them sends.
    this.registry.on<EventPayload<typeof CompetitionEvents.seasonCreated>>(
      CompetitionEvents.seasonCreated.type,
      'communications.schedule_season_messages',
      (event, ctx) =>
        this.messageSchedule.onSubjectEvent(
          ctx.trx,
          event.organizationId,
          { type: 'season', id: event.payload.seasonId },
          'materialize',
          event.correlationId,
        ),
      { failureOwner: 'league_manager' },
    );
    this.registry.on<EventPayload<typeof CompetitionEvents.seasonUpdated>>(
      CompetitionEvents.seasonUpdated.type,
      'communications.follow_season_messages',
      (event, ctx) =>
        this.messageSchedule.onSubjectEvent(
          ctx.trx,
          event.organizationId,
          { type: 'season', id: event.payload.seasonId },
          'follow',
          event.correlationId,
        ),
      { failureOwner: 'league_manager' },
    );
    // The first game of a season is one of its anchor dates and placeholders.
    this.registry.on<EventPayload<typeof CompetitionEvents.fixtureChanged>>(
      CompetitionEvents.fixtureChanged.type,
      'communications.follow_season_first_game',
      (event, ctx) =>
        this.messageSchedule.onSubjectEvent(
          ctx.trx,
          event.organizationId,
          { type: 'season', id: event.payload.seasonId },
          'follow',
          event.correlationId,
        ),
      { failureOwner: 'league_manager' },
    );
    this.registry.on<EventPayload<typeof CatalogEvents.offeringPublished>>(
      CatalogEvents.offeringPublished.type,
      'communications.schedule_offering_messages',
      (event, ctx) =>
        this.messageSchedule.onSubjectEvent(
          ctx.trx,
          event.organizationId,
          { type: 'offering', id: event.payload.offeringId },
          'materialize',
          event.correlationId,
        ),
      { failureOwner: 'program_manager' },
    );
    this.registry.on<EventPayload<typeof CatalogEvents.offeringUpdated>>(
      CatalogEvents.offeringUpdated.type,
      'communications.follow_offering_messages',
      (event, ctx) =>
        this.messageSchedule.onSubjectEvent(
          ctx.trx,
          event.organizationId,
          { type: 'offering', id: event.payload.offeringId },
          'follow',
          event.correlationId,
        ),
      { failureOwner: 'program_manager' },
    );
    this.registry.on<EventPayload<typeof CatalogEvents.offeringArchived>>(
      CatalogEvents.offeringArchived.type,
      'communications.cancel_archived_offering_messages',
      (event, ctx) =>
        this.messageSchedule.onSubjectEvent(
          ctx.trx,
          event.organizationId,
          { type: 'offering', id: event.payload.offeringId },
          'follow',
          event.correlationId,
        ),
      { failureOwner: 'program_manager' },
    );
    // Provider receipts resolve accepted/unknown attempts; duplicates are ignored (SPK-COMMS-004).
    this.inbox.on(
      FAKE_MESSAGING_PROVIDER,
      'communications.delivery_receipt',
      async (event, ctx) => {
        if (event.eventType !== 'delivery.receipt') return;
        const receipt = DeliveryReceiptSchema.parse(event.payload);
        await this.worker.applyReceipt(ctx.trx, receipt, event.id, event.provider);
      },
    );
  }

  onModuleDestroy(): void {
    this.worker.stop();
  }
}
