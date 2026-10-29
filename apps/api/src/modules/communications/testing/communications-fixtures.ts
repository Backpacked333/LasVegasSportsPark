import type { INestApplication } from '@nestjs/common';
import {
  newId,
  type DeliveryReceiptStatus,
  type Notification,
  type PushPlatformValue,
  type Principal,
} from '@sportspark/contracts';
import type { Db } from '@sportspark/db';
import { Inbox, OutboxDispatcher, type Clock } from '../../../kernel';
import { hashToken } from '../services/calendar-feeds.service';
import { tokenHintOf } from '../services/push-devices.service';
import {
  FAKE_MESSAGING_PROVIDER,
  FakeEmailProvider,
  FakeMessagingProvider,
  FakePushProvider,
  FakeSmsProvider,
} from '../providers/fake-messaging.provider';
import { DeliveryWorker, type DeliverySummary } from '../services/delivery-worker';
import { NotificationsService, type ComposeInput } from '../services/notifications.service';

/**
 * Fixtures for downstream module tests (enrollment, finance, competition, workforce, reporting).
 * They drive the real pipeline: outbox dispatch → recipient re-check → delivery worker → provider
 * fakes → receipts through the kernel inbox. Nothing here bypasses authorization or the outbox.
 */

export interface FakeProviders {
  push: FakePushProvider;
  email: FakeEmailProvider;
  sms: FakeSmsProvider;
}

export function fakeProviders(app: INestApplication): FakeProviders {
  return {
    push: app.get(FakePushProvider),
    email: app.get(FakeEmailProvider),
    sms: app.get(FakeSmsProvider),
  };
}

/** Runs the outbox dispatcher until no pending event is claimable (bounded). */
export async function dispatchOutbox(
  app: INestApplication,
  maxPasses = 20,
): Promise<{ dispatched: number; retried: number; dead: number }> {
  const dispatcher = app.get(OutboxDispatcher);
  const totals = { dispatched: 0, retried: 0, dead: 0 };
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const summary = await dispatcher.runOnce();
    totals.dispatched += summary.dispatched;
    totals.retried += summary.retried;
    totals.dead += summary.dead;
    if (summary.claimed === 0) break;
  }
  return totals;
}

/** Hands every ready external attempt to its provider (bounded). */
export async function deliverQueued(
  app: INestApplication,
  maxPasses = 20,
): Promise<DeliverySummary> {
  const worker = app.get(DeliveryWorker);
  const totals: DeliverySummary = {
    claimed: 0,
    accepted: 0,
    failed: 0,
    unknown: 0,
    revoked: 0,
    skipped: 0,
  };
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const summary = await worker.runOnce();
    for (const key of Object.keys(totals) as (keyof DeliverySummary)[]) totals[key] += summary[key];
    if (summary.claimed === 0) break;
  }
  return totals;
}

/** Queue a notice (compose + send) and run dispatch; returns the dispatched/suppressed notification. */
export async function composeAndDispatch(
  app: INestApplication,
  principal: Principal,
  input: ComposeInput,
): Promise<Notification> {
  const notifications = app.get(NotificationsService);
  const queued = await notifications.composeAndQueue(principal, input, input.correlationId ?? null);
  await dispatchOutbox(app);
  return notifications.get(principal, queued.id);
}

/** Records a provider receipt through the kernel inbox (as the webhook would) and processes it. */
export async function recordReceipt(
  app: INestApplication,
  provider: FakeMessagingProvider,
  request: { attemptId: string; organizationId: string },
  status: DeliveryReceiptStatus,
  options: { error?: string | null; eventId?: string } = {},
): Promise<{ inboxEventId: string; duplicate: boolean }> {
  const inbox = app.get(Inbox);
  const { body } = provider.receipt(request, status, options);
  const recorded = await inbox.record({
    provider: FAKE_MESSAGING_PROVIDER,
    providerEventId: body.id,
    eventType: body.type,
    payload: body.data,
    organizationId: body.data.organizationId,
    signatureVerified: true,
  });
  await inbox.runOnce();
  return { inboxEventId: recorded.id, duplicate: recorded.duplicate };
}

export async function attemptsOf(db: Db, organizationId: string, notificationId: string) {
  return db
    .selectFrom('delivery_attempts')
    .selectAll()
    .where('organization_id', '=', organizationId)
    .where('notification_id', '=', notificationId)
    .orderBy('channel')
    .orderBy('created_at')
    .execute();
}

export async function recipientsOf(db: Db, organizationId: string, notificationId: string) {
  return db
    .selectFrom('notification_recipients')
    .selectAll()
    .where('organization_id', '=', organizationId)
    .where('notification_id', '=', notificationId)
    .orderBy('person_id')
    .execute();
}

/** In-app attempts addressed to the person, newest first (what GET /me/inbox shows). */
export async function inboxOf(db: Db, organizationId: string, personId: string) {
  return db
    .selectFrom('delivery_attempts as a')
    .innerJoin('notification_recipients as r', 'r.id', 'a.recipient_id')
    .selectAll('a')
    .where('a.organization_id', '=', organizationId)
    .where('a.channel', '=', 'in_app')
    .where('r.person_id', '=', personId)
    .orderBy('a.created_at', 'desc')
    .execute();
}

/**
 * An active push registration for a person (COM-01), as `POST /v1/me/push-devices` would leave it;
 * for tests of other flows that need the push channel to reach someone. The account defaults to
 * the person's active account. Returns the device id and its token.
 */
export async function registerPushDeviceFixture(
  ctx: { db: Db; clock: Clock; organizationId: string },
  input: {
    personId: string;
    accountId?: string;
    token?: string;
    platform?: PushPlatformValue;
    organizationId?: string;
  },
): Promise<{ deviceId: string; token: string }> {
  const organizationId = input.organizationId ?? ctx.organizationId;
  let accountId = input.accountId;
  if (!accountId) {
    const account = await ctx.db
      .selectFrom('accounts')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('person_id', '=', input.personId)
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (!account) throw new Error(`person ${input.personId} has no active account for a device`);
    accountId = account.id;
  }
  const token = input.token ?? `device-${newId()}`;
  const deviceId = newId();
  const now = ctx.clock.now();
  await ctx.db
    .insertInto('push_devices')
    .values({
      id: deviceId,
      organization_id: organizationId,
      person_id: input.personId,
      account_id: accountId,
      platform: input.platform ?? 'ios',
      token,
      token_hash: hashToken(token),
      token_hint: tokenHintOf(token),
      app_version: null,
      registered_at: now,
      last_seen_at: now,
      revoked_at: null,
      revoked_reason: null,
    })
    .execute();
  return { deviceId, token };
}
