import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  type CloseRegisterSessionInput,
  type CreatePosProductInput,
  type CreatePosRegisterInput,
  type ListPosProductsQuery,
  type ListPosRegistersQuery,
  type OpenRegisterSessionInput,
  type Page,
  type PosProduct,
  type PosRegister,
  type PosRegisterSession,
  type Principal,
  type RetirePosRecordInput,
  type UpdatePosProductInput,
} from '@sportspark/contracts';
import { isUniqueViolation, json, type Db } from '@sportspark/db';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  CapabilityService,
  DATABASE,
  FacilityDirectory,
  OperationalExceptions,
  Outbox,
  UnitOfWork,
  assertExpectedRevision,
  snapshotActor,
  type Clock,
  type Trx,
} from '../../../../kernel';
import { FinanceActions } from '../../finance.actions';
import { FinanceEvents } from '../../finance.events';
import {
  afterKeysetDesc,
  decodeKeyset,
  keysetAt,
  keysetPage,
  organizationOf,
  type Reader,
} from '../../finance.shared';
import {
  PosProductMachine,
  PosRegisterMachine,
  PosRegisterSessionMachine,
} from '../../finance.state-machines';
import { requirePosRead } from './pos-access';
import {
  expectedCash,
  toPosProduct,
  toPosRegister,
  toPosSession,
  type PosProductRow,
  type PosRegisterRow,
  type PosSessionRow,
} from './pos-views';

/** `YYYYMMDD` of an instant in a facility's zone (SPK-SCHED-008). */
export function businessDate(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}${part('month')}${part('day')}`;
}

/**
 * Point-of-sale products, registers and register sessions (FIN-06; §3.16 POS row, SPK-PAY-002,
 * SPK-PAY-012, POL-018). Creating or changing a product or a register and opening a session are new
 * commitments of the `point_of_sale` capability (DEC-016, DEC-079): refused while it is disabled.
 * Retiring and closing never check it. Every command is authorized against the facility it acts at.
 */
@Injectable()
export class PosSetupService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly capabilities: CapabilityService,
    private readonly facilities: FacilityDirectory,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly exceptions: OperationalExceptions,
  ) {}

  // -------------------------------------------------------------------------------------------
  // Products
  // -------------------------------------------------------------------------------------------

  private async chargeKeys(db: Reader, organizationId: string, productId: string) {
    const rows = await db
      .selectFrom('pos_product_charges')
      .select('tax_fee_policy_key')
      .where('organization_id', '=', organizationId)
      .where('product_id', '=', productId)
      .orderBy('position')
      .execute();
    return rows.map((r) => r.tax_fee_policy_key);
  }

  async productView(db: Reader, row: PosProductRow): Promise<PosProduct> {
    return toPosProduct(row, await this.chargeKeys(db, row.organization_id, row.id));
  }

  private async lockProduct(trx: Trx, organizationId: string, id: string): Promise<PosProductRow> {
    const row = await trx
      .selectFrom('pos_products')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw errors.notFound('pos product', id);
    return row;
  }

  private async replaceCharges(
    trx: Trx,
    organizationId: string,
    productId: string,
    keys: readonly string[],
  ): Promise<void> {
    await trx
      .deleteFrom('pos_product_charges')
      .where('organization_id', '=', organizationId)
      .where('product_id', '=', productId)
      .execute();
    if (keys.length === 0) return;
    await trx
      .insertInto('pos_product_charges')
      .values(
        keys.map((key, index) => ({
          organization_id: organizationId,
          product_id: productId,
          tax_fee_policy_key: key,
          position: index + 1,
        })),
      )
      .execute();
  }

  private async assertFacility(trx: Trx, organizationId: string, facilityId: string) {
    const found = await this.facilities.describe(organizationId, [facilityId], trx);
    const facility = found.get(facilityId);
    if (!facility) throw errors.notFound('facility', facilityId);
    return facility;
  }

  async createProduct(
    principal: Principal,
    input: CreatePosProductInput,
    correlationId: string | null,
  ): Promise<PosProduct> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, FinanceActions.managePosProducts, {
      type: 'pos_product',
      organizationId,
      facilityId: input.facilityId ?? null,
    });
    return this.uow.run(async ({ trx }) => {
      await this.capabilities.require(organizationId, 'point_of_sale', trx);
      if (input.facilityId) await this.assertFacility(trx, organizationId, input.facilityId);
      const id = newId();
      try {
        await trx
          .insertInto('pos_products')
          .values({
            id,
            organization_id: organizationId,
            facility_id: input.facilityId ?? null,
            sku: input.sku,
            name: input.name,
            kind: input.kind,
            price_minor: input.priceMinor,
            currency: input.currency,
            retired_at: null,
            retire_reason: null,
            created_by: json(snapshotActor(principal)),
          })
          .execute();
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw errors.resourceConflict('Another product already uses this SKU.', {
            code: 'SKU_TAKEN',
            sku: input.sku,
          });
        }
        throw error;
      }
      await this.replaceCharges(trx, organizationId, id, input.chargePolicyKeys);
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: FinanceActions.managePosProducts.id,
        targetType: 'pos_product',
        targetId: id,
        afterRevision: 1,
        reason: input.reason ?? null,
        correlationId,
        details: {
          sku: input.sku,
          kind: input.kind,
          priceMinor: input.priceMinor,
          currency: input.currency,
          chargePolicyKeys: input.chargePolicyKeys,
        },
      });
      return this.productView(trx, await this.lockProduct(trx, organizationId, id));
    });
  }

  /** §4.9: with the current revision; the change applies to later sales only (lines snapshot). */
  async updateProduct(
    principal: Principal,
    id: string,
    input: UpdatePosProductInput,
    correlationId: string | null,
  ): Promise<PosProduct> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const row = await this.lockProduct(trx, organizationId, id);
      await this.authorization.require(principal, FinanceActions.managePosProducts, {
        type: 'pos_product',
        id,
        organizationId,
        facilityId: row.facility_id,
      });
      await this.capabilities.require(organizationId, 'point_of_sale', trx);
      assertExpectedRevision(input.expectedRevision, row.revision);
      if (row.status !== 'active')
        throw errors.invalidTransition('PosProduct', row.status, 'update');
      const before = await this.chargeKeys(trx, organizationId, id);
      await trx
        .updateTable('pos_products')
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.priceMinor !== undefined ? { price_minor: input.priceMinor } : {}),
          revision: row.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', row.revision)
        .executeTakeFirstOrThrow();
      if (input.chargePolicyKeys !== undefined) {
        await this.replaceCharges(trx, organizationId, id, input.chargePolicyKeys);
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: `${FinanceActions.managePosProducts.id}.update`,
        targetType: 'pos_product',
        targetId: id,
        beforeRevision: row.revision,
        afterRevision: row.revision + 1,
        reason: input.reason ?? null,
        correlationId,
        details: {
          before: { name: row.name, priceMinor: Number(row.price_minor), chargePolicyKeys: before },
          after: {
            name: input.name ?? row.name,
            priceMinor: input.priceMinor ?? Number(row.price_minor),
            chargePolicyKeys: input.chargePolicyKeys ?? before,
          },
        },
      });
      return this.productView(trx, await this.lockProduct(trx, organizationId, id));
    });
  }

  /** Retiring is never gated by the capability; past sales keep their snapshot. */
  async retireProduct(
    principal: Principal,
    id: string,
    input: RetirePosRecordInput,
    correlationId: string | null,
  ): Promise<PosProduct> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const row = await this.lockProduct(trx, organizationId, id);
      await this.authorization.require(principal, FinanceActions.managePosProducts, {
        type: 'pos_product',
        id,
        organizationId,
        facilityId: row.facility_id,
      });
      assertExpectedRevision(input.expectedRevision, row.revision);
      const status = PosProductMachine.next(row.status, 'retire');
      await trx
        .updateTable('pos_products')
        .set({
          status,
          retired_at: this.clock.now(),
          retire_reason: input.reason,
          revision: row.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', row.revision)
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: `${FinanceActions.managePosProducts.id}.retire`,
        targetType: 'pos_product',
        targetId: id,
        beforeRevision: row.revision,
        afterRevision: row.revision + 1,
        reason: input.reason,
        correlationId,
      });
      return this.productView(trx, await this.lockProduct(trx, organizationId, id));
    });
  }

  async listProducts(principal: Principal, query: ListPosProductsQuery): Promise<Page<PosProduct>> {
    const organizationId = organizationOf(principal);
    await requirePosRead(this.authorization, principal, FinanceActions.readPos, {
      type: 'pos_product',
      organizationId,
      facilityId: query.facilityId ?? null,
    });
    const cursor = decodeKeyset(query.cursor);
    let q = this.db
      .selectFrom('pos_products')
      .selectAll()
      .select(keysetAt('pos_products').as('cursor_at'))
      .where('organization_id', '=', organizationId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(query.limit + 1);
    if (query.facilityId) {
      const facilityId = query.facilityId;
      q = q.where((eb) =>
        eb.or([eb('facility_id', 'is', null), eb('facility_id', '=', facilityId)]),
      );
    }
    if (query.status) q = q.where('status', '=', query.status);
    if (cursor) q = q.where(afterKeysetDesc('pos_products', cursor));
    const page = keysetPage(await q.execute(), query.limit);
    const items: PosProduct[] = [];
    for (const row of page.rows) items.push(await this.productView(this.db, row));
    return { items, nextCursor: page.nextCursor };
  }

  // -------------------------------------------------------------------------------------------
  // Registers
  // -------------------------------------------------------------------------------------------

  private async openSessionOf(db: Reader, organizationId: string, registerId: string) {
    const row = await db
      .selectFrom('pos_register_sessions')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('register_id', '=', registerId)
      .where('status', '=', 'open')
      .executeTakeFirst();
    return row?.id ?? null;
  }

  async registerView(db: Reader, row: PosRegisterRow): Promise<PosRegister> {
    return toPosRegister(row, await this.openSessionOf(db, row.organization_id, row.id));
  }

  private async lockRegister(
    trx: Trx,
    organizationId: string,
    id: string,
  ): Promise<PosRegisterRow> {
    const row = await trx
      .selectFrom('pos_registers')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw errors.notFound('pos register', id);
    return row;
  }

  async createRegister(
    principal: Principal,
    input: CreatePosRegisterInput,
    correlationId: string | null,
  ): Promise<PosRegister> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, FinanceActions.managePosRegisters, {
      type: 'pos_register',
      organizationId,
      facilityId: input.facilityId,
    });
    return this.uow.run(async ({ trx }) => {
      await this.capabilities.require(organizationId, 'point_of_sale', trx);
      await this.assertFacility(trx, organizationId, input.facilityId);
      const id = newId();
      try {
        await trx
          .insertInto('pos_registers')
          .values({
            id,
            organization_id: organizationId,
            facility_id: input.facilityId,
            code: input.code,
            name: input.name,
            retired_at: null,
            retire_reason: null,
            created_by: json(snapshotActor(principal)),
          })
          .execute();
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw errors.resourceConflict('Another register already uses this code.', {
            code: 'REGISTER_CODE_TAKEN',
            registerCode: input.code,
          });
        }
        throw error;
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: FinanceActions.managePosRegisters.id,
        targetType: 'pos_register',
        targetId: id,
        afterRevision: 1,
        reason: input.reason ?? null,
        correlationId,
        details: { facilityId: input.facilityId, code: input.code },
      });
      return this.registerView(trx, await this.lockRegister(trx, organizationId, id));
    });
  }

  async retireRegister(
    principal: Principal,
    id: string,
    input: RetirePosRecordInput,
    correlationId: string | null,
  ): Promise<PosRegister> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const row = await this.lockRegister(trx, organizationId, id);
      await this.authorization.require(principal, FinanceActions.managePosRegisters, {
        type: 'pos_register',
        id,
        organizationId,
        facilityId: row.facility_id,
      });
      assertExpectedRevision(input.expectedRevision, row.revision);
      if (await this.openSessionOf(trx, organizationId, id)) {
        throw errors.resourceConflict('Close the register session before retiring the register.', {
          code: 'REGISTER_SESSION_OPEN',
        });
      }
      const status = PosRegisterMachine.next(row.status, 'retire');
      await trx
        .updateTable('pos_registers')
        .set({
          status,
          retired_at: this.clock.now(),
          retire_reason: input.reason,
          revision: row.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', row.revision)
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: `${FinanceActions.managePosRegisters.id}.retire`,
        targetType: 'pos_register',
        targetId: id,
        beforeRevision: row.revision,
        afterRevision: row.revision + 1,
        reason: input.reason,
        correlationId,
      });
      return this.registerView(trx, await this.lockRegister(trx, organizationId, id));
    });
  }

  async listRegisters(
    principal: Principal,
    query: ListPosRegistersQuery,
  ): Promise<Page<PosRegister>> {
    const organizationId = organizationOf(principal);
    await requirePosRead(this.authorization, principal, FinanceActions.readPos, {
      type: 'pos_register',
      organizationId,
      facilityId: query.facilityId ?? null,
    });
    const cursor = decodeKeyset(query.cursor);
    let q = this.db
      .selectFrom('pos_registers')
      .selectAll()
      .select(keysetAt('pos_registers').as('cursor_at'))
      .where('organization_id', '=', organizationId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(query.limit + 1);
    if (query.facilityId) q = q.where('facility_id', '=', query.facilityId);
    if (query.status) q = q.where('status', '=', query.status);
    if (cursor) q = q.where(afterKeysetDesc('pos_registers', cursor));
    const page = keysetPage(await q.execute(), query.limit);
    const items: PosRegister[] = [];
    for (const row of page.rows) items.push(await this.registerView(this.db, row));
    return { items, nextCursor: page.nextCursor };
  }

  // -------------------------------------------------------------------------------------------
  // Register sessions (cash drawers)
  // -------------------------------------------------------------------------------------------

  async lockSession(trx: Trx, organizationId: string, id: string): Promise<PosSessionRow> {
    const row = await trx
      .selectFrom('pos_register_sessions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw errors.notFound('register session', id);
    return row;
  }

  async openSession(
    principal: Principal,
    registerId: string,
    input: OpenRegisterSessionInput,
    correlationId: string | null,
  ): Promise<PosRegisterSession> {
    const organizationId = organizationOf(principal);
    if (!principal.personId) throw errors.accessDenied('A register is opened by a named person.');
    const openedBy = principal.personId;
    return this.uow.run(async ({ trx }) => {
      const register = await this.lockRegister(trx, organizationId, registerId);
      await this.authorization.require(principal, FinanceActions.operateRegister, {
        type: 'pos_register',
        id: registerId,
        organizationId,
        facilityId: register.facility_id,
      });
      await this.capabilities.require(organizationId, 'point_of_sale', trx);
      if (register.status !== 'active') {
        throw errors.invalidTransition('PosRegister', register.status, 'open_session');
      }
      if (await this.openSessionOf(trx, organizationId, registerId)) {
        throw errors.resourceConflict('This register already has an open session.', {
          code: 'REGISTER_SESSION_OPEN',
        });
      }
      const facility = await this.assertFacility(trx, organizationId, register.facility_id);
      const now = this.clock.now();
      const date = businessDate(now, facility.timezone);
      // Sale numbers continue across sessions of the register on the same local date.
      const earlier = await trx
        .selectFrom('pos_register_sessions')
        .select((eb) => eb.fn.max('next_sale_number').as('next'))
        .where('organization_id', '=', organizationId)
        .where('register_id', '=', registerId)
        .where('business_date', '=', date)
        .executeTakeFirst();
      const id = newId();
      await trx
        .insertInto('pos_register_sessions')
        .values({
          id,
          organization_id: organizationId,
          register_id: registerId,
          facility_id: register.facility_id,
          currency: input.currency,
          business_date: date,
          opening_float_minor: input.openingFloatMinor,
          opened_by: json(snapshotActor(principal)),
          opened_by_person_id: openedBy,
          opened_at: now,
          next_sale_number: Number(earlier?.next ?? 1),
          counted_cash_minor: null,
          expected_cash_minor: null,
          variance_minor: null,
          closed_by: null,
          closed_by_person_id: null,
          closed_at: null,
        })
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: `${FinanceActions.operateRegister.id}.open_session`,
        targetType: 'pos_register_session',
        targetId: id,
        afterRevision: 1,
        reason: input.reason ?? null,
        correlationId,
        details: {
          registerId,
          currency: input.currency,
          openingFloatMinor: input.openingFloatMinor,
          businessDate: date,
        },
      });
      return toPosSession(trx, await this.lockSession(trx, organizationId, id));
    });
  }

  /**
   * Closing is never gated (DEC-016). Expected cash = float + settled cash of the session's sales
   * that were not voided − cash returns paid from this drawer; any variance is put in front of the
   * finance operator (`finance.pos_register_variance`) with no tolerance and no automatic posting
   * (POL-018 pending).
   */
  async closeSession(
    principal: Principal,
    id: string,
    input: CloseRegisterSessionInput,
    correlationId: string | null,
  ): Promise<PosRegisterSession> {
    const organizationId = organizationOf(principal);
    if (!principal.personId) throw errors.accessDenied('A register is closed by a named person.');
    const closedBy = principal.personId;
    return this.uow.run(async ({ trx }) => {
      const session = await this.lockSession(trx, organizationId, id);
      await this.authorization.require(principal, FinanceActions.operateRegister, {
        type: 'pos_register_session',
        id,
        organizationId,
        facilityId: session.facility_id,
      });
      assertExpectedRevision(input.expectedRevision, session.revision);
      const status = PosRegisterSessionMachine.next(session.status, 'close');
      const open = await trx
        .selectFrom('pos_sales')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('organization_id', '=', organizationId)
        .where('register_session_id', '=', id)
        .where('status', '=', 'open')
        .executeTakeFirstOrThrow();
      if (Number(open.n) > 0) {
        throw errors.resourceConflict(
          'Complete or void the open sales of this session before closing it.',
          { code: 'SESSION_HAS_OPEN_SALES', openSales: Number(open.n) },
        );
      }
      const expected = await expectedCash(trx, session);
      const variance = input.countedCashMinor - expected;
      const now = this.clock.now();
      await trx
        .updateTable('pos_register_sessions')
        .set({
          status,
          counted_cash_minor: input.countedCashMinor,
          expected_cash_minor: expected,
          variance_minor: variance,
          closed_by: json(snapshotActor(principal)),
          closed_by_person_id: closedBy,
          closed_at: now,
          revision: session.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', session.revision)
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: `${FinanceActions.operateRegister.id}.close_session`,
        targetType: 'pos_register_session',
        targetId: id,
        beforeRevision: session.revision,
        afterRevision: session.revision + 1,
        reason: input.reason ?? null,
        correlationId,
        details: {
          expectedCashMinor: expected,
          countedCashMinor: input.countedCashMinor,
          varianceMinor: variance,
          currency: session.currency,
        },
      });
      if (variance !== 0) {
        await this.exceptions.raise(trx, {
          organizationId,
          facilityId: session.facility_id,
          category: 'finance.pos_register_variance',
          severity: 'warning',
          title: 'A register closed with a cash difference; review it (no tolerance is approved)',
          affectedType: 'pos_register_session',
          affectedId: id,
          ownerQueue: 'finance_operator',
          dedupeKey: `pos-variance:${id}`,
          details: {
            registerId: session.register_id,
            expectedCashMinor: expected,
            countedCashMinor: input.countedCashMinor,
            varianceMinor: variance,
            currency: session.currency,
          },
        });
      }
      await this.outbox.enqueue(trx, FinanceEvents.posRegisterSessionClosed, {
        organizationId,
        aggregateType: 'pos_register_session',
        aggregateId: id,
        correlationId,
        payload: {
          sessionId: id,
          registerId: session.register_id,
          expectedCashMinor: expected,
          countedCashMinor: input.countedCashMinor,
          varianceMinor: variance,
          currency: session.currency,
        },
      });
      return toPosSession(trx, await this.lockSession(trx, organizationId, id));
    });
  }

  async getSession(principal: Principal, id: string): Promise<PosRegisterSession> {
    const organizationId = organizationOf(principal);
    if (principal.kind !== 'staff' && principal.kind !== 'system') throw errors.accessDenied();
    const row = await this.db
      .selectFrom('pos_register_sessions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw errors.notFound('register session', id);
    await requirePosRead(this.authorization, principal, FinanceActions.readPos, {
      type: 'pos_register_session',
      id,
      organizationId,
      facilityId: row.facility_id,
    });
    return toPosSession(this.db, row);
  }
}
