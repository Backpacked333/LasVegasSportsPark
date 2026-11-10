import { FakePaymentTokens } from '../../modules/finance';
import { DEMO_CURRENCY } from './catalog';
import type { DemoSession } from './client';
import { localInstant, type DemoContext } from './context';
import type { DemoLeague } from './league';
import type { DemoYouth } from './youth';

export interface DemoOperations {
  teamFeeObligations: number;
  paidTeamFees: number;
  outstandingObligationId: string;
  visits: number;
  checkins: number;
  supportCaseId: string;
  customerRequestId: string;
  noticeId: string;
  assignments: number;
  acceptedAssignments: number;
}

/** Synthetic team fee; the billing model for teams is DEC-008 (pending). */
const TEAM_FEE_MINOR = 60_000;

/**
 * Money owed and paid by teams (SPK-PAY-004/005): every team entry has a team fee with one
 * responsible payer, its captain. Five captains paid through the fake provider; dev-parent's team
 * still owes its fee, due in a week, so one obligation is outstanding.
 */
async function seedTeamFees(
  ctx: DemoContext,
  league: DemoLeague,
): Promise<{ count: number; paid: number; outstandingId: string }> {
  let outstandingId = '';
  let paid = 0;
  for (const [index, team] of league.teams.entries()) {
    const obligation = await ctx.api.post<{ id: string }>('/obligations', ctx.staff.finance, {
      debtor: { kind: 'team_entry', teamEntryId: team.entryId },
      mode: 'single_team_payer',
      responsiblePayerPersonId: team.captain.personId,
      amountMinor: TEAM_FEE_MINOR,
      currency: DEMO_CURRENCY,
      dueAt: localInstant(ctx, 7, '18:00'),
      description: `Demo team fee: ${team.name} (synthetic example)`,
      source: { kind: 'team_fee', id: team.entryId },
    });
    if (index === 0) {
      outstandingId = obligation.id;
      continue;
    }
    await ctx.api.post(`/obligations/${obligation.id}/payments`, team.captain, {
      paymentMethodToken: FakePaymentTokens.succeed,
    });
    paid += 1;
  }
  await ctx.drain();
  return { count: league.teams.length, paid, outstandingId };
}

/**
 * Arrivals at the front desk (SPK-ENTRY-001/003/006): two families arrive, and the children who
 * came are checked in to today's session. Arriving is not attending; nobody is marked present.
 */
async function seedArrivals(
  ctx: DemoContext,
  youth: DemoYouth,
): Promise<{ visits: number; checkins: number }> {
  let visits = 0;
  let checkins = 0;
  for (const family of youth.families.slice(0, 2)) {
    const arrived = await ctx.api.post<{ visits: unknown[] }>('/visits', ctx.staff.desk, {
      facilityId: ctx.facilityId,
      arrivals: [
        { personId: family.parent.personId, visitorCategory: 'guardian' },
        ...family.childIds.map((personId) => ({ personId, visitorCategory: 'participant' })),
      ],
    });
    visits += arrived.visits.length;
    for (const personId of family.childIds) {
      await ctx.api.post('/session-checkins', ctx.staff.desk, {
        personId,
        activity: {
          type: 'session',
          offeringId: youth.offeringId,
          sessionId: youth.todaySession.id,
        },
      });
      checkins += 1;
    }
  }
  await ctx.drain();
  return { visits, checkins };
}

/**
 * Support (SPK-SUPPORT-001..003): dev-parent asks a question from the app, which opens a case the
 * support team can see, and the front desk opens a second case of its own that stays open.
 */
async function seedSupport(
  ctx: DemoContext,
  parent: DemoSession,
  youth: DemoYouth,
): Promise<{ caseId: string; customerRequestId: string }> {
  const family = youth.families[0];
  const request = await ctx.api.post<{ id: string }>('/me/support-requests', parent, {
    category: 'payment',
    title: 'Demo: can I get a copy of my receipt? (synthetic example)',
    description:
      'Synthetic example request for demonstrations: the customer asks for a copy of the receipt for the term.',
    relatedRecords: family?.orderId ? [{ type: 'order', id: family.orderId }] : [],
  });
  const opened = await ctx.api.post<{ id: string }>('/cases', ctx.staff.desk, {
    category: 'schedule',
    priority: 'normal',
    title: 'Demo: family asked to move to the later session (synthetic example)',
    description:
      'Synthetic example case for demonstrations: a parent called the desk about swapping session days.',
    facilityId: ctx.facilityId,
    subjectPersonId: youth.families[1]?.parent.personId,
    ownerQueue: 'front_desk',
  });
  await ctx.drain();
  return { caseId: opened.id, customerRequestId: request.id };
}

/** A staff notice to the families of today's session, sent and delivered to their inboxes. */
async function seedNotice(ctx: DemoContext, youth: DemoYouth): Promise<string> {
  const notice = await ctx.api.post<{ id: string }>('/notifications', ctx.staff.desk, {
    kind: 'staff_broadcast',
    category: 'operational',
    facilityId: ctx.facilityId,
    subject: { type: 'offering', id: youth.offeringId },
    audience: { subjectPersonIds: youth.enrolledChildIds },
    title: 'Demo notice: bring water and shin guards (synthetic example)',
    body: "Synthetic example message for demonstrations. Today's Demo Junior Skills session is on the north half of Demo Pitch 1.",
  });
  await ctx.api.post(`/notifications/${notice.id}/send`, ctx.staff.desk, {});
  await ctx.drain();
  return notice.id;
}

/**
 * Staffing (SPK-STAFF-001..003) of the next session and the next three games: normally today's,
 * or the following ones when the seed runs after today's have ended (an ended activity takes no
 * assignment). Each states who it needs; the seeded coach and official have accepted, the demo
 * coach and one demo official still hold an offer, and one game has no official yet, so Today
 * shows an uncovered slot.
 */
async function seedStaffing(
  ctx: DemoContext,
  league: DemoLeague,
  youth: DemoYouth,
): Promise<{ assignments: number; accepted: number }> {
  const { api } = ctx;
  let assignments = 0;
  let accepted = 0;
  const assign = async (
    target: { targetType: 'session' | 'fixture'; targetId: string; offeringId?: string },
    kind: 'coach' | 'official',
    role: string,
    slot: number,
    person: DemoSession,
    accept: boolean,
  ): Promise<void> => {
    const { assignment } = await api.post<{ assignment: { id: string; revision: number } }>(
      '/assignments',
      ctx.staff.league,
      { ...target, personId: person.personId, kind, role, slot, offer: true },
    );
    assignments += 1;
    if (accept) {
      await api.post(`/assignments/${assignment.id}/accept`, person, {
        expectedRevision: assignment.revision,
      });
      accepted += 1;
    }
  };

  const now = ctx.clock.now().getTime();
  const upcoming = <T extends { start: string; end: string }>(items: readonly T[]): T[] =>
    items
      .filter((item) => Date.parse(item.end) > now)
      .sort((a, b) => a.start.localeCompare(b.start));
  const nextSession = upcoming(youth.sessions)[0];
  if (!nextSession) return { assignments, accepted };
  const session = {
    targetType: 'session' as const,
    targetId: nextSession.id,
    offeringId: youth.offeringId,
  };
  await api.post('/assignment-requirements', ctx.staff.league, {
    ...session,
    kind: 'coach',
    role: 'coach',
    requiredCount: 2,
  });
  await assign(session, 'coach', 'coach', 1, ctx.staff.coach, true);
  await assign(session, 'coach', 'coach', 2, ctx.staff.coach2, false);

  for (const [index, fixture] of upcoming(league.fixtures).slice(0, 3).entries()) {
    const target = { targetType: 'fixture' as const, targetId: fixture.id };
    await api.post('/assignment-requirements', ctx.staff.league, {
      ...target,
      kind: 'official',
      role: 'referee',
      requiredCount: 1,
    });
    // First game: accepted by the seeded official. Second: offered. Third: nobody yet.
    if (index === 0) await assign(target, 'official', 'referee', 1, ctx.staff.official, true);
    if (index === 1) await assign(target, 'official', 'referee', 1, ctx.staff.official2, false);
  }
  await ctx.drain();
  return { assignments, accepted };
}

/**
 * dev-parent's own records in the customer app: a household with the two children and a personal
 * entry pass (SPK-ENTRY-002: an opaque reference, nothing about the family in it).
 */
async function seedFamilyRecords(
  ctx: DemoContext,
  parent: DemoSession,
  youth: DemoYouth,
): Promise<{ householdId: string; passId: string }> {
  const household = await ctx.api.post<{ id: string }>('/households', parent, {
    name: 'Demo household (synthetic)',
  });
  for (const personId of youth.families[0]?.childIds ?? []) {
    await ctx.api.post(`/households/${household.id}/members`, parent, { personId, label: 'child' });
  }
  const issued = await ctx.api.post<{ pass: { id: string } }>('/passes', parent, {
    holder: { kind: 'person', personId: parent.personId },
  });
  return { householdId: household.id, passId: issued.pass.id };
}

export async function seedOperations(
  ctx: DemoContext,
  parent: DemoSession,
  league: DemoLeague,
  youth: DemoYouth,
): Promise<DemoOperations> {
  const fees = await seedTeamFees(ctx, league);
  await seedFamilyRecords(ctx, parent, youth);
  const arrivals = await seedArrivals(ctx, youth);
  const support = await seedSupport(ctx, parent, youth);
  const noticeId = await seedNotice(ctx, youth);
  const staffing = await seedStaffing(ctx, league, youth);
  return {
    teamFeeObligations: fees.count,
    paidTeamFees: fees.paid,
    outstandingObligationId: fees.outstandingId,
    visits: arrivals.visits,
    checkins: arrivals.checkins,
    supportCaseId: support.caseId,
    customerRequestId: support.customerRequestId,
    noticeId,
    assignments: staffing.assignments,
    acceptedAssignments: staffing.accepted,
  };
}
