import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  scopeCoversFacility,
  staffFacilityScope,
  type AddPosOpenAmountLineInput,
  type ApprovePosOpenAmountLineInput,
  type ListSessionOpenAmountLinesQuery,
  type Page,
  type PosOpenAmountRules,
  type PosSale,
  type PosSessionOpenAmountLine,
  type Principal,
} from '@sportspark/contracts';
import { json, type Db, type PosReturnLineRecord } from '@sportspark/db';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  CapabilityService,
  DATABASE,
  UnitOfWork,
  assertExpectedRevision,
  snapshotActor,
  type Clock,
} from '../../../../kernel';
import { FinanceActions } from '../../finance.actions';
import type { OpenAmountLinePolicy } from '../../finance.policy';
import {
  afterKeysetDesc,
  decodeKeyset,
  iso,
  keysetAt,
  keysetPage,
  organizationOf,
  type Reader,
} from '../../finance.shared';
import { FinancePolicyResolver } from '../finance-policy.resolver';
import { requirePosRead } from './pos-access';
import { PosSaleFinalizer } from './pos-sale-finalizer.service';
import { PosSalesService } from './pos-sales.service';
import {
  awaitsApproval,
  enteredTotalOf,
  liveLines,
  openAmountTotals,
  toLineApproval,
} from './pos-views';

/**
 * SPK-PAY-016 (proposed amendment PA-08): the ceiling of the principal at the facility, the
 * highest among the staff roles through which they may enter an open-amount line there (a role
 * the policy does not name takes its default). Null when no such role is held at the facility.
 */
export function openAmountCeiling(
  principal: Principal,
  facilityId: string,
  rules: OpenAmountLinePolicy,
): number | null {
  if (principal.kind !== 'staff') return null;
  const ceilings = FinanceActions.enterOpenAmountLine.staffRoles
    .filter((role) => scopeCoversFacility(staffFacilityScope(principal, [role]), facilityId))
    .map((role) => rules.ceilings.byRole[role] ?? rules.ceilings.defaultMinor);
  return ceilings.length === 0 ? null : Math.max(...ceilings);
}

/**
 * SPK-PAY-016 (proposed): the total of the open-amount lines in effect that one person entered on
 * one sale. It is what that person's ceiling is judged against (migration 0697 derives the same
 * figure under the sale lock). Read with the sale locked.
 */
export async function enteredOpenAmountTotal(
  db: Reader,
  organizationId: string,
  saleId: string,
  personId: string,
): Promise<number> {
  const rows = await db
    .selectFrom('pos_sale_lines')
    .selectAll()
    .where('organization_id', '=', organizationId)
    .where('sale_id', '=', saleId)
    .execute();
  return openAmountTotals(rows).get(personId) ?? 0;
}

/**
 * Open-amount register lines (SPK-PAY-016, proposed amendment PA-08; §3.16 POS row; capability
 * `open_amount_lines`, DEC-102 pending). Migrations 0695, 0696 and 0697.
 *
 * - Entering a line (`finance.enter_open_amount_line`): a typed description, a positive amount and
 *   a reason category of the approved list. The category gives the revenue category the line books
 *   to and the approved `tax_fee` policies applied to it (the same refusals as a product's
 *   charges, DEC-057). The categories and the ceilings are policy content read through
 *   FinancePolicyResolver (`OPEN_AMOUNT_POLICY`); while no version is approved the proposed
 *   default of the finance configuration applies, and the line records which basis it used
 *   (`policy_version_id`, null for the default). The line records who entered it and the ceiling
 *   that applied to them.
 * - The ceiling applies to what one person enters on one sale, not to each line alone (security
 *   review M-4): a line needs the second approval when the open-amount lines in effect that its
 *   enterer has on the sale, this line included, total more than the ceiling. One line above the
 *   ceiling is the case of a total of one line. The database derives the total under the sale
 *   lock and whether the approval is needed (migration 0697); the service computes the same
 *   first. Totals across separate sales of a session are not limited: they are in the session's
 *   open-amount report (**Pending decision**, DEC-102).
 * - Approving such a line (`finance.approve_open_amount_line`): its own command and its own
 *   append-only record (`pos_line_approvals`: who, when, why, and the total it was given for).
 *   The approver is never the person who entered the line (SECOND_PERSON_REQUIRED; the database
 *   refuses it too). Until then the sale takes no tender (PosSalesService.addTender,
 *   OPEN_AMOUNT_APPROVAL_REQUIRED).
 * - Both commands need the `open_amount_lines` switch; entering a line also needs
 *   `point_of_sale`, like any line. Removing the line, voiding the sale, tenders, returns and
 *   reads are never gated by it (DEC-016), so turning the switch off strands no sale.
 * - Reads: the rules in force with the caller's own ceiling, and the open-amount lines in effect
 *   of a register session, apart from product lines, for review.
 */
@Injectable()
export class PosOpenAmountService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly capabilities: CapabilityService,
    private readonly audit: AuditWriter,
    private readonly finalizer: PosSaleFinalizer,
    private readonly sales: PosSalesService,
    private readonly policy: FinancePolicyResolver,
  ) {}

  async addLine(
    principal: Principal,
    saleId: string,
    input: AddPosOpenAmountLineInput,
    correlationId: string | null,
  ): Promise<PosSale> {
    const organizationId = organizationOf(principal);
    await this.uow.run(async ({ trx }) => {
      const sale = await this.finalizer.lockSale(trx, organizationId, saleId);
      await this.authorization.require(principal, FinanceActions.enterOpenAmountLine, {
        type: 'pos_sale',
        id: sale.id,
        organizationId,
        facilityId: sale.facility_id,
      });
      await this.capabilities.require(organizationId, 'point_of_sale', trx);
      await this.capabilities.require(organizationId, 'open_amount_lines', trx);
      if (!principal.personId) {
        throw errors.accessDenied('An open-amount line is entered by a named person.');
      }
      if (sale.status !== 'open')
        throw errors.invalidTransition('PosSale', sale.status, 'add_line');
      assertExpectedRevision(input.expectedRevision, sale.revision);
      const now = this.clock.now();
      const resolved = await this.policy.openAmountRules(organizationId, now, trx);
      const rules = resolved.rules;
      if (rules.currency !== null && rules.currency !== sale.currency) {
        throw errors.resourceConflict(
          'The approved open-amount ceilings are stated in another currency than the sale.',
          {
            code: 'OPEN_AMOUNT_POLICY_CURRENCY_MISMATCH',
            policyCurrency: rules.currency,
            saleCurrency: sale.currency,
          },
        );
      }
      const category = rules.categories.find((c) => c.code === input.reasonCategory);
      if (!category) {
        throw errors.validation('The reason category is not on the approved list.', {
          code: 'OPEN_AMOUNT_CATEGORY_UNKNOWN',
          reasonCategory: input.reasonCategory,
          categories: rules.categories.map((c) => c.code),
        });
      }
      const ceiling = openAmountCeiling(principal, sale.facility_id, rules);
      if (ceiling === null) {
        // Unreachable after the authorization above; kept so no line is ever written without one.
        throw errors.accessDenied('No ceiling applies to you for an open-amount line here.');
      }
      const { charges, chargesMinor } = await this.sales.approvedCharges(
        trx,
        sale,
        category.chargePolicyKeys,
        input.amountMinor,
        1,
        {
          what: 'the open-amount line cannot be added',
          subject: { reasonCategory: category.code },
        },
      );
      const last = await trx
        .selectFrom('pos_sale_lines')
        .select((eb) => eb.fn.max('line_number').as('n'))
        .where('organization_id', '=', organizationId)
        .where('sale_id', '=', sale.id)
        .executeTakeFirst();
      const lineId = newId();
      // The ceiling is for what this person enters on this sale: the lines in effect they
      // already have on it count with this one (the sale is locked, so the sum is stable).
      const enteredBefore = await enteredOpenAmountTotal(
        trx,
        organizationId,
        sale.id,
        principal.personId,
      );
      const enteredTotal = enteredBefore + input.amountMinor;
      const approvalRequired = enteredTotal > ceiling;
      await trx
        .insertInto('pos_sale_lines')
        .values({
          id: lineId,
          organization_id: organizationId,
          sale_id: sale.id,
          currency: sale.currency,
          line_number: Number(last?.n ?? 0) + 1,
          product_id: null,
          sku: null,
          // The category's label as approved now (a later version changes later lines only).
          name: category.label,
          kind: 'open_amount',
          unit_price_minor: input.amountMinor,
          quantity: 1,
          base_minor: input.amountMinor,
          charges: json(charges),
          charges_minor: chargesMinor,
          line_total_minor: input.amountMinor + chargesMinor,
          description: input.description,
          reason_category: category.code,
          revenue_category: category.revenueCategory,
          entered_by: json(snapshotActor(principal)),
          entered_by_person_id: principal.personId,
          approval_ceiling_minor: ceiling,
          approval_required: approvalRequired,
          // Stated for the reader; the database derives it itself and judges by its own figure.
          entered_total_minor: enteredTotal,
          policy_version_id: resolved.policyVersionId,
        })
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: FinanceActions.enterOpenAmountLine.id,
        targetType: 'pos_sale',
        targetId: sale.id,
        beforeRevision: sale.revision,
        reason: input.reason ?? null,
        correlationId,
        details: {
          lineId,
          description: input.description,
          amountMinor: input.amountMinor,
          currency: sale.currency,
          reasonCategory: category.code,
          revenueCategory: category.revenueCategory,
          ceilingMinor: ceiling,
          enteredTotalMinor: enteredTotal,
          approvalRequired,
          policyBasis: resolved.basis,
          policyVersionId: resolved.policyVersionId,
          charges: charges.map((c) => ({
            policyVersionId: c.policyVersionId,
            code: c.code,
            amountMinor: c.amountMinor,
          })),
        },
      });
    });
    return this.sales.afterCommand(organizationId, saleId);
  }

  /** The second approval: its own record, by a second person, while the sale is open. */
  async approve(
    principal: Principal,
    saleId: string,
    lineId: string,
    input: ApprovePosOpenAmountLineInput,
    correlationId: string | null,
  ): Promise<PosSale> {
    const organizationId = organizationOf(principal);
    await this.uow.run(async ({ trx }) => {
      const sale = await this.finalizer.lockSale(trx, organizationId, saleId);
      await this.authorization.require(principal, FinanceActions.approveOpenAmountLine, {
        type: 'pos_sale',
        id: sale.id,
        organizationId,
        facilityId: sale.facility_id,
      });
      await this.capabilities.require(organizationId, 'open_amount_lines', trx);
      if (!principal.personId) {
        throw errors.accessDenied('An open-amount line is approved by a named person.');
      }
      if (sale.status !== 'open') {
        throw errors.invalidTransition('PosSale', sale.status, 'approve_line');
      }
      assertExpectedRevision(input.expectedRevision, sale.revision);
      const rows = await trx
        .selectFrom('pos_sale_lines')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('sale_id', '=', sale.id)
        .execute();
      const line = rows.find((r) => r.id === lineId);
      if (!line) {
        throw errors.validation('The line is not on this sale.', {
          code: 'LINE_NOT_ON_SALE',
          saleLineId: lineId,
        });
      }
      if (!liveLines(rows).some((r) => r.id === lineId)) {
        throw errors.resourceConflict('The line was already changed or removed; reload the sale.', {
          code: 'LINE_ALREADY_CHANGED',
          saleLineId: lineId,
        });
      }
      if (line.kind !== 'open_amount' || line.approval_required !== true) {
        throw errors.resourceConflict('This line needs no second approval.', {
          code: 'APPROVAL_NOT_REQUIRED',
          saleLineId: lineId,
        });
      }
      const existing = await trx
        .selectFrom('pos_line_approvals')
        .select('id')
        .where('organization_id', '=', organizationId)
        .where('sale_line_id', '=', lineId)
        .executeTakeFirst();
      if (existing) {
        throw errors.resourceConflict('The line is already approved; reload the sale.', {
          code: 'LINE_ALREADY_APPROVED',
          saleLineId: lineId,
          approvalId: existing.id,
        });
      }
      if (line.entered_by_person_id === principal.personId) {
        throw errors.accessDenied(
          'The person who entered an open-amount line cannot approve it: a second person approves.',
          { code: 'SECOND_PERSON_REQUIRED', saleLineId: lineId },
        );
      }
      const approvalId = newId();
      const now = this.clock.now();
      await trx
        .insertInto('pos_line_approvals')
        .values({
          id: approvalId,
          organization_id: organizationId,
          sale_id: sale.id,
          sale_line_id: lineId,
          currency: line.currency,
          amount_minor: Number(line.unit_price_minor),
          ceiling_minor: Number(line.approval_ceiling_minor),
          entered_total_minor: enteredTotalOf(line),
          reason: input.reason,
          approved_by: json(snapshotActor(principal)),
          approved_by_person_id: principal.personId,
          approved_at: now,
        })
        .execute();
      // §4.9: what the sale may do next changed (it can take a tender now), so its revision moves.
      await trx
        .updateTable('pos_sales')
        .set({ revision: sale.revision + 1 })
        .where('organization_id', '=', organizationId)
        .where('id', '=', sale.id)
        .where('revision', '=', sale.revision)
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: FinanceActions.approveOpenAmountLine.id,
        targetType: 'pos_sale',
        targetId: sale.id,
        beforeRevision: sale.revision,
        afterRevision: sale.revision + 1,
        reason: input.reason,
        correlationId,
        details: {
          approvalId,
          lineId,
          amountMinor: Number(line.unit_price_minor),
          ceilingMinor: Number(line.approval_ceiling_minor),
          enteredTotalMinor: enteredTotalOf(line),
          currency: line.currency,
          enteredByPersonId: line.entered_by_person_id,
        },
      });
    });
    return this.sales.afterCommand(organizationId, saleId);
  }

  /**
   * GET /v1/pos-open-amount-rules: the categories and the caller's own ceiling at the facility,
   * for the register's entry form. A read of configuration: not gated (DEC-016); POS readers of
   * the facility and its desk staff.
   */
  async rules(principal: Principal, facilityId: string): Promise<PosOpenAmountRules> {
    const organizationId = organizationOf(principal);
    if (principal.kind !== 'staff' && principal.kind !== 'system') throw errors.accessDenied();
    await requirePosRead(this.authorization, principal, FinanceActions.readPos, {
      type: 'facility',
      id: facilityId,
      organizationId,
      facilityId,
    });
    const resolved = await this.policy.openAmountRules(organizationId, this.clock.now());
    return {
      basis: resolved.basis,
      policyVersionId: resolved.policyVersionId,
      currency: resolved.rules.currency,
      categories: resolved.rules.categories.map((c) => ({
        code: c.code,
        label: c.label,
        revenueCategory: c.revenueCategory,
        chargePolicyKeys: [...c.chargePolicyKeys],
      })),
      ceilingMinor: openAmountCeiling(principal, facilityId, resolved.rules),
      approverRoles: [...FinanceActions.approveOpenAmountLine.staffRoles],
    };
  }

  /**
   * GET /v1/pos-register-sessions/{id}/open-amount-lines: the open-amount lines in effect of the
   * session's sales, newest first, whatever the sale's state (an open sale's line waiting for its
   * approval is exactly what a reviewer looks for).
   */
  async listForSession(
    principal: Principal,
    sessionId: string,
    query: ListSessionOpenAmountLinesQuery,
  ): Promise<Page<PosSessionOpenAmountLine>> {
    const organizationId = organizationOf(principal);
    if (principal.kind !== 'staff' && principal.kind !== 'system') throw errors.accessDenied();
    const session = await this.db
      .selectFrom('pos_register_sessions')
      .select(['id', 'facility_id'])
      .where('organization_id', '=', organizationId)
      .where('id', '=', sessionId)
      .executeTakeFirst();
    if (!session) throw errors.notFound('register session', sessionId);
    await requirePosRead(this.authorization, principal, FinanceActions.readPos, {
      type: 'pos_register_session',
      id: sessionId,
      organizationId,
      facilityId: session.facility_id,
    });
    const cursor = decodeKeyset(query.cursor);
    let q = this.db
      .selectFrom('pos_sale_lines')
      .innerJoin('pos_sales', (join) =>
        join
          .onRef('pos_sales.id', '=', 'pos_sale_lines.sale_id')
          .onRef('pos_sales.organization_id', '=', 'pos_sale_lines.organization_id'),
      )
      .selectAll('pos_sale_lines')
      .select([
        'pos_sales.sale_number as sale_number',
        'pos_sales.status as sale_status',
        keysetAt('pos_sale_lines').as('cursor_at'),
      ])
      .where('pos_sale_lines.organization_id', '=', organizationId)
      .where('pos_sales.register_session_id', '=', sessionId)
      .where('pos_sale_lines.kind', '=', 'open_amount')
      .where('pos_sale_lines.quantity', '>', 0)
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('pos_sale_lines as n')
              .select('n.id')
              .whereRef('n.organization_id', '=', 'pos_sale_lines.organization_id')
              .whereRef('n.supersedes_line_id', '=', 'pos_sale_lines.id'),
          ),
        ),
      )
      .orderBy('pos_sale_lines.created_at', 'desc')
      .orderBy('pos_sale_lines.id', 'desc')
      .limit(query.limit + 1);
    if (cursor) q = q.where(afterKeysetDesc('pos_sale_lines', cursor));
    const page = keysetPage(await q.execute(), query.limit);
    const lineIds = page.rows.map((r) => r.id);
    const saleIds = [...new Set(page.rows.map((r) => r.sale_id))];
    const approvals =
      lineIds.length === 0
        ? []
        : await this.db
            .selectFrom('pos_line_approvals')
            .selectAll()
            .where('organization_id', '=', organizationId)
            .where('sale_line_id', 'in', lineIds)
            .execute();
    const returns =
      saleIds.length === 0
        ? []
        : await this.db
            .selectFrom('pos_returns')
            .select('lines')
            .where('organization_id', '=', organizationId)
            .where('sale_id', 'in', saleIds)
            .execute();
    const returned = new Map<string, number>();
    for (const r of returns) {
      for (const l of r.lines as PosReturnLineRecord[]) {
        returned.set(l.saleLineId, (returned.get(l.saleLineId) ?? 0) + l.quantity);
      }
    }
    const approvalOf = new Map(approvals.map((a) => [a.sale_line_id, a]));
    // Whether a line still waits depends on what its enterer has in effect on its sale now.
    const saleLines =
      saleIds.length === 0
        ? []
        : await this.db
            .selectFrom('pos_sale_lines')
            .selectAll()
            .where('organization_id', '=', organizationId)
            .where('sale_id', 'in', saleIds)
            .where('kind', '=', 'open_amount')
            .execute();
    const totalsOf = new Map(
      saleIds.map((id) => [id, openAmountTotals(saleLines.filter((l) => l.sale_id === id))]),
    );
    return {
      items: page.rows.map((r) => {
        const approval = approvalOf.get(r.id);
        return {
          saleId: r.sale_id,
          saleNumber: r.sale_number,
          saleStatus: r.sale_status,
          lineId: r.id,
          description: r.description ?? '',
          reasonCategory: r.reason_category ?? '',
          reasonLabel: r.name,
          revenueCategory: r.revenue_category ?? '',
          currency: r.currency,
          amountMinor: Number(r.base_minor),
          chargesMinor: Number(r.charges_minor),
          lineTotalMinor: Number(r.line_total_minor),
          enteredByPersonId: r.entered_by_person_id ?? '',
          enteredAt: iso(r.created_at),
          ceilingMinor: Number(r.approval_ceiling_minor ?? 0),
          enteredTotalMinor: enteredTotalOf(r),
          approvalRequired: r.approval_required === true,
          awaitingApproval:
            r.sale_status === 'open' &&
            awaitsApproval(r, approval !== undefined, totalsOf.get(r.sale_id) ?? new Map()),
          approval: approval ? toLineApproval(approval) : null,
          returnedQuantity: returned.get(r.id) ?? 0,
        };
      }),
      nextCursor: page.nextCursor,
    };
  }
}
