import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  ComposeNotificationBody,
  ListNotificationsQuery,
  SendNotificationBody,
  z,
  type Notification,
  type NotificationDeliveries,
  type Page,
  type Principal,
  type RecipientPreview,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams, ZodQuery } from '../../../kernel';
import { NotificationsService } from '../services/notifications.service';
import { CorrelationId } from './correlation.decorator';

const IdParams = z.object({ id: z.uuid() });

/** Staff composition flow (SPK-COMMS-006): compose → preview recipients → confirm send → watch delivery. */
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Post()
  @Idempotent()
  compose(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(ComposeNotificationBody) body: z.infer<typeof ComposeNotificationBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Notification> {
    return this.notifications.compose(principal, body, correlationId);
  }

  @Get()
  list(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListNotificationsQuery) query: ListNotificationsQuery,
  ): Promise<Page<Notification>> {
    return this.notifications.list(principal, query);
  }

  @Get(':id')
  get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<Notification> {
    return this.notifications.get(principal, params.id);
  }

  @Get(':id/recipients')
  previewRecipients(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<RecipientPreview> {
    return this.notifications.previewRecipients(principal, params.id);
  }

  @Post(':id/send')
  @HttpCode(200)
  @Idempotent()
  send(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(SendNotificationBody) body: z.infer<typeof SendNotificationBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Notification> {
    return this.notifications.send(
      principal,
      params.id,
      { expectedRevision: body.expectedRevision, reason: body.reason ?? null },
      correlationId,
    );
  }

  @Get(':id/deliveries')
  deliveries(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<NotificationDeliveries> {
    return this.notifications.deliveries(principal, params.id);
  }
}
