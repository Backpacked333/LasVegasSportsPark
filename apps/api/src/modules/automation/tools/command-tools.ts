import { Inject, Injectable } from '@nestjs/common';
import {
  ComposeNotificationBody,
  CreateScheduleDraftBody,
  DomainError,
  DraftChangeInputSchema,
  errors,
  z,
  type Audience,
  type ComposeNotificationInput,
  type NotificationCategoryValue,
  type NotificationKindValue,
  type Principal,
} from '@sportspark/contracts';
import { sql, type SqlBool } from 'kysely';
import {
  AuthorizationService,
  UnitOfWork,
  listFacilityScope,
  type ActionDefinition,
} from '../../../kernel';
import {
  COMMUNICATIONS_POLICY,
  CommunicationsActions,
  NotificationsService,
  type CommunicationsPolicy,
} from '../../communications';
import { FinanceActions, PaymentsService, RefundsService } from '../../finance';
import { EventsService, ScheduleDraftsService, SchedulingActions } from '../../scheduling';
import { missingEvidence, type EvidenceDraft } from '../evidence';
import { ApplyFailure, commandTool, type AnyCommandTool, type ApplyContext } from './tool.types';

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
  /**
   * R4-COMMS-AUTOMATION-01 (SPK-SCHED-005, §4.9): the revision of every event a repair changes, as
   * the requester read it through scheduling when the repair was proposed. Recorded by the module,
   * never taken from the provider.
   */
  baseRevisions: z.record(z.uuid(), z.number().int()).optional(),
});
type PublishInput = z.infer<typeof PublishInput>;

/** The events a repair's changes name (each once, in order). */
function repairTargets(changes: ReadonlyArray<{ targetEventId?: string | undefined }>): string[] {
  return [
    ...new Set(changes.map((c) => c.targetEventId).filter((id): id is string => Boolean(id))),
  ];
}

/**
 * R4-COMMS-AUTOMATION-01 (SPK-SCHED-005, §4.9 "a sensitive stale edit must fail"): a repair is a
 * draft held for review, so it carries the revision of each event it changes from its proposal and
 * is never published over a change made after that. The refusal is a failed apply (nothing ran;
 * the claim is released).
 */
function repairTargetChanged(
  eventId: string,
  expected: number | null,
  actual: number,
): ApplyFailure {
  return new ApplyFailure(
    new DomainError(
      'STALE_REVISION',
      'An event this repair changes was changed after the repair was proposed; ask for a new repair instead of applying this one.',
      {
        details: {
          code: 'REPAIR_TARGET_CHANGED',
          eventId,
          expectedRevision: expected,
          currentRevision: actual,
        },
      },
    ),
    { outcome: 'failed' },
  );
}

/** What a refused repair publication carries to the next apply: the draft it opened. */
const RepairCarry = z.object({ repairDraftId: z.uuid(), lastSavedAt: z.string() });
type RepairCarry = z.infer<typeof RepairCarry>;

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
    private readonly events: EventsService,
    private readonly notifications: NotificationsService,
    @Inject(COMMUNICATIONS_POLICY) private readonly communicationsPolicy: CommunicationsPolicy,
    private readonly payments: PaymentsService,
    private readonly refunds: RefundsService,
  ) {}

  all(): AnyCommandTool[] {
    return [this.publishSchedule(), this.sendNotice(), this.refund()];
  }

  /**
   * A facility the provider chose is data, not authority (SPK-AUTO-004): it must be a facility of
   * the requester's organization before anything is authorized or proposed on it. A missing id and
   * another organization's id are refused alike (NOT_FOUND), so nothing about either is disclosed,
   * and the proposal can never carry a facility the recommendation's composite key would refuse.
   */
  private async requireFacility(organizationId: string, facilityId: string): Promise<void> {
    const row = await this.uow
      .reader()
      .selectFrom('facilities')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('id', '=', facilityId)
      .executeTakeFirst();
    if (!row) throw errors.notFound('facility', facilityId);
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
        await this.requireFacility(organizationId, repair.facilityId);
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
        // R4-COMMS-AUTOMATION-01 (SPK-SCHED-005): every event the repair changes is read through
        // scheduling with the requester's principal, and its revision becomes the repair's base —
        // what a draft opened now would capture — so a later change to it refuses the apply.
        const baseRevisions: Record<string, number> = {};
        const evidence: EvidenceDraft[] = [];
        for (const eventId of repairTargets(repair.changes)) {
          const event = await this.events.getEvent(principal, eventId);
          if (event.facilityId !== repair.facilityId) {
            throw errors.validation('A target event of the repair is not in its facility.', {
              targetEventId: eventId,
            });
          }
          baseRevisions[event.id] = event.revision;
          evidence.push({
            recordType: 'event',
            recordId: event.id,
            label: `${event.title} (${event.status}, revision ${event.revision})`,
            asOf: event.updatedAt,
            basis: 'record',
          });
        }
        return {
          kind: 'schedule_repair',
          title: `Schedule repair: ${repair.name}`.slice(0, 200),
          summary:
            rationale ??
            `Open draft “${repair.name}” with ${repair.changes.length} change(s) and publish it.`,
          facilityId: repair.facilityId,
          payload: { repair, baseRevisions },
          command: {
            actionId: 'scheduling.publish_schedule',
            input: { repair, baseRevisions },
            target: { type: 'schedule_draft', id: null, facilityId: repair.facilityId },
          },
          evidence,
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
        const publish = async (draftId: string, expectedRevision: number | undefined) => {
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
        };
        if (input.draftId) return publish(input.draftId, input.draftRevision);
        const repair = input.repair as NonNullable<typeof input.repair>;
        // §4.11: a refused publication leaves the draft this repair opened. A retry publishes that
        // draft again instead of opening another, as long as nobody changed, published or
        // discarded it meanwhile — then the reviewer settles it in scheduling.
        const previous = RepairCarry.safeParse(ctx.carried ?? undefined);
        let carry: RepairCarry | null = previous.success ? previous.data : null;
        try {
          if (carry) {
            const draft = await this.drafts.get(reviewer, carry.repairDraftId);
            if (
              draft.lastSavedAt !== carry.lastSavedAt ||
              draft.status === 'published' ||
              draft.status === 'discarded'
            ) {
              throw errors.resourceConflict(
                'The draft this repair opened was changed, published or discarded outside this recommendation; review it in scheduling instead.',
                { code: 'REPAIR_DRAFT_CHANGED', draftId: draft.id, draftStatus: draft.status },
              );
            }
            this.assertDraftOnRepairBase(input, draft.changes, draft.id, carry);
            return await publish(draft.id, draft.revision);
          }
          // Nothing is opened for a repair whose events moved on since it was proposed …
          await this.assertRepairBase(reviewer, input);
          const body = CreateScheduleDraftBody.parse({
            facilityId: repair.facilityId,
            name: repair.name,
            changes: repair.changes,
            ...meta,
          });
          const draft = await this.drafts.create(reviewer, body, ctx.correlationId ?? undefined);
          try {
            // … and a draft that captured a later revision (a change between that read and the
            // draft) is discarded, never published; scheduling then holds the base to publication.
            this.assertDraftOnRepairBase(input, draft.changes, draft.id, null);
          } catch (stale) {
            await this.drafts
              .discard(
                reviewer,
                draft.id,
                {
                  expectedRevision: draft.revision,
                  reason: 'An event of this repair changed after the repair was proposed.',
                },
                ctx.correlationId ?? undefined,
              )
              .catch(() => undefined);
            throw stale;
          }
          carry = { repairDraftId: draft.id, lastSavedAt: draft.lastSavedAt };
          return await publish(draft.id, draft.revision);
        } catch (error) {
          if (!carry || error instanceof ApplyFailure) throw error;
          throw new ApplyFailure(error, {
            record: { type: 'schedule_draft', id: carry.repairDraftId },
            carried: carry,
          });
        }
      },
    });
  }

  /**
   * R4-COMMS-AUTOMATION-01: each event the repair changes, read as the reviewer, is still at the
   * revision the proposal recorded. A repair stored without them (proposed before they were
   * recorded) cannot be checked and is refused the same way.
   */
  private async assertRepairBase(reviewer: Principal, input: PublishInput): Promise<void> {
    for (const eventId of repairTargets(input.repair?.changes ?? [])) {
      const expected = input.baseRevisions?.[eventId];
      const event = await this.events.getEvent(reviewer, eventId);
      if (expected === undefined || event.revision !== expected) {
        throw repairTargetChanged(eventId, expected ?? null, event.revision);
      }
    }
  }

  /**
   * The draft opened (or carried) for a repair captured exactly the proposal's base revisions. A
   * refusal names the draft; a carried one stays carried, a just-opened one is not.
   */
  private assertDraftOnRepairBase(
    input: PublishInput,
    changes: ReadonlyArray<{ targetEventId: string | null; baseEventRevision: number | null }>,
    draftId: string,
    carried: RepairCarry | null,
  ): void {
    for (const change of changes) {
      if (!change.targetEventId) continue;
      const expected = input.baseRevisions?.[change.targetEventId];
      if (expected === undefined || change.baseEventRevision !== expected) {
        const failure = repairTargetChanged(
          change.targetEventId,
          expected ?? null,
          change.baseEventRevision ?? 0,
        );
        throw new ApplyFailure(failure.error, {
          ...failure.options,
          record: { type: 'schedule_draft', id: draftId },
          ...(carried ? { carried } : {}),
        });
      }
    }
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
        if (args.facilityId) await this.requireFacility(organizationId, args.facilityId);
        if (args.audience.facilityId && args.audience.facilityId !== args.facilityId) {
          await this.requireFacility(organizationId, args.audience.facilityId);
        }
        // R4-COMMS-AUTOMATION-10 (SPK-AUTO-004, SPK-COMMS-006, invariant 10): the rules of a
        // direct compose and send, so a requester can never propose a notice they could not send.
        if (args.protected && args.audience.personIds.length > 0) {
          throw errors.validation(
            'A protected notice must address people through subject persons, team entries or staff roles, whose authority is re-checked before dispatch; explicit person ids carry no authority.',
            { code: 'PROTECTED_EXPLICIT_RECIPIENT', path: 'audience.personIds' },
          );
        }
        // Sending is compose + send: the requester must hold both on the notice's facility and on
        // its audience's facility, as for a direct call.
        for (const action of [CommunicationsActions.compose, CommunicationsActions.send]) {
          await this.requireAudience(
            principal,
            action,
            organizationId,
            args.facilityId ?? null,
            args.audience,
          );
        }
        this.requireCategory(args.kind, args.category);
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

  /**
   * R4-COMMS-AUTOMATION-10: communications' audience rule (SPK-COMMS-006, §4.14) — the action on
   * the notice's facility and on the audience's facility, and a facility-scoped composer never
   * addresses a staff role across every facility.
   */
  private async requireAudience(
    principal: Principal,
    action: ActionDefinition,
    organizationId: string,
    facilityId: string | null,
    audience: Audience,
  ): Promise<void> {
    for (const facility of new Set([facilityId, audience.facilityId])) {
      await this.authorization.require(principal, action, {
        type: 'notification',
        organizationId,
        facilityId: facility,
      });
    }
    if (
      listFacilityScope(principal, action) !== null &&
      audience.staffRoles.length > 0 &&
      audience.facilityId === null
    ) {
      throw errors.accessDenied(
        'A facility-scoped composer addresses staff roles within one of their facilities.',
        { action: action.id },
      );
    }
  }

  /** SPK-COMMS-007: the category follows the communication policy's binding for the kind. */
  private requireCategory(
    kind: NotificationKindValue,
    requested: NotificationCategoryValue | undefined,
  ): void {
    const bound = this.communicationsPolicy.categoryByKind[kind] ?? 'choose';
    if (bound === 'choose' && !requested) {
      throw errors.validation('This kind of notice must name its category.', {
        code: 'CATEGORY_REQUIRED',
        path: 'category',
        kind,
        allowed: ['operational', 'promotional'],
      });
    }
    if (bound !== 'choose' && requested && requested !== bound) {
      throw errors.validation(`A ${kind.replace(/_/g, ' ')} notice is ${bound}.`, {
        code: 'CATEGORY_MISMATCH',
        path: 'category',
        kind,
        category: requested,
        required: bound,
      });
    }
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
        let refund: Awaited<ReturnType<RefundsService['request']>>;
        try {
          refund = await this.refunds.request(
            reviewer,
            input.paymentAttemptId,
            { amountMinor: input.amountMinor, reason: ctx.reason ?? input.reason },
            ctx.correlationId,
          );
        } catch (error) {
          // R3-OPERATIONS-02 (§5.8, SPK-AT-028): during recovery finance refuses the refund
          // before anything is reserved or sent, so the apply failed with a known outcome and may
          // be retried after POST /v1/recovery/resume.
          if (
            DomainError.is(error) &&
            error.code === 'INTEGRATION_UNAVAILABLE' &&
            (error.details as { reason?: unknown } | undefined)?.reason === 'recovery_mode'
          ) {
            throw new ApplyFailure(error, { outcome: 'failed' });
          }
          throw error;
        }
        // SPK-AUTO-003, §4.11: the recommendation is applied only when the money moved. A refund
        // the provider declined (its reservation released) is a failed apply that may be retried;
        // one whose outcome is not reported yet keeps the apply claimed until it is reconciled.
        const record = { type: 'refund_attempt', id: refund.id };
        if (refund.status === 'failed' || refund.status === 'canceled') {
          throw new ApplyFailure(
            errors.resourceConflict('The refund did not go through; nothing was refunded.', {
              code: 'REFUND_NOT_COMPLETED',
              refundId: refund.id,
              refundStatus: refund.status,
              failureReason: refund.failureReason,
            }),
            { outcome: 'failed', record },
          );
        }
        if (refund.status !== 'succeeded') {
          throw new ApplyFailure(
            errors.paymentOutcomeUnknown({ refundId: refund.id, refundStatus: refund.status }),
            { outcome: 'unknown', record },
          );
        }
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
