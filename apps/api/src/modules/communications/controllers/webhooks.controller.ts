import { Body, Controller, Headers, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { MessagingWebhookBody, errors, z } from '@sportspark/contracts';
import { APP_CONFIG, Inbox, Public, ZodValidationPipe, type AppConfig } from '../../../kernel';
import {
  FAKE_MESSAGING_PROVIDER,
  FAKE_MESSAGING_SIGNATURE_HEADER,
  FakeMessagingProvider,
} from '../providers/fake-messaging.provider';

const bodyPipe = new ZodValidationPipe(MessagingWebhookBody);

/**
 * Provider delivery receipts (§4.11): authenticate the event, record it durably and idempotently
 * in the kernel inbox, and let a worker apply it. Nothing about an attempt changes in this request.
 * Only the fake provider exists until a messaging vendor is selected (DEC-020). Its signing secret
 * is a published test constant, so its receipts are accepted only outside production (like
 * `/v1/dev/tokens`): in production the endpoint answers NOT_FOUND, and no one who has read the
 * source can mark an attempt delivered or failed (§4.11, §5.2).
 */
@Controller('webhooks/messaging')
export class MessagingWebhooksController {
  constructor(
    private readonly inbox: Inbox,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Post(':provider')
  @HttpCode(202)
  async receive(
    @Param('provider') provider: string,
    @Body() raw: unknown,
    @Headers(FAKE_MESSAGING_SIGNATURE_HEADER) signature: string | undefined,
  ): Promise<{ inboxEventId: string; duplicate: boolean }> {
    if (provider !== FAKE_MESSAGING_PROVIDER || this.config.NODE_ENV === 'production') {
      throw errors.notFound('messaging provider', provider);
    }
    if (!FakeMessagingProvider.verify(raw, signature)) {
      throw errors.authenticationRequired('The webhook signature is invalid.');
    }
    const body: z.infer<typeof MessagingWebhookBody> = bodyPipe.transform(raw);
    const recorded = await this.inbox.record({
      provider,
      providerEventId: body.id,
      eventType: body.type,
      payload: body.data,
      organizationId: body.data.organizationId,
      signatureVerified: true,
    });
    return { inboxEventId: recorded.id, duplicate: recorded.duplicate };
  }
}
