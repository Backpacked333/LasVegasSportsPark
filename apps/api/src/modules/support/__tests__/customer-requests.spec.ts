import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OperationalExceptions } from '../../../kernel';
import type { TestApp } from '../../../testing';
import { createSeasonFixture, createTeamEntryFixture } from '../../competition';
import { createObligationFixture } from '../../finance';
import {
  adultCustomer,
  childOf,
  drainOutbox,
  get,
  key,
  post,
  staffMember,
  supportTestApp,
  type Actor,
} from './support';

/**
 * SUP-01 (SPK-SUPPORT-002, SPK-CAP-001 "contact the operating team", SCR-C-22, SCR-C-38): a
 * customer opens a support request about themselves, someone they view, or a team they captain,
 * and reads only its status. Staff work it as any case; the origin filter tells them apart.
 */
describe('customer support requests (SUP-01)', () => {
  let t: TestApp;
  let operator: Actor;
  let captain: Actor;
  let player: Actor;
  let parent: Actor;
  let childId: string;
  let otherParent: Actor;
  let otherChildId: string;
  let teamEntryId: string;

  beforeAll(async () => {
    t = await supportTestApp();
    operator = await staffMember(t, ['support_operator']);
    captain = await adultCustomer(t, { givenName: 'Cara', familyName: 'Captain' });
    player = await adultCustomer(t);
    parent = await adultCustomer(t);
    childId = await childOf(t, [parent]);
    otherParent = await adultCustomer(t);
    otherChildId = await childOf(t, [otherParent]);
    const season = await createSeasonFixture(t, { status: 'active' });
    teamEntryId = (
      await createTeamEntryFixture(t, {
        seasonId: season.seasonId,
        captainPersonId: captain.personId,
      })
    ).teamEntryId;
  });
  afterAll(async () => {
    await t.close();
  });

  const request = (actor: Actor, body: object, idem = key()) =>
    post(t, '/v1/me/support-requests', actor, body, idem);

  it('SPK-SUPPORT-002 / SPK-CAP-001: a captain contacts the operating team and reads the case status, never internal notes', async () => {
    const body = {
      category: 'team',
      title: 'Our Thursday fixture clashes with the cup',
      description: 'Can the league move our fixture on the 4th?',
      teamEntryId,
    };
    const idem = key();
    const opened = await request(captain, body, idem);
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    // The customer view: status only — no owner, queue, notes, history or actions.
    expect(Object.keys(opened.body).sort()).toEqual(
      ['category', 'createdAt', 'id', 'resolvedAt', 'status', 'title', 'updatedAt'].sort(),
    );
    expect(opened.body).toMatchObject({ category: 'team', status: 'open', resolvedAt: null });
    const caseId = opened.body.id as string;
    // §4.9: the same key replays the same request.
    const replay = await request(captain, body, idem);
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(caseId);

    // Staff see a normal case opened by the customer, routed by the support policy (DEC-015).
    const staffView = await get(t, `/v1/cases/${caseId}`, operator);
    expect(staffView.status, JSON.stringify(staffView.body)).toBe(200);
    expect(staffView.body).toMatchObject({
      openedVia: 'customer',
      origin: null,
      priority: 'normal',
      subject: { personId: captain.personId, canonicalPersonId: captain.personId },
      owner: { personId: null, queue: 'support_operator' },
      relatedRecords: [{ type: 'team_entry', id: teamEntryId }],
      openedBy: { kind: 'customer', personId: captain.personId },
      description: body.description,
    });
    const audit = await t.db
      .selectFrom('audit_records')
      .select(['action', 'details'])
      .where('target_type', '=', 'support_case')
      .where('target_id', '=', caseId)
      .execute();
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'support.request_support',
        details: expect.objectContaining({ openedVia: 'customer', category: 'team' }),
      }),
    ]);
    const event = await t.db
      .selectFrom('outbox_events')
      .select('payload')
      .where('event_type', '=', 'support.case_opened')
      .where('aggregate_id', '=', caseId)
      .executeTakeFirstOrThrow();
    expect(event.payload).toMatchObject({ caseId, openedVia: 'customer', origin: null });

    // Staff work the case: an internal note and a status change.
    const note = await post(t, `/v1/cases/${caseId}/notes`, operator, {
      body: 'Internal: league manager prefers to keep the cup slot',
    });
    expect(note.status).toBe(201);
    const waiting = await post(t, `/v1/cases/${caseId}/transition`, operator, {
      event: 'wait_internal',
      expectedRevision: staffView.body.revision,
    });
    expect(waiting.status, JSON.stringify(waiting.body)).toBe(200);

    // The captain reads the status, never the note, the owner or the queue.
    const mine = await get(t, '/v1/me/cases', captain);
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(mine.body.items).toEqual([
      expect.objectContaining({ id: caseId, status: 'waiting_internal' }),
    ]);
    const one = await get(t, `/v1/me/cases/${caseId}`, captain);
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ id: caseId, status: 'waiting_internal' });
    const text = JSON.stringify([mine.body, one.body]);
    expect(text).not.toContain('Internal');
    expect(text).not.toContain('support_operator');
    expect(text).not.toContain('events');
    expect(text).not.toContain(operator.personId);
    const filtered = await get(t, '/v1/me/cases?status=open', captain);
    expect(filtered.body.items).toEqual([]);

    // Anyone else's request is not found, and never listed.
    const foreign = await get(t, `/v1/me/cases/${caseId}`, player);
    expect(foreign.status).toBe(404);
    expect(foreign.body.code).toBe('NOT_FOUND');
    expect((await get(t, '/v1/me/cases', player)).body.items).toEqual([]);
    // A staff-opened case about the captain is a staff record, not the captain's request.
    const staffCase = await post(t, '/v1/cases', operator, {
      category: 'team',
      title: 'Staff note about the captain',
      subjectPersonId: captain.personId,
    });
    expect((await get(t, `/v1/me/cases/${staffCase.body.id}`, captain)).status).toBe(404);
    // Customers still cannot read staff case views.
    expect((await get(t, `/v1/cases/${caseId}`, captain)).status).toBe(404);
  });

  it('SPK-CAP-001: only the entry captain contacts the operating team for a team', async () => {
    const res = await request(player, {
      category: 'team',
      title: 'Roster question',
      description: 'Am I on the team?',
      teamEntryId,
    });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    const unknown = await request(captain, {
      category: 'team',
      title: 'Another team',
      description: 'x',
      teamEntryId: newId(),
    });
    expect(unknown.status).toBe(404);
  });

  it('SCR-C-38: a guardian asks about their child; another household’s person and records are not found', async () => {
    const aboutChild = await request(parent, {
      category: 'registration',
      title: 'Which group is my child in?',
      description: 'We registered last week.',
      subjectPersonId: childId,
    });
    expect(aboutChild.status, JSON.stringify(aboutChild.body)).toBe(201);
    const staffView = await get(t, `/v1/cases/${aboutChild.body.id}`, operator);
    expect(staffView.body.subject.personId).toBe(childId);

    const otherChild = await request(parent, {
      category: 'registration',
      title: 'Question',
      description: 'x',
      subjectPersonId: otherChildId,
    });
    expect(otherChild.status).toBe(404);
    expect(otherChild.body.code).toBe('NOT_FOUND');

    // A linked record is read with the customer's own principal through its owning module.
    const own = await createObligationFixture(t, {
      debtorPersonId: parent.personId,
      amountMinor: 900,
    });
    const linked = await request(parent, {
      category: 'payment',
      title: 'Uniform fee',
      description: 'Is this still due?',
      relatedRecords: [{ type: 'obligation', id: own }],
    });
    expect(linked.status, JSON.stringify(linked.body)).toBe(201);
    expect((await get(t, `/v1/cases/${linked.body.id}`, operator)).body.relatedRecords).toEqual([
      { type: 'obligation', id: own },
    ]);
    const theirs = await createObligationFixture(t, {
      debtorPersonId: otherParent.personId,
      amountMinor: 900,
    });
    const foreign = await request(parent, {
      category: 'payment',
      title: 'Not mine',
      description: 'x',
      relatedRecords: [{ type: 'obligation', id: theirs }],
    });
    expect(foreign.status).toBe(404);
    const unsupported = await request(parent, {
      category: 'other',
      title: 'A message',
      description: 'x',
      relatedRecords: [{ type: 'notification', id: newId() }],
    });
    expect(unsupported.status).toBe(400);
    expect(unsupported.body.details).toMatchObject({ code: 'UNSUPPORTED_RELATED_RECORD' });
    // Validation: a request names a category, a title and a description (SCR-C-38).
    const missing = await request(parent, { category: 'other', title: 'No description' });
    expect(missing.status).toBe(400);
    // A staff member is also a person: they may contact support about themselves as a customer.
    const asCustomer = await request(operator, {
      category: 'other',
      title: 'My own membership',
      description: 'x',
    });
    expect(asCustomer.status, JSON.stringify(asCustomer.body)).toBe(201);
  });

  it('cases filter by origin', async () => {
    const staff = await post(t, '/v1/cases', operator, { category: 'other', title: 'Staff case' });
    const customer = await request(player, {
      category: 'other',
      title: 'Customer case',
      description: 'Please call me',
    });
    const exception = await t.db.transaction().execute((trx) =>
      t.app.get(OperationalExceptions).raise(trx, {
        organizationId: t.organizationId,
        category: 'test.origin_filter',
        severity: 'warning',
        title: 'Needs coordination',
        ownerQueue: 'support_operator',
      }),
    );
    const coordinating = await post(t, '/v1/cases', operator, {
      category: 'other',
      title: 'Coordinate the exception',
      originExceptionId: exception.id,
    });
    expect(coordinating.status, JSON.stringify(coordinating.body)).toBe(201);
    expect(coordinating.body.openedVia).toBe('hook');
    await drainOutbox(t);
    const ids = async (origin: string) =>
      (await get(t, `/v1/cases?origin=${origin}&limit=200`, operator)).body.items.map(
        (c: { id: string; openedVia: string }) => [c.id, c.openedVia],
      ) as Array<[string, string]>;
    const staffIds = await ids('staff');
    expect(staffIds.map(([id]) => id)).toContain(staff.body.id);
    expect(staffIds.every(([, via]) => via === 'staff')).toBe(true);
    const customerIds = await ids('customer');
    expect(customerIds.map(([id]) => id)).toContain(customer.body.id);
    expect(customerIds.map(([id]) => id)).not.toContain(staff.body.id);
    expect(customerIds.every(([, via]) => via === 'customer')).toBe(true);
    expect((await ids('exception')).map(([id]) => id)).toEqual([coordinating.body.id]);
    expect(await ids('access_review')).toEqual([]);
    expect((await get(t, '/v1/cases?origin=elsewhere', operator)).status).toBe(400);
  });
});
