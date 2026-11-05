import { Injectable } from '@nestjs/common';
import type { DomainEvent, EventPayload } from '@sportspark/contracts';
import { OperationalExceptions, type HandlerContext, type Trx } from '../../../kernel';
import type { IdentityEvents } from '../../identity';
import { FinanceCustomerScope } from './customer-scope';

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
 * naming them, each row with the record that holds it, so a person reviews the two sides' money.
 *
 * Merges chain (A into B, later B into C): the money that joins the survivor is that of the merged
 * record and of every record merged into it earlier, whose own exception named the earlier
 * survivor and may already be resolved. Identity's directory gives the survivor's whole merge tree
 * (`personIdsResolvingTo`), not the branch that just joined it, so every record of that tree but
 * the survivor is read, and money an earlier exception of this survivor already named (a record
 * merged into it before) is left out. Nothing is raised when nothing is left: no active or pending
 * credit with a balance, no open obligation owed or answered for. Idempotent by merge id: a
 * replay, or a second delivery of the same merge, raises nothing new, whatever the earlier
 * exception's status.
 */
@Injectable()
export class PersonMergeMoneyFollowUp {
  constructor(
    private readonly exceptions: OperationalExceptions,
    private readonly scope: FinanceCustomerScope,
  ) {}

  async onPersonsMerged(event: DomainEvent<PersonsMerged>, ctx: HandlerContext): Promise<void> {
    const { mergeId, survivorPersonId, mergedPersonId } = event.payload;
    const organizationId = event.organizationId;
    if (survivorPersonId === mergedPersonId) return;
    const earlier = await this.earlierExceptions(organizationId, survivorPersonId, ctx.trx);
    if (earlier.some((details) => details['mergeId'] === mergeId)) return;
    const named = namedMoney(earlier);

    // The survivor's merge tree is `[canonical, ...merged records]`; the canonical record is the
    // survivor (or, if the survivor was merged on meanwhile, its own survivor): its money is the
    // side the merged records join, not money that joined it.
    const tree = await this.scope.idsOf(organizationId, survivorPersonId, ctx.trx);
    const canonical = tree[0];
    const records = [
      ...new Set([
        mergedPersonId,
        ...tree.filter((id) => id !== survivorPersonId && id !== canonical),
      ]),
    ];

    const credits = (
      await ctx.trx
        .selectFrom('credits')
        .select(['id', 'owner_person_id', 'currency', 'remaining_minor', 'status'])
        .where('organization_id', '=', organizationId)
        .where('owner_person_id', 'in', records)
        .where('status', 'in', ['active', 'pending_approval'])
        .where('remaining_minor', '>', 0)
        .orderBy('created_at')
        .orderBy('id')
        .execute()
    ).filter((c) => !named.credits.has(c.id));
    const obligations = (
      await ctx.trx
        .selectFrom('obligations')
        .select([
          'id',
          'debtor_person_id',
          'responsible_payer_person_id',
          'currency',
          'amount_minor',
          'allocated_minor',
          'description',
        ])
        .where('organization_id', '=', organizationId)
        .where('status', '=', 'open')
        .where((eb) =>
          eb.or([
            eb('debtor_person_id', 'in', records),
            eb('responsible_payer_person_id', 'in', records),
          ]),
        )
        .orderBy('due_at')
        .orderBy('id')
        .execute()
    ).filter((o) => !named.obligations.has(o.id));
    if (credits.length === 0 && obligations.length === 0) return;

    await this.exceptions.raise(ctx.trx, {
      organizationId,
      category: MERGED_PERSON_MONEY,
      severity: 'warning',
      title: `Merged person records still hold ${credits.length} credit(s) and ${obligations.length} open obligation(s)`,
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
          ownerPersonId: c.owner_person_id,
          status: c.status,
          remainingMinor: Number(c.remaining_minor),
          currency: c.currency,
        })),
        obligations: obligations.map((o) => ({
          obligationId: o.id,
          debtorPersonId: o.debtor_person_id,
          responsiblePayerPersonId: o.responsible_payer_person_id,
          description: o.description,
          outstandingMinor: Number(o.amount_minor) - Number(o.allocated_minor),
          currency: o.currency,
        })),
        requiredAction:
          'Review these credits and open obligations against those of the surviving record; they now count for it. Revoke or settle anything given or owed twice.',
      },
    });
  }

  /** The details of every earlier merge exception of the survivor, any status, all pages. */
  private async earlierExceptions(
    organizationId: string,
    survivorPersonId: string,
    trx: Trx,
  ): Promise<Array<Record<string, unknown>>> {
    const found: Array<Record<string, unknown>> = [];
    let cursor: string | undefined;
    do {
      const page = await this.exceptions.list(
        organizationId,
        {
          category: MERGED_PERSON_MONEY,
          affectedType: 'person',
          affectedId: survivorPersonId,
          limit: 200,
          ...(cursor ? { cursor } : {}),
        },
        trx,
      );
      found.push(...page.items.map((e) => detailsOf(e.details)));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return found;
  }
}

/** The credits and obligations earlier merge exceptions of one survivor already named. */
function namedMoney(earlier: Array<Record<string, unknown>>): {
  credits: Set<string>;
  obligations: Set<string>;
} {
  const credits = new Set<string>();
  const obligations = new Set<string>();
  for (const details of earlier) {
    for (const row of rowsOf(details['credits'])) {
      if (typeof row['creditId'] === 'string') credits.add(row['creditId']);
    }
    for (const row of rowsOf(details['obligations'])) {
      if (typeof row['obligationId'] === 'string') obligations.add(row['obligationId']);
    }
  }
  return { credits, obligations };
}

function rowsOf(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(detailsOf) : [];
}

function detailsOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}
