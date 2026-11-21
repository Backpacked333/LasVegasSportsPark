import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  ListFieldPreparationsQuery,
  MarkFieldReadyBody,
  RecordFieldPreparationBody,
  z,
  type FieldPreparation,
  type FieldPreparationDay,
  type MarkFieldReadyInput,
  type Principal,
  type RecordFieldPreparationInput,
} from '@sportspark/contracts';
import {
  CurrentPrincipal,
  Idempotent,
  NoRecordAuthority,
  ZodBody,
  ZodParams,
  ZodQuery,
} from '../../../kernel';
import { FieldPreparationsService } from '../services/field-preparations.service';
import { CorrelationId } from './correlation.decorator';

const IdParams = z.object({ id: z.uuid() });

/** The field crew's daily pitch preparation (migration 0975, SPK-FAC-001, SPK-READY-001). */
@Controller()
export class FieldPreparationsController {
  constructor(private readonly preparations: FieldPreparationsService) {}

  @Get('field-preparations')
  list(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListFieldPreparationsQuery) query: ListFieldPreparationsQuery,
  ): Promise<FieldPreparationDay> {
    return this.preparations.list(principal, query);
  }

  @Post('field-preparations')
  @NoRecordAuthority('Daily pitch preparation by the field crew, not a §5.3 record category')
  @HttpCode(200)
  @Idempotent()
  record(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(RecordFieldPreparationBody) body: RecordFieldPreparationInput,
    @CorrelationId() correlationId: string,
  ): Promise<FieldPreparation> {
    return this.preparations.record(principal, body, correlationId);
  }

  @Post('field-preparations/:id/ready')
  @NoRecordAuthority('Daily pitch preparation by the field crew, not a §5.3 record category')
  @HttpCode(200)
  @Idempotent()
  markReady(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(MarkFieldReadyBody) body: MarkFieldReadyInput,
    @CorrelationId() correlationId: string,
  ): Promise<FieldPreparation> {
    return this.preparations.markReady(principal, params.id, body, correlationId);
  }
}
