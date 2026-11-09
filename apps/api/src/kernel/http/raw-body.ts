import type { IncomingMessage } from 'node:http';
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

/** The path prefix of every provider webhook route (`/v1/webhooks/<provider kind>/<provider>`). */
export const WEBHOOK_PATH_PREFIX = '/v1/webhooks/';

/** A request whose exact body bytes were kept for signature verification. */
export interface RequestWithRawBody extends IncomingMessage {
  rawBody?: Buffer;
}

/**
 * Body-parser `verify` hook (§4.11 "Webhook handlers must authenticate provider events"): keeps
 * the exact bytes of a webhook request's body, because providers sign the bytes they sent and a
 * re-serialized parsed body does not reproduce them. Only webhook routes keep them, so ordinary
 * requests hold one copy of their body, not two.
 */
export function captureWebhookRawBody(req: IncomingMessage, _res: unknown, buffer: Buffer): void {
  if (req.url?.startsWith(WEBHOOK_PATH_PREFIX)) (req as RequestWithRawBody).rawBody = buffer;
}

/** Injects the exact body bytes of a webhook request (undefined on other routes). */
export const RawBody = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Buffer | undefined =>
    ctx.switchToHttp().getRequest<RequestWithRawBody>().rawBody,
);
