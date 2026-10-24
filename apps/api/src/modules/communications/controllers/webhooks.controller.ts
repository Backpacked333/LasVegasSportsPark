import { Body, Controller, Headers, HttpCode, Param, Post } from '@nestjs/common';
import { MessagingWebhookBody, errors, z } from '@sportspark/contracts';
import { Inbox, Public, ZodValidationPipe } from '../../../kernel';
import {
  FAKE_MESSAGING_PROVIDER,
  FAKE_MESSAGING_SIGNATURE_HEADER,
  FakeMessagingProvider,
} from '../providers/fake-messaging.provider';

const bodyPipe = new ZodValidationPipe(MessagingWebhookBody);

/**
 * Provider delivery receipts (§4.11): authenticate the event, record it durably and idempotently
 * in the kernel inbox, and let a worker apply it. Nothing about an attempt changes in this request.
 * Only the fake provider exists until a messaging vendor is selected (DEC-020).
 */
@Controller('webhooks/messaging')
export class MessagingWebhooksController {
  constructor(private readonly inbox: Inbox) {}

  @Public()
  @Post(':provider')
  @HttpCode(202)
  async receive(
    @Param('provider') provider: string,
    @Body() raw: unknown,
    @Headers(FAKE_MESSAGING_SIGNATURE_HEADER) signature: string | undefined,
  ): Promise<{ inboxEventId: string; duplicate: boolean }> {
    if (provider !== FAKE_MESSAGING_PROVIDER) throw errors.notFound('messaging provider', provider);
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
