import { Injectable } from '@nestjs/common';
import {
  ComposeNotificationBody,
  CreateScheduleDraftBody,
  DraftChangeInputSchema,
  errors,
  z,
  type ComposeNotificationInput,
  type Principal,
} from '@sportspark/contracts';
import { sql, type SqlBool } from 'kysely';
import { AuthorizationService, UnitOfWork } from '../../../kernel';
import { CommunicationsActions, NotificationsService } from '../../communications';
import { FinanceActions, PaymentsService, RefundsService } from '../../finance';
import { ScheduleDraftsService, SchedulingActions } from '../../scheduling';
import { missingEvidence } from '../evidence';
import { commandTool, type AnyCommandTool, type ApplyContext } from './tool.types';

function organizationOf(principal: Principal): string {
  if (!principal.organizationId) throw errors.authenticationRequired();
  return principal.organizationId;
}

const PublishArgs = z
  .object({
    /** Publish this existing draft … */
    draftId: z.uuid().optional(),
    /** … or open a draft with these repair changes and publish it. */
    repair: z
      .object({
        facilityId: z.uuid(),
        name: z.string().trim().min(1).max(200),
        changes: z.array(DraftChangeInputSchema).min(1).max(100),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((a) => (a.draftId === undefined) !== (a.repair === undefined), {
    message: 'Give exactly one of draftId or repair.',
  });

const PublishInput = z.object({
  draftId: z.uuid().optional(),
  draftRevision: z.number().int().optional(),
  repair: z
    .object({
      facilityId: z.uuid(),
      name: z.string(),
      changes: z.array(DraftChangeInputSchema),
    })
    .optional(),
});

const RefundArgs = z
  .object({
    paymentAttemptId: z.uuid(),
    amountMinor: z.number().int().positive(),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();
const RefundInput = RefundArgs;

/** A drafted notice: the communications compose body without command metadata. */
const SendArgs = ComposeNotificationBody.omit({
  expectedRevision: true,
  reason: true,
  policyReferences: true,
});

/**
 * Command tools (SPK-AUTO-003): the consequential commands a recommendation may carry. Proposing
 * one executes nothing; it is authorized like a direct call — the target is read through the
 * owning module with the requester's principal and the command's own action is checked on the
 * real target — and becomes a recommendation. Applying runs the owning module's normal command
 * with the approving reviewer's principal, outside any automation transaction (§4.11).
 * Roster, permission and discipline changes are deliberately absent: the assistant can never
 * propose or apply them; a person makes them through the owning module.
 */
@Injectable()
export class CommandTools {
  constructor(
    private readonly authorization: AuthorizationService,
    private readonly uow: UnitOfWork,
    private readonly drafts: ScheduleDraftsService,
    private readonly notifications: NotificationsService,
    private readonly payments: PaymentsService,
    private readonly refunds: RefundsService,
  ) {}

  all(): AnyCommandTool[] {
    return [this.publishSchedule(), this.sendNotice(), this.refund()];
  }

  /** SPK-AUTO-001 "Propose schedule repairs" → SPK-AUTO-003 "Publishing schedules". */
  private publishSchedule(): AnyCommandTool {
    return commandTool({
      kind: 'command',
      name: 'scheduling.publish_schedule',
      actionId: 'scheduling.publish_schedule',
      description:
        'Propose publishing a schedule draft, or a repair (draft changes) to publish; a person reviews and applies it',
      argumentsDoc: {
        draftId: 'existing draft id (or repair)',
        repair: '{ facilityId, name, changes[] } (or draftId)',
        rationale: 'why',
      },
      argsSchema: PublishArgs,
      propose: async (principal, args, rationale) => {
        const organizationId = organizationOf(principal);
        if (args.draftId) {
          const draft = await this.drafts.get(principal, args.draftId);
          await this.authorization.require(principal, SchedulingActions.publishSchedule, {
            type: 'schedule_draft',
            id: draft.id,
            organizationId,
            facilityId: draft.facilityId,
          });
          const missing = [];
          if (!draft.validationResults || !draft.validationResults.ok) {
            missing.push(
              missingEvidence(
                'schedule_draft_validation',
                draft.id,
                'scheduling.publish_schedule',
                'not_evaluated',
                draft.validationResults
                  ? 'The last validation reported issues; publication re-checks every conflict.'
                  : 'The draft has not been validated; publication re-checks every conflict.',
              ),
            );
          }
          return {
            kind: 'schedule_repair',
            title: `Publish schedule draft “${draft.name}”`.slice(0, 200),
            summary:
              rationale ??
              `Publish the ${draft.changes.length} change(s) of draft “${draft.name}” as one publication.`,
            facilityId: draft.facilityId,
            payload: {
              draftId: draft.id,
              draftName: draft.name,
              draftRevision: draft.revision,
              changeCount: draft.changes.length,
              validationOk: draft.validationResults?.ok ?? null,
            },
            command: {
              actionId: 'scheduling.publish_schedule',
              input: { draftId: draft.id, draftRevision: draft.revision },
              target: { type: 'schedule_draft', id: draft.id, facilityId: draft.facilityId },
            },
            evidence: [
              {
                recordType: 'schedule_draft',
                recordId: draft.id,
                label: draft.name,
                asOf: draft.lastSavedAt,
                basis: 'record',
              },
            ],
            missing,
          };
        }
        const repair = args.repair as NonNullable<typeof args.repair>;
        // A repair opens a draft and publishes it: the requester must be able to do both.
        await this.authorization.require(principal, SchedulingActions.manageDrafts, {
          type: 'schedule_draft',
          organizationId,
          facilityId: repair.facilityId,
        });
        await this.authorization.require(principal, SchedulingActions.publishSchedule, {
          type: 'schedule_draft',
          organizationId,
          facilityId: repair.facilityId,
        });
        return {
          kind: 'schedule_repair',
          title: `Schedule repair: ${repair.name}`.slice(0, 200),
          summary:
            rationale ??
            `Open draft “${repair.name}” with ${repair.changes.length} change(s) and publish it.`,
          facilityId: repair.facilityId,
          payload: { repair },
          command: {
            actionId: 'scheduling.publish_schedule',
            input: { repair },
            target: { type: 'schedule_draft', id: null, facilityId: repair.facilityId },
          },
          evidence: [],
          missing: [
            missingEvidence(
              'schedule_draft_validation',
              null,
              'scheduling.publish_schedule',
              'not_evaluated',
              'The repair has not been validated yet; publication checks every conflict when applied.',
            ),
          ],
        };
      },
      apply: async (reviewer, rawInput, ctx) => {
        const input = PublishInput.parse(rawInput);
        const meta = {
          reason: ctx.reason ?? undefined,
          policyReferences: ctx.policyReferences.length ? [...ctx.policyReferences] : undefined,
        };
        let draftId = input.draftId;
        let expectedRevision = input.draftRevision;
        if (!draftId) {
          const repair = input.repair as NonNullable<typeof input.repair>;
          const body = CreateScheduleDraftBody.parse({
            facilityId: repair.facilityId,
            name: repair.name,
            changes: repair.changes,
            ...meta,
          });
          const draft = await this.drafts.create(reviewer, body, ctx.correlationId ?? undefined);
          draftId = draft.id;
          expectedRevision = draft.revision;
        }
        const publication = await this.drafts.publish(
          reviewer,
          draftId,
          { expectedRevision, ...meta },
          ctx.correlationId ?? undefined,
        );
        return {
          commandOperationId: publication.operationId,
          record: { type: 'schedule_publication', id: publication.id },
          result: { draftId, publicationId: publication.id, eventIds: publication.eventIds },
        };
      },
    });
  }

  /** SPK-AUTO-001 "Draft communications" → SPK-AUTO-003 "Sending external communications". */
  private sendNotice(): AnyCommandTool {
    return commandTool({
      kind: 'command',
      name: 'communications.send',
      actionId: 'communications.send',
      description:
        'Propose a drafted notice (kind, audience, title, body); a person reviews it and sends it',
      argumentsDoc: {
        kind: 'notification kind',
        audience: '{ subjectPersonIds, staffRoles, teamEntryIds, personIds, facilityId }',
        title: 'title',
        body: 'body',
        facilityId: 'optional facility id',
      },
      argsSchema: SendArgs,
      propose: async (principal, args, rationale) => {
        const organizationId = organizationOf(principal);
        const target = {
          type: 'notification',
          organizationId,
          facilityId: args.facilityId ?? null,
        };
        // Sending is compose + send: the requester must hold both, as for a direct call.
        await this.authorization.require(principal, CommunicationsActions.compose, target);
        await this.authorization.require(principal, CommunicationsActions.send, target);
        return {
          kind: 'communication_draft',
          title: `Send “${args.title}”`.slice(0, 200),
          summary: rationale ?? `Send the drafted ${args.kind.replace(/_/g, ' ')} notice.`,
          facilityId: args.facilityId ?? null,
          payload: {
            kind: args.kind,
            category: args.category,
            title: args.title,
            body: args.body,
            audience: args.audience,
            protected: args.protected,
          },
          command: {
            actionId: 'communications.send',
            input: args as unknown as Record<string, unknown>,
            target: { type: 'notification', id: null, facilityId: args.facilityId ?? null },
          },
          evidence: [],
          missing: [],
        };
      },
      apply: async (reviewer, rawInput, ctx) => {
        const body: ComposeNotificationInput = ComposeNotificationBody.parse({
          ...rawInput,
          reason: ctx.reason ?? undefined,
          policyReferences: ctx.policyReferences.length ? [...ctx.policyReferences] : undefined,
        });
        const notification = await this.notifications.composeAndQueue(
          reviewer,
          body,
          ctx.correlationId,
        );
        return {
          commandOperationId: notification.operationId,
          record: { type: 'notification', id: notification.id },
          result: { notificationId: notification.id, status: notification.status },
        };
      },
    });
  }

  /** SPK-AUTO-001 "Explain financial exceptions" with a proposed refund → "Charging or refunding". */
  private refund(): AnyCommandTool {
    return commandTool({
      kind: 'command',
      name: 'finance.refund',
      actionId: 'finance.refund',
      description:
        'Propose a refund of a captured payment with a reason; a finance reviewer applies it',
      argumentsDoc: {
        paymentAttemptId: 'payment attempt id',
        amountMinor: 'minor units',
        reason: 'why',
      },
      argsSchema: RefundArgs,
      propose: async (principal, args, rationale) => {
        const organizationId = organizationOf(principal);
        // The payment is customer-private: whoever may not read it learns nothing (§4.10).
        const payment = await this.payments.get(principal, args.paymentAttemptId);
        await this.authorization.require(principal, FinanceActions.refund, {
          type: 'payment_attempt',
          id: payment.id,
          organizationId,
        });
        if (payment.status !== 'succeeded') {
          throw errors.invalidTransition('PaymentAttempt', payment.status, 'refund');
        }
        return {
          kind: 'financial_exception_explanation',
          title: `Refund ${args.amountMinor} ${payment.currency} (minor units) of payment ${payment.id.slice(0, 8)}`,
          summary: rationale ?? args.reason,
          facilityId: null,
          payload: {
            paymentAttemptId: payment.id,
            paymentStatus: payment.status,
            paymentAmountMinor: payment.amountMinor,
            currency: payment.currency,
            amountMinor: args.amountMinor,
            reason: args.reason,
          },
          command: {
            actionId: 'finance.refund',
            input: { ...args },
            target: { type: 'payment_attempt', id: payment.id, facilityId: null },
          },
          evidence: [
            {
              recordType: 'payment_attempt',
              recordId: payment.id,
              label: `Payment ${payment.status}`,
              asOf: payment.resolvedAt ?? payment.updatedAt,
              basis: 'record',
            },
          ],
          missing: [],
        };
      },
      apply: async (reviewer, rawInput, ctx) => {
        const input = RefundInput.parse(rawInput);
        // Finance authorizes `finance.refund` for the reviewer and enforces the refundable ceiling
        // (§4.7 invariant 6); automation adds no authority of its own.
        const refund = await this.refunds.request(
          reviewer,
          input.paymentAttemptId,
          { amountMinor: input.amountMinor, reason: ctx.reason ?? input.reason },
          ctx.correlationId,
        );
        return {
          commandOperationId: refund.operationId,
          record: { type: 'refund_attempt', id: refund.id },
          result: { refundId: refund.id, status: refund.status },
        };
      },
      effectRecordedDespiteError: async (reviewer, rawInput, ctx: ApplyContext) => {
        // Finance audits the reservation in the transaction that makes it; a refusal raised after
        // that point leaves a reserved refund, so the outcome is unknown, never failed.
        const input = RefundInput.parse(rawInput);
        let q = this.uow
          .reader()
          .selectFrom('audit_records')
          .select('id')
          .where('organization_id', '=', organizationOf(reviewer))
          .where('action', '=', FinanceActions.refund.id)
          .where('occurred_at', '>=', ctx.startedAt)
          .where(sql<SqlBool>`actor->>'accountId' = ${reviewer.accountId ?? ''}`)
          .where(sql<SqlBool>`details->>'paymentAttemptId' = ${input.paymentAttemptId}`)
          .where(sql<SqlBool>`details->>'amountMinor' = ${String(input.amountMinor)}`);
        if (ctx.correlationId) q = q.where('correlation_id', '=', ctx.correlationId);
        return (await q.executeTakeFirst()) !== undefined;
      },
    });
  }
}
