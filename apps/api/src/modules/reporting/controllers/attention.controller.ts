import { Controller, Get } from '@nestjs/common';
import type { AttentionCounts, Principal } from '@sportspark/contracts';
import { CurrentPrincipal } from '../../../kernel';
import { AttentionService } from '../services/attention.service';

/** GET /v1/me/attention: the sidebar's per-area counts of items waiting for the viewer. */
@Controller('me')
export class AttentionController {
  constructor(private readonly attention: AttentionService) {}

  @Get('attention')
  counts(@CurrentPrincipal() principal: Principal): Promise<AttentionCounts> {
    return this.attention.counts(principal);
  }
}
