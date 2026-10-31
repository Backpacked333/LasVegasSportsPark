import { z } from '../zod';
import { Revision, withCommandMeta } from '../commands';
import { CurrencyCode } from '../money';
import { ErrorResponseSchema, openApiRegistry } from '../openapi';
import { PageRequestSchema, pageSchema } from '../pagination';
import { Instant } from '../time';
import { PaymentMethodToken } from './finance';

/**
 * Finance point of sale (FIN-06; §3.16 POS row "products, prices, approved taxes, tenders,
 * receipts, returns, permissions, reconciliation"; SPK-PAY-002, SPK-PAY-008, SPK-PAY-010,
 * SPK-PAY-012). Behind the per-organization capability `point_of_sale` (DEC-016, DEC-079): with
 * the switch off, creating or changing products, creating registers, opening sessions, new sales
 * and lines are refused (ACCESS_DENIED, `details.code CAPABILITY_DISABLED`); a tender settling an
 * existing open sale, retiring a product or register, closing a session, voids, returns, reads and
 * provider outcomes stay available, so a sale started before the switch was turned off can still
 * be paid, returned and its session closed. Prices come from the product, never from the request
 * (SPK-PAY-001); taxes and fees only from approved catalog `tax_fee` policy versions (DEC-057).
 * Registrations, memberships, packages and bookings are never sold here (SPK-PAY-012).
 */

const Reason = z.string().trim().min(1).max(2000);
const PositiveMinor = z.number().int().min(1).safe();
const NonNegativeMinor = z.number().int().min(0).safe();
const PolicyKey = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9_-]{0,99}$/, 'lowercase letters, digits, "-" and "_" only');
const Evidence = z
  .object({ reference: z.string().trim().min(1).max(200), notes: z.string().max(2000) })
  .partial({ notes: true })
  .strict();

export const PosProductKindSchema = z
  .enum(['merchandise', 'concession', 'service'])
  .openapi('PosProductKind', {
    description:
      'What a point-of-sale product is. Registrations, memberships, packages and bookings are never POS products (SPK-PAY-012).',
  });
export const PosLifecycleStatusSchema = z.enum(['active', 'retired']).openapi('PosLifecycleStatus');
export const PosSaleStatusSchema = z
  .enum(['open', 'paid', 'voided', 'partially_returned', 'returned'])
  .openapi('PosSaleStatus');
export const PosTenderKindSchema = z.enum(['cash', 'card', 'external']).openapi('PosTenderKind');

// ---------------------------------------------------------------------------------------------
// Products and registers
// ---------------------------------------------------------------------------------------------

export const PosProductSchema = z
  .object({
    id: z.uuid(),
    /** Null: sold at every facility of the organization. */
    facilityId: z.uuid().nullable(),
    sku: z.string(),
    name: z.string(),
    kind: PosProductKindSchema,
    priceMinor: z.number().int(),
    currency: CurrencyCode,
    /** Keys of catalog `tax_fee` policies; the approved version effective at sale time applies. */
    chargePolicyKeys: z.array(z.string()),
    status: PosLifecycleStatusSchema,
    retiredAt: Instant.nullable(),
    retireReason: z.string().nullable(),
    revision: Revision,
    createdAt: Instant,
    updatedAt: Instant,
  })
  .openapi('PosProduct');
export type PosProduct = z.infer<typeof PosProductSchema>;

const ChargePolicyKeys = z
  .array(PolicyKey)
  .max(10)
  .refine((keys) => new Set(keys).size === keys.length, { message: 'list each policy key once' });

export const CreatePosProductBody = withCommandMeta({
  facilityId: z.uuid().optional(),
  sku: z
    .string()
    .trim()
    .regex(/^[A-Z0-9][A-Z0-9_-]{0,39}$/, 'upper-case letters, digits, "-" and "_" only'),
  name: z.string().trim().min(1).max(200),
  kind: PosProductKindSchema,
  priceMinor: NonNegativeMinor,
  currency: CurrencyCode,
  chargePolicyKeys: ChargePolicyKeys.default([]),
})
  .strict()
  .openapi('CreatePosProductRequest');
export type CreatePosProductInput = z.infer<typeof CreatePosProductBody>;

/** §4.9: a product edit needs the current revision; it changes later sales only. */
export const UpdatePosProductBody = withCommandMeta({
  name: z.string().trim().min(1).max(200).optional(),
  priceMinor: NonNegativeMinor.optional(),
  chargePolicyKeys: ChargePolicyKeys.optional(),
})
  .extend({ expectedRevision: Revision })
  .strict()
  .refine(
    (v) => v.name !== undefined || v.priceMinor !== undefined || v.chargePolicyKeys !== undefined,
    { message: 'change at least one of name, priceMinor or chargePolicyKeys' },
  )
  .openapi('UpdatePosProductRequest');
export type UpdatePosProductInput = z.infer<typeof UpdatePosProductBody>;

export const RetirePosRecordBody = withCommandMeta({})
  .extend({ reason: Reason })
  .strict()
  .openapi('RetirePosRecordRequest');
export type RetirePosRecordInput = z.infer<typeof RetirePosRecordBody>;

export const ListPosProductsQuery = PageRequestSchema.extend({
  facilityId: z.uuid().optional(),
  status: PosLifecycleStatusSchema.optional(),
});
export type ListPosProductsQuery = z.infer<typeof ListPosProductsQuery>;

export const PosRegisterSchema = z
  .object({
    id: z.uuid(),
    facilityId: z.uuid(),
    code: z.string(),
    name: z.string(),
    status: PosLifecycleStatusSchema,
    openSessionId: z.uuid().nullable(),
    retiredAt: Instant.nullable(),
    retireReason: z.string().nullable(),
    revision: Revision,
    createdAt: Instant,
  })
  .openapi('PosRegister');
export type PosRegister = z.infer<typeof PosRegisterSchema>;

export const CreatePosRegisterBody = withCommandMeta({
  facilityId: z.uuid(),
  code: z
    .string()
    .trim()
    .regex(/^[A-Z0-9]{2,8}$/, '2 to 8 upper-case letters or digits'),
  name: z.string().trim().min(1).max(200),
})
  .strict()
  .openapi('CreatePosRegisterRequest');
export type CreatePosRegisterInput = z.infer<typeof CreatePosRegisterBody>;

export const ListPosRegistersQuery = PageRequestSchema.extend({
  facilityId: z.uuid().optional(),
  status: PosLifecycleStatusSchema.optional(),
});
export type ListPosRegistersQuery = z.infer<typeof ListPosRegistersQuery>;

// ---------------------------------------------------------------------------------------------
// Register sessions (cash drawers; POL-018 pending: no tolerance, no automatic posting)
// ---------------------------------------------------------------------------------------------

export const PosRegisterSessionSchema = z
  .object({
    id: z.uuid(),
    registerId: z.uuid(),
    facilityId: z.uuid(),
    currency: CurrencyCode,
    /** The facility-local opening date (YYYYMMDD) that sale numbers carry. */
    businessDate: z.string(),
    openingFloatMinor: z.number().int(),
    openedByPersonId: z.uuid(),
    openedAt: Instant,
    status: z.enum(['open', 'closed']),
    /** Float + settled cash tenders of the session's sales that were not voided − cash returns paid from it. */
    expectedCashMinor: z.number().int(),
    countedCashMinor: z.number().int().nullable(),
    /** Counted − expected; any difference raises `finance.pos_register_variance` for finance. */
    varianceMinor: z.number().int().nullable(),
    closedByPersonId: z.uuid().nullable(),
    closedAt: Instant.nullable(),
    revision: Revision,
  })
  .openapi('PosRegisterSession');
export type PosRegisterSession = z.infer<typeof PosRegisterSessionSchema>;

export const OpenRegisterSessionBody = withCommandMeta({
  currency: CurrencyCode,
  openingFloatMinor: NonNegativeMinor,
})
  .strict()
  .openapi('OpenRegisterSessionRequest');
export type OpenRegisterSessionInput = z.infer<typeof OpenRegisterSessionBody>;

export const CloseRegisterSessionBody = withCommandMeta({ countedCashMinor: NonNegativeMinor })
  .extend({ expectedRevision: Revision })
  .strict()
  .openapi('CloseRegisterSessionRequest');
export type CloseRegisterSessionInput = z.infer<typeof CloseRegisterSessionBody>;

// ---------------------------------------------------------------------------------------------
// Sales, lines, tenders, voids and returns
// ---------------------------------------------------------------------------------------------

export const PosLineChargeSchema = z
  .object({
    /** The approved `tax_fee` policy version the charge came from (DEC-057). */
    policyVersionId: z.uuid(),
    code: z.string(),
    label: z.string(),
    kind: z.enum(['tax', 'fee']),
    amountMinor: z.number().int(),
  })
  .openapi('PosLineCharge');

export const PosSaleLineSchema = z
  .object({
    id: z.uuid(),
    lineNumber: z.number().int(),
    productId: z.uuid(),
    sku: z.string(),
    name: z.string(),
    kind: PosProductKindSchema,
    unitPriceMinor: z.number().int(),
    quantity: z.number().int(),
    baseMinor: z.number().int(),
    charges: z.array(PosLineChargeSchema),
    chargesMinor: z.number().int(),
    lineTotalMinor: z.number().int(),
    returnedQuantity: z.number().int(),
  })
  .openapi('PosSaleLine');
export type PosSaleLine = z.infer<typeof PosSaleLineSchema>;

export const PosTenderSchema = z
  .object({
    id: z.uuid(),
    kind: PosTenderKindSchema,
    amountMinor: z.number().int(),
    currency: CurrencyCode,
    /** Cash and external tenders settle when recorded; a card tender waits for the provider. */
    status: z.enum(['pending', 'settled', 'failed']),
    paymentAttemptId: z.uuid().nullable(),
    /** The card payment's own status: `unknown` keeps the sale open until it is reconciled. */
    paymentStatus: z
      .enum([
        'created',
        'action_required',
        'processing',
        'succeeded',
        'failed',
        'canceled',
        'unknown',
      ])
      .nullable(),
    evidenceReference: z.string().nullable(),
    failureReason: z.string().nullable(),
    recordedByPersonId: z.uuid(),
    recordedAt: Instant,
    settledAt: Instant.nullable(),
  })
  .openapi('PosTender');
export type PosTender = z.infer<typeof PosTenderSchema>;

export const PosReturnLineSchema = z
  .object({
    saleLineId: z.uuid(),
    quantity: z.number().int(),
    amountMinor: z.number().int(),
    baseMinor: z.number().int(),
    charges: z.array(
      z.object({ code: z.string(), kind: z.enum(['tax', 'fee']), amountMinor: z.number().int() }),
    ),
  })
  .openapi('PosReturnLine');

export const PosReturnSchema = z
  .object({
    id: z.uuid(),
    amountMinor: z.number().int(),
    tenderKind: PosTenderKindSchema,
    lines: z.array(PosReturnLineSchema),
    refundAttemptId: z.uuid().nullable(),
    /** The card refund's status; REFUND_PENDING rules apply while it is not final (SPK-PAY-008). */
    refundStatus: z
      .enum(['requested', 'processing', 'succeeded', 'failed', 'canceled', 'unknown'])
      .nullable(),
    registerSessionId: z.uuid().nullable(),
    reason: z.string(),
    approvedByPersonId: z.uuid(),
    returnedAt: Instant,
  })
  .openapi('PosReturn');
export type PosReturn = z.infer<typeof PosReturnSchema>;

export const PosSaleSchema = z
  .object({
    id: z.uuid(),
    saleNumber: z.string(),
    registerSessionId: z.uuid(),
    facilityId: z.uuid(),
    customerPersonId: z.uuid().nullable(),
    status: PosSaleStatusSchema,
    currency: CurrencyCode,
    subtotalMinor: z.number().int(),
    chargesMinor: z.number().int(),
    totalMinor: z.number().int(),
    settledMinor: z.number().int(),
    pendingMinor: z.number().int(),
    /** Total − settled − pending: what a further tender may still cover. */
    remainingMinor: z.number().int(),
    returnedMinor: z.number().int(),
    lines: z.array(PosSaleLineSchema),
    tenders: z.array(PosTenderSchema),
    returns: z.array(PosReturnSchema),
    paidAt: Instant.nullable(),
    voidReason: z.string().nullable(),
    voidedAt: Instant.nullable(),
    revision: Revision,
    createdAt: Instant,
  })
  .openapi('PosSale');
export type PosSale = z.infer<typeof PosSaleSchema>;

export const CreatePosSaleBody = withCommandMeta({
  registerSessionId: z.uuid(),
  /** The customer, when known; a card tender needs one (the payer of the card payment). */
  customerPersonId: z.uuid().optional(),
})
  .strict()
  .openapi('CreatePosSaleRequest');
export type CreatePosSaleInput = z.infer<typeof CreatePosSaleBody>;

/** No price is accepted (SPK-PAY-001): the product's price and approved charges apply. */
export const AddPosSaleLineBody = withCommandMeta({
  productId: z.uuid(),
  quantity: z.number().int().min(1).max(999),
})
  .strict()
  .openapi('AddPosSaleLineRequest');
export type AddPosSaleLineInput = z.infer<typeof AddPosSaleLineBody>;

export const AddPosTenderBody = z
  .discriminatedUnion('kind', [
    withCommandMeta({ kind: z.literal('cash'), amountMinor: PositiveMinor }).strict(),
    withCommandMeta({
      kind: z.literal('external'),
      amountMinor: PositiveMinor,
      /** SPK-PAY-012: an externally recorded tender carries its evidence (a reference at least). */
      evidence: Evidence,
    }).strict(),
    withCommandMeta({
      kind: z.literal('card'),
      amountMinor: PositiveMinor,
      paymentMethodToken: PaymentMethodToken,
    }).strict(),
  ])
  .openapi('AddPosTenderRequest');
export type AddPosTenderInput = z.infer<typeof AddPosTenderBody>;

export const VoidPosSaleBody = withCommandMeta({})
  .extend({ reason: Reason })
  .strict()
  .openapi('VoidPosSaleRequest');
export type VoidPosSaleInput = z.infer<typeof VoidPosSaleBody>;

export const CreatePosReturnBody = withCommandMeta({
  lines: z
    .array(z.object({ saleLineId: z.uuid(), quantity: z.number().int().min(1).max(999) }).strict())
    .min(1)
    .max(50)
    .refine((lines) => new Set(lines.map((l) => l.saleLineId)).size === lines.length, {
      message: 'list each sale line once',
    }),
  tenderKind: PosTenderKindSchema,
  /** An external return carries its evidence (SPK-PAY-012). */
  evidence: Evidence.optional(),
  /**
   * The open register session whose drawer pays a cash return; defaults to the sale's own session
   * while it is open.
   */
  registerSessionId: z.uuid().optional(),
})
  .extend({ reason: Reason })
  .strict()
  .refine((v) => v.tenderKind !== 'external' || v.evidence !== undefined, {
    message: 'an external return carries its evidence',
    path: ['evidence'],
  })
  .openapi('CreatePosReturnRequest');
export type CreatePosReturnInput = z.infer<typeof CreatePosReturnBody>;

/** What the customer keeps: the sale as paid, its approved charges, tenders and returns. */
export const PosReceiptSchema = z
  .object({
    saleId: z.uuid(),
    saleNumber: z.string(),
    facilityId: z.uuid(),
    status: PosSaleStatusSchema,
    currency: CurrencyCode,
    lines: z.array(
      z.object({
        name: z.string(),
        kind: PosProductKindSchema,
        quantity: z.number().int(),
        unitPriceMinor: z.number().int(),
        baseMinor: z.number().int(),
        charges: z.array(PosLineChargeSchema),
        lineTotalMinor: z.number().int(),
      }),
    ),
    subtotalMinor: z.number().int(),
    charges: z.array(
      z.object({
        code: z.string(),
        label: z.string(),
        kind: z.enum(['tax', 'fee']),
        amountMinor: z.number().int(),
      }),
    ),
    totalMinor: z.number().int(),
    tenders: z.array(z.object({ kind: PosTenderKindSchema, amountMinor: z.number().int() })),
    returns: z.array(
      z.object({
        amountMinor: z.number().int(),
        tenderKind: PosTenderKindSchema,
        returnedAt: Instant,
      }),
    ),
    paidAt: Instant.nullable(),
  })
  .openapi('PosReceipt');
export type PosReceipt = z.infer<typeof PosReceiptSchema>;

export const ListMyPosReceiptsQuery = PageRequestSchema;
export type ListMyPosReceiptsQuery = z.infer<typeof ListMyPosReceiptsQuery>;

// ---------------------------------------------------------------------------------------------
// OpenAPI registration
// ---------------------------------------------------------------------------------------------
const IdParams = z.object({ id: z.uuid() });
const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorResponseSchema } },
});

function register(input: {
  method: 'get' | 'post' | 'patch';
  path: string;
  summary: string;
  query?: z.ZodObject<z.ZodRawShape>;
  body?: z.ZodType;
  response: z.ZodType;
}): void {
  const status = input.method === 'post' ? 201 : 200;
  openApiRegistry.registerPath({
    method: input.method,
    path: input.path,
    summary: input.summary,
    description:
      'FIN-06, §3.16 POS row. Commands that start a new commitment need the point_of_sale capability (DEC-016, DEC-079).',
    tags: ['Finance'],
    request: {
      ...(input.path.includes('{id}') ? { params: IdParams } : {}),
      ...(input.query ? { query: input.query } : {}),
      ...(input.body ? { body: { content: { 'application/json': { schema: input.body } } } } : {}),
    },
    responses: {
      [status]: {
        description: 'Success',
        content: { 'application/json': { schema: input.response } },
      },
      400: errorResponse('Validation failed (a client price or card data is rejected)'),
      401: errorResponse('Authentication required'),
      403: errorResponse(
        'Access denied or the point_of_sale capability is disabled (CAPABILITY_DISABLED)',
      ),
      404: errorResponse('Not found or not visible'),
      409: errorResponse(
        'Conflict (CHARGE_POLICY_NOT_APPROVED, PAYMENT_OUTCOME_UNKNOWN, REFUND_PENDING, STALE_REVISION, INVALID_TRANSITION, RESOURCE_CONFLICT, IDEMPOTENCY_*)',
      ),
    },
  });
}

register({
  method: 'post',
  path: '/pos-products',
  summary: 'Create a point-of-sale product with its approved charge policies',
  body: CreatePosProductBody,
  response: PosProductSchema,
});
register({
  method: 'get',
  path: '/pos-products',
  summary: 'List point-of-sale products',
  query: ListPosProductsQuery,
  response: pageSchema(PosProductSchema),
});
register({
  method: 'patch',
  path: '/pos-products/{id}',
  summary: 'Change a product for later sales (expected revision)',
  body: UpdatePosProductBody,
  response: PosProductSchema,
});
register({
  method: 'post',
  path: '/pos-products/{id}/retire',
  summary: 'Retire a product (past sales keep their snapshot)',
  body: RetirePosRecordBody,
  response: PosProductSchema,
});
register({
  method: 'post',
  path: '/pos-registers',
  summary: 'Create a register at a facility',
  body: CreatePosRegisterBody,
  response: PosRegisterSchema,
});
register({
  method: 'get',
  path: '/pos-registers',
  summary: 'List registers',
  query: ListPosRegistersQuery,
  response: pageSchema(PosRegisterSchema),
});
register({
  method: 'post',
  path: '/pos-registers/{id}/retire',
  summary: 'Retire a register that has no open session',
  body: RetirePosRecordBody,
  response: PosRegisterSchema,
});
register({
  method: 'post',
  path: '/pos-registers/{id}/sessions',
  summary: 'Open a register session with its opening float',
  body: OpenRegisterSessionBody,
  response: PosRegisterSessionSchema,
});
register({
  method: 'get',
  path: '/pos-register-sessions/{id}',
  summary: 'Read a register session with its expected cash',
  response: PosRegisterSessionSchema,
});
register({
  method: 'post',
  path: '/pos-register-sessions/{id}/close',
  summary: 'Close a register session with the counted cash (variance raised for finance, POL-018)',
  body: CloseRegisterSessionBody,
  response: PosRegisterSessionSchema,
});
register({
  method: 'post',
  path: '/pos-sales',
  summary: 'Start a sale in an open register session',
  body: CreatePosSaleBody,
  response: PosSaleSchema,
});
register({
  method: 'get',
  path: '/pos-sales/{id}',
  summary: 'Read a sale',
  response: PosSaleSchema,
});
register({
  method: 'post',
  path: '/pos-sales/{id}/lines',
  summary: 'Add a product line at its price with approved taxes and fees (SPK-PAY-002)',
  body: AddPosSaleLineBody,
  response: PosSaleSchema,
});
register({
  method: 'post',
  path: '/pos-sales/{id}/tenders',
  summary:
    'Take a cash, external or card tender on an open sale (card through the provider, §4.11; not gated by the switch, DEC-016)',
  body: AddPosTenderBody,
  response: PosSaleSchema,
});
register({
  method: 'post',
  path: '/pos-sales/{id}/void',
  summary: 'Void an open sale that holds no card tender',
  body: VoidPosSaleBody,
  response: PosSaleSchema,
});
register({
  method: 'post',
  path: '/pos-sales/{id}/returns',
  summary: 'Return lines of a paid sale (approved; reversing journals, SPK-PAY-010)',
  body: CreatePosReturnBody,
  response: PosSaleSchema,
});
register({
  method: 'get',
  path: '/pos-sales/{id}/receipt',
  summary: "Read a sale's receipt (facility staff or the customer)",
  response: PosReceiptSchema,
});
register({
  method: 'get',
  path: '/me/pos-receipts',
  summary: 'My point-of-sale receipts',
  query: ListMyPosReceiptsQuery,
  response: pageSchema(PosReceiptSchema),
});
