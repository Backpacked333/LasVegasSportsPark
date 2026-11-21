import type { INestApplicationContext } from '@nestjs/common';
import { CAPABILITIES, CAPABILITY_IDS, type CapabilityId } from '@sportspark/contracts';
import { CapabilityService } from '../kernel/capabilities/capability.service';
import type { Clock } from '../kernel/clock';
import type { AppConfig } from '../kernel/config';
import { APP_CONFIG, CLOCK } from '../kernel/tokens';
import { seedAssignments } from './demo/assignments';
import { seedCatalog } from './demo/catalog';
import {
  calendarOf,
  requirePrincipal,
  service,
  settle,
  systemFor,
  type DemoContext,
} from './demo/context';
import { seedCompetitions, seedLeague } from './demo/league';
import { seedMessageSequence, seedSeasonSchedule } from './demo/messages';
import { seedFrontDesk } from './demo/front-desk';
import { nameParentHousehold, seedParentCore } from './demo/parent-core';
import { seedFamilies, seedStaff } from './demo/people';
import { seedRegister } from './demo/register';
import { seedRegistrations } from './demo/registrations';
import { seedRentals } from './demo/rentals';
import { seedReports } from './demo/reports';
import { seedSpaces } from './demo/spaces';
import { seedStaffToday } from './demo/staff-today';
import { seedStaffSchedule } from './demo/staff-schedule';
import {
  assertSeedAllowed,
  seedDevelopment,
  type SeededAccount,
  type SeedSummary,
} from './seed-dev';

/**
 * The demo dataset (ADR-007, design section 4 "Demo mode"): a facility a person can walk through.
 * It runs the development seed (the organization `dev`, the facility `dev-facility` and the six
 * sign-in accounts) and then builds the facility's data by calling each module's services as the
 * staff member or customer who would, in the order a facility works: capabilities, staff, spaces,
 * policies and programs, families and registrations, the league, rentals, the register, messages.
 * It writes no table of another module and turns every capability on.
 *
 * Everything is synthetic (invented names, `example.test` addresses, 555-01xx numbers) and dated
 * from the clock the seed is given, in the facility's time zone, so the demo is alive on the day
 * it is run. Idempotent by natural keys: records are found by name, slug or account subject
 * before they are created. Development with local identity only (`assertSeedAllowed`).
 */
export const DEMO_TIMEZONE = 'America/Los_Angeles';

export interface DemoSeedOptions {
  /** Progress lines; the script writes them to standard error, tests leave them out. */
  log?: (line: string) => void;
}

export interface DemoSeedSummary extends SeedSummary {
  demo: {
    /**
     * Sign-in accounts the dataset adds to the six of the development seed (`accounts` keeps
     * those six, in their order): the general manager, who approves and sees money and reports.
     */
    accounts: SeededAccount[];
    /** Paths of the staff dashboard that open without signing in. */
    publicLinks: Record<string, string>;
    /** Screens of the staff dashboard the tours open on a seeded record (path by name). */
    tourLinks: Record<string, string>;
    /** Parts of the dataset the services refused, with the reason (reported, never hidden). */
    notCreated: Array<{ what: string; why: string }>;
  };
}

/** Every capability, each with its own applicability decision (DEC-016 names them all). */
export function capabilityDecision(capability: CapabilityId): string {
  const references = CAPABILITIES[capability].applicabilityReferences;
  return references[references.length - 1] as string;
}

async function enableEveryCapability(ctx: DemoContext): Promise<CapabilityId[]> {
  const capabilities = service(ctx, CapabilityService);
  // The administrator turns the switches on, as in the dashboard (core.manage_capabilities).
  const administrator = await requirePrincipal(ctx, 'dev-admin');
  const current = await capabilities.list(ctx.organizationId);
  for (const view of current) {
    if (view.enabled) continue;
    await capabilities.change(
      administrator,
      view.capability,
      'enable',
      { decisionReference: capabilityDecision(view.capability), reason: 'Demo dataset' },
      null,
    );
  }
  return [...CAPABILITY_IDS];
}

export async function seedDemo(
  app: INestApplicationContext,
  options: DemoSeedOptions = {},
): Promise<DemoSeedSummary> {
  const config = app.get<AppConfig>(APP_CONFIG);
  assertSeedAllowed(config);
  const base = await seedDevelopment(app, { timezone: DEMO_TIMEZONE });
  const ctx: DemoContext = {
    app,
    config,
    clock: app.get<Clock>(CLOCK),
    organizationId: base.organization.id,
    organizationSlug: base.organization.slug,
    facilityId: base.facility.id,
    timezone: base.facility.timezone,
    system: systemFor({ organizationId: base.organization.id }),
    log: options.log ?? (() => undefined),
    notCreated: [],
  };
  const calendar = calendarOf(ctx);

  ctx.log('capabilities');
  const enabledCapabilities = await enableEveryCapability(ctx);
  ctx.log('staff and families');
  const staff = await seedStaff(ctx);
  const families = await seedFamilies(ctx, calendar.today, base.child.personId);
  ctx.log('spaces');
  const spaces = await seedSpaces(ctx, staff);
  await settle(ctx);
  ctx.log('policies, programs and offerings');
  const catalog = await seedCatalog(ctx, staff, spaces);
  await settle(ctx);
  ctx.log('waivers, registrations and payments');
  await seedRegistrations(ctx, staff, families, catalog);
  ctx.log('league: competitions, message sequence, season, teams, fixtures, results');
  const shell = await seedCompetitions(ctx, staff);
  await seedMessageSequence(ctx, staff, shell.competitionId);
  const parent = families.find((f) => f.key === 'dev') as (typeof families)[number];
  const league = await seedLeague(ctx, staff, spaces, shell, parent.adult.principal);
  await seedSeasonSchedule(ctx, staff, league.seasonId);
  await settle(ctx);
  ctx.log('rentals and the group roster');
  const rentals = await seedRentals(ctx, staff, spaces, catalog, parent.adult.principal);
  ctx.log('register');
  const register = await seedRegister(ctx, staff, families);
  ctx.log('staff assignments');
  // The desk scans the parent app's family: name it (Dana, Maya, Leo) before the desk's seed.
  await nameParentHousehold(ctx, base.child.personId);
  await seedFrontDesk(ctx, staff, spaces);
  await seedAssignments(ctx, staff, catalog, league);
  await seedStaffToday(ctx, staff, spaces, catalog, league);
  await settle(ctx);
  ctx.log('reports');
  await seedReports(ctx, staff);
  await settle(ctx);
  await seedParentCore(ctx, staff, spaces, base.child.personId);
  await seedStaffSchedule(ctx, staff, spaces, catalog, families);
  ctx.log('done');

  const slug = ctx.organizationSlug;
  const publicLinks: Record<string, string> = {};
  if (league.facilityPublicCode) {
    publicLinks['publicSchedule'] = `/public/${slug}/schedule/${league.facilityPublicCode}`;
    publicLinks['lobby'] = league.seasonPublicCode
      ? `/lobby/${slug}/${league.facilityPublicCode}?seasons=${league.seasonPublicCode}`
      : `/lobby/${slug}/${league.facilityPublicCode}`;
  }
  if (league.seasonPublicCode) {
    publicLinks['publicStandings'] = `/public/${slug}/seasons/${league.seasonPublicCode}/standings`;
    publicLinks['publicFixtures'] = `/public/${slug}/seasons/${league.seasonPublicCode}/fixtures`;
  }
  const childOf = (key: string): string | undefined =>
    families.find((f) => f.key === key)?.children[0]?.personId;
  const tourLinks: Record<string, string> = {
    season: `/leagues/seasons/${league.seasonId}`,
    seasonResults: `/leagues/seasons/${league.seasonId}/results`,
    standings: `/leagues/seasons/${league.seasonId}/standings`,
    competition: `/leagues/competitions/${league.competitionId}`,
    teamEntries: `/teams/seasons/${league.seasonId}/entries`,
    messageSchedule: `/communications/schedules/season/${league.seasonId}`,
    perSessionClass: `/programs/offerings/${catalog.perSessionClass.id}`,
    memberClass: `/programs/offerings/${catalog.memberClass.id}`,
    camp: `/programs/offerings/${catalog.camp.id}`,
    campUniforms: `/programs/offerings/${catalog.camp.id}/uniforms`,
    waitlist: `/registrations/waitlists/${catalog.smallClass.id}`,
    registerSession: `/finance/point-of-sale/sessions/${register.sessionId}`,
  };
  if (rentals.rosterBookingId) {
    tourLinks['rentalRoster'] = `/schedule/rentals/${rentals.rosterBookingId}`;
  }
  if (register.waitingSaleId) {
    tourLinks['openAmountSale'] = `/finance/point-of-sale/sales/${register.waitingSaleId}`;
  }
  const paper = childOf('dune');
  const missing = childOf('heath');
  if (paper) tourLinks['paperWaiverPerson'] = `/people/${paper}`;
  if (missing) tourLinks['missingWaiverPerson'] = `/people/${missing}`;

  return {
    ...base,
    enabledCapabilities,
    demo: {
      accounts: [
        {
          subject: staff.manager.subject,
          accountId: staff.manager.accountId,
          personId: staff.manager.personId,
          roles: [...staff.manager.principal.staffRoles],
        },
      ],
      publicLinks,
      tourLinks,
      notCreated: ctx.notCreated,
    },
  };
}
