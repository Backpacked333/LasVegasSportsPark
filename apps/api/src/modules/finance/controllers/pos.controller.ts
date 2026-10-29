import { Controller, Get, Patch, Post } from '@nestjs/common';
import {
  AddPosSaleLineBody,
  AddPosTenderBody,
  CloseRegisterSessionBody,
  CreatePosProductBody,
  CreatePosRegisterBody,
  CreatePosReturnBody,
  CreatePosSaleBody,
  ListMyPosReceiptsQuery,
  ListPosProductsQuery,
  ListPosRegistersQuery,
  OpenRegisterSessionBody,
  RetirePosRecordBody,
  UpdatePosProductBody,
  VoidPosSaleBody,
  z,
  type Page,
  type PosProduct,
  type PosReceipt,
  type PosRegister,
  type PosRegisterSession,
  type PosSale,
  type Principal,
} from '@sportspark/contracts';
import {
  CurrentPrincipal,
  Idempotent,
  NoRecordAuthority,
  RecordAuthority,
  RefusedDuringRecovery,
  ZodBody,
  ZodParams,
  ZodQuery,
} from '../../../kernel';
import { CorrelationId } from '../finance.shared';
import { PosSalesService } from '../services/pos/pos-sales.service';
import { PosSetupService } from '../services/pos/pos-setup.service';

const IdParams = z.object({ id: z.uuid() });
const NOT_A_CATEGORY = 'Not a §5.3 record category (point-of-sale setup, FIN-06).';

/** Point-of-sale products and registers (FIN-06; capability point_of_sale, DEC-016, DEC-079). */
@RefusedDuringRecovery()
@Controller()
export class PosSetupController {
  constructor(private readonly setup: PosSetupService) {}

  @Post('pos-products')
  @Idempotent()
  @NoRecordAuthority(NOT_A_CATEGORY)
  createProduct(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreatePosProductBody) body: z.infer<typeof CreatePosProductBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<PosProduct> {
    return this.setup.createProduct(principal, body, correlationId);
  }

  @Get('pos-products')
  listProducts(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListPosProductsQuery) query: z.infer<typeof ListPosProductsQuery>,
  ): Promise<Page<PosProduct>> {
    return this.setup.listProducts(principal, query);
  }

  @Patch('pos-products/:id')
  @Idempotent()
  @NoRecordAuthority(NOT_A_CATEGORY)
  updateProduct(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(UpdatePosProductBody) body: z.infer<typeof UpdatePosProductBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<PosProduct> {
    return this.setup.updateProduct(principal, params.id, body, correlationId);
  }

  @Post('pos-products/:id/retire')
  @Idempotent()
  @NoRecordAuthority(NOT_A_CATEGORY)
  retireProduct(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(RetirePosRecordBody) body: z.infer<typeof RetirePosRecordBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<PosProduct> {
    return this.setup.retireProduct(principal, params.id, body, correlationId);
  }

  @Post('pos-registers')
  @Idempotent()
  @NoRecordAuthority(NOT_A_CATEGORY)
  createRegister(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreatePosRegisterBody) body: z.infer<typeof CreatePosRegisterBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<PosRegister> {
    return this.setup.createRegister(principal, body, correlationId);
  }

  @Get('pos-registers')
  listRegisters(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListPosRegistersQuery) query: z.infer<typeof ListPosRegistersQuery>,
  ): Promise<Page<PosRegister>> {
    return this.setup.listRegisters(principal, query);
  }

  @Post('pos-registers/:id/retire')
  @Idempotent()
  @NoRecordAuthority(NOT_A_CATEGORY)
  retireRegister(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(RetirePosRecordBody) body: z.infer<typeof RetirePosRecordBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<PosRegister> {
    return this.setup.retireRegister(principal, params.id, body, correlationId);
  }

  @Post('pos-registers/:id/sessions')
  @Idempotent()
  @NoRecordAuthority(NOT_A_CATEGORY)
  openSession(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(OpenRegisterSessionBody) body: z.infer<typeof OpenRegisterSessionBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<PosRegisterSession> {
    return this.setup.openSession(principal, params.id, body, correlationId);
  }

  @Get('pos-register-sessions/:id')
  getSession(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<PosRegisterSession> {
    return this.setup.getSession(principal, params.id);
  }

  @Post('pos-register-sessions/:id/close')
  @Idempotent()
  @NoRecordAuthority(NOT_A_CATEGORY)
  closeSession(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(CloseRegisterSessionBody) body: z.infer<typeof CloseRegisterSessionBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<PosRegisterSession> {
    return this.setup.closeSession(principal, params.id, body, correlationId);
  }
}

/** Point-of-sale sales, tenders, voids, returns and receipts (FIN-06, §4.11 for cards). */
@RefusedDuringRecovery()
@Controller()
export class PosSalesController {
  constructor(private readonly sales: PosSalesService) {}

  @Post('pos-sales')
  @Idempotent()
  @RecordAuthority('order')
  create(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreatePosSaleBody) body: z.infer<typeof CreatePosSaleBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<PosSale> {
    return this.sales.create(principal, body, correlationId);
  }

  @Get('pos-sales/:id')
  get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<PosSale> {
    return this.sales.get(principal, params.id);
  }

  @Post('pos-sales/:id/lines')
  @Idempotent()
  @RecordAuthority('order')
  addLine(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(AddPosSaleLineBody) body: z.infer<typeof AddPosSaleLineBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<PosSale> {
    return this.sales.addLine(principal, params.id, body, correlationId);
  }

  @Post('pos-sales/:id/tenders')
  @Idempotent()
  @RecordAuthority('order')
  addTender(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(AddPosTenderBody) body: z.infer<typeof AddPosTenderBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<PosSale> {
    return this.sales.addTender(principal, params.id, body, correlationId);
  }

  @Post('pos-sales/:id/void')
  @Idempotent()
  @RecordAuthority('order')
  void(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(VoidPosSaleBody) body: z.infer<typeof VoidPosSaleBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<PosSale> {
    return this.sales.void(principal, params.id, body, correlationId);
  }

  @Post('pos-sales/:id/returns')
  @Idempotent()
  @RecordAuthority('order')
  createReturn(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(CreatePosReturnBody) body: z.infer<typeof CreatePosReturnBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<PosSale> {
    return this.sales.createReturn(principal, params.id, body, correlationId);
  }

  @Get('pos-sales/:id/receipt')
  receipt(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<PosReceipt> {
    return this.sales.receipt(principal, params.id);
  }

  @Get('me/pos-receipts')
  myReceipts(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListMyPosReceiptsQuery) query: z.infer<typeof ListMyPosReceiptsQuery>,
  ): Promise<Page<PosReceipt>> {
    return this.sales.myReceipts(principal, query);
  }
}
