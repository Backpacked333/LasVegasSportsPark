import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  type ContributionRequest,
  type ContributionSummary,
  type CreateContributionRequestInput,
  type CreateObligationInput,
  type ListObligationsQuery,
  type Obligation,
  type Page,
  type PayContributionInput,
  type PayObligationInput,
  type PaymentOutcome,
  type Principal,
} from '@sportspark/contracts';
import { isUniqueViolation, json, type Db } from '@sportspark/db';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  Outbox,
  UnitOfWork,
  snapshotActor,
  type AuthorizationTargetInput,
  type Clock,
  type Trx,
} from '../../../kernel';
import { TEAM_ENTRY_QUERY_PORT, type TeamEntryQueryPort } from '../../competition';
import { PERSON_DIRECTORY_PORT, type PersonDirectoryPort } from '../../identity';
import { FinanceActions } from '../finance.actions';
import { FinanceEvents } from '../finance.events';
import {
  iso,
  isoOrNull,
  isStaffLike,
  organizationOf,
  toPaymentAttempt,
  toReceipt,
  type Reader,
} from '../finance.shared';
import { MoneyFacts, type ObligationRow } from './money-facts.service';
import { PaymentsService } from './payments.service';

/**
 * Obligations and team billing (SPK-PAY-004/005, SPK-AT-022). Three models: individual player
 * billing, one responsible team payer, or ONE team obligation with player contributions. A
 * contribution request is an invitation to pay toward that one obligation: it never copies the
 * debt, carries no amount owed, and grants no authority over anyone's account. Totals (amount,
 * received, allocated, remaining, excess) come from one consistent read; excess from concurrent
 * payments is held per the overpayment policy and stays visible.
 */
@Injectable()
export class ObligationsService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(TEAM_ENTRY_QUERY_PORT) private readonly teamEntries: TeamEntryQueryPort,
    @Inject(PERSON_DIRECTORY_PORT) private readonly people: PersonDirectoryPort,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly facts: MoneyFacts,
    private readonly payments: PaymentsService,
  ) {}

  // -------------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------------

  private readTarget(obligation: ObligationRow): AuthorizationTargetInput {
    return {
      type: 'obligation',
      id: obligation.id,
      organizationId: obligation.organization_id,
      subjectPersonIds: obligation.debtor_person_id ? [obligation.debtor_person_id] : [],
      teamEntryId: obligation.debtor_team_entry_id,
      protected: true,
    };
  }

  /** The debtor (view), the team captain, the responsible payer, or finance readers. */
  private async requireRead(principal: Principal, obligation: ObligationRow): Promise<void> {
    if (
      principal.personId &&
      obligation.responsible_payer_person_id === principal.personId &&
      principal.kind === 'customer'
    ) {
      return;
    }
    await this.authorization.require(
      principal,
      FinanceActions.readObligation,
      this.readTarget(obligation),
    );
  }

  /** Captains, responsible payers and staff see the contributions; nobody sees payers' accounts. */
  private async seesContributions(
    principal: Principal,
    obligation: ObligationRow,
  ): Promise<boolean> {
    if (obligation.mode !== 'team_with_contributions') return false;
    if (isStaffLike(principal)) return true;
    if (principal.personId && principal.personId === obligation.responsible_payer_person_id)
      return true;
    const decision = await this.authorization.decide(
      principal,
      FinanceActions.requestContribution,
      {
        type: 'obligation',
        id: obligation.id,
        organizationId: obligation.organization_id,
        teamEntryId: obligation.debtor_team_entry_id,
      },
    );
    return decision.allowed;
  }

  async view(db: Reader, principal: Principal, obligation: ObligationRow): Promise<Obligation> {
    let contributions: ContributionSummary[] | null = null;
    if (await this.seesContributions(principal, obligation)) {
      const rows = await db
        .selectFrom('contribution_requests')
        .selectAll()
        .where('organization_id', '=', obligation.organization_id)
        .where('obligation_id', '=', obligation.id)
        .orderBy('created_at')
        .orderBy('id')
        .execute();
      contributions = rows.map((r) => ({
        id: r.id,
        requestedPersonId: r.requested_person_id,
        amountMinor: r.amount_minor,
        currency: r.currency,
        status: r.status,
        paidAt: isoOrNull(r.paid_at),
      }));
    }
    return {
      id: obligation.id,
      debtor: {
        kind: obligation.debtor_kind,
        personId: obligation.debtor_person_id,
        teamEntryId: obligation.debtor_team_entry_id,
      },
      mode: obligation.mode,
      responsiblePayerPersonId: obligation.responsible_payer_person_id,
      source: { kind: obligation.source_kind, id: obligation.source_id },
      orderId: obligation.order_id,
      description: obligation.description,
      dueAt: iso(obligation.due_at),
      status: obligation.status,
      totals: await this.facts.obligationTotals(db, obligation),
      contributions,
      revision: obligation.revision,
      createdAt: iso(obligation.created_at),
    };
  }

  async get(principal: Principal, id: string): Promise<Obligation> {
    const organizationId = organizationOf(principal);
    const obligation = await this.facts.loadObligation(this.db, organizationId, id);
    if (!obligation) throw errors.protectedNotFound('obligation');
    await this.requireRead(principal, obligation);
    return this.view(this.db, principal, obligation);
  }

  async list(principal: Principal, query: ListObligationsQuery): Promise<Page<Obligation>> {
    const organizationId = organizationOf(principal);
    if (query.debtorPersonId) {
      await this.authorization.require(principal, FinanceActions.readObligation, {
        type: 'obligation',
        organizationId,
        subjectPersonIds: [query.debtorPersonId],
        protected: true,
      });
    } else if (query.teamEntryId) {
      await this.authorization.require(principal, FinanceActions.readObligation, {
        type: 'obligation',
        organizationId,
        teamEntryId: query.teamEntryId,
        protected: true,
      });
    } else if (!isStaffLike(principal)) {
      throw errors.validation('debtorPersonId or teamEntryId is required.');
    } else {
      await this.authorization.require(principal, FinanceActions.readObligation, {
        type: 'obligation',
        organizationId,
      });
    }
    let q = this.db
      .selectFrom('obligations')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .orderBy('due_at')
      .orderBy('id')
      .limit(query.limit);
    if (query.debtorPersonId) q = q.where('debtor_person_id', '=', query.debtorPersonId);
    if (query.teamEntryId) q = q.where('debtor_team_entry_id', '=', query.teamEntryId);
    if (query.status) q = q.where('status', '=', query.status);
    const rows = await q.execute();
    const items: Obligation[] = [];
    for (const row of rows) items.push(await this.view(this.db, principal, row));
    return { items, nextCursor: null };
  }

  // -------------------------------------------------------------------------------------------
  // POST /obligations (team fees and manual charges)
  // -------------------------------------------------------------------------------------------

  async create(
    principal: Principal,
    input: CreateObligationInput,
    correlationId: string | null,
  ): Promise<Obligation> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, FinanceActions.manageObligations, {
      type: 'obligation',
      organizationId,
    });
    return this.uow.run(async ({ trx }) => {
      let debtorPersonId: string | null = null;
      let debtorTeamEntryId: string | null = null;
      if (input.debtor.kind === 'person') {
        const person = await this.people.findPerson(organizationId, input.debtor.personId, trx);
        if (!person) throw errors.notFound('person', input.debtor.personId);
        debtorPersonId = person.id;
      } else {
        const entry = await this.teamEntries.findTeamEntry(
          organizationId,
          input.debtor.teamEntryId,
          trx,
        );
        if (!entry) throw errors.notFound('team entry', input.debtor.teamEntryId);
        debtorTeamEntryId = entry.id;
      }
      if (input.responsiblePayerPersonId) {
        const payer = await this.people.findPerson(
          organizationId,
          input.responsiblePayerPersonId,
          trx,
        );
        if (!payer) throw errors.notFound('person', input.responsiblePayerPersonId);
        if (payer.kind !== 'adult')
          throw errors.validation('The responsible payer must be an adult.');
      }
      let row: ObligationRow;
      try {
        row = await this.facts.createObligation(trx, {
          organizationId,
          debtorKind: input.debtor.kind,
          debtorPersonId,
          debtorTeamEntryId,
          mode: input.mode,
          responsiblePayerPersonId: input.responsiblePayerPersonId ?? null,
          sourceKind: input.source.kind,
          sourceId: input.source.id ?? null,
          orderId: null,
          installmentPlanId: null,
          description: input.description,
          amountMinor: input.amountMinor,
          currency: input.currency,
          dueAt: new Date(input.dueAt),
          actor: principal,
          correlationId,
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw errors.resourceConflict('This debtor already has an obligation for that source.', {
            code: 'DUPLICATE_OBLIGATION',
          });
        }
        throw error;
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: FinanceActions.manageObligations.id,
        targetType: 'obligation',
        targetId: row.id,
        afterRevision: 1,
        reason: input.reason ?? null,
        correlationId,
        details: {
          mode: input.mode,
          amountMinor: input.amountMinor,
          currency: input.currency,
          policyReferences: input.policyReferences ?? [],
        },
      });
      return this.view(trx, principal, row);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Contribution requests (SPK-PAY-004)
  // -------------------------------------------------------------------------------------------

  async requestContribution(
    principal: Principal,
    obligationId: string,
    input: CreateContributionRequestInput,
    correlationId: string | null,
  ): Promise<ContributionRequest> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const obligation = await this.facts.loadObligation(trx, organizationId, obligationId, true);
      if (!obligation) throw errors.protectedNotFound('obligation');
      await this.authorization.require(principal, FinanceActions.requestContribution, {
        type: 'obligation',
        id: obligationId,
        organizationId,
        teamEntryId: obligation.debtor_team_entry_id,
        protected: true,
      });
      if (obligation.mode !== 'team_with_contributions') {
        throw errors.validation(
          'Contributions are requested only toward a team obligation with contributions.',
        );
      }
      if (obligation.status !== 'open') {
        throw errors.invalidTransition('Obligation', obligation.status, 'request_contribution');
      }
      const memberships = await this.teamEntries.entriesOfPerson(
        organizationId,
        input.requestedPersonId,
        this.clock.now(),
        trx,
      );
      if (!memberships.some((m) => m.teamEntryId === obligation.debtor_team_entry_id)) {
        throw errors.validation('Contributions are requested from members of the team.', {
          code: 'NOT_A_TEAM_MEMBER',
        });
      }
      const id = newId();
      try {
        await trx
          .insertInto('contribution_requests')
          .values({
            id,
            organization_id: organizationId,
            obligation_id: obligationId,
            requested_person_id: input.requestedPersonId,
            requested_by: json(snapshotActor(principal)),
            requested_by_person_id: principal.personId,
            amount_minor: input.amountMinor,
            currency: obligation.currency,
            message: input.message ?? null,
            receipt_id: null,
            paid_at: null,
            canceled_at: null,
            cancel_reason: null,
          })
          .execute();
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw errors.resourceConflict('This player already has an open contribution request.', {
            code: 'CONTRIBUTION_ALREADY_REQUESTED',
          });
        }
        throw error;
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: FinanceActions.requestContribution.id,
        targetType: 'contribution_request',
        targetId: id,
        afterRevision: 1,
        correlationId,
        details: { obligationId, amountMinor: input.amountMinor },
      });
      await this.outbox.enqueue(trx, FinanceEvents.contributionRequested, {
        organizationId,
        aggregateType: 'contribution_request',
        aggregateId: id,
        correlationId,
        payload: {
          organizationId,
          contributionRequestId: id,
          obligationId,
          requestedPersonId: input.requestedPersonId,
          amountMinor: input.amountMinor,
          currency: obligation.currency,
        },
      });
      return this.contributionView(trx, organizationId, id);
    });
  }

  private async contributionView(
    db: Reader,
    organizationId: string,
    id: string,
  ): Promise<ContributionRequest> {
    const row = await db
      .selectFrom('contribution_requests')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    const obligation = (await this.facts.loadObligation(
      db,
      organizationId,
      row.obligation_id,
    )) as ObligationRow;
    return {
      id: row.id,
      obligationId: row.obligation_id,
      requestedPersonId: row.requested_person_id,
      amountMinor: row.amount_minor,
      currency: row.currency,
      message: row.message,
      status: row.status,
      paidAt: isoOrNull(row.paid_at),
      obligation: {
        description: obligation.description,
        totals: await this.facts.obligationTotals(db, obligation),
        status: obligation.status,
      },
      revision: row.revision,
      createdAt: iso(row.created_at),
    };
  }

  async getContribution(principal: Principal, id: string): Promise<ContributionRequest> {
    const organizationId = organizationOf(principal);
    const row = await this.db
      .selectFrom('contribution_requests')
      .innerJoin('obligations', (join) =>
        join
          .onRef('obligations.id', '=', 'contribution_requests.obligation_id')
          .onRef('obligations.organization_id', '=', 'contribution_requests.organization_id'),
      )
      .select([
        'contribution_requests.requested_person_id as requested_person_id',
        'obligations.debtor_team_entry_id as team_entry_id',
      ])
      .where('contribution_requests.organization_id', '=', organizationId)
      .where('contribution_requests.id', '=', id)
      .executeTakeFirst();
    if (!row) throw errors.protectedNotFound('contribution request');
    await this.authorization.require(principal, FinanceActions.readObligation, {
      type: 'contribution_request',
      id,
      organizationId,
      subjectPersonIds: [row.requested_person_id],
      teamEntryId: row.team_entry_id,
      protected: true,
    });
    return this.contributionView(this.db, organizationId, id);
  }

  async payContribution(
    principal: Principal,
    id: string,
    input: PayContributionInput,
    correlationId: string | null,
  ): Promise<PaymentOutcome> {
    const organizationId = organizationOf(principal);
    const attempt = await this.uow.run(async ({ trx }) => {
      const request = await trx
        .selectFrom('contribution_requests')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!request) throw errors.protectedNotFound('contribution request');
      await this.authorization.require(principal, FinanceActions.payContribution, {
        type: 'contribution_request',
        id,
        organizationId,
        subjectPersonIds: [request.requested_person_id],
        protected: true,
      });
      if (request.status !== 'requested') {
        throw errors.invalidTransition('ContributionRequest', request.status, 'pay');
      }
      // SPK-PAY-004/005: a contribution pays toward an open team obligation; once the balance is
      // settled (or canceled, written off) nothing is charged. A plain read: capture locks the
      // obligation before the request, and a capture racing the settlement is still handled as
      // visible overpayment (SPK-AT-022).
      const obligation = await this.facts.loadObligation(
        trx,
        organizationId,
        request.obligation_id,
      );
      if (!obligation || obligation.status !== 'open') {
        throw errors.invalidTransition(
          'Obligation',
          obligation?.status ?? 'missing',
          'pay_contribution',
        );
      }
      if (!principal.personId) throw errors.accessDenied();
      return this.payments.createAttemptInTrx(trx, {
        organizationId,
        purpose: 'contribution',
        obligationId: request.obligation_id,
        contributionRequestId: request.id,
        payerPersonId: principal.personId,
        amountMinor: request.amount_minor,
        currency: request.currency,
        paymentMethodRef: input.paymentMethodToken,
        actor: principal,
      });
    });
    return this.executeAndDescribe(principal, attempt.id, correlationId);
  }

  // -------------------------------------------------------------------------------------------
  // POST /obligations/{id}/payments
  // -------------------------------------------------------------------------------------------

  async pay(
    principal: Principal,
    obligationId: string,
    input: PayObligationInput,
    correlationId: string | null,
  ): Promise<PaymentOutcome> {
    const organizationId = organizationOf(principal);
    const attempt = await this.uow.run(async ({ trx }) => {
      const obligation = await this.facts.loadObligation(trx, organizationId, obligationId, true);
      if (!obligation) throw errors.protectedNotFound('obligation');
      const subject =
        obligation.mode === 'individual'
          ? obligation.debtor_person_id
          : obligation.responsible_payer_person_id;
      await this.authorization.require(principal, FinanceActions.payObligation, {
        type: 'obligation',
        id: obligationId,
        organizationId,
        subjectPersonIds: subject ? [subject] : [],
        // Only the contributions model lets the captain pay the team balance; one responsible
        // payer means exactly that person (SPK-PAY-004).
        teamEntryId:
          obligation.mode === 'team_with_contributions' ? obligation.debtor_team_entry_id : null,
        protected: true,
      });
      if (obligation.status !== 'open') {
        throw errors.invalidTransition('Obligation', obligation.status, 'pay');
      }
      const remaining = obligation.amount_minor - obligation.allocated_minor;
      const amount = input.amountMinor ?? remaining;
      if (amount > remaining) {
        throw errors.validation('The payment exceeds the remaining balance.', {
          remainingMinor: remaining,
        });
      }
      // SPK-PAY-007, §4.7 invariant 5: the checkout or the installment worker may already be
      // charging this debt; no second charge while that outcome is pending or unknown.
      const charging = await trx
        .selectFrom('payment_attempts')
        .select(['id', 'status'])
        .where('organization_id', '=', organizationId)
        .where('obligation_id', '=', obligationId)
        .where('purpose', 'in', ['checkout', 'installment'])
        .where('status', 'in', ['created', 'action_required', 'processing', 'unknown'])
        .executeTakeFirst();
      if (charging) {
        throw errors.paymentOutcomeUnknown({
          paymentAttemptId: charging.id,
          status: charging.status,
        });
      }
      if (!principal.personId) throw errors.accessDenied();
      return this.payments.createAttemptInTrx(trx, {
        organizationId,
        purpose: 'obligation',
        obligationId,
        orderId: obligation.order_id,
        payerPersonId: principal.personId,
        amountMinor: amount,
        currency: obligation.currency,
        paymentMethodRef: input.paymentMethodToken,
        actor: principal,
      });
    });
    return this.executeAndDescribe(principal, attempt.id, correlationId);
  }

  private async executeAndDescribe(
    principal: Principal,
    attemptId: string,
    correlationId: string | null,
  ): Promise<PaymentOutcome> {
    const organizationId = organizationOf(principal);
    const outcome = await this.payments.execute(organizationId, attemptId, correlationId);
    return this.describePayment(principal, outcome.attempt.id);
  }

  async describePayment(principal: Principal, attemptId: string): Promise<PaymentOutcome> {
    const organizationId = organizationOf(principal);
    const attempt = await this.payments.load(this.db, organizationId, attemptId);
    if (!attempt) throw errors.notFound('payment attempt', attemptId);
    const receipt = await this.db
      .selectFrom('receipts')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('payment_attempt_id', '=', attemptId)
      .executeTakeFirst();
    const credit = receipt
      ? await this.db
          .selectFrom('credits')
          .select('id')
          .where('organization_id', '=', organizationId)
          .where('source_kind', '=', 'overpayment')
          .where('source_id', '=', receipt.id)
          .executeTakeFirst()
      : undefined;
    const obligation = (await this.facts.loadObligation(
      this.db,
      organizationId,
      attempt.obligation_id as string,
    )) as ObligationRow;
    return {
      payment: toPaymentAttempt(attempt),
      receipt: receipt ? toReceipt(receipt) : null,
      obligation: await this.view(this.db, principal, obligation),
      overpaymentCreditId: credit?.id ?? null,
    };
  }

  /** Used by cash tenders and staff tools: the obligation row for a command (locked). */
  async lockOpen(trx: Trx, organizationId: string, id: string): Promise<ObligationRow> {
    const obligation = await this.facts.loadObligation(trx, organizationId, id, true);
    if (!obligation) throw errors.protectedNotFound('obligation');
    if (obligation.status !== 'open') {
      throw errors.invalidTransition('Obligation', obligation.status, 'pay');
    }
    return obligation;
  }
}
