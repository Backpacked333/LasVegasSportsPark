import { z } from '../zod';
import { Revision, withCommandMeta } from '../commands';
import { CurrencyCode } from '../money';
import { ErrorResponseSchema, openApiRegistry } from '../openapi';
import { PageRequestSchema, pageSchema } from '../pagination';
import { Instant } from '../time';
import { LedgerAccountSchema } from './finance';

/**
 * Finance accounting export (FIN-07; §3.16 Accounting row "approved mappings, export or
 * integration batches, reconciliation, correction handling"; SPK-PAY-010, SPK-PAY-011; §5.2
 * accounting gate). Behind the per-organization capability `accounting` (DEC-016, DEC-081): with
 * the switch off, proposing and approving mappings, preparing and submitting batches are refused
 * (ACCESS_DENIED, `details.code CAPABILITY_DISABLED`); reads, retiring a mapping, canceling a
 * prepared batch, reconciliation and provider outcomes stay available. The accounting connection is
 * pending DEC-022: only the deterministic fake exists. No mapping is assumed: every exported
 * account needs a mapping approved by someone other than its proposer. Corrections are later
 * journals exported in a later batch; an exported batch never changes. Revenue recognition is
 * not done (DEC-022).
 */

const Reason = z.string().trim().min(1).max(2000);

export const AccountingMappingStatusSchema = z
  .enum(['proposed', 'approved', 'retired'])
  .openapi('AccountingMappingStatus');
export const AccountingBatchStatusSchema = z
  .enum(['prepared', 'submitted', 'accepted', 'rejected', 'unknown', 'canceled'])
  .openapi('AccountingBatchStatus', {
    description:
      "prepared: lines chosen, not sent. submitted: handed to the accounting connection. unknown: no answer; the reconciliation job asks again and never sends a second batch. accepted and rejected are the connection's answers (rejected lines can be exported again). canceled: a prepared batch withdrawn before sending.",
  });

export const AccountingMappingSchema = z
  .object({
    id: z.uuid(),
    ledgerAccount: LedgerAccountSchema,
    externalAccountRef: z.string(),
    status: AccountingMappingStatusSchema,
    proposedByPersonId: z.uuid(),
    approvedByPersonId: z.uuid().nullable(),
    approvedAt: Instant.nullable(),
    retiredAt: Instant.nullable(),
    retireReason: z.string().nullable(),
    revision: Revision,
    createdAt: Instant,
  })
  .openapi('AccountingMapping');
export type AccountingMapping = z.infer<typeof AccountingMappingSchema>;

export const ProposeAccountingMappingBody = withCommandMeta({
  ledgerAccount: LedgerAccountSchema,
  externalAccountRef: z.string().trim().min(1).max(200),
})
  .strict()
  .openapi('ProposeAccountingMappingRequest');
export type ProposeAccountingMappingInput = z.infer<typeof ProposeAccountingMappingBody>;

export const ApproveAccountingMappingBody = withCommandMeta({})
  .extend({ expectedRevision: Revision })
  .strict()
  .openapi('ApproveAccountingMappingRequest');
export type ApproveAccountingMappingInput = z.infer<typeof ApproveAccountingMappingBody>;

export const RetireAccountingMappingBody = withCommandMeta({})
  .extend({ reason: Reason, expectedRevision: Revision })
  .strict()
  .openapi('RetireAccountingMappingRequest');
export type RetireAccountingMappingInput = z.infer<typeof RetireAccountingMappingBody>;

export const ListAccountingMappingsQuery = PageRequestSchema.extend({
  status: AccountingMappingStatusSchema.optional(),
  ledgerAccount: LedgerAccountSchema.optional(),
});
export type ListAccountingMappingsQuery = z.infer<typeof ListAccountingMappingsQuery>;

export const AccountingExportLineSchema = z
  .object({
    id: z.uuid(),
    lineNumber: z.number().int(),
    journalEntryId: z.uuid(),
    ledgerAccount: LedgerAccountSchema,
    externalAccountRef: z.string(),
    debitMinor: z.number().int(),
    creditMinor: z.number().int(),
    currency: CurrencyCode,
    postedAt: Instant,
    memo: z.string(),
    /** False once the batch was rejected or canceled: the entry may then be exported again. */
    live: z.boolean(),
  })
  .openapi('AccountingExportLine');

export const AccountingExportBatchSchema = z
  .object({
    id: z.uuid(),
    periodStart: Instant,
    periodEnd: Instant,
    status: AccountingBatchStatusSchema,
    checksum: z.string(),
    lineCount: z.number().int(),
    /** Debit and credit totals per currency (they balance). */
    totals: z.array(
      z.object({
        currency: CurrencyCode,
        debitMinor: z.number().int(),
        creditMinor: z.number().int(),
      }),
    ),
    providerReference: z.string().nullable(),
    lastError: z.string().nullable(),
    preparedByPersonId: z.uuid().nullable(),
    preparedAt: Instant,
    submittedAt: Instant.nullable(),
    decidedAt: Instant.nullable(),
    canceledAt: Instant.nullable(),
    cancelReason: z.string().nullable(),
    revision: Revision,
    /** Present on the single read; lists leave it out. */
    lines: z.array(AccountingExportLineSchema).nullable(),
  })
  .openapi('AccountingExportBatch');
export type AccountingExportBatch = z.infer<typeof AccountingExportBatchSchema>;

export const PrepareAccountingBatchBody = withCommandMeta({
  periodStart: Instant,
  periodEnd: Instant,
})
  .strict()
  .refine((v) => new Date(v.periodEnd) > new Date(v.periodStart), {
    message: 'periodEnd must be after periodStart',
    path: ['periodEnd'],
  })
  .openapi('PrepareAccountingBatchRequest');
export type PrepareAccountingBatchInput = z.infer<typeof PrepareAccountingBatchBody>;

export const SubmitAccountingBatchBody = withCommandMeta({})
  .extend({ expectedRevision: Revision })
  .strict()
  .openapi('SubmitAccountingBatchRequest');
export type SubmitAccountingBatchInput = z.infer<typeof SubmitAccountingBatchBody>;

export const CancelAccountingBatchBody = withCommandMeta({})
  .extend({ reason: Reason })
  .strict()
  .openapi('CancelAccountingBatchRequest');
export type CancelAccountingBatchInput = z.infer<typeof CancelAccountingBatchBody>;

export const ListAccountingBatchesQuery = PageRequestSchema.extend({
  status: AccountingBatchStatusSchema.optional(),
});
export type ListAccountingBatchesQuery = z.infer<typeof ListAccountingBatchesQuery>;

// ---------------------------------------------------------------------------------------------
// OpenAPI registration
// ---------------------------------------------------------------------------------------------
const IdParams = z.object({ id: z.uuid() });
const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorResponseSchema } },
});

function register(input: {
  method: 'get' | 'post';
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
      'FIN-07, §3.16 Accounting row. Proposing, approving, preparing and submitting need the accounting capability (DEC-016, DEC-081); the connection is pending DEC-022.',
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
      400: errorResponse('Validation failed'),
      401: errorResponse('Authentication required'),
      403: errorResponse(
        'Access denied or the accounting capability is disabled (CAPABILITY_DISABLED)',
      ),
      404: errorResponse('Not found'),
      409: errorResponse(
        'Conflict (ACCOUNTING_MAPPING_REQUIRED with the unmapped accounts, NOTHING_TO_EXPORT, FOUR_EYES_REQUIRED, STALE_REVISION, INVALID_TRANSITION, IDEMPOTENCY_*)',
      ),
    },
  });
}

register({
  method: 'post',
  path: '/accounting-mappings',
  summary: 'Propose the external account of a ledger account',
  body: ProposeAccountingMappingBody,
  response: AccountingMappingSchema,
});
register({
  method: 'get',
  path: '/accounting-mappings',
  summary: 'List accounting mappings',
  query: ListAccountingMappingsQuery,
  response: pageSchema(AccountingMappingSchema),
});
register({
  method: 'post',
  path: '/accounting-mappings/{id}/approve',
  summary: 'Approve a proposed mapping (never by its proposer)',
  body: ApproveAccountingMappingBody,
  response: AccountingMappingSchema,
});
register({
  method: 'post',
  path: '/accounting-mappings/{id}/retire',
  summary: 'Withdraw a proposed mapping or retire an approved one',
  body: RetireAccountingMappingBody,
  response: AccountingMappingSchema,
});
register({
  method: 'post',
  path: '/accounting-export-batches',
  summary: 'Prepare a batch from the period journal entries not yet exported (SPK-PAY-010)',
  body: PrepareAccountingBatchBody,
  response: AccountingExportBatchSchema,
});
register({
  method: 'get',
  path: '/accounting-export-batches',
  summary: 'List accounting export batches',
  query: ListAccountingBatchesQuery,
  response: pageSchema(AccountingExportBatchSchema),
});
register({
  method: 'get',
  path: '/accounting-export-batches/{id}',
  summary: 'Read a batch with its lines',
  response: AccountingExportBatchSchema,
});
register({
  method: 'post',
  path: '/accounting-export-batches/{id}/submit',
  summary: 'Submit a prepared batch to the accounting connection (outside any transaction)',
  body: SubmitAccountingBatchBody,
  response: AccountingExportBatchSchema,
});
register({
  method: 'post',
  path: '/accounting-export-batches/{id}/cancel',
  summary: 'Cancel a prepared batch; its entries can be exported again',
  body: CancelAccountingBatchBody,
  response: AccountingExportBatchSchema,
});
