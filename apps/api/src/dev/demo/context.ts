import type { INestApplication } from '@nestjs/common';
import type { StaffRole } from '@sportspark/contracts';
import type { Clock } from '../../kernel/clock';
import { addDays, resolveLocal } from '../../modules/scheduling';
import type { DemoClient, DemoSession } from './client';

/** A local account the demo created, listed in the seed's summary for signing in. */
export interface DemoAccount {
  subject: string;
  accountId: string;
  personId: string;
  about: string;
}

/** Everything a demo stage needs: the HTTP client, who acts, where, and "now" (injected clock). */
export interface DemoContext {
  app: INestApplication;
  api: DemoClient;
  organizationId: string;
  facilityId: string;
  timezone: string;
  /** The injected clock (never `Date.now()`): "now" for every date the seed derives. */
  clock: Clock;
  /** Today in the facility's time zone (SPK-SCHED-008), `YYYY-MM-DD`: the dataset's anchor. */
  today: string;
  /** Signs in an existing account of the local identity provider. */
  signIn(subject: string, accountId: string, personId: string): Promise<DemoSession>;
  /** Resolves once the injected clock has reached `instant` (a test advances its fixed clock). */
  waitUntil(instant: Date): Promise<void>;
  /** Runs the outbox and the delivery worker until nothing more is due (§4.12). */
  drain(): Promise<void>;
  staff: Record<DemoStaffKey, DemoSession>;
  /** Accounts created so far (demo staff, captains, parents). */
  accounts: DemoAccount[];
  /** Counters that keep generated values unique within one run. */
  sequence: { email: number };
}

/** The staff the demo acts as: five of the seeded accounts and the demo-only ones next to them. */
export type DemoStaffKey =
  | 'admin'
  | 'desk'
  | 'league'
  | 'coach'
  | 'official'
  | 'program'
  | 'finance'
  | 'facilities'
  | 'manager'
  | 'support'
  | 'coach2'
  | 'official2'
  | 'official3';

export interface DemoStaffSpec {
  key: DemoStaffKey;
  subject: string;
  givenName: string;
  familyName: string;
  roles: StaffRole[];
}

/** The facility-local date `dayOffset` days from today. */
export function localDate(ctx: Pick<DemoContext, 'today'>, dayOffset: number): string {
  return addDays(ctx.today, dayOffset);
}

/** A facility-local wall-clock time on a day relative to today, as a UTC instant (SPK-SCHED-008). */
export function localInstant(
  ctx: Pick<DemoContext, 'today' | 'timezone'>,
  dayOffset: number,
  time: string,
): string {
  const date = localDate(ctx, dayOffset);
  const resolved = resolveLocal(date, time, ctx.timezone);
  if (!resolved) throw new Error(`${date} ${time} does not exist in ${ctx.timezone}`);
  return resolved.instant.toISOString();
}
