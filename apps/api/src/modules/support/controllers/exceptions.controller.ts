import { Controller, Get, HttpCode, Patch, Post } from '@nestjs/common';
import {
  AcknowledgeExceptionBody,
  CreateExceptionQueueBody,
  ListExceptionsQuery,
  SettleExceptionBody,
  UpdateExceptionQueueBody,
  z,
  type AcknowledgeExceptionInput,
  type CreateExceptionQueueInput,
  type ExceptionQueue,
  type OperationalException,
  type Page,
  type Principal,
  type SettleExceptionInput,
  type UpdateExceptionQueueInput,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams, ZodQuery } from '../../../kernel';
import { ExceptionQueuesService } from '../services/exception-queues.service';
import { ExceptionsService } from '../services/exceptions.service';
import { CorrelationId } from './request-context.decorators';

const IdParams = z.object({ id: z.uuid() });
type IdParams = z.infer<typeof IdParams>;

/**
 * Operational exceptions (§4.4 Exception, SPK-UX-006): queue-scoped lists and the acknowledge /
 * resolve / close workflow through the kernel. The affected record is never changed here.
 */
@Controller()
export class ExceptionsController {
  constructor(
    private readonly exceptions: ExceptionsService,
    private readonly queues: ExceptionQueuesService,
  ) {}

  @Get('exceptions')
  list(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListExceptionsQuery) query: ListExceptionsQuery,
  ): Promise<Page<OperationalException>> {
    return this.exceptions.list(principal, query);
  }

  @Get('exceptions/:id')
  get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: IdParams,
  ): Promise<OperationalException> {
    return this.exceptions.get(principal, params.id);
  }

  @Post('exceptions/:id/acknowledge')
  @HttpCode(200)
  @Idempotent()
  acknowledge(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: IdParams,
    @ZodBody(AcknowledgeExceptionBody) body: AcknowledgeExceptionInput,
    @CorrelationId() correlationId: string,
  ): Promise<OperationalException> {
    return this.exceptions.acknowledge(principal, params.id, body, correlationId);
  }

  @Post('exceptions/:id/resolve')
  @HttpCode(200)
  @Idempotent()
  resolve(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: IdParams,
    @ZodBody(SettleExceptionBody) body: SettleExceptionInput,
    @CorrelationId() correlationId: string,
  ): Promise<OperationalException> {
    return this.exceptions.resolve(principal, params.id, body, correlationId);
  }

  @Post('exceptions/:id/close')
  @HttpCode(200)
  @Idempotent()
  close(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: IdParams,
    @ZodBody(SettleExceptionBody) body: SettleExceptionInput,
    @CorrelationId() correlationId: string,
  ): Promise<OperationalException> {
    return this.exceptions.close(principal, params.id, body, correlationId);
  }

  @Get('exception-queues')
  listQueues(@CurrentPrincipal() principal: Principal): Promise<ExceptionQueue[]> {
    return this.queues.list(principal);
  }

  @Post('exception-queues')
  @Idempotent()
  createQueue(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateExceptionQueueBody) body: CreateExceptionQueueInput,
    @CorrelationId() correlationId: string,
  ): Promise<ExceptionQueue> {
    return this.queues.create(principal, body, correlationId);
  }

  @Patch('exception-queues/:id')
  @Idempotent()
  updateQueue(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: IdParams,
    @ZodBody(UpdateExceptionQueueBody) body: UpdateExceptionQueueInput,
    @CorrelationId() correlationId: string,
  ): Promise<ExceptionQueue> {
    return this.queues.update(principal, params.id, body, correlationId);
  }
}
