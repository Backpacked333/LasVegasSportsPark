import { Module, type OnModuleDestroy, type OnModuleInit, type Provider } from '@nestjs/common';
import { DeliveryReceiptSchema, type EventPayload } from '@sportspark/contracts';
import { ModuleRef } from '@nestjs/core';
import { BackgroundWorkers, EventHandlerRegistry, Inbox, lazyPort } from '../../kernel';
import { CHANGE_NOTICE_CHECK_IMPL, CompetitionModule } from '../competition';
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
import { MeCommunicationsController } from './controllers/me.controller';
import { NotificationsController } from './controllers/notifications.controller';
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
import { AudienceResolver } from './services/audience-resolver';
import { CalendarEntriesService } from './services/calendar-entries.service';
import { CalendarFeedsService } from './services/calendar-feeds.service';
import { CompetitionTeamMembership } from './services/competition-team-membership';
import { ChangeNoticeCheck } from './services/change-notice-check';
import { DeliveryWorker } from './services/delivery-worker';
import { InboxService } from './services/inbox.service';
import { NotificationsService } from './services/notifications.service';
import { PreferencesService } from './services/preferences.service';
import { RecipientAddresses } from './services/recipient-addresses';
import { ScheduleNotices } from './services/schedule-notices';

const providers: Provider[] = [
  { provide: COMMUNICATIONS_POLICY, useValue: DEFAULT_COMMUNICATIONS_POLICY },
  // Provider-selection gate (§5.2, DEC-020): one deterministic fake per external channel.
  FakePushProvider,
  FakeEmailProvider,
  FakeSmsProvider,
  {
    provide: CHANNEL_PROVIDERS,
    inject: [FakePushProvider, FakeEmailProvider, FakeSmsProvider],
    useFactory: (...fakes: ChannelProviderPort[]): ChannelProviderPort[] => fakes,
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
  RecipientAddresses,
  PreferencesService,
  NotificationsService,
  DeliveryWorker,
  InboxService,
  CalendarEntriesService,
  CalendarFeedsService,
  ScheduleNotices,
  // Fixture readiness "Material change notifications" (SPK-READY-001): this module's delivery
  // evidence for the schedule-change notice.
  ChangeNoticeCheck,
  { provide: CHANGE_NOTICE_CHECK_IMPL, useExisting: ChangeNoticeCheck },
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
  imports: [IdentityModule, SchedulingModule, CompetitionModule],
  providers,
  controllers: [
    NotificationsController,
    MeCommunicationsController,
    CalendarFeedController,
    MessagingWebhooksController,
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
  ) {}

  onModuleInit(): void {
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
