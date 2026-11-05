import { Controller, Get } from '@nestjs/common';
import {
  RegistrationOptionsQuery,
  z,
  type Principal,
  type RegistrationOptions,
} from '@sportspark/contracts';
import { CurrentPrincipal, ZodParams, ZodQuery } from '../../../kernel';
import { RegistrationOptionsService } from '../services/registration-options.service';

const IdParams = z.object({ id: z.uuid() });

/** ENR-05 (SPK-REG-001/002, SCR-C-08/10): what an offering accepts and who may register. */
@Controller('offerings')
export class RegistrationOptionsController {
  constructor(private readonly options: RegistrationOptionsService) {}

  @Get(':id/registration-options')
  get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodQuery(RegistrationOptionsQuery) query: RegistrationOptionsQuery,
  ): Promise<RegistrationOptions> {
    return this.options.options(principal, params.id, query.participantPersonIds);
  }
}
