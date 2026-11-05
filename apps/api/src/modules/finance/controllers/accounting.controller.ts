import { Controller, Get, Post } from '@nestjs/common';
import {
  ApproveAccountingMappingBody,
  CancelAccountingBatchBody,
  ListAccountingBatchesQuery,
  ListAccountingMappingsQuery,
  PrepareAccountingBatchBody,
  ProposeAccountingMappingBody,
  RetireAccountingMappingBody,
  SubmitAccountingBatchBody,
  z,
  type AccountingExportBatch,
  type AccountingMapping,
  type Page,
  type Principal,
} from '@sportspark/contracts';
import {
  CurrentPrincipal,
  Idempotent,
  NoRecordAuthority,
  RefusedDuringRecovery,
  ZodBody,
  ZodParams,
  ZodQuery,
} from '../../../kernel';
import { CorrelationId } from '../finance.shared';
import { AccountingExportService } from '../services/accounting/accounting-export.service';

const IdParams = z.object({ id: z.uuid() });
const NOT_A_CATEGORY = 'Not a §5.3 record category (accounting export, FIN-07).';

/** Accounting mappings and export batches (FIN-07; capability accounting, DEC-016, DEC-081). */
@RefusedDuringRecovery()
@Controller()
export class AccountingController {
  constructor(private readonly accounting: AccountingExportService) {}

  @Post('accounting-mappings')
  @Idempotent()
  @NoRecordAuthority(NOT_A_CATEGORY)
  propose(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(ProposeAccountingMappingBody) body: z.infer<typeof ProposeAccountingMappingBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<AccountingMapping> {
    return this.accounting.proposeMapping(principal, body, correlationId);
  }

  @Get('accounting-mappings')
  listMappings(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListAccountingMappingsQuery) query: z.infer<typeof ListAccountingMappingsQuery>,
  ): Promise<Page<AccountingMapping>> {
    return this.accounting.listMappings(principal, query);
  }

  @Post('accounting-mappings/:id/approve')
  @Idempotent()
  @NoRecordAuthority(NOT_A_CATEGORY)
  approve(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(ApproveAccountingMappingBody) body: z.infer<typeof ApproveAccountingMappingBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<AccountingMapping> {
    return this.accounting.approveMapping(principal, params.id, body, correlationId);
  }

  @Post('accounting-mappings/:id/retire')
  @Idempotent()
  @NoRecordAuthority(NOT_A_CATEGORY)
  retire(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(RetireAccountingMappingBody) body: z.infer<typeof RetireAccountingMappingBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<AccountingMapping> {
    return this.accounting.retireMapping(principal, params.id, body, correlationId);
  }

  @Post('accounting-export-batches')
  @Idempotent()
  @NoRecordAuthority(NOT_A_CATEGORY)
  prepare(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(PrepareAccountingBatchBody) body: z.infer<typeof PrepareAccountingBatchBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<AccountingExportBatch> {
    return this.accounting.prepareBatch(principal, body, correlationId);
  }

  @Get('accounting-export-batches')
  list(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListAccountingBatchesQuery) query: z.infer<typeof ListAccountingBatchesQuery>,
  ): Promise<Page<AccountingExportBatch>> {
    return this.accounting.list(principal, query);
  }

  @Get('accounting-export-batches/:id')
  get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<AccountingExportBatch> {
    return this.accounting.get(principal, params.id);
  }

  @Post('accounting-export-batches/:id/submit')
  @Idempotent()
  @NoRecordAuthority(NOT_A_CATEGORY)
  submit(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(SubmitAccountingBatchBody) body: z.infer<typeof SubmitAccountingBatchBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<AccountingExportBatch> {
    return this.accounting.submitBatch(principal, params.id, body, correlationId);
  }

  @Post('accounting-export-batches/:id/cancel')
  @Idempotent()
  @NoRecordAuthority(NOT_A_CATEGORY)
  cancel(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(CancelAccountingBatchBody) body: z.infer<typeof CancelAccountingBatchBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<AccountingExportBatch> {
    return this.accounting.cancelBatch(principal, params.id, body, correlationId);
  }
}
