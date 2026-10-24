import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../testing';
import {
  authHeaderForPerson,
  createOrganizationPeople,
  createStaffMemberFixture,
} from '../../identity';
import { CatalogModule } from '../catalog.module';
import { OFFERING_LOOKUP_PORT, type OfferingLookupPort } from '../catalog.ports';
import {
  createEntitlementDefinitionFixture,
  createOfferingFixture,
  createOfferingSessionFixture,
  createPolicyVersionFixture,
  createProgramFixture,
} from '../testing/catalog-fixtures';

const key = () => `k-${newId()}`;

describe('offerings (SPK-CAT-001..004, SPK-YOUTH-002, §4.14)', () => {
  let t: TestApp;
  let managerPersonId: string;
  let pm: { Authorization: string };
  let finance: { Authorization: string };
  let frontDesk: { Authorization: string };
  let scheduler: { Authorization: string };
  let customer: { Authorization: string };
  let slug: string;
  let programId: string;

  beforeAll(async () => {
    t = await createTestApp({
      imports: [CatalogModule],
      principalResolver: 'module',
      clockStart: '2026-10-23T12:00:00Z',
    });
    const manager = await createStaffMemberFixture(t, { roles: ['program_manager'] });
    managerPersonId = manager.personId;
    pm = await authHeaderForPerson(t, manager.personId);
    finance = await authHeaderForPerson(
      t,
      (await createStaffMemberFixture(t, { roles: ['finance_operator'] })).personId,
    );
    frontDesk = await authHeaderForPerson(
      t,
      (await createStaffMemberFixture(t, { roles: ['front_desk'] })).personId,
    );
    scheduler = await authHeaderForPerson(
      t,
      (await createStaffMemberFixture(t, { roles: ['scheduler'] })).personId,
    );
    const people = await createOrganizationPeople(t);
    customer = await authHeaderForPerson(t, people.adult.personId);
    slug = (
      await t.db
        .selectFrom('organizations')
        .select('slug')
        .where('id', '=', t.organizationId)
        .executeTakeFirstOrThrow()
    ).slug;
    programId = await createProgramFixture(t, { ageBand: { minAgeYears: 6, maxAgeYears: 9 } });
  });
  afterAll(async () => {
    await t.close();
  });

  const draftBody = (overrides: Record<string, unknown> = {}) => ({
    programId,
    name: `Winter term ${newId().slice(-6)}`,
    description: 'Eight weeks of small-sided play',
    kind: 'term',
    facilityId: t.facilityId,
    startsOn: '2027-01-10',
    endsOn: '2027-03-07',
    location: { label: 'Indoor hall', resourceIds: [] },
    ...overrides,
  });

  it('SPK-CAT-001: a draft offering is created with its definition and is visible to staff only', async () => {
    const res = await t.http
      .post('/v1/offerings')
      .set(pm)
      .set('Idempotency-Key', key())
      .send(draftBody());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      kind: 'term',
      publicationState: 'draft',
      ageBand: { minAgeYears: 6, maxAgeYears: 9 },
      price: null,
      capacity: [],
      staff: { revision: 1, location: { label: 'Indoor hall', resourceIds: [] } },
    });
    const id = res.body.id as string;
    expect((await t.http.get(`/v1/offerings/${id}`).set(frontDesk)).body.staff).not.toBeNull();
    expect((await t.http.get(`/v1/offerings/${id}`).set(customer)).status).toBe(404);
    expect((await t.http.get(`/v1/offerings/${id}`)).status).toBe(404);
    const denied = await t.http
      .post('/v1/offerings')
      .set(frontDesk)
      .set('Idempotency-Key', key())
      .send(draftBody());
    expect(denied.status).toBe(403);
    const financeDenied = await t.http
      .post('/v1/offerings')
      .set(finance)
      .set('Idempotency-Key', key())
      .send(draftBody());
    expect(financeDenied.status).toBe(403);
  });

  it('§4.9: offering creation replays on the same idempotency key', async () => {
    const k = key();
    const body = draftBody();
    const first = await t.http.post('/v1/offerings').set(pm).set('Idempotency-Key', k).send(body);
    const replay = await t.http.post('/v1/offerings').set(pm).set('Idempotency-Key', k).send(body);
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.id).toBe(first.body.id);
    const rows = await t.db
      .selectFrom('offerings')
      .select('id')
      .where('name', '=', body.name)
      .execute();
    expect(rows).toHaveLength(1);
  });

  it('SPK-CAT-004: publication validates every required configuration and lists what is missing', async () => {
    const created = await t.http
      .post('/v1/offerings')
      .set(pm)
      .set('Idempotency-Key', key())
      .send(draftBody());
    const id = created.body.id as string;
    const bare = await t.http
      .post(`/v1/offerings/${id}/publish`)
      .set(pm)
      .set('Idempotency-Key', key())
      .send({});
    expect(bare.status).toBe(400);
    expect(bare.body.code).toBe('VALIDATION_FAILED');
    const codes = bare.body.details.problems.map((p: { code: string }) => p.code).sort();
    expect(codes).toEqual(
      [
        'cancellation_policy_missing',
        'capacity_missing',
        'eligibility_policy_missing',
        'entitlement_missing',
        'price_rule_missing',
        'registration_window_missing',
        'responsible_manager_missing',
      ].sort(),
    );
    expect(
      (
        await t.db
          .selectFrom('offerings')
          .select('publication_state')
          .where('id', '=', id)
          .executeTakeFirstOrThrow()
      ).publication_state,
    ).toBe('draft');

    // configure it, but with a draft eligibility policy and a form policy used as cancellation policy
    const draftEligibility = await createPolicyVersionFixture(t, {
      kind: 'eligibility',
      approved: false,
    });
    const approvedEligibility = await createPolicyVersionFixture(t, { kind: 'eligibility' });
    const cancellation = await createPolicyVersionFixture(t, { kind: 'cancellation' });
    const form = await createPolicyVersionFixture(t, { kind: 'form' });
    const entitlement = await createEntitlementDefinitionFixture(t);
    const configured = await t.http
      .patch(`/v1/offerings/${id}`)
      .set(pm)
      .set('Idempotency-Key', key())
      .send({
        expectedRevision: 1,
        registrationOpensAt: '2026-11-01T08:00:00Z',
        registrationClosesAt: '2027-01-05T00:00:00Z',
        eligibilityPolicyVersionId: draftEligibility,
        cancellationPolicyVersionId: form,
        entitlementDefinitionId: entitlement,
        capacityUnits: [{ unit: 'seats', limit: 16 }],
        requiredFormPolicyVersionIds: [form],
        responsibleManagerPersonId: managerPersonId,
      });
    expect(configured.status).toBe(200);
    expect(configured.body.staff.revision).toBe(2);
    const stillInvalid = await t.http
      .post(`/v1/offerings/${id}/publish`)
      .set(pm)
      .set('Idempotency-Key', key())
      .send({});
    expect(stillInvalid.status).toBe(400);
    expect(stillInvalid.body.details.problems.map((p: { code: string }) => p.code).sort()).toEqual([
      'cancellation_policy_wrong_kind',
      'eligibility_policy_not_approved',
      'price_rule_missing',
    ]);

    // finance prices it; the manager fixes the policies; scheduler may not publish
    const priced = await t.http
      .post(`/v1/offerings/${id}/price-rules`)
      .set(finance)
      .set('Idempotency-Key', key())
      .send({
        effectiveFrom: '2026-10-23T12:00:00Z',
        basePriceMinor: 18_500,
        currency: 'USD',
        chargeLines: [{ code: 'tax', label: 'Sales tax', kind: 'tax', basisPoints: 825 }],
      });
    expect(priced.status).toBe(201);
    const fixed = await t.http
      .patch(`/v1/offerings/${id}`)
      .set(pm)
      .set('Idempotency-Key', key())
      .send({
        expectedRevision: 2,
        eligibilityPolicyVersionId: approvedEligibility,
        cancellationPolicyVersionId: cancellation,
      });
    expect(fixed.status).toBe(200);
    const notPublisher = await t.http
      .post(`/v1/offerings/${id}/publish`)
      .set(scheduler)
      .set('Idempotency-Key', key())
      .send({});
    expect(notPublisher.status).toBe(403);
    const published = await t.http
      .post(`/v1/offerings/${id}/publish`)
      .set(pm)
      .set('Idempotency-Key', key())
      .send({ expectedRevision: 3, reason: 'Season approved at the planning meeting' });
    expect(published.status).toBe(200);
    expect(published.body).toMatchObject({
      publicationState: 'published',
      price: { basePriceMinor: 18_500, currency: 'USD' },
      requiredFormPolicyVersionIds: [form],
      capacity: [{ unit: 'seats', limit: 16 }],
    });
    expect(published.body.staff.publishedAt).not.toBeNull();
    const approval = await t.db
      .selectFrom('approvals')
      .selectAll()
      .where('subject_type', '=', 'offering_publication')
      .where('subject_id', '=', id)
      .executeTakeFirstOrThrow();
    expect(approval).toMatchObject({ decision: 'approved', actor_person_id: managerPersonId });
    const event = await t.db
      .selectFrom('outbox_events')
      .select('payload')
      .where('event_type', '=', 'catalog.offering_published')
      .where('aggregate_id', '=', id)
      .executeTakeFirstOrThrow();
    expect(event.payload).toMatchObject({
      offeringId: id,
      kind: 'term',
      registrationOpensAt: '2026-11-01T08:00:00.000Z',
    });

    // publishing twice is an invalid transition, as is stripping required configuration later
    const again = await t.http
      .post(`/v1/offerings/${id}/publish`)
      .set(pm)
      .set('Idempotency-Key', key())
      .send({});
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('INVALID_TRANSITION');
    const strip = await t.http
      .patch(`/v1/offerings/${id}`)
      .set(pm)
      .set('Idempotency-Key', key())
      .send({ expectedRevision: 4, eligibilityPolicyVersionId: null });
    expect(strip.status).toBe(400);
    expect(strip.body.details.problems[0].code).toBe('eligibility_policy_missing');

    // §4.14: public discovery shows child-safe fields only
    const anonymous = await t.http.get(`/v1/offerings?organization=${slug}&kind=term`);
    expect(anonymous.status).toBe(200);
    const listed = anonymous.body.items.find((o: { id: string }) => o.id === id);
    expect(listed).toBeDefined();
    expect(listed).not.toHaveProperty('staff');
    expect(listed).not.toHaveProperty('responsibleManagerPersonId');
    expect(listed.price).toMatchObject({ basePriceMinor: 18_500 });
    const detail = await t.http.get(`/v1/offerings/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.staff).toBeNull();
    expect((await t.http.get(`/v1/offerings/${id}`).set(customer)).body.staff).toBeNull();
    expect((await t.http.get(`/v1/offerings/${id}`).set(frontDesk)).body.staff).not.toBeNull();
    expect((await t.http.get('/v1/offerings')).status).toBe(400);
    expect((await t.http.get('/v1/offerings?organization=no-such-org')).status).toBe(404);
  });

  it('SPK-CAT-004: registration opening, pausing and closing are distinct from publication', async () => {
    const fixture = await createOfferingFixture(t, {
      responsibleManagerPersonId: managerPersonId,
      publicationState: 'published',
    });
    const id = fixture.offeringId;
    const transition = (path: string, body: Record<string, unknown> = {}, auth = pm) =>
      t.http.post(`/v1/offerings/${id}/${path}`).set(auth).set('Idempotency-Key', key()).send(body);

    const paused = await transition('registration/pause');
    expect(paused.status).toBe(409); // not open yet
    expect((await transition('registration/open', {}, frontDesk)).status).toBe(403);
    const opened = await transition('registration/open');
    expect(opened.status).toBe(200);
    expect(opened.body.publicationState).toBe('registration_open');
    expect(opened.body.staff.registrationOpenedAt).not.toBeNull();
    expect((await transition('registration/open')).status).toBe(409);

    const pause = await transition('registration/pause', { reason: 'Coach shortage this week' });
    expect(pause.status).toBe(200);
    expect(pause.body.publicationState).toBe('registration_paused');
    // paused offerings stay published and discoverable; nothing about participation changed here
    const detail = await t.http.get(`/v1/offerings/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.publicationState).toBe('registration_paused');
    const pausedEvent = await t.db
      .selectFrom('outbox_events')
      .select('payload')
      .where('event_type', '=', 'catalog.registration_paused')
      .where('aggregate_id', '=', id)
      .executeTakeFirstOrThrow();
    expect(pausedEvent.payload).toMatchObject({ reason: 'Coach shortage this week' });

    const resumed = await transition('registration/resume');
    expect(resumed.status).toBe(200);
    expect(resumed.body.publicationState).toBe('registration_open');
    expect((await transition('archive')).status).toBe(409);
    const closed = await transition('close', { reason: 'Season started' });
    expect(closed.status).toBe(200);
    expect(closed.body.publicationState).toBe('closed');
    expect((await t.http.get(`/v1/offerings/${id}`)).status).toBe(404);
    const editClosed = await t.http
      .patch(`/v1/offerings/${id}`)
      .set(pm)
      .set('Idempotency-Key', key())
      .send({ expectedRevision: closed.body.staff.revision, name: 'Too late' });
    expect(editClosed.status).toBe(409);
    const archived = await transition('archive');
    expect(archived.status).toBe(200);
    expect(archived.body.publicationState).toBe('archived');
    expect((await transition('close')).status).toBe(409);
    const audit = await t.db
      .selectFrom('audit_records')
      .select('action')
      .where('target_id', '=', id)
      .orderBy('occurred_at')
      .execute();
    expect(audit.map((a) => a.action)).toEqual([
      'catalog.offering_open_registration',
      'catalog.offering_pause_registration',
      'catalog.offering_resume_registration',
      'catalog.offering_close',
      'catalog.offering_archive',
    ]);
  });

  it('SPK-CAT-003: copying creates a draft with the configuration only, never prices or transactional data', async () => {
    const source = await createOfferingFixture(t, {
      responsibleManagerPersonId: managerPersonId,
      publicationState: 'registration_open',
      startsOn: '2027-01-10',
      endsOn: '2027-03-07',
      capacityUnits: [{ unit: 'seats', limit: 12 }],
    });
    await createOfferingSessionFixture(t, {
      offeringId: source.offeringId,
      scheduledStart: new Date('2027-01-10T17:00:00Z'),
      scheduledEnd: new Date('2027-01-10T18:00:00Z'),
    });
    await createOfferingSessionFixture(t, {
      offeringId: source.offeringId,
      scheduledStart: new Date('2027-01-17T17:00:00Z'),
      scheduledEnd: new Date('2027-01-17T18:00:00Z'),
      status: 'canceled',
    });
    const copied = await t.http
      .post(`/v1/offerings/${source.offeringId}/copy`)
      .set(pm)
      .set('Idempotency-Key', key())
      .send({ name: 'Spring term', startsOn: '2027-04-11', copySessions: true });
    expect(copied.status).toBe(201);
    expect(copied.body).toMatchObject({
      name: 'Spring term',
      publicationState: 'draft',
      startsOn: '2027-04-11',
      endsOn: '2027-06-06',
      programId: source.programId,
      eligibilityPolicyVersionId: source.eligibilityPolicyVersionId,
      cancellationPolicyVersionId: source.cancellationPolicyVersionId,
      entitlementDefinitionId: source.entitlementDefinitionId,
      requiredFormPolicyVersionIds: [source.formPolicyVersionId],
      capacity: [{ unit: 'seats', limit: 12 }],
      price: null,
      staff: { copiedFromOfferingId: source.offeringId, revision: 1, publishedAt: null },
    });
    const newId_ = copied.body.id as string;
    expect(new Date(copied.body.registrationOpensAt).getTime()).toBe(
      new Date(
        (await t.http.get(`/v1/offerings/${source.offeringId}`).set(pm)).body.registrationOpensAt,
      ).getTime() +
        91 * 86_400_000,
    );
    const sessions = await t.http.get(`/v1/offerings/${newId_}/sessions`).set(pm);
    expect(sessions.body).toHaveLength(1); // the canceled session is not copied
    expect(sessions.body[0]).toMatchObject({
      sequence: 1,
      scheduledStart: '2027-04-11T17:00:00.000Z',
      schedulingEventId: null,
      status: 'scheduled',
    });
    const prices = await t.http.get(`/v1/offerings/${newId_}/price-rules`).set(finance);
    expect(prices.body).toEqual([]);
    const event = await t.db
      .selectFrom('outbox_events')
      .select('payload')
      .where('event_type', '=', 'catalog.offering_copied')
      .where('aggregate_id', '=', newId_)
      .executeTakeFirstOrThrow();
    expect(event.payload).toMatchObject({ sourceOfferingId: source.offeringId });
    expect((event.payload as { copiedSessionIds: string[] }).copiedSessionIds).toHaveLength(1);
    // the source is untouched
    const sourceAfter = await t.http.get(`/v1/offerings/${source.offeringId}`).set(pm);
    expect(sourceAfter.body.publicationState).toBe('registration_open');
    expect(sourceAfter.body.staff.revision).toBe(1);
  });

  it('SPK-YOUTH-002: raising capacity that increases the staffing requirement needs an explicit reason', async () => {
    const fixture = await createOfferingFixture(t, {
      responsibleManagerPersonId: managerPersonId,
      kind: 'camp',
      publicationState: 'draft',
      capacityUnits: [
        {
          unit: 'camp_group_places',
          limit: 24,
          groupSize: 12,
          staffingRatio: { participantsPerStaff: 12 },
        },
      ],
    });
    const id = fixture.offeringId;
    const silent = await t.http
      .patch(`/v1/offerings/${id}`)
      .set(pm)
      .set('Idempotency-Key', key())
      .send({
        expectedRevision: 1,
        capacityUnits: [
          {
            unit: 'camp_group_places',
            limit: 36,
            groupSize: 12,
            staffingRatio: { participantsPerStaff: 12 },
          },
        ],
      });
    expect(silent.status).toBe(400);
    expect(silent.body.details).toMatchObject({ requiredStaffBefore: 2, requiredStaffAfter: 3 });
    const explicit = await t.http
      .patch(`/v1/offerings/${id}`)
      .set(pm)
      .set('Idempotency-Key', key())
      .send({
        expectedRevision: 1,
        reason: 'Third coach confirmed for the camp week',
        capacityUnits: [
          {
            unit: 'camp_group_places',
            limit: 36,
            groupSize: 12,
            staffingRatio: { participantsPerStaff: 12 },
          },
        ],
      });
    expect(explicit.status).toBe(200);
    expect(explicit.body.capacity).toEqual([{ unit: 'camp_group_places', limit: 36 }]);
    const event = await t.db
      .selectFrom('outbox_events')
      .select('payload')
      .where('event_type', '=', 'catalog.offering_updated')
      .where('aggregate_id', '=', id)
      .executeTakeFirstOrThrow();
    expect(event.payload).toMatchObject({
      capacityChange: {
        requiredStaffBefore: 2,
        requiredStaffAfter: 3,
        reason: 'Third coach confirmed for the camp week',
      },
    });
    // lowering capacity needs no reason; a camp unit without a ratio cannot be published
    const lowered = await t.http
      .patch(`/v1/offerings/${id}`)
      .set(pm)
      .set('Idempotency-Key', key())
      .send({ expectedRevision: 2, capacityUnits: [{ unit: 'camp_group_places', limit: 12 }] });
    expect(lowered.status).toBe(200);
    const publish = await t.http
      .post(`/v1/offerings/${id}/publish`)
      .set(pm)
      .set('Idempotency-Key', key())
      .send({});
    expect(publish.status).toBe(400);
    expect(publish.body.details.problems.map((p: { code: string }) => p.code)).toContain(
      'staffing_requirement_missing',
    );
  });

  it('§4.4 Session: sessions follow the offering lifecycle and their own cancellation', async () => {
    const fixture = await createOfferingFixture(t, {
      responsibleManagerPersonId: managerPersonId,
      publicationState: 'registration_open',
    });
    const id = fixture.offeringId;
    const session = await t.http
      .post(`/v1/offerings/${id}/sessions`)
      .set(scheduler)
      .set('Idempotency-Key', key())
      .send({
        scheduledStart: '2027-01-12T17:00:00Z',
        scheduledEnd: '2027-01-12T18:00:00Z',
        title: 'Week 1',
      });
    expect(session.status).toBe(201);
    expect(session.body).toMatchObject({ sequence: 1, status: 'scheduled', title: 'Week 1' });
    const dup = await t.http
      .post(`/v1/offerings/${id}/sessions`)
      .set(scheduler)
      .set('Idempotency-Key', key())
      .send({
        sequence: 1,
        scheduledStart: '2027-01-19T17:00:00Z',
        scheduledEnd: '2027-01-19T18:00:00Z',
      });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('RESOURCE_CONFLICT');
    expect(
      (
        await t.http
          .post(`/v1/offerings/${id}/sessions`)
          .set(frontDesk)
          .set('Idempotency-Key', key())
          .send({ scheduledStart: '2027-01-19T17:00:00Z', scheduledEnd: '2027-01-19T18:00:00Z' })
      ).status,
    ).toBe(403);
    const publicList = await t.http.get(`/v1/offerings/${id}/sessions`);
    expect(publicList.status).toBe(200);
    expect(publicList.body).toHaveLength(1);
    const canceled = await t.http
      .post(`/v1/sessions/${session.body.id}/cancel`)
      .set(pm)
      .set('Idempotency-Key', key())
      .send({ reason: 'Pitch flooded', expectedRevision: 1 });
    expect(canceled.status).toBe(200);
    expect(canceled.body).toMatchObject({
      status: 'canceled',
      cancelReason: 'Pitch flooded',
      revision: 2,
    });
    const twice = await t.http
      .post(`/v1/sessions/${session.body.id}/cancel`)
      .set(pm)
      .set('Idempotency-Key', key())
      .send({ reason: 'again' });
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe('INVALID_TRANSITION');
    await t.http.post(`/v1/offerings/${id}/close`).set(pm).set('Idempotency-Key', key()).send({});
    const afterClose = await t.http
      .post(`/v1/offerings/${id}/sessions`)
      .set(pm)
      .set('Idempotency-Key', key())
      .send({ scheduledStart: '2027-02-12T17:00:00Z', scheduledEnd: '2027-02-12T18:00:00Z' });
    expect(afterClose.status).toBe(409);
  });

  it('§4.3: offerings of another organization are not found for staff, customers and listings', async () => {
    const { seedOrganization } = await import('@sportspark/db');
    const other = await seedOrganization(t.db);
    const foreignStaff = await createStaffMemberFixture(t, {
      roles: ['program_manager'],
      organizationId: other.organizationId,
    });
    const foreign = await authHeaderForPerson(t, foreignStaff.personId);
    const mine = await createOfferingFixture(t, {
      responsibleManagerPersonId: managerPersonId,
      publicationState: 'registration_open',
    });
    expect((await t.http.get(`/v1/offerings/${mine.offeringId}`).set(foreign)).status).toBe(404);
    const patch = await t.http
      .patch(`/v1/offerings/${mine.offeringId}`)
      .set(foreign)
      .set('Idempotency-Key', key())
      .send({ expectedRevision: 1, name: 'Hijacked' });
    expect(patch.status).toBe(404);
    const publish = await t.http
      .post(`/v1/offerings/${mine.offeringId}/registration/pause`)
      .set(foreign)
      .set('Idempotency-Key', key())
      .send({});
    expect(publish.status).toBe(404);
    const otherSlug = (
      await t.db
        .selectFrom('organizations')
        .select('slug')
        .where('id', '=', other.organizationId)
        .executeTakeFirstOrThrow()
    ).slug;
    const listing = await t.http.get(`/v1/offerings?organization=${otherSlug}`);
    expect(listing.body.items).toEqual([]);
    expect((await t.http.get(`/v1/offerings?organization=${otherSlug}`).set(pm)).status).toBe(404);
  });

  it('OfferingLookupPort: a snapshot carries price, entitlement, policies, forms and the registration state', async () => {
    const fixture = await createOfferingFixture(t, {
      responsibleManagerPersonId: managerPersonId,
      publicationState: 'registration_open',
      basePriceMinor: 22_000,
    });
    const port = t.app.get<OfferingLookupPort>(OFFERING_LOOKUP_PORT);
    const snapshot = await port.getOffering(t.organizationId, fixture.offeringId, t.clock.now());
    expect(snapshot).not.toBeNull();
    expect(snapshot!.priceRule).toMatchObject({ basePriceMinor: 22_000, currency: 'USD' });
    expect(snapshot!.entitlementDefinition?.id).toBe(fixture.entitlementDefinitionId);
    expect(snapshot!.eligibilityPolicy?.id).toBe(fixture.eligibilityPolicyVersionId);
    expect(snapshot!.cancellationPolicy?.id).toBe(fixture.cancellationPolicyVersionId);
    expect(snapshot!.requiredForms.map((f) => f.id)).toEqual([fixture.formPolicyVersionId]);
    expect(snapshot!.eligibilityReferenceDate).toBe('2027-01-10');
    expect(snapshot!.registrationOpen).toBe(true);
    expect(snapshot!.capacityUnits).toEqual([{ unit: 'seats', limit: 20 }]);
    // before the window opened there was no price and registration was not open
    const earlier = await port.getOffering(
      t.organizationId,
      fixture.offeringId,
      new Date('2026-01-01T00:00:00Z'),
    );
    expect(earlier!.priceRule).toBeNull();
    expect(earlier!.registrationOpen).toBe(false);
    expect(await port.getOffering(newId(), fixture.offeringId, t.clock.now())).toBeNull();
    expect(await port.getOffering(t.organizationId, newId(), t.clock.now())).toBeNull();
  });
});
