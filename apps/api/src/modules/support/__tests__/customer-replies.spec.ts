import { newId } from '@sportspark/contracts';
import { json } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import {
  CLOCK_START,
  adultCustomer,
  expectPgError,
  get,
  key,
  post,
  staffMember,
  supportTestApp,
  type Actor,
} from './support';

/**
 * SUP-06 (SPK-SUPPORT-002, SCR-C-38): the customer who opened a request answers it while it is not
 * resolved. A request "Waiting for you" returns to the team's queue; the reply is in the staff
 * case history; the customer reads back only their own replies, never staff notes (§4.14).
 */
describe('customer replies on their own support requests (SUP-06)', () => {
  let t: TestApp;
  let operator: Actor;
  let customer: Actor;
  let stranger: Actor;

  beforeAll(async () => {
    t = await supportTestApp();
    operator = await staffMember(t, ['support_operator']);
    customer = await adultCustomer(t);
    stranger = await adultCustomer(t);
  });
  afterAll(async () => {
    await t.close();
  });

  async function openRequest(title = 'Refund question'): Promise<string> {
    const res = await post(t, '/v1/me/support-requests', customer, {
      category: 'payment',
      title,
      description: 'I was charged twice for the spring league.',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id as string;
  }

  async function staffTransition(caseId: string, event: string, extra: object = {}) {
    const view = await get(t, `/v1/cases/${caseId}`, operator);
    const res = await post(t, `/v1/cases/${caseId}/transition`, operator, {
      event,
      expectedRevision: view.body.revision,
      ...extra,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body;
  }

  const reply = (actor: Actor, caseId: string, body: string, idem = key()) =>
    post(t, `/v1/me/cases/${caseId}/replies`, actor, { body }, idem);

  it('SCR-C-38: a reply to a request waiting for the customer returns it to the team, with history, audit and events', async () => {
    const caseId = await openRequest();
    await post(t, `/v1/cases/${caseId}/notes`, operator, { body: 'Internal: check processor' });
    await staffTransition(caseId, 'wait_customer');

    const idem = key();
    const res = await reply(customer, caseId, 'The second charge was on 3 January.', idem);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ id: caseId, status: 'open' });
    // The customer view stays status only.
    expect(Object.keys(res.body).sort()).toEqual(
      [
        'category',
        'createdAt',
        'id',
        'resolvedAt',
        'status',
        'subjectPersonId',
        'title',
        'updatedAt',
      ].sort(),
    );
    // §4.9: the same key replays the same reply; no second history row.
    const replay = await reply(customer, caseId, 'The second charge was on 3 January.', idem);
    expect(replay.status).toBe(201);

    // Staff read the reply in the case history, followed by the resume it caused.
    const staffView = await get(t, `/v1/cases/${caseId}`, operator);
    expect(staffView.body.status).toBe('open');
    const kinds = (staffView.body.events as { kind: string }[]).map((e) => e.kind);
    expect(kinds.filter((k) => k === 'customer_reply')).toHaveLength(1);
    expect(staffView.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'customer_reply',
          body: 'The second charge was on 3 January.',
        }),
        expect.objectContaining({
          kind: 'status',
          fromStatus: 'waiting_customer',
          toStatus: 'open',
        }),
      ]),
    );

    // The customer reads back their own replies only, never the staff note.
    const mine = await get(t, `/v1/me/cases/${caseId}/replies`, customer);
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(mine.body).toEqual([
      {
        id: expect.any(String),
        body: 'The second charge was on 3 January.',
        sentAt: expect.any(String),
      },
    ]);
    expect(JSON.stringify(mine.body)).not.toContain('Internal');

    const audit = await t.db
      .selectFrom('audit_records')
      .select(['action', 'details'])
      .where('target_type', '=', 'support_case')
      .where('target_id', '=', caseId)
      .where('action', '=', 'support.request_support')
      .execute();
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          details: expect.objectContaining({
            change: 'customer_reply',
            from: 'waiting_customer',
            to: 'open',
          }),
        }),
      ]),
    );
    const events = await t.db
      .selectFrom('outbox_events')
      .select(['event_type', 'payload'])
      .where('aggregate_id', '=', caseId)
      .where('event_type', 'in', ['support.case_customer_replied', 'support.case_status_changed'])
      .execute();
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_type: 'support.case_customer_replied',
          payload: expect.objectContaining({ caseId, resumed: true }),
        }),
        expect.objectContaining({
          event_type: 'support.case_status_changed',
          payload: expect.objectContaining({ from: 'waiting_customer', to: 'open' }),
        }),
      ]),
    );
    // §4.14: the event carries identifiers only, never the reply text.
    expect(JSON.stringify(events)).not.toContain('3 January');
  });

  it('SPK-SUPPORT-002: a reply on an open or internally waiting request keeps its status', async () => {
    const caseId = await openRequest('Schedule question');
    const first = await reply(customer, caseId, 'Adding: evenings work best.');
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.status).toBe('open');
    await staffTransition(caseId, 'wait_internal');
    const second = await reply(customer, caseId, 'Any update?');
    expect(second.status).toBe(201);
    expect(second.body.status).toBe('waiting_internal');
    const mine = await get(t, `/v1/me/cases/${caseId}/replies`, customer);
    expect((mine.body as { body: string }[]).map((r) => r.body)).toEqual([
      'Adding: evenings work best.',
      'Any update?',
    ]);
  });

  it('SCR-C-38: a resolved request takes no reply; the refusal says it is resolved', async () => {
    const caseId = await openRequest('Resolved question');
    await staffTransition(caseId, 'resolve', {
      resolution: { kind: 'information_provided', summary: 'Answered by phone' },
    });
    const res = await reply(customer, caseId, 'One more thing');
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'INVALID_TRANSITION',
      nextAction: 'reload_current_state',
      details: { code: 'CASE_RESOLVED' },
    });
  });

  it('§4.10: anyone else’s request, a staff case and an unknown id are not found; an empty reply is refused', async () => {
    const caseId = await openRequest('Private question');
    const foreign = await reply(stranger, caseId, 'Let me in');
    expect(foreign.status).toBe(404);
    expect(foreign.body.code).toBe('NOT_FOUND');
    expect((await get(t, `/v1/me/cases/${caseId}/replies`, stranger)).status).toBe(404);
    const staffCase = await post(t, '/v1/cases', operator, {
      category: 'other',
      title: 'Staff case about the customer',
      subjectPersonId: customer.personId,
    });
    expect((await reply(customer, staffCase.body.id as string, 'Hello')).status).toBe(404);
    expect((await reply(customer, newId(), 'Hello')).status).toBe(404);
    expect((await reply(customer, caseId, '   ')).status).toBe(400);
    // Staff do not reply as the customer.
    expect((await reply(operator, caseId, 'Staff text')).status).toBe(404);
  });

  it('migration 1104: the database refuses a customer reply without a body', async () => {
    const caseId = await openRequest('Integrity');
    const org = await t.db
      .selectFrom('cases')
      .select('organization_id')
      .where('id', '=', caseId)
      .executeTakeFirstOrThrow();
    await expectPgError(
      t.db
        .insertInto('case_events')
        .values({
          id: newId(),
          organization_id: org.organization_id,
          case_id: caseId,
          sequence: 99,
          kind: 'customer_reply',
          body: null,
          from_status: null,
          to_status: null,
          case_action_id: null,
          details: json({}),
          actor: json({ kind: 'system' }),
          actor_person_id: null,
          occurred_at: new Date(CLOCK_START),
        })
        .execute(),
      '23514',
    );
  });
});
