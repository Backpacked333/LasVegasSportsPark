import { newId } from '@sportspark/contracts';
import { json } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../testing/test-app';
import { IdentityModule } from '../identity.module';
import {
  authHeaderForPerson,
  createAccountFixture,
  createOrganizationPeople,
  createPersonFixture,
  createRelationshipFixture,
  createStaffMemberFixture,
} from '../testing/identity-fixtures';

const key = () => `k-${newId()}`;

/**
 * Operational care notes (migration 0181): §1.7 (not a medical assessment system), SPK-DISC-005
 * (operational, distinct from diagnosis), §4.14 (protected child information, audited access),
 * §4.10 (a caller who may not read them learns nothing), §4.7 (corrections are new rows).
 */
describe('care notes (§1.7, §4.14, SPK-DISC-005)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({
      imports: [IdentityModule],
      principalResolver: 'module',
      clockStart: '2026-11-06T15:00:00Z',
    });
  });
  afterAll(async () => {
    await t.close();
  });

  it('§4.14: front desk records an allergy note; the guardian holding view reads it; every read is audited', async () => {
    const cast = await createOrganizationPeople(t, { staffRoles: ['front_desk'] });
    const desk = await authHeaderForPerson(t, cast.staff.personId);
    const recorded = await t.http
      .post(`/v1/people/${cast.child.personId}/care-notes`)
      .set(desk)
      .set('Idempotency-Key', key())
      .send({ kind: 'allergy', body: 'Peanuts: EpiPen in the kit bag' });
    expect(recorded.status).toBe(201);
    expect(recorded.body).toMatchObject({
      personId: cast.child.personId,
      kind: 'allergy',
      status: 'active',
      revision: 1,
    });

    const guardian = await t.http
      .get(`/v1/people/${cast.child.personId}/care-notes`)
      .set(await authHeaderForPerson(t, cast.adult.personId));
    expect(guardian.status).toBe(200);
    expect(guardian.body.notes.map((n: { body: string }) => n.body)).toEqual([
      'Peanuts: EpiPen in the kit bag',
    ]);
    expect(guardian.body.visibleToRoles).toEqual([
      'front_desk',
      'program_manager',
      'general_manager',
    ]);
    expect(guardian.body.readAudited).toBe(true);

    const reads = await t.db
      .selectFrom('audit_records')
      .select(['action', 'details'])
      .where('target_id', '=', cast.child.personId)
      .where('action', '=', 'identity.read_care_notes')
      .execute();
    expect(reads).toHaveLength(1);
    // The audit names the note, never its text (§4.14).
    expect(JSON.stringify(reads[0]?.details)).not.toContain('Peanuts');
    const writes = await t.db
      .selectFrom('audit_records')
      .select(['details'])
      .where('target_id', '=', recorded.body.id)
      .execute();
    expect(JSON.stringify(writes)).not.toContain('Peanuts');
    const events = await t.db
      .selectFrom('outbox_events')
      .select(['event_type', 'payload'])
      .where('aggregate_id', '=', recorded.body.id)
      .execute();
    expect(events.map((e) => e.event_type)).toEqual(['identity.care_note_changed']);
    expect(JSON.stringify(events[0]?.payload)).not.toContain('Peanuts');
  });

  it('§4.10: a role outside the explicit readers and an unrelated customer both get NOT_FOUND', async () => {
    const cast = await createOrganizationPeople(t);
    const desk = await authHeaderForPerson(t, cast.staff.personId);
    await t.http
      .post(`/v1/people/${cast.child.personId}/care-notes`)
      .set(desk)
      .set('Idempotency-Key', key())
      .send({ kind: 'care_instruction', body: 'Needs an inhaler before running drills' });
    for (const roles of [
      ['league_manager'],
      ['finance_operator'],
      ['system_administrator'],
    ] as const) {
      const staff = await createStaffMemberFixture(t, { roles: [...roles] });
      const read = await t.http
        .get(`/v1/people/${cast.child.personId}/care-notes`)
        .set(await authHeaderForPerson(t, staff.personId));
      expect(read.status).toBe(404);
    }
    const stranger = await createPersonFixture(t, { kind: 'adult' });
    await createAccountFixture(t, { personId: stranger });
    const strangerRead = await t.http
      .get(`/v1/people/${cast.child.personId}/care-notes`)
      .set(await authHeaderForPerson(t, stranger));
    expect(strangerRead.status).toBe(404);
    const missing = await t.http.get(`/v1/people/${newId()}/care-notes`).set(desk);
    expect(missing.status).toBe(404);
  });

  it('SPK-IAM-003: a holder of view only cannot record a note; a guardian holding complete_forms can', async () => {
    const cast = await createOrganizationPeople(t, { guardianPermissions: ['view'] });
    const viewer = await authHeaderForPerson(t, cast.adult.personId);
    const refused = await t.http
      .post(`/v1/people/${cast.child.personId}/care-notes`)
      .set(viewer)
      .set('Idempotency-Key', key())
      .send({ kind: 'allergy', body: 'Bees' });
    expect(refused.status).toBe(404);
    const other = await createPersonFixture(t, { kind: 'adult' });
    await createAccountFixture(t, { personId: other });
    await createRelationshipFixture(t, {
      actorPersonId: other,
      subjectPersonId: cast.child.personId,
      permissions: ['view', 'complete_forms'],
    });
    const allowed = await t.http
      .post(`/v1/people/${cast.child.personId}/care-notes`)
      .set(await authHeaderForPerson(t, other))
      .set('Idempotency-Key', key())
      .send({ kind: 'allergy', body: 'Bees' });
    expect(allowed.status).toBe(201);
  });

  it('§4.7, §4.9: retiring needs the current revision and a reason; a retired note is not listed', async () => {
    const cast = await createOrganizationPeople(t, { staffRoles: ['program_manager'] });
    const staff = await authHeaderForPerson(t, cast.staff.personId);
    const note = await t.http
      .post(`/v1/people/${cast.child.personId}/care-notes`)
      .set(staff)
      .set('Idempotency-Key', key())
      .send({ kind: 'allergy', body: 'Dairy' });
    const stale = await t.http
      .post(`/v1/care-notes/${note.body.id}/retire`)
      .set(staff)
      .set('Idempotency-Key', key())
      .send({ reason: 'outgrown', expectedRevision: 7 });
    expect(stale.status).toBe(409);
    const retired = await t.http
      .post(`/v1/care-notes/${note.body.id}/retire`)
      .set(staff)
      .set('Idempotency-Key', key())
      .send({ reason: 'outgrown, confirmed by guardian', expectedRevision: 1 });
    expect(retired.status).toBe(200);
    expect(retired.body).toMatchObject({ status: 'retired', revision: 2 });
    const again = await t.http
      .post(`/v1/care-notes/${note.body.id}/retire`)
      .set(staff)
      .set('Idempotency-Key', key())
      .send({ reason: 'twice', expectedRevision: 2 });
    expect(again.status).toBe(409);
    const list = await t.http.get(`/v1/people/${cast.child.personId}/care-notes`).set(staff);
    expect(list.body.notes).toEqual([]);
  });

  it('§1.7: only operational kinds are accepted; the database refuses any other kind, a rewrite or a delete', async () => {
    const cast = await createOrganizationPeople(t);
    const desk = await authHeaderForPerson(t, cast.staff.personId);
    const diagnosis = await t.http
      .post(`/v1/people/${cast.child.personId}/care-notes`)
      .set(desk)
      .set('Idempotency-Key', key())
      .send({ kind: 'diagnosis', body: 'Asthma' });
    expect(diagnosis.status).toBe(400);
    const insert = (kind: string) =>
      t.db
        .insertInto('person_care_notes')
        .values({
          id: newId(),
          organization_id: t.organizationId,
          person_id: cast.child.personId,
          kind: kind as 'allergy',
          body: 'x',
          recorded_by: json({ kind: 'system' }),
          recorded_by_person_id: null,
          retired_at: null,
          retired_by: null,
          retired_reason: null,
        })
        .execute();
    await expect(insert('diagnosis')).rejects.toThrow();
    const note = await t.http
      .post(`/v1/people/${cast.child.personId}/care-notes`)
      .set(desk)
      .set('Idempotency-Key', key())
      .send({ kind: 'allergy', body: 'Latex' });
    await expect(
      t.db
        .updateTable('person_care_notes')
        .set({ body: 'Something else' })
        .where('id', '=', note.body.id)
        .execute(),
    ).rejects.toThrow(/never rewritten/);
    await expect(
      t.db.deleteFrom('person_care_notes').where('id', '=', note.body.id).execute(),
    ).rejects.toThrow(/cannot be deleted/);
    await expect(
      t.db
        .updateTable('person_care_notes')
        .set({ status: 'retired', retired_at: new Date() })
        .where('id', '=', note.body.id)
        .execute(),
    ).rejects.toThrow();
  });
});
