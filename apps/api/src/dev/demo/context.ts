import type { INestApplicationContext, Type } from '@nestjs/common';
import { DomainError, systemPrincipal, type Principal } from '@sportspark/contracts';
import type { Clock } from '../../kernel/clock';
import type { AppConfig } from '../../kernel/config';
import { Inbox } from '../../kernel/inbox/inbox';
import { OutboxDispatcher } from '../../kernel/outbox/outbox-dispatcher';
import { PrincipalResolver } from '../../modules/identity';
import { addDays, localDateOf, resolveLocal } from '../../modules/scheduling';

/**
 * What every stage of the demo dataset shares (ADR-007): the application, the clock it was given,
 * the synthetic organization and facility of the development seed, and the principals that act.
 * A stage never writes a module's tables: it calls the module's services as one of these
 * principals and reads back through the module's own reads.
 */
export interface DemoContext {
  app: INestApplicationContext;
  config: AppConfig;
  clock: Clock;
  organizationId: string;
  organizationSlug: string;
  facilityId: string;
  timezone: string;
  /** The kernel's system principal, for steps no staff role performs (enabling the dataset). */
  system: Principal;
  /** Progress lines (standard error in the script, nothing in tests). */
  log: (line: string) => void;
  /** What a stage could not create, with the reason, for the summary and the hand-off note. */
  notCreated: Array<{ what: string; why: string }>;
}

export function service<T>(ctx: DemoContext, token: Type<T>): T {
  return ctx.app.get(token, { strict: false });
}

/** The principal the API would resolve for a seeded local account (by its subject). */
export async function principalOf(ctx: DemoContext, subject: string): Promise<Principal | null> {
  const now = ctx.clock.now();
  return service(ctx, PrincipalResolver).resolve({
    issuer: ctx.config.AUTH_ISSUER,
    subject,
    sessionId: null,
    issuedAt: now,
    expiresAt: now,
    claims: {},
  });
}

export async function requirePrincipal(ctx: DemoContext, subject: string): Promise<Principal> {
  const principal = await principalOf(ctx, subject);
  if (!principal?.personId) throw new Error(`the demo account ${subject} does not exist`);
  return principal;
}

export function systemFor(ctx: Pick<DemoContext, 'organizationId'>): Principal {
  return systemPrincipal(ctx.organizationId, 'kernel.seed_demo');
}

/**
 * Runs the durable follow-ups until nothing more is due: recorded provider events (the fake
 * payment provider's outcomes) and the outbox (notices, schedules, standings). `pnpm demo` runs no
 * worker while it seeds, so the seed performs the follow-ups a worker would. A handler that keeps
 * failing stops the seed with its error rather than leaving a half-built dataset unnoticed.
 */
export async function settle(ctx: DemoContext): Promise<void> {
  const inbox = service(ctx, Inbox);
  const dispatcher = service(ctx, OutboxDispatcher);
  for (let round = 0; round < 60; round += 1) {
    const received = await inbox.runOnce(200);
    const summary = await dispatcher.runOnce(200);
    if (summary.dead > 0) {
      throw new Error(`a follow-up of the demo dataset failed for good (${summary.dead} event(s))`);
    }
    if (received.processed + received.failed + received.dead + summary.claimed === 0) return;
  }
}

/** Facility-local dates and times, derived from the clock the seed was given (SPK-SCHED-008). */
export interface DemoCalendar {
  /** Today's local date at the facility. */
  today: string;
  /** The local date `days` from today (negative: before). */
  day(days: number): string;
  /** The instant of a local time on the day `days` from today. */
  at(days: number, time: string): Date;
  /** The same, as the ISO text request bodies carry. */
  iso(days: number, time: string): string;
  /** Monday of the current local week. */
  weekStart: number;
}

export function calendarOf(ctx: Pick<DemoContext, 'clock' | 'timezone'>): DemoCalendar {
  const now = ctx.clock.now();
  const today = localDateOf(ctx.timezone, now);
  const at = (days: number, time: string): Date => {
    const resolved = resolveLocal(addDays(today, days), time, ctx.timezone);
    if (!resolved) throw new Error(`no such local time: ${addDays(today, days)} ${time}`);
    return resolved.instant;
  };
  const [year, month, dayOfMonth] = today.split('-').map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(year, month - 1, dayOfMonth)).getUTCDay();
  return {
    today,
    day: (days) => addDays(today, days),
    at,
    iso: (days, time) => at(days, time).toISOString(),
    weekStart: -((weekday + 6) % 7),
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * An instant a price rule may take effect at. A rule never prices an instant that has passed
 * (SPK-PAY-002), and the service reads its own "now" after the caller read theirs, so with a clock
 * that moves the instant is a moment ahead; `waitUntil` then waits for it before anything is
 * priced. With a clock that stands still (tests) it is the clock's instant.
 */
export async function soon(ctx: Pick<DemoContext, 'clock'>): Promise<string> {
  const before = ctx.clock.now().getTime();
  await sleep(3);
  const after = ctx.clock.now().getTime();
  return new Date(after > before ? after + 400 : after).toISOString();
}

/** Waits until the clock has reached the instant (at once when it already has). */
export async function waitUntil(ctx: Pick<DemoContext, 'clock'>, instant: string): Promise<void> {
  const target = new Date(instant).getTime();
  for (let i = 0; i < 200 && ctx.clock.now().getTime() < target; i += 1) await sleep(25);
  if (ctx.clock.now().getTime() < target) {
    throw new Error(
      `the clock did not reach ${instant}; the demo dataset needs a clock that moves`,
    );
  }
}

/** A readable line for a refused command (the code, the message and the detail code). */
export function describeError(error: unknown): string {
  if (DomainError.is(error)) {
    const details = error.details ? ` ${JSON.stringify(error.details)}` : '';
    return `${error.code}: ${error.message}${details}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs an optional part of the dataset: a refusal is recorded (and reported in the summary) and
 * the rest of the dataset is still built. Required parts are called directly and stop the seed.
 */
export async function optional<T>(
  ctx: DemoContext,
  what: string,
  build: () => Promise<T>,
): Promise<T | null> {
  try {
    return await build();
  } catch (error) {
    const why = describeError(error);
    ctx.notCreated.push({ what, why });
    ctx.log(`  could not create ${what}: ${why}`);
    return null;
  }
}
