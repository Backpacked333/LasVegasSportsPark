import { Controller, Get } from '@nestjs/common';
import {
  ListMyApplicationsQuery,
  ListMyBasketsQuery,
  ListMyTrialParticipationsQuery,
  ListMyWaitlistEntriesQuery,
  type Application,
  type Basket,
  type MyWaitlistEntry,
  type Page,
  type Principal,
  type TrialParticipation,
} from '@sportspark/contracts';
import { CurrentPrincipal, ZodQuery } from '../../../kernel';
import { MyRegistrationsService } from '../services/my-registrations.service';

/**
 * A person's own registration lists (ENR-01; SPK-REG-001, SPK-REG-004, SPK-REG-008, SPK-YOUTH-003,
 * SPK-UX-001): themselves and everyone they may view, keyset pages newest first.
 */
@Controller('me')
export class MeRegistrationsController {
  constructor(private readonly mine: MyRegistrationsService) {}

  @Get('baskets')
  baskets(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListMyBasketsQuery) query: ListMyBasketsQuery,
  ): Promise<Page<Basket>> {
    return this.mine.listBaskets(principal, query);
  }

  @Get('waitlist-entries')
  waitlistEntries(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListMyWaitlistEntriesQuery) query: ListMyWaitlistEntriesQuery,
  ): Promise<Page<MyWaitlistEntry>> {
    return this.mine.listWaitlistEntries(principal, query);
  }

  @Get('applications')
  applications(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListMyApplicationsQuery) query: ListMyApplicationsQuery,
  ): Promise<Page<Application>> {
    return this.mine.listApplications(principal, query);
  }

  @Get('trial-participations')
  trialParticipations(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListMyTrialParticipationsQuery) query: ListMyTrialParticipationsQuery,
  ): Promise<Page<TrialParticipation>> {
    return this.mine.listTrialParticipations(principal, query);
  }
}
