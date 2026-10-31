import { Injectable } from '@nestjs/common';
import type { DomainEvent, EventPayload } from '@sportspark/contracts';
import { OperationalExceptions, type HandlerContext } from '../../../kernel';
import type { IdentityEvents } from '../../identity';

type PersonsMerged = EventPayload<typeof IdentityEvents.personsMerged>;

/** The exception a merge raises when the merged record still holds money (R2-LIFECYCLES-02). */
export const MERGED_PERSON_MONEY = 'finance.merged_person_money';

/**
 * Person merge follow-up (R2-LIFECYCLES-02; SPK-IAM-007, SPK-PAY-004, SPK-PAY-009, §4.12): finance
 * never rewrites the owner of a credit or the debtor of an obligation (they are financial facts;
 * credits, obligations, quotes and the arrival standing read them through the survivor instead,
 * FinanceCustomerScope). What a merge can leave behind is money a person may have been given
 * twice: the merged record's live credits and open debts now count for the survivor, beside any
 * the survivor already had (a goodwill credit issued again to the survivor would double the
 * liability). One `finance.merged_person_money` exception per merge goes to the finance operator
 * naming them, so a person reviews the two records' money. Nothing is raised when the merged
 * record holds no active or pending credit with a balance and owes or answers for no open
 * obligation. Idempotent by merge id: a replay, or a second delivery of the same merge, raises
 * nothing new, whatever the earlier exception's status.
 */
@Injectable()
export class PersonMergeMoneyFollowUp {
  constructor(private readonly exceptions: OperationalExceptions) {}

  async onPersonsMerged(event: DomainEvent<PersonsMerged>, ctx: HandlerContext): Promise<void> {
    const { mergeId, survivorPersonId, mergedPersonId } = event.payload;
    const organizationId = event.organizationId;
    if (survivorPersonId === mergedPersonId) return;
    const earlier = await this.exceptions.list(
      organizationId,
      {
        category: MERGED_PERSON_MONEY,
        affectedType: 'person',
        affectedId: survivorPersonId,
        limit: 200,
      },
      ctx.trx,
    );
    if (earlier.items.some((e) => detailsOf(e.details)['mergeId'] === mergeId)) return;

    const credits = await ctx.trx
      .selectFrom('credits')
      .select(['id', 'currency', 'remaining_minor', 'status'])
      .where('organization_id', '=', organizationId)
      .where('owner_person_id', '=', mergedPersonId)
      .where('status', 'in', ['active', 'pending_approval'])
      .where('remaining_minor', '>', 0)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    const obligations = await ctx.trx
      .selectFrom('obligations')
      .select(['id', 'currency', 'amount_minor', 'allocated_minor', 'description'])
      .where('organization_id', '=', organizationId)
      .where('status', '=', 'open')
      .where((eb) =>
        eb.or([
          eb('debtor_person_id', '=', mergedPersonId),
          eb('responsible_payer_person_id', '=', mergedPersonId),
        ]),
      )
      .orderBy('due_at')
      .orderBy('id')
      .execute();
    if (credits.length === 0 && obligations.length === 0) return;

    await this.exceptions.raise(ctx.trx, {
      organizationId,
      category: MERGED_PERSON_MONEY,
      severity: 'warning',
      title: `A merged person record still holds ${credits.length} credit(s) and ${obligations.length} open obligation(s)`,
      affectedType: 'person',
      affectedId: survivorPersonId,
      ownerQueue: 'finance_operator',
      dedupeKey: `${MERGED_PERSON_MONEY}:${mergeId}`,
      details: {
        mergeId,
        survivorPersonId,
        mergedPersonId,
        credits: credits.map((c) => ({
          creditId: c.id,
          status: c.status,
          remainingMinor: Number(c.remaining_minor),
          currency: c.currency,
        })),
        obligations: obligations.map((o) => ({
          obligationId: o.id,
          description: o.description,
          outstandingMinor: Number(o.amount_minor) - Number(o.allocated_minor),
          currency: o.currency,
        })),
        requiredAction:
          'Review the credits and open obligations of both records; they now count for the surviving record. Revoke or settle anything given or owed twice.',
      },
    });
  }
}

function detailsOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}
