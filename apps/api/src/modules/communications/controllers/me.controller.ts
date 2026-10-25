import { Controller, Get, HttpCode, Patch, Post } from '@nestjs/common';
import {
  AcknowledgeBody,
  CreateCalendarFeedBody,
  InboxQuery,
  MarkReadBody,
  RevokeCalendarFeedBody,
  UpdatePreferencesBody,
  z,
  type CalendarFeed,
  type CalendarFeedCreated,
  type CommunicationPreferences,
  type InboxItem,
  type Page,
  type Principal,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams, ZodQuery } from '../../../kernel';
import { CalendarFeedsService } from '../services/calendar-feeds.service';
import { InboxService } from '../services/inbox.service';
import { PreferencesService } from '../services/preferences.service';
import { CorrelationId } from './correlation.decorator';

const IdParams = z.object({ id: z.uuid() });

/**
 * Self-service surface: the inbox (SPK-UX-003), channel preferences (SPK-COMMS-007) and private
 * calendar feeds (SPK-COMMS-008) of the authenticated person. Never addresses another person.
 */
@Controller('me')
export class MeCommunicationsController {
  constructor(
    private readonly inbox: InboxService,
    private readonly preferences: PreferencesService,
    private readonly feeds: CalendarFeedsService,
  ) {}

  @Get('inbox')
  listInbox(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(InboxQuery) query: InboxQuery,
  ): Promise<Page<InboxItem>> {
    return this.inbox.list(principal, query);
  }

  @Post('inbox/:id/read')
  @HttpCode(200)
  @Idempotent()
  markRead(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(MarkReadBody) body: z.infer<typeof MarkReadBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<InboxItem> {
    return this.inbox.markRead(principal, params.id, body, correlationId);
  }

  @Post('inbox/:id/acknowledge')
  @HttpCode(200)
  @Idempotent()
  acknowledge(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(AcknowledgeBody) body: z.infer<typeof AcknowledgeBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<InboxItem> {
    return this.inbox.acknowledge(principal, params.id, body, correlationId);
  }

  @Get('communication-preferences')
  getPreferences(@CurrentPrincipal() principal: Principal): Promise<CommunicationPreferences> {
    return this.preferences.getMine(principal);
  }

  @Patch('communication-preferences')
  @Idempotent()
  updatePreferences(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(UpdatePreferencesBody) body: z.infer<typeof UpdatePreferencesBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<CommunicationPreferences> {
    return this.preferences.updateMine(principal, body, correlationId);
  }

  @Get('calendar-feeds')
  listFeeds(@CurrentPrincipal() principal: Principal): Promise<{ feeds: CalendarFeed[] }> {
    return this.feeds.listMine(principal);
  }

  @Post('calendar-feeds')
  // §4.14: the feed token (and the path that embeds it) is stored only as a hash.
  @Idempotent({ withhold: ['token', 'path'] })
  createFeed(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateCalendarFeedBody) body: z.infer<typeof CreateCalendarFeedBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<CalendarFeedCreated> {
    return this.feeds.create(principal, body, correlationId);
  }

  @Post('calendar-feeds/:id/revoke')
  @HttpCode(200)
  @Idempotent()
  revokeFeed(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(RevokeCalendarFeedBody) body: z.infer<typeof RevokeCalendarFeedBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<CalendarFeed> {
    return this.feeds.revoke(principal, params.id, body, correlationId);
  }
}
