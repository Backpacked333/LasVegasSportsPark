import {
  Inject,
  Module,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
  type Provider,
} from '@nestjs/common';
import { DeliveryReceiptSchema, type EventPayload } from '@sportspark/contracts';
import { APP_CONFIG, EventHandlerRegistry, Inbox, type AppConfig } from '../../kernel';
import { CompetitionModule } from '../competition';
import { IdentityEvents, IdentityModule } from '../identity';
import { EventChanged, SchedulePublished, SchedulingModule } from '../scheduling';
import { DeliveryRequested } from './communications.events';
import { COMMUNICATIONS_POLICY, DEFAULT_COMMUNICATIONS_POLICY } from './communications.policy';
import { CalendarFeedController } from './controllers/calendar-feed.controller';
import { MeCommunicationsController } from './controllers/me.controller';
import { NotificationsController } from './controllers/notifications.controller';
import { MessagingWebhooksController } from './controllers/webhooks.controller';
import { CHANNEL_PROVIDERS, TEAM_MEMBERSHIP_PORT, type ChannelProviderPort } from './ports';
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
  AudienceResolver,
  RecipientAddresses,
  PreferencesService,
  NotificationsService,
  DeliveryWorker,
  InboxService,
  CalendarEntriesService,
  CalendarFeedsService,
  ScheduleNotices,
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
export class CommunicationsModule implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly registry: EventHandlerRegistry,
    private readonly inbox: Inbox,
    private readonly notifications: NotificationsService,
    private readonly scheduleNotices: ScheduleNotices,
    private readonly worker: DeliveryWorker,
  ) {}

  onModuleInit(): void {
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
    );
    // Schedule publication, change and cancellation notices with old and new details (SPK-COMMS-005).
    this.registry.on<EventPayload<typeof EventChanged>>(
      EventChanged.type,
      'communications.schedule_change_notice',
      (event, ctx) => this.scheduleNotices.onEventChanged(ctx.trx, event),
    );
    this.registry.on<EventPayload<typeof SchedulePublished>>(
      SchedulePublished.type,
      'communications.schedule_published_summary',
      (event, ctx) => this.scheduleNotices.onSchedulePublished(ctx.trx, event),
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
    );
    // Provider receipts resolve accepted/unknown attempts; duplicates are ignored (SPK-COMMS-004).
    this.inbox.on(
      FAKE_MESSAGING_PROVIDER,
      'communications.delivery_receipt',
      async (event, ctx) => {
        if (event.eventType !== 'delivery.receipt') return;
        const receipt = DeliveryReceiptSchema.parse(event.payload);
        await this.worker.applyReceipt(ctx.trx, receipt, event.id);
      },
    );
  }

  /**
   * The delivery poller runs in every non-test process (API and worker alike; claims use
   * SKIP LOCKED leases so several pollers cooperate). Tests drive `DeliveryWorker.runOnce()`.
   */
  onApplicationBootstrap(): void {
    if (this.config.NODE_ENV !== 'test') this.worker.start();
  }

  onModuleDestroy(): void {
    this.worker.stop();
  }
}
