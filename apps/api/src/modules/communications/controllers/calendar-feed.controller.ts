import { Controller, Get, Param, Res } from '@nestjs/common';
import { errors } from '@sportspark/contracts';
import type { Response } from 'express';
import { Public } from '../../../kernel';
import { CalendarFeedsService } from '../services/calendar-feeds.service';

/** Feed tokens are 32 random bytes in base64url (CalendarFeedsService.create); anything else is not a feed. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{32,64}$/;

/**
 * Token-authorized iCalendar feed (SPK-COMMS-008). The token is the only credential, so the route
 * is public to the auth guard; an unknown, malformed or revoked token answers NOT_FOUND like any
 * protected record (§4.10). Headers are set only on success so an error keeps the JSON error
 * contract; responses are never cacheable by intermediaries.
 */
@Controller('calendar-feeds')
export class CalendarFeedController {
  constructor(private readonly feeds: CalendarFeedsService) {}

  @Public()
  @Get(':token.ics')
  async fetch(
    @Param('token') token: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<string> {
    if (!TOKEN_SHAPE.test(token)) throw errors.protectedNotFound('calendar_feed');
    const { body } = await this.feeds.fetch(token);
    response.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    response.setHeader('Cache-Control', 'private, no-store');
    return body;
  }
}
