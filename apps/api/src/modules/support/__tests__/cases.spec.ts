import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { authHeaderForPerson, createOrganizationPeople, createPersonFixture } from '../../identity';
import {
  adultCustomer,
  drainOutbox,
  get,
  otherOrganization,
  patch,
  post,
  secondFacility,
  staffMember,
  supportTestApp,
  type Actor,
} from './support';

/**
 * Support cases (SPK-SUPPORT-002): owner, category, related records, history and resolution;
 * staff assist without customer credentials; the lifecycle, revisions, idempotency and the
 * authorization matrix.
 */
describe('support cases (SPK-SUPPORT-002)', () => {
  let t: TestApp;
  let operator: Actor;
  let desk: Actor;
  let manager: Actor;

  beforeAll(async () => {
    t = await supportTestApp();
    operator = await staffMember(t, ['support_operator']);
    desk = await staffMember(t, ['front_desk']);
    manager = await staffMember(t, ['general_manager']);
  });
  afterAll(async () => {
    await t.close();
  });

  const openCase = async (actor: Actor, body: Record<string, unknown> = {}) => {
    const res = await post(t, '/v1/cases', actor, {
      category: 'registration',
      title: 'Parent cannot see the spring enrollment',
      ...body,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; revision: number; events: unknown[] };
  };

  it('SPK-SUPPORT-002 / SPK-AT-026: staff open a case for a person who has no account at all — no customer credentials are involved', async () => {
    // A staff-created participant with no login account: support works with its own principal.
    const personId = await createPersonFixture(t, { kind: 'adult', source: 'staff' });
    const res = await post(t, '/v1/cases', operator, {
      category: 'payment',
      priority: 'high',
      title: 'Charged twice for the spring league',
      description: 'Customer called the desk; two charges on the statement.',
      subjectPersonId: personId,
      ownerPersonId: operator.personId,
      ownerQueue: 'support_operator',
      relatedRecords: [{ type: 'order', id: 'ord-123' }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      category: 'payment',
      priority: 'high',
      status: 'open',
      subject: { personId, householdId: null },
      owner: { personId: operator.personId, queue: 'support_operator' },
      relatedRecords: [{ type: 'order', id: 'ord-123' }],
      resolution: null,
      overdue: false,
      allowedEvents: ['wait_customer', 'wait_internal', 'resolve'],
      revision: 1,
      openedBy: { kind: 'staff', accountId: operator.accountId },
    });
    // Proposed service level for high priority: one day from opening.
    expect(res.body.dueAt).toBe('2027-01-17T20:00:00.000Z');
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0]).toMatchObject({
      kind: 'status',
      fromStatus: null,
      toStatus: 'open',
    });
    const audit = await t.db
      .selectFrom('audit_records')
      .select(['action', 'details'])
      .where('target_type', '=', 'support_case')
      .where('target_id', '=', res.body.id)
      .execute();
    expect(audit).toEqual([expect.objectContaining({ action: 'support.open_case' })]);
    // Audit details carry identifiers and enumerations only, never the description (§4.14).
    expect(JSON.stringify(audit)).not.toContain('statement');
    const outbox = await t.db
      .selectFrom('outbox_events')
      .select('event_type')
      .where('aggregate_id', '=', res.body.id)
      .execute();
    expect(outbox.map((o) => o.event_type)).toContain('support.case_opened');
  });

  it('§4.9: opening a case replays with the same key and payload; the same key with another payload conflicts', async () => {
    const idem = `k-replay-${Date.now()}`;
    const body = { category: 'schedule', title: 'Wants the Saturday slot back' };
    const first = await post(t, '/v1/cases', desk, body, idem);
    expect(first.status).toBe(201);
    const replay = await post(t, '/v1/cases', desk, body, idem);
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.id).toBe(first.body.id);
    const conflict = await post(t, '/v1/cases', desk, { ...body, title: 'Other' }, idem);
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
    const count = await t.db
      .selectFrom('cases')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('title', '=', body.title)
      .executeTakeFirstOrThrow();
    expect(Number(count.n)).toBe(1);
  });

  it('CaseMachine: every transition, with the resolution recorded and cleared on reopen', async () => {
    const opened = await openCase(operator);
    const step = async (event: string, revision: number, extra: Record<string, unknown> = {}) => {
      const res = await post(t, `/v1/cases/${opened.id}/transition`, operator, {
        event,
        expectedRevision: revision,
        ...extra,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return res.body;
    };
    expect((await step('wait_customer', 1)).status).toBe('waiting_customer');
    expect((await step('wait_internal', 2)).status).toBe('waiting_internal');
    expect((await step('wait_customer', 3)).status).toBe('waiting_customer');
    expect((await step('resume', 4)).status).toBe('open');
    expect((await step('wait_internal', 5)).status).toBe('waiting_internal');
    expect((await step('resume', 6)).status).toBe('open');
    const resolved = await step('resolve', 7, {
      resolution: { kind: 'information_provided', summary: 'Explained the enrollment view' },
    });
    expect(resolved).toMatchObject({
      status: 'resolved',
      resolution: { kind: 'information_provided', summary: 'Explained the enrollment view' },
      allowedEvents: ['reopen', 'close'],
    });
    expect(resolved.resolvedAt).not.toBeNull();
    const reopened = await step('reopen', 8);
    expect(reopened).toMatchObject({ status: 'open', resolution: null, resolvedAt: null });
    await step('wait_customer', 9);
    await step('resolve', 10, {
      resolution: { kind: 'customer_unreachable', summary: 'Three calls, no answer' },
    });
    const closed = await step('close', 11);
    expect(closed).toMatchObject({ status: 'closed', allowedEvents: [] });
    expect(closed.closedAt).not.toBeNull();
    const statusEvents = (
      closed.events as Array<{ kind: string; fromStatus: string | null; toStatus: string }>
    )
      .filter((e) => e.kind === 'status')
      .map((e) => `${e.fromStatus ?? '∅'}→${e.toStatus}`);
    expect(statusEvents).toEqual([
      '∅→open',
      'open→waiting_customer',
      'waiting_customer→waiting_internal',
      'waiting_internal→waiting_customer',
      'waiting_customer→open',
      'open→waiting_internal',
      'waiting_internal→open',
      'open→resolved',
      'resolved→open',
      'open→waiting_customer',
      'waiting_customer→resolved',
      'resolved→closed',
    ]);
  });

  it('CaseMachine: refused transitions and a closed case is final (notes included)', async () => {
    const opened = await openCase(operator);
    const close = await post(t, `/v1/cases/${opened.id}/transition`, operator, {
      event: 'close',
      expectedRevision: 1,
    });
    expect(close.status).toBe(409);
    expect(close.body.code).toBe('INVALID_TRANSITION');
    const noResolution = await post(t, `/v1/cases/${opened.id}/transition`, operator, {
      event: 'resolve',
      expectedRevision: 1,
    });
    expect(noResolution.status).toBe(400);
    await post(t, `/v1/cases/${opened.id}/transition`, operator, {
      event: 'resolve',
      expectedRevision: 1,
      resolution: { kind: 'duplicate', summary: 'Same as another case' },
    });
    await post(t, `/v1/cases/${opened.id}/transition`, operator, {
      event: 'close',
      expectedRevision: 2,
    });
    const reopen = await post(t, `/v1/cases/${opened.id}/transition`, operator, {
      event: 'reopen',
      expectedRevision: 3,
    });
    expect(reopen.status).toBe(409);
    expect(reopen.body.code).toBe('INVALID_TRANSITION');
    const note = await post(t, `/v1/cases/${opened.id}/notes`, operator, { body: 'late note' });
    expect(note.status).toBe(409);
    expect(note.body.code).toBe('INVALID_TRANSITION');
  });

  it('§4.9: a stale revision fails instead of overwriting newer work', async () => {
    const opened = await openCase(desk);
    const first = await patch(t, `/v1/cases/${opened.id}`, desk, {
      priority: 'urgent',
      expectedRevision: 1,
    });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({ priority: 'urgent', revision: 2 });
    // Urgent: four hours from opening (proposed service level).
    expect(first.body.dueAt).toBe('2027-01-17T00:00:00.000Z');
    const stale = await patch(t, `/v1/cases/${opened.id}`, desk, {
      title: 'Older edit',
      expectedRevision: 1,
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({
      code: 'STALE_REVISION',
      details: { expectedRevision: 1, currentRevision: 2 },
    });
    const update = first.body.events.find((e: { kind: string }) => e.kind === 'update');
    expect(update.details).toMatchObject({ priority: { from: 'normal', to: 'urgent' } });
  });

  it('assignment: the owner must be current case staff; the queue must exist', async () => {
    const opened = await openCase(operator);
    const league = await staffMember(t, ['league_manager']);
    const notCaseStaff = await post(t, `/v1/cases/${opened.id}/assign`, operator, {
      ownerPersonId: league.personId,
      expectedRevision: 1,
    });
    expect(notCaseStaff.status).toBe(400);
    expect(notCaseStaff.body.details).toMatchObject({ code: 'OWNER_NOT_CASE_STAFF' });
    const unknownQueue = await post(t, `/v1/cases/${opened.id}/assign`, operator, {
      ownerPersonId: desk.personId,
      ownerQueue: 'no_such_queue',
      expectedRevision: 1,
    });
    expect(unknownQueue.status).toBe(400);
    const assigned = await post(t, `/v1/cases/${opened.id}/assign`, operator, {
      ownerPersonId: desk.personId,
      ownerQueue: 'front_desk',
      expectedRevision: 1,
    });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
    expect(assigned.body.owner).toEqual({ personId: desk.personId, queue: 'front_desk' });
    expect(assigned.body.events.at(-1)).toMatchObject({
      kind: 'assignment',
      details: { to: { personId: desk.personId, queue: 'front_desk' } },
    });
    const listed = await get(t, `/v1/cases?ownerPersonId=${desk.personId}`, desk);
    expect(listed.status).toBe(200);
    expect(listed.body.items.map((c: { id: string }) => c.id)).toContain(opened.id);
  });

  it('authorization matrix: case staff work cases; other staff and every customer learn nothing (NOT_FOUND); other organizations are not found', async () => {
    const people = await createOrganizationPeople(t);
    const opened = await openCase(manager, { subjectPersonId: people.child.personId });
    for (const actor of [operator, desk, manager]) {
      const res = await get(t, `/v1/cases/${opened.id}`, actor);
      expect(res.status).toBe(200);
    }
    const league = await staffMember(t, ['league_manager']);
    const finance = await staffMember(t, ['finance_operator']);
    for (const actor of [league, finance]) {
      expect((await get(t, `/v1/cases/${opened.id}`, actor)).status).toBe(404);
      const open = await post(t, '/v1/cases', actor, { category: 'other', title: 'x' });
      expect(open.status).toBe(403);
      expect(open.body.code).toBe('ACCESS_DENIED');
    }
    // A guardian of the subject child is still a customer: cases are staff records (§4.10).
    const guardianHeader = await authHeaderForPerson(t, people.adult.personId);
    const asGuardian = await t.http.get(`/v1/cases/${opened.id}`).set(guardianHeader);
    expect(asGuardian.status).toBe(404);
    expect(asGuardian.body.code).toBe('NOT_FOUND');
    const stranger = await adultCustomer(t);
    const asStranger = await get(t, `/v1/cases/${opened.id}`, stranger);
    expect(asStranger.status).toBe(404);
    // Customers cannot open cases either (decided before any lookup: nothing about the subject leaks).
    const customerOpen = await post(t, '/v1/cases', stranger, {
      category: 'other',
      title: 'x',
      subjectPersonId: people.child.personId,
    });
    expect(customerOpen.status).toBe(403);
    // Another organization's staff see neither the case nor the people in it.
    const elsewhere = await otherOrganization(t);
    const foreignOperator = await staffMember(t, ['support_operator'], {
      organizationId: elsewhere.organizationId,
    });
    expect((await get(t, `/v1/cases/${opened.id}`, foreignOperator)).status).toBe(404);
    const foreignSubject = await post(t, '/v1/cases', foreignOperator, {
      category: 'other',
      title: 'x',
      subjectPersonId: people.child.personId,
    });
    expect(foreignSubject.status).toBe(404);
    const foreignList = await get(t, '/v1/cases', foreignOperator);
    expect(foreignList.body.items.map((c: { id: string }) => c.id)).not.toContain(opened.id);
  });

  it('§4.3: facility-scoped staff work cases of their facility and organization-wide cases only', async () => {
    const annex = await secondFacility(t);
    const annexDesk = await staffMember(t, ['front_desk'], { facilityIds: [annex] });
    const mainCase = await openCase(manager, { facilityId: t.facilityId });
    const orgCase = await openCase(manager);
    expect((await get(t, `/v1/cases/${mainCase.id}`, annexDesk)).status).toBe(404);
    expect((await get(t, `/v1/cases/${orgCase.id}`, annexDesk)).status).toBe(200);
    const listed = await get(t, '/v1/cases?limit=200', annexDesk);
    const ids = listed.body.items.map((c: { id: string }) => c.id);
    expect(ids).toContain(orgCase.id);
    expect(ids).not.toContain(mainCase.id);
    const opensElsewhere = await post(t, '/v1/cases', annexDesk, {
      category: 'facility',
      title: 'Lights out on pitch 1',
      facilityId: t.facilityId,
    });
    expect(opensElsewhere.status).toBe(403);
  });

  it('SPK-IAM-005: an escalated disputed-access review becomes one owned support case; later decisions are history, never a resolution', async () => {
    const people = await createOrganizationPeople(t);
    const opened = await post(t, '/v1/access-reviews', manager, {
      subjectPersonId: people.child.personId,
      ownerRole: 'general_manager',
      reason: 'Two adults claim pickup authority',
    });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const reviewId = opened.body.id as string;
    await drainOutbox(t);
    // Opening alone is identity's workflow: no case yet.
    const before = await t.db
      .selectFrom('cases')
      .select('id')
      .where('origin_access_review_id', '=', reviewId)
      .execute();
    expect(before).toHaveLength(0);
    const escalated = await post(t, `/v1/access-reviews/${reviewId}/decisions`, manager, {
      kind: 'escalate',
      note: 'Needs the support lead',
      ownerRole: 'support_operator',
    });
    expect(escalated.status, JSON.stringify(escalated.body)).toBeLessThan(300);
    await drainOutbox(t);
    await drainOutbox(t);
    const cases = await t.db
      .selectFrom('cases')
      .selectAll()
      .where('origin_access_review_id', '=', reviewId)
      .execute();
    expect(cases).toHaveLength(1);
    const escalationCase = cases[0]!;
    expect(escalationCase).toMatchObject({
      category: 'access',
      priority: 'high',
      status: 'open',
      subject_person_id: people.child.personId,
      owner_queue: 'support_operator',
    });
    const decided = await post(t, `/v1/access-reviews/${reviewId}/decisions`, manager, {
      kind: 'decide',
      note: 'Only the registered guardian collects',
      outcome: { decision: 'guardian_only' },
    });
    expect(decided.status, JSON.stringify(decided.body)).toBeLessThan(300);
    await drainOutbox(t);
    const detail = await get(t, `/v1/cases/${escalationCase.id}`, operator);
    expect(detail.status).toBe(200);
    // The decision is recorded on the case; the case itself stays open for its owner.
    expect(detail.body.status).toBe('open');
    expect(
      detail.body.events.some(
        (e: { kind: string; details: { accessReview?: { kind: string } } }) =>
          e.kind === 'update' && e.details.accessReview?.kind === 'decide',
      ),
    ).toBe(true);
    // Replaying the escalation event (a second delivery) never opens another case.
    const stillOne = await t.db
      .selectFrom('cases')
      .select('id')
      .where('origin_access_review_id', '=', reviewId)
      .execute();
    expect(stillOne).toHaveLength(1);
  });
});
