import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  type ApproveCreditInput,
  type Credit,
  type IssueCreditInput,
  type ListCreditsQuery,
  type Page,
  type Principal,
  type RedeemCreditInput,
} from '@sportspark/contracts';
import { isUniqueViolation, json, pgConstraintName, type Db } from '@sportspark/db';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  Outbox,
  UnitOfWork,
  assertExpectedRevision,
  snapshotActor,
  type Clock,
} from '../../../kernel';
import { PERSON_DIRECTORY_PORT, type PersonDirectoryPort } from '../../identity';
import { FinanceActions } from '../finance.actions';
import {
  afterKeysetAsc,
  decodeKeyset,
  isStaffLike,
  keysetAt,
  keysetPage,
  organizationOf,
  toCredit,
  type CreditRow,
  type Reader,
} from '../finance.shared';
import { LedgerService } from '../ledger/ledger.service';
import { MoneyFacts } from './money-facts.service';

/**
 * Credits (SPK-PAY-009): explicit owner, currency, permitted uses, expiry when approved,
 * remaining balance, source and redemption history. Issuance posts to `credits_payable`; an
 * overpayment credit moves from `overpayment_liability` only when finance approves it (POL-015).
 * Redemption is the conditional UPDATE in MoneyFacts (§4.7 invariant 7).
 */
@Injectable()
export class CreditsService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly ledger: LedgerService,
    private readonly facts: MoneyFacts,
    @Inject(PERSON_DIRECTORY_PORT) private readonly people: PersonDirectoryPort,
  ) {}

  async view(db: Reader, row: CreditRow): Promise<Credit> {
    const redemptions = await db
      .selectFrom('credit_redemptions')
      .selectAll()
      .where('organization_id', '=', row.organization_id)
      .where('credit_id', '=', row.id)
      .orderBy('redeemed_at')
      .orderBy('id')
      .execute();
    return toCredit(row, redemptions, this.clock.now());
  }

  async get(principal: Principal, id: string): Promise<Credit> {
    const organizationId = organizationOf(principal);
    const row = await this.facts.loadCredit(this.db, organizationId, id);
    if (!row) throw errors.protectedNotFound('credit');
    await this.authorization.require(principal, FinanceActions.readCredit, {
      type: 'credit',
      id,
      organizationId,
      subjectPersonIds: [row.owner_person_id],
      protected: true,
    });
    return this.view(this.db, row);
  }

  async list(principal: Principal, query: ListCreditsQuery): Promise<Page<Credit>> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, FinanceActions.readCredit, {
      type: 'credit',
      organizationId,
      subjectPersonIds: [query.ownerPersonId],
      protected: true,
    });
    // FIN-02 (§4.5): keyset pages in (created_at, id) order.
    const cursor = decodeKeyset(query.cursor);
    let q = this.db
      .selectFrom('credits')
      .selectAll()
      .select(keysetAt('credits').as('cursor_at'))
      .where('organization_id', '=', organizationId)
      .where('owner_person_id', '=', query.ownerPersonId)
      .orderBy('created_at')
      .orderBy('id')
      .limit(query.limit + 1);
    if (cursor) q = q.where(afterKeysetAsc('credits', cursor));
    const page = keysetPage(await q.execute(), query.limit);
    const items: Credit[] = [];
    for (const row of page.rows) items.push(await this.view(this.db, row));
    return { items, nextCursor: page.nextCursor };
  }

  /**
   * POST /credits: a goodwill or adjustment credit (finance staff, reason required, audited).
   *
   * `options.sourceId` (in-process callers only, never the HTTP body) names the source fact the
   * credit is issued for — for example the migration mapping of an imported opening balance — so
   * the database refuses a second credit for the same fact (`credits_source_idx`, §4.7 invariants
   * 5 and 7): RESOURCE_CONFLICT `CREDIT_ALREADY_ISSUED_FOR_SOURCE`.
   */
  async issue(
    principal: Principal,
    input: IssueCreditInput,
    correlationId: string | null,
    options: { sourceId?: string } = {},
  ): Promise<Credit> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, FinanceActions.issueCredit, {
      type: 'credit',
      organizationId,
    });
    const now = this.clock.now();
    if (input.expiresAt && new Date(input.expiresAt) <= now) {
      throw errors.validation('A credit cannot expire in the past.');
    }
    try {
      return await this.issueInUnitOfWork(principal, organizationId, input, correlationId, options);
    } catch (error) {
      if (isUniqueViolation(error) && pgConstraintName(error) === 'credits_source_idx') {
        throw errors.resourceConflict('A credit was already issued for this source.', {
          code: 'CREDIT_ALREADY_ISSUED_FOR_SOURCE',
          sourceKind: input.sourceKind,
          sourceId: options.sourceId ?? null,
        });
      }
      throw error;
    }
  }

  private issueInUnitOfWork(
    principal: Principal,
    organizationId: string,
    input: IssueCreditInput,
    correlationId: string | null,
    options: { sourceId?: string },
  ): Promise<Credit> {
    return this.uow.run(async ({ trx }) => {
      // §4.2: identity's person directory, never its tables. SPK-IAM-007: a merged record no
      // longer owns money (the survivor's credit list and checkout would never see the credit), so
      // the credit is refused with the surviving record named, never moved silently.
      const owner = await this.people.findPerson(organizationId, input.ownerPersonId, trx);
      if (!owner) throw errors.notFound('person', input.ownerPersonId);
      if (owner.status === 'merged' || owner.canonicalPersonId !== owner.id) {
        throw errors.validation(
          'This person record was merged; issue the credit to the surviving record.',
          {
            code: 'person_merged',
            ownerPersonId: owner.id,
            canonicalPersonId: owner.canonicalPersonId,
          },
        );
      }
      const id = await this.facts.insertCredit(trx, {
        organizationId,
        ownerPersonId: input.ownerPersonId,
        currency: input.currency,
        amountMinor: input.amountMinor,
        permittedUses: input.permittedUses,
        sourceKind: input.sourceKind,
        sourceId: options.sourceId ?? null,
        status: 'active',
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        reason: input.reason,
        actor: principal,
      });
      await this.ledger.post(trx, {
        organizationId,
        sourceType: 'credit',
        sourceId: id,
        purpose: 'credit_issued',
        description: `Credit issued (${input.sourceKind})`,
        currency: input.currency,
        actor: principal,
        correlationId,
        lines: [
          { account: 'refunds', debitMinor: input.amountMinor, personId: input.ownerPersonId },
          {
            account: 'credits_payable',
            creditMinor: input.amountMinor,
            personId: input.ownerPersonId,
          },
        ],
      });
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: FinanceActions.issueCredit.id,
        targetType: 'credit',
        targetId: id,
        afterRevision: 1,
        reason: input.reason,
        correlationId,
        details: {
          amountMinor: input.amountMinor,
          currency: input.currency,
          sourceKind: input.sourceKind,
        },
      });
      const row = await this.facts.loadCredit(trx, organizationId, id);
      return this.view(trx, row as CreditRow);
    });
  }

  /** POST /credits/{id}/approve: an overpayment credit held pending approval becomes usable. */
  async approve(
    principal: Principal,
    id: string,
    input: ApproveCreditInput,
    correlationId: string | null,
  ): Promise<Credit> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      // §4.10: a finance-only command is authorized before the record is read, so a caller
      // without the role gets the same answer whether or not the credit exists.
      await this.authorization.require(principal, FinanceActions.approveCredit, {
        type: 'credit',
        id,
        organizationId,
      });
      const credit = await this.facts.loadCredit(trx, organizationId, id, true);
      if (!credit) throw errors.protectedNotFound('credit');
      assertExpectedRevision(input.expectedRevision, credit.revision);
      if (credit.status !== 'pending_approval') {
        throw errors.invalidTransition('Credit', credit.status, 'approve');
      }
      const now = this.clock.now();
      await trx
        .updateTable('credits')
        .set({
          status: 'active',
          approved_at: now,
          approved_by: json(snapshotActor(principal)),
          revision: credit.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', credit.revision)
        .execute();
      await this.ledger.post(trx, {
        organizationId,
        sourceType: 'credit',
        sourceId: id,
        purpose: 'overpayment_credit_approved',
        description: 'Overpayment held as credit approved',
        currency: credit.currency,
        actor: principal,
        correlationId,
        lines: [
          {
            account: 'overpayment_liability',
            debitMinor: credit.original_minor,
            personId: credit.owner_person_id,
          },
          {
            account: 'credits_payable',
            creditMinor: credit.original_minor,
            personId: credit.owner_person_id,
          },
        ],
      });
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: FinanceActions.approveCredit.id,
        targetType: 'credit',
        targetId: id,
        beforeRevision: credit.revision,
        afterRevision: credit.revision + 1,
        reason: input.reason ?? null,
        correlationId,
        details: { policyReferences: input.policyReferences ?? [] },
      });
      const row = await this.facts.loadCredit(trx, organizationId, id);
      return this.view(trx, row as CreditRow);
    });
  }

  /** POST /credits/{id}/redeem: the owner (or someone with pay over them) or desk staff. */
  async redeem(
    principal: Principal,
    id: string,
    input: RedeemCreditInput,
    correlationId: string | null,
  ): Promise<Credit> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const credit = await this.facts.loadCredit(trx, organizationId, id);
      if (!credit) throw errors.protectedNotFound('credit');
      await this.authorization.require(principal, FinanceActions.redeemCredit, {
        type: 'credit',
        id,
        organizationId,
        subjectPersonIds: [credit.owner_person_id],
        protected: true,
      });
      assertExpectedRevision(input.expectedRevision, credit.revision);
      const obligation = await this.facts.loadObligation(trx, organizationId, input.obligationId);
      if (!obligation) throw errors.protectedNotFound('obligation');
      if (!isStaffLike(principal)) {
        // The credit's owner must also be entitled to pay this obligation (no paying into
        // another household's debt by guessing an id, §4.10, §4.14). The same subject as
        // ObligationsService.pay: the debtor of an individual obligation, otherwise the
        // responsible payer, and for the contributions model the team captain; never the
        // credit's owner by default. Refused as not-found before any balance is revealed.
        const subject =
          obligation.mode === 'individual'
            ? obligation.debtor_person_id
            : obligation.responsible_payer_person_id;
        await this.authorization.require(principal, FinanceActions.payObligation, {
          type: 'obligation',
          id: obligation.id,
          organizationId,
          subjectPersonIds: subject ? [subject] : [],
          teamEntryId:
            obligation.mode === 'team_with_contributions' ? obligation.debtor_team_entry_id : null,
          protected: true,
        });
      }
      const { replayed } = await this.facts.redeemCredit(trx, {
        organizationId,
        creditId: id,
        amountMinor: input.amountMinor,
        currency: credit.currency,
        use: 'obligation',
        ownerPersonId: credit.owner_person_id,
        referenceType: 'obligation',
        referenceId: input.obligationId,
        obligationId: input.obligationId,
        actor: principal,
        correlationId,
      });
      if (replayed) {
        // SPK-PAY-009, §4.9: a credit is applied to a given obligation once (one redemption per
        // credit and reference; whether repeated partial use is allowed is pending POL-010 /
        // DEC-058). A true replay never reaches here (the Idempotency-Key returns the stored
        // response), so this is a second, distinct command: refused, nothing audited.
        throw errors.resourceConflict('This credit has already been applied to this obligation.', {
          code: 'CREDIT_ALREADY_APPLIED',
        });
      }
      const row = (await this.facts.loadCredit(trx, organizationId, id)) as CreditRow;
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: FinanceActions.redeemCredit.id,
        targetType: 'credit',
        targetId: id,
        beforeRevision: credit.revision,
        afterRevision: row.revision,
        correlationId,
        details: { obligationId: input.obligationId, amountMinor: input.amountMinor },
      });
      return this.view(trx, row);
    });
  }
}
