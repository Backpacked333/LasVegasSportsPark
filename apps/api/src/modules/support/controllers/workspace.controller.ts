import { Controller, Get } from '@nestjs/common';
import {
  TimelineQuery,
  TodayQuery,
  z,
  type CustomerTimeline,
  type Principal,
  type TodayFeed,
} from '@sportspark/contracts';
import { CurrentPrincipal, ZodParams, ZodQuery } from '../../../kernel';
import { TimelineService } from '../services/timeline.service';
import { TodayService } from '../services/today.service';

const PersonParams = z.object({ personId: z.uuid() });
type PersonParams = z.infer<typeof PersonParams>;

/** The Today workspace (SPK-UX-006) and the scoped customer timeline (SPK-SUPPORT-001). */
@Controller()
export class WorkspaceController {
  constructor(
    private readonly today: TodayService,
    private readonly timeline: TimelineService,
  ) {}

  @Get('today')
  feed(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(TodayQuery) query: TodayQuery,
  ): Promise<TodayFeed> {
    return this.today.feed(principal, query);
  }

  @Get('customers/:personId/timeline')
  customerTimeline(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(PersonParams) params: PersonParams,
    @ZodQuery(TimelineQuery) query: TimelineQuery,
  ): Promise<CustomerTimeline> {
    return this.timeline.timeline(principal, params.personId, query);
  }
}
