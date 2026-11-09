import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { adult, financeTestApp, post, staff, type Actor } from './support';

/**
 * FIN-08 (SCR-S-53, §3.16 POS): POS readers of a facility list a register's sessions and a
 * session's sales, newest first in keyset pages; everyone else is refused, and another
 * organization's or an unknown id is not found.
 */
describe('point of sale lists: register sessions and session sales (FIN-08)', () => {
  let t: TestApp;
  let manager: Actor;
  let desk: Actor;
  let coach: Actor;
  let customer: Actor;

  beforeAll(async () => {
    t = await financeTestApp({ capabilities: ['point_of_sale'] });
    manager = await staff(t, ['general_manager']);
    desk = await staff(t, ['front_desk']);
    coach = await staff(t, ['coach']);
    customer = await adult(t);
  });
  afterAll(async () => {
    await t.close();
  });

  const get = (actor: Actor, path: string) => t.http.get(path).set(actor.header);
  const ids = (res: { body: { items: { id: string }[] } }) => res.body.items.map((i) => i.id);

  async function register(code: string): Promise<string> {
    const res = await post(t, '/v1/pos-registers', manager.header, {
      facilityId: t.facilityId,
      code,
      name: `Register ${code}`,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id as string;
  }

  async function openSession(registerId: string) {
    const res = await post(t, `/v1/pos-registers/${registerId}/sessions`, desk.header, {
      currency: 'USD',
      openingFloatMinor: 0,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; revision: number };
  }

  it('SCR-S-53: a register’s sessions are listed most recently opened first, filtered by status and paged', async () => {
    const registerId = await register('LS1');
    const first = await openSession(registerId);
    const closed = await post(t, `/v1/pos-register-sessions/${first.id}/close`, desk.header, {
      countedCashMinor: 0,
      expectedRevision: first.revision,
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(201);
    t.clock.advance(60_000);
    const second = await openSession(registerId);

    const all = await get(desk, `/v1/pos-registers/${registerId}/sessions`);
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    expect(ids(all)).toEqual([second.id, first.id]);
    expect(all.body.items[1]).toMatchObject({ status: 'closed', countedCashMinor: 0 });
    const open = await get(desk, `/v1/pos-registers/${registerId}/sessions?status=open`);
    expect(ids(open)).toEqual([second.id]);
    const page1 = await get(desk, `/v1/pos-registers/${registerId}/sessions?limit=1`);
    expect(ids(page1)).toEqual([second.id]);
    const page2 = await get(
      desk,
      `/v1/pos-registers/${registerId}/sessions?limit=1&cursor=${encodeURIComponent(page1.body.nextCursor as string)}`,
    );
    expect(ids(page2)).toEqual([first.id]);
    expect(page2.body.nextCursor).toBeNull();
  });

  it('SCR-S-53: a session’s sales are listed newest first, filtered by status', async () => {
    const registerId = await register('LS2');
    const session = await openSession(registerId);
    const sale = async () => {
      const res = await post(t, '/v1/pos-sales', desk.header, {
        registerSessionId: session.id,
        customerPersonId: customer.personId,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      t.clock.advance(1_000);
      return res.body as { id: string; revision: number };
    };
    const a = await sale();
    const b = await sale();
    const voided = await post(t, `/v1/pos-sales/${a.id}/void`, desk.header, {
      reason: 'Rung up by mistake',
      expectedRevision: a.revision,
    });
    expect(voided.status, JSON.stringify(voided.body)).toBeLessThan(300);

    const sales = await get(desk, `/v1/pos-register-sessions/${session.id}/sales`);
    expect(sales.status, JSON.stringify(sales.body)).toBe(200);
    expect(ids(sales)).toEqual([b.id, a.id]);
    expect(sales.body.items[0]).toMatchObject({ registerSessionId: session.id, status: 'open' });
    const open = await get(desk, `/v1/pos-register-sessions/${session.id}/sales?status=open`);
    expect(ids(open)).toEqual([b.id]);
    // Another session's sales are not listed here.
    const other = await openSession(await register('LS3'));
    const empty = await get(desk, `/v1/pos-register-sessions/${other.id}/sales`);
    expect(empty.body.items).toEqual([]);
  });

  it('§4.3: a customer and a coach are refused; an unknown register or session is not found', async () => {
    const registerId = await register('LS4');
    const session = await openSession(registerId);
    for (const actor of [customer, coach]) {
      expect((await get(actor, `/v1/pos-registers/${registerId}/sessions`)).status).toBe(403);
      expect((await get(actor, `/v1/pos-register-sessions/${session.id}/sales`)).status).toBe(403);
    }
    expect((await get(desk, `/v1/pos-registers/${newId()}/sessions`)).status).toBe(404);
    expect((await get(desk, `/v1/pos-register-sessions/${newId()}/sales`)).status).toBe(404);
  });
});
