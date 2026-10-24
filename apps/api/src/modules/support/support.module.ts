import { Module, type OnModuleInit, type Provider } from '@nestjs/common';
import type { EventPayload } from '@sportspark/contracts';
import { EventHandlerRegistry, runWithTransaction } from '../../kernel';
import { CommunicationsModule, NotificationDispatched } from '../communications';
import { CompetitionModule } from '../competition';
import { EnrollmentModule } from '../enrollment';
import { FacilitiesModule } from '../facilities';
import {
  FinanceModule,
  OrderPaid,
  PaymentFailed,
  PaymentOutcomeUnknown,
  PaymentReceived,
  RefundRequested,
  RefundSettled,
} from '../finance';
import { IdentityEvents, IdentityModule } from '../identity';
import { EventChanged, SchedulingModule } from '../scheduling';
import { WorkforceModule } from '../workforce';
import { CasesController } from './controllers/cases.controller';
import { ExceptionsController } from './controllers/exceptions.controller';
import { WorkspaceController } from './controllers/workspace.controller';
import { CaseActionsService } from './services/case-actions.service';
import { CasesService } from './services/cases.service';
import { ExceptionQueuesService } from './services/exception-queues.service';
import { ExceptionsService } from './services/exceptions.service';
import { NextActions } from './services/next-actions';
import { TimelineIndexer } from './services/timeline-indexer.service';
import { TimelineService } from './services/timeline.service';
import { TodayService } from './services/today.service';
import { DEFAULT_SUPPORT_POLICY, SUPPORT_POLICY } from './support.policy';
import { SUPPORT_CASES_PORT } from './support.ports';

const providers: Provider[] = [
  { provide: SUPPORT_POLICY, useValue: DEFAULT_SUPPORT_POLICY },
  ExceptionQueuesService,
  NextActions,
  CasesService,
  CaseActionsService,
  ExceptionsService,
  TodayService,
  TimelineService,
  TimelineIndexer,
  { provide: SUPPORT_CASES_PORT, useExisting: CasesService },
];

/**
 * SupportModule (specification §3.19 SPK-SUPPORT-001..003, §2.3 SPK-UX-006, §4.4 Operations:
 * Case and Exception, SPK-IAM-005 escalation, SPK-AT-026). Owns support cases, their history and
 * action links, exception queues and the timeline reference index. Every read of another module
 * goes through that module's exported services with the operator's principal; every change to
 * another module's records is that module's own command (refund, resend), never a support write
 * (§4.2, SPK-SUPPORT-003). Operational exceptions are transitioned through the kernel.
 */
@Module({
  imports: [
    IdentityModule,
    SchedulingModule,
    CompetitionModule,
    WorkforceModule,
    FacilitiesModule,
    CommunicationsModule,
    EnrollmentModule,
    FinanceModule,
  ],
  providers,
  controllers: [WorkspaceController, CasesController, ExceptionsController],
  exports: [
    SUPPORT_POLICY,
    ExceptionQueuesService,
    CasesService,
    CaseActionsService,
    ExceptionsService,
    TodayService,
    TimelineService,
    SUPPORT_CASES_PORT,
  ],
})
export class SupportModule implements OnModuleInit {
  constructor(
    private readonly registry: EventHandlerRegistry,
    private readonly cases: CasesService,
    private readonly indexer: TimelineIndexer,
  ) {}

  onModuleInit(): void {
    // SPK-SUPPORT-001: index which records of other modules concern which person.
    for (const definition of [PaymentReceived, PaymentFailed, PaymentOutcomeUnknown]) {
      this.registry.on<EventPayload<typeof definition>>(
        definition.type,
        'support.index_payment',
        (event, ctx) => runWithTransaction(ctx.trx, () => this.indexer.onPayment(event, ctx)),
      );
    }
    for (const definition of [RefundRequested, RefundSettled]) {
      this.registry.on<EventPayload<typeof definition>>(
        definition.type,
        'support.index_refund',
        (event, ctx) => runWithTransaction(ctx.trx, () => this.indexer.onRefund(event, ctx)),
      );
    }
    this.registry.on<EventPayload<typeof OrderPaid>>(
      OrderPaid.type,
      'support.index_order',
      (event, ctx) => runWithTransaction(ctx.trx, () => this.indexer.onOrderPaid(event, ctx)),
    );
    this.registry.on<EventPayload<typeof NotificationDispatched>>(
      NotificationDispatched.type,
      'support.index_message',
      (event, ctx) =>
        runWithTransaction(ctx.trx, () => this.indexer.onNotificationDispatched(event, ctx)),
    );
    this.registry.on<EventPayload<typeof EventChanged>>(
      EventChanged.type,
      'support.index_schedule_change',
      (event, ctx) => runWithTransaction(ctx.trx, () => this.indexer.onEventChanged(event, ctx)),
    );
    // SPK-IAM-007: a merge keeps the merged person's support history with the survivor.
    this.registry.on<EventPayload<typeof IdentityEvents.personsMerged>>(
      IdentityEvents.personsMerged.type,
      'support.follow_person_merge',
      (event, ctx) =>
        runWithTransaction(ctx.trx, async () => {
          await this.indexer.onPersonsMerged(event, ctx);
          await this.cases.onPersonsMerged(ctx.trx, event);
        }),
    );
    // SPK-IAM-005: an escalated disputed-access review becomes an owned support case.
    this.registry.on<EventPayload<typeof IdentityEvents.accessReviewDecided>>(
      IdentityEvents.accessReviewDecided.type,
      'support.access_review_escalation',
      (event, ctx) =>
        runWithTransaction(ctx.trx, () => this.cases.onAccessReviewDecided(ctx.trx, event)),
    );
  }
}
