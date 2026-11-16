import type { PosSale, Principal } from '@sportspark/contracts';
import {
  FakePaymentTokens,
  PosOpenAmountService,
  PosSalesService,
  PosSetupService,
} from '../../modules/finance';
import { optional, service, settle, type DemoContext } from './context';
import type { DemoFamily, DemoStaff } from './people';

/**
 * The front-desk register (SPK-PAY-012): products, a register with an open session and a few
 * sales. With the open-amount line (SPK-PAY-016): one below the desk's ceiling, one above it with
 * the manager's second approval, and one above it still waiting for approval. No policy version is
 * approved for the open-amount rules, so the proposed default applies (three categories, a desk
 * ceiling of 50.00); the screen says so.
 */
const PRODUCTS: ReadonlyArray<{
  sku: string;
  name: string;
  kind: 'merchandise' | 'concession' | 'service';
  priceMinor: number;
}> = [
  { sku: 'WATER-500', name: 'Water, 500 ml', kind: 'concession', priceMinor: 250 },
  { sku: 'SPORT-DRINK', name: 'Sports drink', kind: 'concession', priceMinor: 350 },
  { sku: 'SNACK-BAR', name: 'Granola bar', kind: 'concession', priceMinor: 200 },
  { sku: 'SHIN-GUARD-Y', name: 'Shin guards, youth', kind: 'merchandise', priceMinor: 1_800 },
  { sku: 'SOCKS-TEAM', name: 'Team socks', kind: 'merchandise', priceMinor: 900 },
  {
    sku: 'BIB-RENTAL',
    name: 'Training bibs, set of ten (rental)',
    kind: 'service',
    priceMinor: 1_000,
  },
];

export interface DemoRegister {
  sessionId: string;
  /** The open sale whose open-amount line waits for a second approval. */
  waitingSaleId: string | null;
}

export async function seedRegister(
  ctx: DemoContext,
  staff: DemoStaff,
  families: DemoFamily[],
): Promise<DemoRegister> {
  const setup = service(ctx, PosSetupService);
  const sales = service(ctx, PosSalesService);
  const openAmount = service(ctx, PosOpenAmountService);
  const manager = staff.manager.principal;
  const desk = staff.desk.principal;
  const facilityId = ctx.facilityId;

  const known = (await setup.listProducts(manager, { facilityId, limit: 200 })).items;
  const productIds = new Map<string, string>();
  for (const spec of PRODUCTS) {
    const product =
      known.find((p) => p.sku === spec.sku) ??
      (await setup.createProduct(
        manager,
        { ...spec, facilityId, currency: 'USD', chargePolicyKeys: [], policyReferences: [] },
        null,
      ));
    productIds.set(spec.sku, product.id);
  }
  const product = (sku: string): string => productIds.get(sku) as string;

  const registers = (await setup.listRegisters(manager, { facilityId, limit: 50 })).items;
  const register =
    registers.find((r) => r.code === 'DESK1') ??
    (await setup.createRegister(
      manager,
      { facilityId, code: 'DESK1', name: 'Front desk register', policyReferences: [] },
      null,
    ));
  const sessionId =
    register.openSessionId ??
    (
      await setup.openSession(
        desk,
        register.id,
        { currency: 'USD', openingFloatMinor: 15_000, policyReferences: [] },
        null,
      )
    ).id;

  const summary = async (): Promise<DemoRegister> => {
    const listed = await sales.listForSession(desk, sessionId, { limit: 50 });
    const waiting = listed.items.find(
      (s) => s.status === 'open' && s.lines.some((l) => l.kind === 'open_amount'),
    );
    return { sessionId, waitingSaleId: waiting?.id ?? null };
  };
  const existing = await sales.listForSession(desk, sessionId, { limit: 50 });
  if (existing.items.length > 0) return summary();

  const sale = (customer?: Principal): Promise<PosSale> =>
    sales.create(
      desk,
      {
        registerSessionId: sessionId,
        customerPersonId: customer?.personId ?? undefined,
        policyReferences: [],
      },
      null,
    );
  const line = (saleId: string, sku: string, quantity: number): Promise<PosSale> =>
    sales.addLine(desk, saleId, { productId: product(sku), quantity, policyReferences: [] }, null);
  const cash = (ticket: PosSale): Promise<PosSale> =>
    sales.addTender(
      desk,
      ticket.id,
      { kind: 'cash', amountMinor: ticket.remainingMinor, policyReferences: [] },
      null,
    );
  const family = (key: string): DemoFamily => families.find((f) => f.key === key) as DemoFamily;

  // Two ordinary sales: drinks for cash, and kit on a card for a known customer.
  let ticket = await sale();
  await line(ticket.id, 'WATER-500', 2);
  ticket = await line(ticket.id, 'SPORT-DRINK', 1);
  await cash(ticket);

  await optional(ctx, 'the card sale at the register', async () => {
    const customer = family('birch').adult.principal;
    let kit = await sale(customer);
    await line(kit.id, 'SHIN-GUARD-Y', 1);
    kit = await line(kit.id, 'SOCKS-TEAM', 2);
    await sales.addTender(
      desk,
      kit.id,
      {
        kind: 'card',
        amountMinor: kit.remainingMinor,
        paymentMethodToken: FakePaymentTokens.succeed,
        policyReferences: [],
      },
      null,
    );
    await settle(ctx);
  });

  // SPK-PAY-016: below the desk's ceiling, the line needs nobody else. The seeded parent is named
  // on the sale, so the receipt is in the customer app.
  await optional(ctx, 'the open-amount line below the ceiling', async () => {
    let lostKey = await sale(family('dev').adult.principal);
    lostKey = await openAmount.addLine(
      desk,
      lostKey.id,
      {
        description: 'Locker key 14 not returned',
        amountMinor: 1_500,
        reasonCategory: 'lost_key',
        policyReferences: [],
      },
      null,
    );
    lostKey = await line(lostKey.id, 'WATER-500', 1);
    await cash(lostKey);
  });

  // Above the ceiling: the desk enters it, the manager approves it, then it is paid.
  await optional(ctx, 'the open-amount line with a second approval', async () => {
    let damage = await sale();
    damage = await openAmount.addLine(
      desk,
      damage.id,
      {
        description: 'Goal net torn on Field 3 during a rental',
        amountMinor: 12_000,
        reasonCategory: 'field_damage_fee',
        policyReferences: [],
      },
      null,
    );
    const entered = damage.lines.find((l) => l.kind === 'open_amount');
    if (!entered) throw new Error('the open-amount line was not added');
    damage = await openAmount.approve(
      manager,
      damage.id,
      entered.id,
      {
        expectedRevision: damage.revision,
        reason: 'Seen on the field; the renter agreed to the fee.',
        policyReferences: [],
      },
      null,
    );
    await cash(damage);
  });

  // Above the ceiling and not yet approved: the sale stays open until a second person approves.
  await optional(ctx, 'the open-amount line waiting for approval', async () => {
    const waiting = await sale();
    await openAmount.addLine(
      desk,
      waiting.id,
      {
        description: 'One hour with a coach for a birthday group',
        amountMinor: 9_000,
        reasonCategory: 'one_off_service',
        policyReferences: [],
      },
      null,
    );
  });
  await settle(ctx);
  return summary();
}
