import { Controller, Get, Post } from '@nestjs/common';
import {
  CustomerSupportRequestBody,
  ListMyCasesQuery,
  z,
  type CustomerCase,
  type CustomerSupportRequestInput,
  type Page,
  type Principal,
} from '@sportspark/contracts';
import {
  CurrentPrincipal,
  Idempotent,
  NoRecordAuthority,
  ZodBody,
  ZodParams,
  ZodQuery,
} from '../../../kernel';
import { CasesService } from '../services/cases.service';
import { CorrelationId } from './request-context.decorators';

const IdParams = z.object({ id: z.uuid() });
type IdParams = z.infer<typeof IdParams>;

/**
 * A customer's own support requests (SUP-01: SPK-SUPPORT-002, SPK-CAP-001 "contact the operating
 * team", SCR-C-22, SCR-C-38). The customer opens a request and reads its status; notes, owner,
 * queue and every internal detail stay staff records (§4.14). Anyone else's request is not found.
 */
@Controller('me')
export class MySupportController {
  constructor(private readonly cases: CasesService) {}

  @Post('support-requests')
  @Idempotent()
  @NoRecordAuthority('Not a §5.3 record category (authority matrix §4.1 scope notes).')
  request(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CustomerSupportRequestBody) body: CustomerSupportRequestInput,
    @CorrelationId() correlationId: string,
  ): Promise<CustomerCase> {
    return this.cases.requestSupport(principal, body, correlationId);
  }

  @Get('cases')
  list(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListMyCasesQuery) query: ListMyCasesQuery,
  ): Promise<Page<CustomerCase>> {
    return this.cases.myCases(principal, query);
  }

  @Get('cases/:id')
  get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: IdParams,
  ): Promise<CustomerCase> {
    return this.cases.myCase(principal, params.id);
  }
}
