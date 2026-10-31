import { newId, systemPrincipal, type TimelineEntry } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { createCreditFixture, createObligationFixture } from '../../finance';
import { authHeaderForPerson, createPersonFixture } from '../../identity';
import { EventsService, at, createScheduledEvent, seedPitchWithHalves } from '../../scheduling';
import {
  adultCustomer,
  childOf,
  drainOutbox,
  get,
  offering,
  otherOrganization,
  post,
  registerAndPay,
  secondFacility,
  staffMember,
  supportTestApp,
  type Actor,
} from './support';

/**
 * SPK-SUPPORT-001 scoped customer timeline: registration, participation, orders, payments,
 * refunds, credits, changes, messages and support requests of a person and their dependents,
 * read through the owning modules with the operator's principal.
 */
describe('customer timeline (SPK-SUPPORT-001)', () => {
  let t: TestApp;
  let operator: Actor;
  let manager: Actor;
  let parent: Actor;
  let childId: string;
  let otherParent: Actor;
  let otherChildId: string;
  let paid: Awaited<ReturnType<typeof registerAndPay>>;
  let eventId: string;
  let caseId: string;

  beforeAll(async () => {
    t = await supportTestApp();
    operator = await staffMember(t, ['support_operator']);
    manager = await staffMember(t, ['general_manager']);
    parent = await adultCustomer(t, { givenName: 'Ana', familyName: 'Alvarez' });
    childId = await childOf(t, [parent], {
      givenName: 'Cleo',
      familyName: 'Quintanilla',
      dateOfBirth: '2016-09-03',
    });
    // Another household in the same organization.
    otherParent = await adultCustomer(t, { givenName: 'Bea', familyName: 'Brandt' });
    otherChildId = await childOf(t, [otherParent], { givenName: 'Dov', familyName: 'Brandt' });

    // Registration and payment through enrollment and finance (real facts and events).
    const setup = await offering(t, 12_000);
    paid = await registerAndPay(t, parent, childId, setup);
    await registerAndPay(t, otherParent, otherChildId, setup);
    await createObligationFixture(t, {
      debtorPersonId: parent.personId,
      amountMinor: 2_500,
      description: 'Uniform fee',
    });
    await createCreditFixture(t, { ownerPersonId: parent.personId, amountMinor: 1_000 });
    await createObligationFixture(t, { debtorPersonId: otherParent.personId, amountMinor: 999 });

    // Messages: one to both households, one about the child (to the guardian).
    for (const audience of [
      { subjectPersonIds: [parent.personId, otherParent.personId] },
      { subjectPersonIds: [childId] },
    ]) {
      const composed = await post(t, '/v1/notifications', operator, {
        kind: 'schedule_changed',
        title: 'Saturday session moved to pitch 2',
        body: 'Private detail that the timeline never repeats.',
        audience,
      });
      expect(composed.status, JSON.stringify(composed.body)).toBe(201);
      const sent = await post(t, `/v1/notifications/${composed.body.id}/send`, operator, {});
      expect(sent.status, JSON.stringify(sent.body)).toBeLessThan(300);
    }

    // A published event the parent is committed to, then moved (a schedule change they saw).
    const pitch = await seedPitchWithHalves(t.db, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      name: 'Pitch 9',
    });
    const events = t.app.get(EventsService);
    const event = await createScheduledEvent(events, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      resourceIds: [pitch.pitchId],
      start: at('2027-01-23', '10:00'),
      end: at('2027-01-23', '11:00'),
      kind: 'practice',
      title: 'Parent and child skills hour',
      sourceType: 'manual',
      commitments: [{ partyType: 'person', partyId: parent.personId, role: 'participant' }],
    });
    eventId = event.id;
    await events.moveEvent(systemPrincipal(t.organizationId, 'tests'), event.id, {
      scheduledStart: at('2027-01-23', '12:00'),
      scheduledEnd: at('2027-01-23', '13:00'),
      reason: 'Field maintenance',
    });

    // A support case about the child, and a refund requested from it through finance.
    const opened = await post(t, '/v1/cases', manager, {
      category: 'payment',
      title: 'Refund the first week',
      subjectPersonId: childId,
    });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    caseId = opened.body.id;
    const refund = await post(t, `/v1/cases/${caseId}/request-refund`, manager, {
      paymentAttemptId: paid.paymentAttemptId,
      amountMinor: 2_000,
      reason: 'Missed the first week',
    });
    expect(refund.status, JSON.stringify(refund.body)).toBe(201);
    await drainOutbox(t);
  });
  afterAll(async () => {
    await t.close();
  });

  const timelineOf = async (actor: Actor, personId: string, query = '') => {
    const res = await get(t, `/v1/customers/${personId}/timeline${query}`, actor);
    return res;
  };
  const kinds = (entries: TimelineEntry[]) => entries.map((e) => e.kind);

  it('SPK-SUPPORT-001: aggregates registration, participation, orders, payments, refunds, credits, obligations, schedule changes, messages and cases', async () => {
    const res = await timelineOf(operator, parent.personId, '?limit=200');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = res.body as { entries: TimelineEntry[]; sources: Array<{ status: string }> };
    expect(
      body.sources.every((s) => s.status === 'ok'),
      JSON.stringify(body.sources),
    ).toBe(true);
    expect(res.body.person).toEqual({
      id: parent.personId,
      kind: 'adult',
      displayName: 'Ana Alvarez',
      status: 'active',
      minimized: false,
    });
    expect(res.body.scope.personIds).toEqual([parent.personId, childId]);
    const k = kinds(body.entries);
    for (const expected of [
      'enrollment.created',
      'enrollment.confirmed',
      'order.created',
      'order.paid',
      'payment.succeeded',
      'refund.succeeded',
      'obligation.created',
      'credit.issued',
      'schedule.moved',
      'message.schedule_changed',
      'case.opened',
    ]) {
      expect(k, expected).toContain(expected);
    }
    const enrollment = body.entries.find((e) => e.kind === 'enrollment.created');
    expect(enrollment).toMatchObject({ personId: childId, category: 'registration' });
    const payment = body.entries.find((e) => e.kind === 'payment.succeeded');
    expect(payment).toMatchObject({
      personId: parent.personId,
      record: { type: 'payment_attempt', id: paid.paymentAttemptId },
      amount: { amountMinor: 12_000, currency: 'USD' },
    });
    const refund = body.entries.find((e) => e.kind === 'refund.succeeded');
    expect(refund).toMatchObject({ personId: parent.personId, amount: { amountMinor: 2_000 } });
    const order = body.entries.find((e) => e.kind === 'order.paid');
    expect(order).toMatchObject({
      personId: parent.personId,
      record: { type: 'order', id: paid.orderId },
      details: { payerInScope: true, otherLines: 0 },
    });
    const moved = body.entries.find((e) => e.kind === 'schedule.moved');
    expect(moved).toMatchObject({
      record: { type: 'scheduling_event', id: eventId },
      personId: parent.personId,
      facilityId: t.facilityId,
      details: { relation: 'committed_party' },
    });
    // The actual delivery state per channel (SPK-COMMS-004), never the message body.
    const messages = body.entries.filter((e) => e.category === 'message');
    expect(messages.length).toBeGreaterThanOrEqual(2);
    const toParent = messages.find(
      (m) => m.personId === parent.personId && Array.isArray(m.details['channels']),
    );
    expect(toParent?.details['channels']).toEqual(
      expect.arrayContaining([expect.objectContaining({ channel: 'in_app', status: 'delivered' })]),
    );
    const aboutChild = messages.find((m) => m.personId === childId);
    expect(aboutChild?.details).toMatchObject({ sentAbout: true, recipientCount: 1 });
    const supportCase = body.entries.find((e) => e.kind === 'case.opened');
    expect(supportCase).toMatchObject({
      personId: childId,
      record: { type: 'support_case', id: caseId },
    });
    // Newest first.
    const instants = body.entries.map((e) => new Date(e.occurredAt).getTime());
    expect([...instants].sort((a, b) => b - a)).toEqual(instants);
  });

  it('§4.14 / §4.7 invariant 1: no card data, no message bodies, no other household, and child information minimized', async () => {
    const res = await timelineOf(operator, parent.personId, '?limit=200');
    const text = JSON.stringify(res.body);
    // Never the payment method token or provider reference (card details stay with the provider).
    expect(text).not.toContain('pm_fake');
    expect(text).not.toContain('fp_');
    expect(text).not.toContain('Private detail');
    // The other household appears nowhere — not as a recipient of the shared message, not by id.
    expect(text).not.toContain(otherParent.personId);
    expect(text).not.toContain(otherChildId);
    expect(text).not.toContain('Brandt');
    // The child is shown by given name only: no family name, date of birth or contacts.
    expect(res.body.scope.dependents).toEqual([
      { id: childId, kind: 'child', displayName: 'Cleo', status: 'active', minimized: true },
    ]);
    expect(text).not.toContain('Quintanilla');
    expect(text).not.toContain('2016-09-03');
    expect(text).not.toContain('dateOfBirth');
    expect(text).not.toContain('contactPoints');
  });

  it("SPK-SUPPORT-001: a child's timeline names only the child; the paying guardian is not named on the order", async () => {
    const res = await timelineOf(operator, childId, '?limit=200');
    expect(res.status).toBe(200);
    expect(res.body.person).toMatchObject({ id: childId, displayName: 'Cleo', minimized: true });
    expect(res.body.scope.personIds).toEqual([childId]);
    const order = (res.body.entries as TimelineEntry[]).find((e) => e.kind === 'order.paid');
    expect(order).toMatchObject({
      personId: childId,
      amount: { amountMinor: 12_000 },
      details: { payerInScope: false, otherLines: 0 },
    });
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(parent.personId);
    expect(text).not.toContain('Alvarez');
  });

  it('SPK-SUPPORT-002 / SPK-AT-026: staff need no customer credentials — the person may have no account at all', async () => {
    const walkIn = await createPersonFixture(t, { kind: 'adult', source: 'staff' });
    await createObligationFixture(t, { debtorPersonId: walkIn, amountMinor: 1_500 });
    const res = await timelineOf(operator, walkIn);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(kinds(res.body.entries)).toContain('obligation.created');
  });

  it('authorization: customers (own, guardian or other household), staff without the role and other organizations receive NOT_FOUND', async () => {
    // The timeline is a staff tool: even the person themself, as a customer, learns nothing.
    for (const [actor, personId] of [
      [parent, parent.personId],
      [parent, childId],
      [otherParent, parent.personId],
      [otherParent, childId],
    ] as const) {
      const res = await timelineOf(actor, personId);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    }
    for (const roles of [['league_manager'], ['coach'], ['finance_operator']] as const) {
      const staff = await staffMember(t, [...roles]);
      expect((await timelineOf(staff, parent.personId)).status).toBe(404);
    }
    for (const roles of [['front_desk'], ['general_manager'], ['support_operator']] as const) {
      const staff = await staffMember(t, [...roles]);
      expect((await timelineOf(staff, parent.personId)).status).toBe(200);
    }
    const elsewhere = await otherOrganization(t);
    const foreign = await staffMember(t, ['support_operator'], {
      organizationId: elsewhere.organizationId,
    });
    expect((await timelineOf(foreign, parent.personId)).status).toBe(404);
    expect((await timelineOf(operator, newId())).status).toBe(404);
    // A customer token never reaches the timeline, even through the person's own account.
    const own = await t.http
      .get(`/v1/customers/${parent.personId}/timeline`)
      .set(await authHeaderForPerson(t, parent.personId));
    expect(own.status).toBe(404);
  });

  it('§4.3: facility-scoped staff see their facilities and organization-wide records only', async () => {
    const annex = await secondFacility(t);
    const annexDesk = await staffMember(t, ['front_desk'], { facilityIds: [annex] });
    const res = await timelineOf(annexDesk, parent.personId, '?limit=200');
    expect(res.status).toBe(200);
    const entries = res.body.entries as TimelineEntry[];
    expect(entries.every((e) => e.facilityId === null || e.facilityId === annex)).toBe(true);
    // Records without a facility (payments, obligations) are still shown.
    expect(kinds(entries)).toContain('payment.succeeded');
    expect(kinds(entries)).not.toContain('schedule.moved');
  });

  it('pagination: entries continue strictly after the cursor without repeats', async () => {
    const all = (await timelineOf(operator, parent.personId, '?limit=200')).body
      .entries as TimelineEntry[];
    const first = await timelineOf(operator, parent.personId, '?limit=5');
    expect(first.body.entries).toHaveLength(5);
    expect(first.body.nextCursor).not.toBeNull();
    const second = await timelineOf(
      operator,
      parent.personId,
      `?limit=200&cursor=${encodeURIComponent(first.body.nextCursor)}`,
    );
    const ids = [...first.body.entries, ...second.body.entries].map((e: TimelineEntry) => e.id);
    expect(ids).toEqual(all.map((e) => e.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('SPK-IAM-007: the survivor’s timeline and case search include the merged person’s records', async () => {
    const duplicate = await createPersonFixture(t, { kind: 'adult' });
    await createObligationFixture(t, {
      debtorPersonId: duplicate,
      amountMinor: 700,
      description: 'Locker rental',
    });
    const composed = await post(t, '/v1/notifications', operator, {
      kind: 'payment_attention',
      title: 'Balance reminder',
      body: 'x',
      audience: { personIds: [duplicate] },
    });
    await post(t, `/v1/notifications/${composed.body.id}/send`, operator, {});
    const dupCase = await post(t, '/v1/cases', operator, {
      category: 'other',
      title: 'Duplicate record',
      subjectPersonId: duplicate,
    });
    expect(dupCase.status, JSON.stringify(dupCase.body)).toBe(201);
    await drainOutbox(t);
    const survivor = await createPersonFixture(t, { kind: 'adult' });
    const indexBefore = await t.db
      .selectFrom('timeline_references')
      .selectAll()
      .where('person_id', 'in', [duplicate, survivor])
      .orderBy('id')
      .execute();
    const caseBefore = await t.db
      .selectFrom('cases')
      .selectAll()
      .where('id', '=', dupCase.body.id)
      .executeTakeFirstOrThrow();
    // What identity's merge does to the persons table (identity owns it; a fixture here). SUP-05:
    // support follows no merge event and rewrites nothing.
    await t.db
      .updateTable('persons')
      .set({ status: 'merged', merged_into_person_id: survivor })
      .where('id', '=', duplicate)
      .execute();

    const res = await timelineOf(operator, survivor, '?limit=200');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.scope.personIds).toEqual([survivor]);
    const entries = res.body.entries as TimelineEntry[];
    const message = entries.find((e) => e.record.id === composed.body.id);
    expect(message).toMatchObject({ category: 'message', personId: survivor });
    const opened = entries.find((e) => e.record.id === dupCase.body.id);
    expect(opened).toMatchObject({ kind: 'case.opened', personId: survivor });
    expect(entries.find((e) => e.title === 'Locker rental')).toMatchObject({
      kind: 'obligation.created',
      personId: survivor,
    });
    // The merged person's id reads the survivor's timeline.
    const viaMerged = await timelineOf(operator, duplicate, '?limit=200');
    expect(viaMerged.body.person.id).toBe(survivor);
    expect((viaMerged.body.entries as TimelineEntry[]).map((e) => e.id)).toEqual(
      entries.map((e) => e.id),
    );

    // Case search by the survivor finds the merged person's case; its subject keeps the original
    // person id and the view names the surviving person.
    const search = await get(t, `/v1/cases?subjectPersonId=${survivor}`, operator);
    expect(search.status, JSON.stringify(search.body)).toBe(200);
    expect(search.body.items.map((c: { id: string }) => c.id)).toContain(dupCase.body.id);
    const view = await get(t, `/v1/cases/${dupCase.body.id}`, operator);
    expect(view.body.subject).toMatchObject({ personId: duplicate, canonicalPersonId: survivor });

    // No support row was rewritten or copied.
    expect(
      await t.db
        .selectFrom('timeline_references')
        .selectAll()
        .where('person_id', 'in', [duplicate, survivor])
        .orderBy('id')
        .execute(),
    ).toEqual(indexBefore);
    expect(
      await t.db
        .selectFrom('cases')
        .selectAll()
        .where('id', '=', dupCase.body.id)
        .executeTakeFirstOrThrow(),
    ).toEqual(caseBefore);
  });
});
