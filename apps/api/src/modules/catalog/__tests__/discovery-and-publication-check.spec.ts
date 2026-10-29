import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../testing';
import {
  authHeaderForPerson,
  createOrganizationPeople,
  createStaffMemberFixture,
} from '../../identity';
import { CatalogModule } from '../catalog.module';
import {
  createOfferingFixture,
  createOfferingSessionFixture,
  createProgramFixture,
} from '../testing/catalog-fixtures';

const key = () => `k-${newId()}`;
type Auth = { Authorization: string };

/**
 * CAT-01: the publication dry run (SPK-CAT-004), discovery with format, date range and the staff
 * view (SPK-CAT-001, §4.14), the facility time zone on every offering view and the facility day's
 * sessions (SPK-SCHED-008).
 */
describe('catalog discovery and publication check (CAT-01)', () => {
  let t: TestApp;
  let managerPersonId: string;
  let pm: Auth;
  let frontDesk: Auth;
  let customer: Auth;
  let eastManager: Auth;
  let eastFrontDesk: Auth;
  let slug: string;
  let programId: string;
  let eastFacilityId: string;

  beforeAll(async () => {
    t = await createTestApp({
      imports: [CatalogModule],
      principalResolver: 'module',
      clockStart: '2026-10-23T12:00:00Z',
    });
    eastFacilityId = newId();
    await t.db
      .insertInto('facilities')
      .values({
        id: eastFacilityId,
        organization_id: t.organizationId,
        slug: 'east',
        name: 'East complex',
        timezone: 'America/New_York',
        address: null,
      })
      .execute();
    const manager = await createStaffMemberFixture(t, { roles: ['program_manager'] });
    managerPersonId = manager.personId;
    pm = await authHeaderForPerson(t, manager.personId);
    frontDesk = await authHeaderForPerson(
      t,
      (await createStaffMemberFixture(t, { roles: ['front_desk'] })).personId,
    );
    eastManager = await authHeaderForPerson(
      t,
      (
        await createStaffMemberFixture(t, {
          roles: ['program_manager'],
          facilityIds: [eastFacilityId],
        })
      ).personId,
    );
    eastFrontDesk = await authHeaderForPerson(
      t,
      (await createStaffMemberFixture(t, { roles: ['front_desk'], facilityIds: [eastFacilityId] }))
        .personId,
    );
    customer = await authHeaderForPerson(t, (await createOrganizationPeople(t)).adult.personId);
    slug = (
      await t.db
        .selectFrom('organizations')
        .select('slug')
        .where('id', '=', t.organizationId)
        .executeTakeFirstOrThrow()
    ).slug;
    programId = await createProgramFixture(t);
  });
  afterAll(async () => {
    await t.close();
  });

  const writes = async (offeringId: string) => ({
    approvals: (
      await t.db.selectFrom('approvals').select('id').where('subject_id', '=', offeringId).execute()
    ).length,
    audit: (
      await t.db
        .selectFrom('audit_records')
        .select('id')
        .where('target_id', '=', offeringId)
        .execute()
    ).length,
    events: (
      await t.db
        .selectFrom('outbox_events')
        .select('id')
        .where('aggregate_id', '=', offeringId)
        .execute()
    ).length,
    revision: (
      await t.db
        .selectFrom('offerings')
        .select(['revision', 'publication_state'])
        .where('id', '=', offeringId)
        .executeTakeFirstOrThrow()
    ).revision,
  });

  it('SPK-CAT-004: the publication check reports the problems publish would and records nothing', async () => {
    const created = await t.http
      .post('/v1/offerings')
      .set(pm)
      .set('Idempotency-Key', key())
      .send({
        programId,
        name: `Spring term ${newId().slice(-6)}`,
        description: 'Small-sided play',
        kind: 'term',
        facilityId: t.facilityId,
        startsOn: '2027-03-01',
        endsOn: '2027-05-01',
        location: { label: 'Indoor hall' },
      });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    const before = await writes(id);

    const check = await t.http.get(`/v1/offerings/${id}/publication-check`).set(pm);
    expect(check.status).toBe(200);
    expect(check.body).toMatchObject({
      offeringId: id,
      publicationState: 'draft',
      revision: 1,
      publishable: false,
    });
    const publish = await t.http
      .post(`/v1/offerings/${id}/publish`)
      .set(pm)
      .set('Idempotency-Key', key())
      .send({});
    expect(publish.status).toBe(400);
    // the dry run reports exactly what publish refuses with, in the same order
    expect(check.body.problems).toEqual(publish.body.details.problems);
    expect(check.body.problems.map((p: { code: string }) => p.code)).toContain(
      'registration_window_missing',
    );
    // nothing was recorded by the check (the refused publish rolled back as well)
    expect(await writes(id)).toEqual(before);

    // a fully configured draft is publishable; checking it still writes nothing
    const ready = await createOfferingFixture(t, {
      responsibleManagerPersonId: managerPersonId,
      publicationState: 'draft',
    });
    const readyBefore = await writes(ready.offeringId);
    const ok = await t.http.get(`/v1/offerings/${ready.offeringId}/publication-check`).set(pm);
    expect(ok.body).toMatchObject({ publishable: true, problems: [], publicationState: 'draft' });
    expect(await writes(ready.offeringId)).toEqual(readyBefore);
    const published = await t.http
      .post(`/v1/offerings/${ready.offeringId}/publish`)
      .set(pm)
      .set('Idempotency-Key', key())
      .send({});
    expect(published.status).toBe(200);
    // a published offering keeps a valid configuration but cannot be published again
    const after = await t.http.get(`/v1/offerings/${ready.offeringId}/publication-check`).set(pm);
    expect(after.body).toMatchObject({
      publicationState: 'published',
      publishable: false,
      problems: [],
      revision: 2,
    });
  });

  it('§4.14, §4.10: the publication check needs catalog.publish_offering at the offering facility', async () => {
    const west = await createOfferingFixture(t, {
      responsibleManagerPersonId: managerPersonId,
      publicationState: 'draft',
    });
    const path = `/v1/offerings/${west.offeringId}/publication-check`;
    expect((await t.http.get(path).set(frontDesk)).status).toBe(403);
    // §4.10: a customer cannot tell a draft id from an id that names nothing
    const draft = await t.http.get(path).set(customer);
    const unknown = await t.http.get(`/v1/offerings/${newId()}/publication-check`).set(customer);
    expect(draft.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(draft.body.code).toBe(unknown.body.code);
    expect((await t.http.get(path)).status).toBe(401);
    // a manager scoped to another facility may not check it
    expect((await t.http.get(path).set(eastManager)).status).toBe(403);
    expect((await t.http.get(`/v1/offerings/${newId()}/publication-check`).set(pm)).status).toBe(
      404,
    );
  });

  it('SPK-SCHED-008: public offerings carry the facility time zone', async () => {
    const west = await createOfferingFixture(t, {
      responsibleManagerPersonId: managerPersonId,
      programId,
      name: `West tz ${newId().slice(-6)}`,
    });
    const east = await createOfferingFixture(t, {
      responsibleManagerPersonId: managerPersonId,
      programId,
      facilityId: eastFacilityId,
      name: `East tz ${newId().slice(-6)}`,
    });
    const listed = await t.http.get(`/v1/offerings?organization=${slug}&programId=${programId}`);
    expect(listed.status).toBe(200);
    const byId = new Map(
      listed.body.items.map((o: { id: string; facility: unknown }) => [o.id, o.facility]),
    );
    expect(byId.get(west.offeringId)).toEqual({
      id: t.facilityId,
      name: 'Main complex',
      timezone: 'America/Los_Angeles',
    });
    expect(byId.get(east.offeringId)).toEqual({
      id: eastFacilityId,
      name: 'East complex',
      timezone: 'America/New_York',
    });
    const detail = await t.http.get(`/v1/offerings/${east.offeringId}`);
    expect(detail.body.facility).toMatchObject({ timezone: 'America/New_York' });
    const staffDetail = await t.http.get(`/v1/offerings/${east.offeringId}`).set(pm);
    expect(staffDetail.body.facility).toMatchObject({ timezone: 'America/New_York' });
  });

  it('SPK-CAT-001: discovery filters by format and by the date range [from, to]', async () => {
    const program = await createProgramFixture(t);
    const make = (name: string, startsOn: string, endsOn: string) =>
      createOfferingFixture(t, {
        responsibleManagerPersonId: managerPersonId,
        programId: program,
        name,
        startsOn,
        endsOn,
      });
    const winter = await make('Winter', '2027-01-04', '2027-02-28');
    const spring = await make('Spring', '2027-03-01', '2027-04-30');
    const summer = await make('Summer', '2027-06-01', '2027-07-31');
    await t.db
      .updateTable('offerings')
      .set({ format: '5v5' })
      .where('id', '=', spring.offeringId)
      .execute();
    const ids = async (query: string) => {
      const res = await t.http.get(
        `/v1/offerings?organization=${slug}&programId=${program}${query}`,
      );
      expect(res.status).toBe(200);
      return res.body.items.map((o: { id: string }) => o.id);
    };
    expect(await ids('&format=5v5')).toEqual([spring.offeringId]);
    expect(await ids('&format=7v7')).toEqual([winter.offeringId, summer.offeringId]);
    // overlap: ends on or after `from`, starts on or before `to`
    expect(await ids('&from=2027-02-15&to=2027-03-15')).toEqual([
      winter.offeringId,
      spring.offeringId,
    ]);
    expect(await ids('&to=2027-02-01')).toEqual([winter.offeringId]);
    expect(await ids('&from=2027-05-01')).toEqual([summer.offeringId]);
    const backwards = await t.http.get(
      `/v1/offerings?organization=${slug}&from=2027-05-01&to=2027-04-01`,
    );
    expect(backwards.status).toBe(400);
  });

  it('CAT-01: view=staff lists every state for offering managers in their facilities; anyone else gets the public view', async () => {
    const program = await createProgramFixture(t);
    const draft = await createOfferingFixture(t, {
      responsibleManagerPersonId: managerPersonId,
      programId: program,
      publicationState: 'draft',
    });
    const closed = await createOfferingFixture(t, {
      responsibleManagerPersonId: managerPersonId,
      programId: program,
      publicationState: 'closed',
    });
    const open = await createOfferingFixture(t, {
      responsibleManagerPersonId: managerPersonId,
      programId: program,
    });
    const eastDraft = await createOfferingFixture(t, {
      responsibleManagerPersonId: managerPersonId,
      programId: program,
      facilityId: eastFacilityId,
      publicationState: 'draft',
    });
    const list = (auth: Auth | null, query = '&view=staff') => {
      const req = t.http.get(`/v1/offerings?programId=${program}${query}`);
      return auth ? req.set(auth) : req.query({ organization: slug });
    };
    const staff = await list(pm);
    expect(staff.status).toBe(200);
    expect(staff.body.items.map((o: { id: string }) => o.id).sort()).toEqual(
      [draft.offeringId, closed.offeringId, open.offeringId, eastDraft.offeringId].sort(),
    );
    const draftRow = staff.body.items.find((o: { id: string }) => o.id === draft.offeringId);
    expect(draftRow.publicationState).toBe('draft');
    expect(draftRow.staff).toMatchObject({
      revision: 1,
      responsibleManagerPersonId: managerPersonId,
    });

    // a manager scoped to the east facility sees only the east facility's rows
    const scoped = await list(eastManager);
    expect(scoped.body.items.map((o: { id: string }) => o.id)).toEqual([eastDraft.offeringId]);

    // front desk reads the catalog but does not manage offerings: public view
    for (const reader of [frontDesk, customer, null]) {
      const res = await list(reader);
      expect(res.status).toBe(200);
      expect(res.body.items.map((o: { id: string }) => o.id)).toEqual([open.offeringId]);
      expect(res.body.items[0]).not.toHaveProperty('staff');
    }
    // without view=staff even a manager gets the public view
    const plain = await list(pm, '');
    expect(plain.body.items.map((o: { id: string }) => o.id)).toEqual([open.offeringId]);
    expect(plain.body.items[0]).not.toHaveProperty('staff');
  });

  it('SPK-SCHED-008: GET /sessions lists a facility day with its time zone for building an attendance ActivityRef', async () => {
    const program = await createProgramFixture(t);
    const term = await createOfferingFixture(t, {
      responsibleManagerPersonId: managerPersonId,
      programId: program,
      name: 'Evening term',
    });
    const draft = await createOfferingFixture(t, {
      responsibleManagerPersonId: managerPersonId,
      programId: program,
      name: 'Draft clinic',
      publicationState: 'draft',
    });
    const east = await createOfferingFixture(t, {
      responsibleManagerPersonId: managerPersonId,
      programId: program,
      facilityId: eastFacilityId,
      name: 'East term',
    });
    const at = (iso: string) => new Date(iso);
    const s1 = await createOfferingSessionFixture(t, {
      offeringId: term.offeringId,
      scheduledStart: at('2026-11-03T01:00:00Z'),
      scheduledEnd: at('2026-11-03T02:00:00Z'),
    });
    const s2 = await createOfferingSessionFixture(t, {
      offeringId: draft.offeringId,
      scheduledStart: at('2026-11-03T03:00:00Z'),
      scheduledEnd: at('2026-11-03T04:00:00Z'),
    });
    const canceled = await createOfferingSessionFixture(t, {
      offeringId: term.offeringId,
      scheduledStart: at('2026-11-03T05:00:00Z'),
      scheduledEnd: at('2026-11-03T06:00:00Z'),
      status: 'canceled',
    });
    // outside the window, and at another facility
    await createOfferingSessionFixture(t, {
      offeringId: term.offeringId,
      scheduledStart: at('2026-11-04T01:00:00Z'),
      scheduledEnd: at('2026-11-04T02:00:00Z'),
    });
    const eastSession = await createOfferingSessionFixture(t, {
      offeringId: east.offeringId,
      scheduledStart: at('2026-11-03T01:00:00Z'),
      scheduledEnd: at('2026-11-03T02:00:00Z'),
    });
    // the local day 2026-11-02 in Los Angeles (UTC-8 after the DST change on 2026-11-01)
    const window = { from: '2026-11-02T08:00:00.000Z', to: '2026-11-03T08:00:00.000Z' };
    const query = (extra: Record<string, string | number> = {}) => ({
      facilityId: t.facilityId,
      ...window,
      ...extra,
    });
    const day = await t.http.get('/v1/sessions').set(frontDesk).query(query());
    expect(day.status).toBe(200);
    expect(day.body.items).toEqual([
      {
        sessionId: s1,
        offeringId: term.offeringId,
        offeringName: 'Evening term',
        sequence: 1,
        title: null,
        scheduledStart: '2026-11-03T01:00:00.000Z',
        scheduledEnd: '2026-11-03T02:00:00.000Z',
        status: 'scheduled',
        facilityId: t.facilityId,
        timezone: 'America/Los_Angeles',
      },
      expect.objectContaining({ sessionId: s2, offeringId: draft.offeringId }),
      expect.objectContaining({ sessionId: canceled, status: 'canceled' }),
    ]);
    expect(day.body.nextCursor).toBeNull();
    const scheduledOnly = await t.http
      .get('/v1/sessions')
      .set(frontDesk)
      .query(query({ status: 'scheduled' }));
    expect(scheduledOnly.body.items.map((s: { sessionId: string }) => s.sessionId)).toEqual([
      s1,
      s2,
    ]);
    // keyset paging by (scheduledStart, id)
    const first = await t.http
      .get('/v1/sessions')
      .set(frontDesk)
      .query(query({ limit: 2 }));
    expect(first.body.items.map((s: { sessionId: string }) => s.sessionId)).toEqual([s1, s2]);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await t.http
      .get('/v1/sessions')
      .set(frontDesk)
      .query(query({ limit: 2, cursor: first.body.nextCursor as string }));
    expect(second.body.items.map((s: { sessionId: string }) => s.sessionId)).toEqual([canceled]);
    expect(second.body.nextCursor).toBeNull();
    // the east facility's day in its own zone, for staff scoped there
    const eastDay = await t.http
      .get('/v1/sessions')
      .set(eastFrontDesk)
      .query({ ...window, facilityId: eastFacilityId });
    expect(eastDay.body.items).toEqual([
      expect.objectContaining({ sessionId: eastSession, timezone: 'America/New_York' }),
    ]);
  });

  it('§4.14: GET /sessions is staff-only, facility-scoped and bounded to 31 days', async () => {
    const window = { from: '2026-11-02T08:00:00.000Z', to: '2026-11-03T08:00:00.000Z' };
    const res = (auth: Auth | null, query: Record<string, string>) => {
      const req = t.http.get('/v1/sessions').query(query);
      return auth ? req.set(auth) : req;
    };
    expect((await res(customer, { ...window, facilityId: t.facilityId })).status).toBe(403);
    expect((await res(null, { ...window, facilityId: t.facilityId })).status).toBe(401);
    expect((await res(eastFrontDesk, { ...window, facilityId: t.facilityId })).status).toBe(403);
    expect((await res(frontDesk, { ...window, facilityId: newId() })).status).toBe(404);
    expect(
      (
        await res(frontDesk, {
          facilityId: t.facilityId,
          from: '2026-11-01T00:00:00.000Z',
          to: '2026-12-02T00:00:01.000Z',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await res(frontDesk, {
          facilityId: t.facilityId,
          from: '2026-11-01T00:00:00.000Z',
          to: '2026-12-02T00:00:00.000Z',
        })
      ).status,
    ).toBe(200);
    expect(
      (await res(frontDesk, { facilityId: t.facilityId, from: window.to, to: window.from })).status,
    ).toBe(400);
  });
});
