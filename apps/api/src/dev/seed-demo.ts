import type { INestApplication } from '@nestjs/common';
import { systemPrincipal } from '@sportspark/contracts';
import type { Db } from '@sportspark/db';
import type { Clock } from '../kernel/clock';
import type { AppConfig } from '../kernel/config';
import { UnitOfWork } from '../kernel/database/unit-of-work';
import { OperationsService } from '../kernel/operations/operations.service';
import { OutboxDispatcher } from '../kernel/outbox/outbox-dispatcher';
import { APP_CONFIG, CLOCK, DATABASE } from '../kernel/tokens';
import { DeliveryWorker } from '../modules/communications';
import { localDateOf } from '../modules/scheduling';
import { openDemoClient, type DemoSession } from './demo/client';
import type { DemoAccount, DemoContext, DemoStaffKey } from './demo/context';
import { seedFacility } from './demo/facility';
import { seedLeague } from './demo/league';
import { seedLeagueRegistration } from './demo/league-registration';
import { seedOperations } from './demo/operations';
import {
  completeSeededPerson,
  createStaff,
  DEMO_STAFF,
  SEEDED_STAFF,
  signInWith,
} from './demo/people';
import { seedYouth } from './demo/youth';
import { assertSeedAllowed, type SeedSummary } from './seed-dev';

/** The durable operation that records a demo seed run for an organization (§4.9). */
export const DEMO_SEED_OPERATION = 'dev.seed_demo';

export const DEMO_NOTICE =
  'Synthetic demonstration data: every name, price, rule, capacity, policy wording and time ' +
  'is an invented example, not operator policy (specification §1.4).';

export interface DemoSummary {
  /** `created` on the run that made the dataset, `existing` when it was already there. */
  status: 'created' | 'existing';
  /** What this run did, ready to print; it always says that the data is synthetic. */
  message: string;
  notice: string;
  /** Today in the facility's time zone on the run that created the dataset. */
  anchoredOn: string;
  timezone: string;
  counts: {
    resources: number;
    demoStaffAccounts: number;
    customerAccounts: number;
    teams: number;
    rosterPlayers: number;
    fixtures: number;
    fixturesToday: number;
    officialResults: number;
    youthSessions: number;
    enrolledChildren: number;
    waitlistedChildren: number;
    completedCheckouts: number;
    teamFees: number;
    paidTeamFees: number;
    outstandingObligations: number;
    arrivals: number;
    sessionCheckins: number;
    openSupportCases: number;
    staffNotices: number;
    staffAssignments: number;
  };
  /** Ids to open records with (all created by this seed). */
  records: {
    competitionId: string;
    seasonId: string;
    divisionId: string;
    parentTeamEntryId: string;
    youthOfferingId: string;
    leagueOfferingId: string;
    todaySessionId: string;
    todayFixtureIds: string[];
    outstandingObligationId: string;
    maintenanceRestrictionId: string;
  };
  /** Local accounts added by the demo, to sign in with (`POST /v1/dev/tokens`). */
  accounts: DemoAccount[];
}

export interface DemoSeedOptions {
  /**
   * How the seed waits for the injected clock to reach an instant a moment ahead (a price rule
   * starts "from now on"). Default: poll the clock. A test with a fixed clock advances it here.
   */
  waitUntil?: (instant: Date) => Promise<void>;
}

/**
 * Demo dataset for a development database (K-14; §1.4: synthetic examples, never operator
 * policy; §5.2 "synthetic fixtures"). Opt-in (`seed:dev -- --demo`, `dev:all -- --seed --demo`),
 * on top of `seedDevelopment`, under the same refusal rules (never production, local identity
 * only).
 *
 * Every domain record is created the way a client would create it: the assembled application is
 * driven over HTTP as the seeded accounts, so each module stays the only writer of its tables
 * (§4.2) and every command is authorized, audited and followed up as usual (§4.9, §4.11). The
 * seed itself writes one kernel record, the `dev.seed_demo` operation that makes a second run a
 * no-op, and it drains the follow-ups the way the worker would (§4.12).
 *
 * The dataset is anchored to today in the facility's time zone (SPK-SCHED-008): "today's" games
 * and session are today's on the day the seed ran, and stay on that date afterwards.
 */
export async function seedDemo(
  app: INestApplication,
  base: SeedSummary,
  options: DemoSeedOptions = {},
): Promise<DemoSummary> {
  const config = app.get<AppConfig>(APP_CONFIG);
  assertSeedAllowed(config);
  const db = app.get<Db>(DATABASE);
  const clock = app.get<Clock>(CLOCK);
  const organizationId = base.organization.id;

  // Kernel read: an earlier run of this seed for the organization.
  const earlier = await db
    .selectFrom('operations')
    .select(['id', 'status', 'result'])
    .where('organization_id', '=', organizationId)
    .where('kind', '=', DEMO_SEED_OPERATION)
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
  const timezone = base.facility.timezone;
  const today = localDateOf(timezone, clock.now());
  if (earlier?.status === 'succeeded' && earlier.result) {
    const stored = earlier.result as unknown as DemoSummary;
    return {
      ...stored,
      status: 'existing',
      message: describe('existing', stored.anchoredOn, today),
    };
  }
  if (earlier) {
    throw new Error(
      `the demo dataset of organization ${base.organization.slug} is incomplete: an earlier ` +
        `--demo run stopped part-way (operation ${earlier.id}, ${earlier.status}). The seed does ` +
        'not resume a partial dataset; start from an empty development database (a new ' +
        'PGLITE_DATA_DIR or an empty DATABASE_URL database) and run it again.',
    );
  }

  const system = systemPrincipal(organizationId, 'kernel.seed_demo');
  const operations = app.get(OperationsService);
  const uow = app.get(UnitOfWork);
  const operationId = await uow.run(({ trx }) =>
    operations.create(trx, {
      organizationId,
      kind: DEMO_SEED_OPERATION,
      requestedBy: system,
      status: 'running',
      input: { anchoredOn: today, timezone },
    }),
  );

  const { client, close } = await openDemoClient(app);
  try {
    const summary = await createDataset(app, base, {
      api: client,
      clock,
      today,
      waitUntil: options.waitUntil ?? pollClock(clock),
    });
    await uow.run(({ trx }) =>
      operations.transition(trx, operationId, 'succeeded', { result: summary }),
    );
    return summary;
  } catch (error) {
    await uow.run(({ trx }) =>
      operations.transition(trx, operationId, 'failed', {
        error: {
          code: 'DEMO_SEED_FAILED',
          message: error instanceof Error ? error.message.slice(0, 1000) : 'demo seed failed',
        },
      }),
    );
    throw error;
  } finally {
    await close();
  }
}

/** One printable sentence about a run. A dataset anchored on an earlier day says so. */
function describe(status: DemoSummary['status'], anchoredOn: string, today: string): string {
  const what =
    status === 'created'
      ? `Demo dataset created, anchored on ${anchoredOn}.`
      : anchoredOn === today
        ? `Demo dataset already present (anchored on ${anchoredOn}); nothing was changed.`
        : `Demo dataset already present; nothing was changed. It is anchored on ${anchoredOn}: ` +
          `its "today" games, session and arrivals are dated that day, not ${today}. For a ` +
          'dataset anchored on today, start from an empty development database.';
  return `${what} ${DEMO_NOTICE}`;
}

/** Waits for the injected clock by polling it (the system clock in a development process). */
function pollClock(clock: Clock): (instant: Date) => Promise<void> {
  return async (instant) => {
    for (let waited = 0; clock.now().getTime() < instant.getTime(); waited += 50) {
      if (waited > 60_000) {
        throw new Error(`demo seed: the clock did not reach ${instant.toISOString()}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
}

async function createDataset(
  app: INestApplication,
  base: SeedSummary,
  given: Pick<DemoContext, 'api' | 'clock' | 'today' | 'waitUntil'>,
): Promise<DemoSummary> {
  const signIn = signInWith({ app });
  const dispatcher = app.get(OutboxDispatcher);
  const delivery = app.get(DeliveryWorker);
  const staff = {} as Record<DemoStaffKey, DemoSession>;
  for (const account of base.accounts) {
    const key = SEEDED_STAFF[account.subject];
    if (key) staff[key] = await signIn(account.subject, account.accountId, account.personId);
  }
  const parentAccount = base.accounts.find((a) => a.subject === 'dev-parent');
  if (!parentAccount) throw new Error('the development seed has no dev-parent account');
  const parent = await signIn('dev-parent', parentAccount.accountId, parentAccount.personId);

  const ctx: DemoContext = {
    ...given,
    app,
    organizationId: base.organization.id,
    facilityId: base.facility.id,
    timezone: base.facility.timezone,
    signIn,
    staff,
    accounts: [],
    sequence: { email: 0 },
    drain: async () => {
      // The worker's loops (§4.12), until both are idle: the outbox until nothing more is due,
      // then the provider hand-off of the notices it queued, whose outcomes are outbox events
      // again. A failed handler stops the seed: nothing is papered over.
      for (let round = 0; round < 200; round += 1) {
        const pass = await dispatcher.runOnce(200);
        if (pass.retried + pass.dead > 0) {
          throw new Error(
            `demo seed: an outbox handler failed (${pass.retried} retried, ${pass.dead} dead); ` +
              'see the job attempts of the outbox for the handler and its error',
          );
        }
        if (pass.claimed > 0) continue;
        const handed = await delivery.runOnce();
        if (handed.claimed === 0) return;
      }
      throw new Error('demo seed: the outbox and the delivery worker did not become idle');
    },
  };

  // The seeded accounts get a synthetic email address so their notices can be delivered.
  for (const account of base.accounts) {
    await completeSeededPerson(ctx, account.personId, {
      email: `${account.subject}@demo.example`,
    });
  }
  for (const spec of DEMO_STAFF) staff[spec.key] = await createStaff(ctx, spec);
  const demoStaffAccounts = ctx.accounts.length;

  const facility = await seedFacility(ctx);
  await ctx.drain();
  const league = await seedLeague(ctx, facility, parent);
  const registration = await seedLeagueRegistration(ctx, facility, league);
  const youth = await seedYouth(ctx, facility, parent, base.child.personId);
  const ops = await seedOperations(ctx, parent, league, youth);
  await ctx.drain();

  return {
    status: 'created',
    message: describe('created', ctx.today, ctx.today),
    notice: DEMO_NOTICE,
    anchoredOn: ctx.today,
    timezone: ctx.timezone,
    counts: {
      resources: facility.resourceCount,
      demoStaffAccounts,
      customerAccounts: ctx.accounts.length - demoStaffAccounts,
      teams: league.teams.length,
      rosterPlayers: league.players + 1,
      fixtures: league.fixtures.length,
      fixturesToday: league.todayFixtures.length,
      officialResults: league.officialResults,
      youthSessions: youth.sessions.length,
      enrolledChildren: youth.enrolledChildIds.length,
      waitlistedChildren: 1,
      completedCheckouts: youth.families.length + 1,
      teamFees: ops.teamFeeObligations,
      paidTeamFees: ops.paidTeamFees,
      outstandingObligations: ops.teamFeeObligations - ops.paidTeamFees,
      arrivals: ops.visits,
      sessionCheckins: ops.checkins,
      openSupportCases: 2,
      staffNotices: 1,
      staffAssignments: ops.assignments,
    },
    records: {
      competitionId: league.competitionId,
      seasonId: league.seasonId,
      divisionId: league.divisionId,
      parentTeamEntryId: league.teams[0]?.entryId ?? '',
      youthOfferingId: youth.offeringId,
      leagueOfferingId: registration.offeringId,
      todaySessionId: youth.todaySession.id,
      todayFixtureIds: league.todayFixtures.map((f) => f.id),
      outstandingObligationId: ops.outstandingObligationId,
      maintenanceRestrictionId: facility.restrictionId,
    },
    accounts: ctx.accounts,
  };
}
