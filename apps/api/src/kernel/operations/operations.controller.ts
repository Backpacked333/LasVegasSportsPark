import { Controller, Get } from '@nestjs/common';
import { z, type Operation, type Principal } from '@sportspark/contracts';
import { CurrentPrincipal } from '../auth/principal.decorator';
import { ZodParams } from '../http/zod-validation.pipe';
import { OperationsService } from './operations.service';

const Params = z.object({ id: z.uuid() });

@Controller('operations')
export class OperationsController {
  constructor(private readonly operations: OperationsService) {}

  @Get(':id')
  async get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(Params) params: z.infer<typeof Params>,
  ): Promise<Operation> {
    return this.operations.find(principal, params.id);
  }
}
