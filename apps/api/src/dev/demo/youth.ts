import { weekdayOf } from '../../modules/scheduling';
import { checkoutBasket, publishOffering } from './catalog';
import type { DemoSession } from './client';
import { localDate, localInstant, type DemoContext } from './context';
import type { DemoFacility } from './facility';
import { completeSeededPerson, createAccount, createPerson, makeGuardian } from './people';

export interface DemoSessionRecord {
  id: string;
  eventId: string;
  dayOffset: number;
  start: string;
  end: string;
}

export interface DemoFamily {
  parent: DemoSession;
  childIds: string[];
  checkoutId: string;
  orderId: string | null;
}

export interface DemoYouth {
  programId: string;
  offeringId: string;
  sessions: DemoSessionRecord[];
  /** The session held today in the facility's time zone. */
  todaySession: DemoSessionRecord;
  families: DemoFamily[];
  enrolledChildIds: string[];
  waitlistedChildId: string;
  waitlistEntryId: string;
  capacity: number;
  priceMinor: number;
}

/** Synthetic values: capacity and price of the demo term. Not an operator decision. */
const CAPACITY = 10;
const PRICE_MINOR = 12_000;
const WEEKS_BEFORE = 3;
const WEEKS = 10;
const SESSION_MINUTES = 60;

/**
 * A youth program with a published term, its sessions on the calendar, a capacity limit, families
 * who registered and paid through checkout, and one child waiting (SPK-CAT-001..004,
 * SPK-REG-001..008, SPK-PAY-001). All names, the price, the capacity and the policy wording are
 * synthetic; the payments go through the deterministic `FakePaymentProvider` (§5.2).
 */
export async function seedYouth(
  ctx: DemoContext,
  facility: DemoFacility,
  parent: DemoSession,
  seededChildId: string,
): Promise<DemoYouth> {
  const { api } = ctx;
  const manager = ctx.staff.program;
  const startOffset = -WEEKS_BEFORE * 7;

  const { programId, offeringId, formPolicyVersionId } = await publishOffering(ctx, {
    slug: 'demo-junior',
    program: {
      name: 'Demo Junior Skills (synthetic)',
      description:
        'Synthetic example program for demonstrations: small-sided skills for ages 6 to 10.',
      format: '7v7',
      ageBand: { minAgeYears: 6, maxAgeYears: 10 },
    },
    entitlementName: 'Demo term seat (synthetic)',
    offering: {
      name: 'Demo Junior Skills: current term (synthetic)',
      description: 'Synthetic example term: two sessions a week on the north half of Demo Pitch 1.',
      kind: 'term',
      locationLabel: 'Demo Pitch 1 north half',
      resourceIds: [facility.pitch1North],
      startDayOffset: startOffset,
      endDayOffset: startOffset + WEEKS * 7,
      seats: CAPACITY,
    },
    basePriceMinor: PRICE_MINOR,
    wording: {
      eligibility: 'Synthetic example wording: players aged 6 to 10 on the first day of term.',
      cancellation: 'Synthetic example wording, not a real cancellation policy.',
      form: 'Synthetic example wording, not a real participation form or waiver.',
    },
  });

  // Sessions: two weekly series on the north half, each occurrence linked to its scheduling event
  // (the calendar and the session follow each other, SPK-SCHED-007).
  const sessions: DemoSessionRecord[] = [];
  const series = async (firstDayOffset: number, time: string, label: string): Promise<void> => {
    const startDate = localDate(ctx, firstDayOffset);
    const made = await api.post<{ eventIds: string[] }>('/event-series', manager, {
      facilityId: ctx.facilityId,
      kind: 'session',
      title: `Demo Junior Skills (${label})`,
      recurrence: {
        frequency: 'weekly',
        interval: 1,
        byWeekday: [weekdayOf(startDate)],
        startDate,
        count: WEEKS,
      },
      localStartTime: time,
      durationMinutes: SESSION_MINUTES,
      resourceIds: [facility.pitch1North],
      sourceType: 'offering',
      sourceId: offeringId,
    });
    for (const [week, eventId] of made.eventIds.entries()) {
      const dayOffset = firstDayOffset + week * 7;
      const start = localInstant(ctx, dayOffset, time);
      const end = new Date(Date.parse(start) + SESSION_MINUTES * 60_000).toISOString();
      const session = await api.post<{ id: string }>(`/offerings/${offeringId}/sessions`, manager, {
        title: `Demo Junior Skills (${label})`,
        scheduledStart: start,
        scheduledEnd: end,
        schedulingEventId: eventId,
      });
      sessions.push({ id: session.id, eventId, dayOffset, start, end });
    }
  };
  await series(startOffset, '16:00', 'first weekly session');
  await series(startOffset + 2, '16:30', 'second weekly session');
  sessions.sort((a, b) => a.start.localeCompare(b.start));
  const todaySession = sessions.find((s) => s.dayOffset === 0);
  if (!todaySession) throw new Error('demo seed: no session falls on today');
  await ctx.drain();

  // Families. Ages are counted from the first day of term (the offering's eligibility reference
  // date), so every child is inside the 6 to 10 band whenever the seed runs.
  const referenceYear = Number(localDate(ctx, startOffset).slice(0, 4));
  await completeSeededPerson(ctx, seededChildId, { dateOfBirth: `${referenceYear - 8}-02-14` });
  const child = async (
    guardian: DemoSession,
    givenName: string,
    familyName: string,
    age: number,
    month: string,
  ): Promise<string> => {
    const id = await createPerson(ctx, {
      kind: 'child',
      givenName,
      familyName: `${familyName} (demo child)`,
      dateOfBirth: `${referenceYear - age}-${month}-20`,
    });
    await makeGuardian(ctx, guardian.personId, id);
    return id;
  };
  const guardian = async (index: number, givenName: string, familyName: string) => {
    const personId = await createPerson(ctx, {
      kind: 'adult',
      givenName,
      familyName: `${familyName} (demo parent)`,
      dateOfBirth: `198${index}-06-0${index}`,
    });
    return createAccount(
      ctx,
      `demo-parent-${index}`,
      personId,
      'customer: guardian of demo children',
    );
  };

  // dev-parent registers the seeded child and a second one; three more synthetic families fill
  // the term to its capacity, and a fifth family's child joins the waitlist.
  const households: Array<{ parent: DemoSession; childIds: string[] }> = [];
  households.push({
    parent,
    childIds: [seededChildId, await child(parent, 'Jamie', 'Parent', 7, '09')],
  });
  const second = await guardian(2, 'Jordan', 'Sample');
  households.push({
    parent: second,
    childIds: [
      await child(second, 'Kai', 'Sample', 7, '03'),
      await child(second, 'Lane', 'Sample', 9, '07'),
      await child(second, 'Milan', 'Sample', 8, '11'),
    ],
  });
  const third = await guardian(3, 'Noel', 'Example');
  households.push({
    parent: third,
    childIds: [
      await child(third, 'Oakley', 'Example', 8, '01'),
      await child(third, 'Peyton', 'Example', 9, '05'),
      await child(third, 'Quinn', 'Example', 7, '08'),
    ],
  });
  const fourth = await guardian(4, 'Reese', 'Placeholder');
  households.push({
    parent: fourth,
    childIds: [
      await child(fourth, 'Sage', 'Placeholder', 9, '04'),
      await child(fourth, 'Tatum', 'Placeholder', 8, '10'),
    ],
  });
  const fifth = await guardian(5, 'Umber', 'Specimen');
  const waitlistedChildId = await child(fifth, 'Vale', 'Specimen', 7, '06');

  const families: DemoFamily[] = [];
  for (const household of households) {
    const basket = await api.post<{ id: string; revision: number }>('/baskets', household.parent, {
      ownerPersonId: household.parent.personId,
    });
    let current = basket;
    for (const childId of household.childIds) {
      // The guardian signs the required form for the child (complete_forms), then adds the line.
      await api.post('/acknowledgments', household.parent, {
        subjectPersonId: childId,
        policyVersionId: formPolicyVersionId,
      });
      current = await api.post(`/baskets/${basket.id}/lines`, household.parent, {
        participantPersonId: childId,
        offeringId,
        intent: 'youth',
      });
    }
    const paid = await checkoutBasket(ctx, household.parent, basket.id, {
      expectedRevision: current.revision,
    });
    families.push({ parent: household.parent, childIds: household.childIds, ...paid });
  }

  // The term is full: the next family joins the waitlist (SPK-REG-008).
  await api.post('/acknowledgments', fifth, {
    subjectPersonId: waitlistedChildId,
    policyVersionId: formPolicyVersionId,
  });
  const waitlist = await api.post<{ id: string }>('/waitlist-entries', fifth, {
    offeringId,
    participantPersonId: waitlistedChildId,
    intent: 'youth',
  });
  await ctx.drain();

  return {
    programId,
    offeringId,
    sessions,
    todaySession,
    families,
    enrolledChildIds: households.flatMap((h) => h.childIds),
    waitlistedChildId,
    waitlistEntryId: waitlist.id,
    capacity: CAPACITY,
    priceMinor: PRICE_MINOR,
  };
}
