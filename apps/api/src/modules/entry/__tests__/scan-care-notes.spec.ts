import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { entryTestApp, family, post, staffMember, type Actor, type Family } from './support';

interface ScannedPerson {
  personId: string;
  careNotes: Array<{ id: string; kind: string; body: string }> | null;
}

/**
 * Care notes on an arrival scan (SPK-ENTRY-004 actionable arrival information; §1.7 operational
 * notes, never a diagnosis; §4.14 protected and audited). The scan still records nobody present.
 */
describe('arrival scan care notes (SPK-ENTRY-004, §4.14)', () => {
  let t: TestApp;
  let desk: Actor;
  let fam: Family;
  let reference: string;

  beforeAll(async () => {
    t = await entryTestApp();
    desk = await staffMember(t, ['front_desk']);
    fam = await family(t, desk);
    const note = await post(t, `/v1/people/${fam.childA}/care-notes`, desk, {
      kind: 'allergy',
      body: 'Peanuts: EpiPen in the kit bag',
    });
    expect(note.status, JSON.stringify(note.body)).toBe(201);
    const issued = await post(t, '/v1/passes', desk, {
      holder: { kind: 'household', householdId: fam.householdId },
    });
    reference = issued.body.reference as string;
  });
  afterAll(async () => {
    await t.close();
  });

  const scan = (actor: Actor) =>
    t.http.post('/v1/passes/scan').set(actor.header).send({ reference, facilityId: t.facilityId });

  it('SPK-ENTRY-004: the front desk scan shows the care note of the child it belongs to and audits that view', async () => {
    const result = await scan(desk);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const people = result.body.people as ScannedPerson[];
    const ava = people.find((p) => p.personId === fam.childA)!;
    const ben = people.find((p) => p.personId === fam.childB)!;
    expect(ava.careNotes).toEqual([
      expect.objectContaining({ kind: 'allergy', body: 'Peanuts: EpiPen in the kit bag' }),
    ]);
    expect(ben.careNotes).toEqual([]);
    expect(result.body.recorded).toBe('nothing');
    const audits = await t.db
      .selectFrom('audit_records')
      .select(['target_id', 'details'])
      .where('action', '=', 'identity.read_care_notes')
      .execute();
    expect(audits.map((a) => a.target_id)).toEqual([fam.childA]);
    expect(audits[0]?.details).toMatchObject({ via: 'entry.scan_pass', facilityId: t.facilityId });
  });

  it('§4.14: a desk role that may scan but not read care notes gets null, and nothing is audited as read', async () => {
    const league = await staffMember(t, ['league_manager']);
    const before = await t.db
      .selectFrom('audit_records')
      .select('id')
      .where('action', '=', 'identity.read_care_notes')
      .execute();
    const result = await scan(league);
    expect(result.status).toBe(200);
    for (const person of result.body.people as ScannedPerson[]) {
      expect(person.careNotes).toBeNull();
    }
    expect(JSON.stringify(result.body)).not.toContain('Peanuts');
    const after = await t.db
      .selectFrom('audit_records')
      .select('id')
      .where('action', '=', 'identity.read_care_notes')
      .execute();
    expect(after.length).toBe(before.length);
  });

  it('§4.3: a front desk scoped to another facility cannot scan here at all', async () => {
    const elsewhere = await staffMember(t, ['front_desk'], {
      facilityIds: ['018f0000-0000-7000-8000-000000000001'],
    });
    const result = await scan(elsewhere);
    expect(result.status).toBe(403);
  });
});
