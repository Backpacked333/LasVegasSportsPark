import {
  Inject,
  Injectable,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { errors } from '@sportspark/contracts';
import type { Db } from '@sportspark/db';
import type { Request, Response } from 'express';
import { sql } from 'kysely';
import type { Clock } from '../clock';
import type { AppConfig } from '../config';
import { APP_CONFIG, CLOCK, DATABASE } from '../tokens';

/** A fixed window: at most `limit` requests per key per `windowSeconds`. */
export interface RateLimitRule {
  limit: number;
  windowSeconds: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Requests left in this window after this one (0 when refused). */
  remaining: number;
  /** Seconds until the window resets. */
  retryAfterSeconds: number;
}

/**
 * Counts requests per key in fixed windows (§4.14 rate-limited recovery). The memory store counts
 * per process; the PostgreSQL store shares one count between every API instance.
 */
export interface RateLimiterPort {
  consume(key: string, rule: RateLimitRule, now: Date): Promise<RateLimitDecision>;
}

export const RATE_LIMITER = Symbol('RATE_LIMITER');

function windowOf(now: Date, rule: RateLimitRule): { start: Date; retryAfterSeconds: number } {
  const ms = rule.windowSeconds * 1000;
  const start = Math.floor(now.getTime() / ms) * ms;
  return {
    start: new Date(start),
    retryAfterSeconds: Math.max(1, Math.ceil((start + ms - now.getTime()) / 1000)),
  };
}

function decide(count: number, rule: RateLimitRule, retryAfterSeconds: number): RateLimitDecision {
  return {
    allowed: count <= rule.limit,
    remaining: Math.max(0, rule.limit - count),
    retryAfterSeconds,
  };
}

/** Per-process counters (development, tests, a single instance). */
export class MemoryRateLimiter implements RateLimiterPort {
  private readonly counts = new Map<string, { windowStart: number; count: number }>();

  async consume(key: string, rule: RateLimitRule, now: Date): Promise<RateLimitDecision> {
    const { start, retryAfterSeconds } = windowOf(now, rule);
    const current = this.counts.get(key);
    const count = current && current.windowStart === start.getTime() ? current.count + 1 : 1;
    this.counts.set(key, { windowStart: start.getTime(), count });
    if (this.counts.size > 10_000) {
      for (const [k, v] of this.counts) if (v.windowStart < start.getTime()) this.counts.delete(k);
    }
    return decide(count, rule, retryAfterSeconds);
  }
}

/** One shared count per window in `rate_limit_buckets` (migration 0019). */
export class PostgresRateLimiter implements RateLimiterPort {
  private lastPrune = 0;

  constructor(private readonly db: Db) {}

  async consume(key: string, rule: RateLimitRule, now: Date): Promise<RateLimitDecision> {
    const { start, retryAfterSeconds } = windowOf(now, rule);
    const { rows } = await sql<{ count: number }>`
      insert into rate_limit_buckets (bucket_key, window_start, count)
      values (${key}, ${start}, 1)
      on conflict (bucket_key, window_start) do update set count = rate_limit_buckets.count + 1
      returning count
    `.execute(this.db);
    if (now.getTime() - this.lastPrune > 3_600_000) {
      this.lastPrune = now.getTime();
      await sql`delete from rate_limit_buckets where window_start < ${new Date(now.getTime() - 86_400_000)}`.execute(
        this.db,
      );
    }
    return decide(Number(rows[0]?.count ?? 1), rule, retryAfterSeconds);
  }
}

/** The routes' named limits; `RATE_LIMITS` overrides them (`dev_tokens=10/60,claims=20/600`). */
export const DEFAULT_RATE_LIMITS = {
  /** Development token minting on a protected staging host (passcode guessing). */
  dev_tokens: { limit: 10, windowSeconds: 60 },
  /** Claim token acceptance (token guessing, SPK-IAM-002). */
  claims: { limit: 20, windowSeconds: 600 },
  /** Invitation acceptance, customer and staff (SPK-IAM-004). */
  invitations: { limit: 30, windowSeconds: 600 },
  /** Account relink, the staff-assisted recovery path (§4.14 rate-limited recovery). */
  account_recovery: { limit: 10, windowSeconds: 600 },
} as const satisfies Record<string, RateLimitRule>;
export type RateLimitName = keyof typeof DEFAULT_RATE_LIMITS;

const RATE_LIMIT_KEY = 'sportspark:rate-limit';

/** Limits a route per client address under the named rule (§4.14). */
export const RateLimited = (name: RateLimitName) => SetMetadata(RATE_LIMIT_KEY, name);

/**
 * Applies `@RateLimited` before authentication (§4.14), so an anonymous caller cannot guess
 * passcodes or tokens at speed. A refused request answers 429 RATE_LIMITED with `Retry-After`.
 * The client address is the one Express reports, which follows `TRUST_PROXY` behind a proxy.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiterPort,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const name = this.reflector.getAllAndOverride<RateLimitName | undefined>(RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!name) return true;
    const rule = this.config.RATE_LIMITS[name] ?? DEFAULT_RATE_LIMITS[name];
    const request = context.switchToHttp().getRequest<Request>();
    const address = request.ip ?? request.socket?.remoteAddress ?? 'unknown';
    const decision = await this.limiter.consume(`${name}:${address}`, rule, this.clock.now());
    if (!decision.allowed) {
      context
        .switchToHttp()
        .getResponse<Response>()
        .setHeader('Retry-After', String(decision.retryAfterSeconds));
      throw errors.rateLimited(decision.retryAfterSeconds);
    }
    return true;
  }
}

/** The configured store: PostgreSQL in production unless set, memory elsewhere. */
export function rateLimiterFor(config: AppConfig, db: Db): RateLimiterPort {
  const store =
    config.RATE_LIMIT_STORE ?? (config.NODE_ENV === 'production' ? 'postgres' : 'memory');
  return store === 'postgres' ? new PostgresRateLimiter(db) : new MemoryRateLimiter();
}

/** Wires the limiter (`RATE_LIMITER`) from configuration and the database. */
export const rateLimiterProvider = {
  provide: RATE_LIMITER,
  inject: [APP_CONFIG, DATABASE],
  useFactory: (config: AppConfig, db: Db): RateLimiterPort => rateLimiterFor(config, db),
};
