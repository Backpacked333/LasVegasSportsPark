import { Controller, Delete, Get, HttpCode, Patch, Post } from '@nestjs/common';
import {
  CreateAssetBody,
  ListAssetsQuery,
  RetireAssetBody,
  UpdateAssetBody,
  z,
  type Asset,
  type Principal,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams, ZodQuery } from '../../../kernel';
import { AssetsService } from '../services/assets.service';
import { CorrelationId } from './correlation.decorator';

const IdParams = z.object({ id: z.uuid() });

/** Maintainable assets (SPK-FAC-001). */
@Controller('assets')
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  @Post()
  @Idempotent()
  create(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateAssetBody) body: CreateAssetBody,
    @CorrelationId() correlationId: string,
  ): Promise<Asset> {
    return this.assets.create(principal, body, correlationId);
  }

  @Get()
  list(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListAssetsQuery) query: ListAssetsQuery,
  ): Promise<Asset[]> {
    return this.assets.list(principal, query);
  }

  @Get(':id')
  get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<Asset> {
    return this.assets.get(principal, params.id);
  }

  @Patch(':id')
  @Idempotent()
  update(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(UpdateAssetBody) body: UpdateAssetBody,
    @CorrelationId() correlationId: string,
  ): Promise<Asset> {
    return this.assets.update(principal, params.id, body, correlationId);
  }

  @Delete(':id')
  @HttpCode(200)
  @Idempotent()
  retire(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(RetireAssetBody.optional()) body: RetireAssetBody | undefined,
    @CorrelationId() correlationId: string,
  ): Promise<Asset> {
    return this.assets.retire(principal, params.id, { ...(body ?? {}), correlationId });
  }
}
