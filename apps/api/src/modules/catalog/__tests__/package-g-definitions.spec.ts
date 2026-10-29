import { newId } from '@sportspark/contracts';
import { isCheckViolation, json, pgConstraintName } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../testing';
import {
  authHeaderForPerson,
  createOrganizationPeople,
  createStaffMemberFixture,
} from '../../identity';
import { seedPitchWithHalves } from '../../scheduling/testing/scheduling-fixtures';
import { CatalogModule } from '../catalog.module';
import { OFFERING_LOOKUP_PORT, type OfferingLookupPort } from '../catalog.ports';
import {
  createEntitlementDefinitionFixture,
  createOfferingFixture,
  createPolicyVersionFixture,
  createProgramFixture,
} from '../testing/catalog-fixtures';

const key = () => `k-${newId()}`;
type Auth = { Authorization: string };

/**
 * CAT-02 (§3.16, §6.5 Package G; SPK-CAT-002, SPK-COND-001 to SPK-COND-003): typed entitlement
 * scopes, booking terms and tax or fee policies, publication rules of Package G offerings and the
 * capability switches that gate their creation (DEC-016, DEC-072, DEC-074, DEC-076, DEC-077,
 * DEC-082). Values in these tests are test data; the catalog has no default for any of them.
 */
describe('Package G catalog definitions (CAT-02)', () => {
  let t: TestApp;
  let managerPersonId: string;
  let pm: Auth;
  let finance: Auth;
  let customer: Auth;
  let programId: string;
  let lookup: OfferingLookupPort;
  const actor = json({ kind: 'system', actorLabel: 'schema-test' });

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
    customer = await authHeaderForPerson(t, (await createOrganizationPeople(t)).adult.personId);
    programId = await createProgramFixture(t);
    lookup = t.app.get<OfferingLookupPort>(OFFERING_LOOKUP_PORT);
  });
  afterAll(async () => {
    await t.close();
  });

  const defineEntitlement = (kind: string, scope: unknown, auth: Auth = pm) =>
    t.http
      .post('/v1/entitlement-definitions')
      .set(auth)
      .set('Idempotency-Key', key())
      .send({ name: `${kind} ${newId().slice(-8)}`, kind, scope, equivalenceScope: 'none' });
  const issuePaths = (body: { details: Array<{ path: string }> }) =>
    body.details.map((d) => d.path);
  const insertDefinition = (kind: string, scope: unknown) =>
    t.db
      .insertInto('entitlement_definitions')
      .values({
        id: newId(),
        organization_id: t.organizationId,
        name: `raw ${newId()}`,
        description: null,
        kind: kind as 'seat',
        scope: json(scope as Record<string, unknown>),
        equivalence_scope: 'none',
        equivalence_rule: json({}),
        created_by: actor,
      })
      .execute();
  const rejectsWith = async (promise: Promise<unknown>, constraint: string) => {
    const error = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error, constraint).not.toBeNull();
    expect(isCheckViolation(error)).toBe(true);
    expect(pgConstraintName(error)).toBe(constraint);
  };

  it('SPK-COND-001: a membership benefit without an explicit attendance effect, term or renewal key is refused; unlimited is accepted only when stated', async () => {
    const term = { kind: 'offering_dates' };
    const renewal = { noticeLeadDays: null };
    const appliesTo = { programIds: [programId] };
    const missingAttendance = await defineEntitlement('membership_benefit', { term, renewal });
    expect(missingAttendance.status).toBe(400);
    expect(missingAttendance.body.code).toBe('VALIDATION_FAILED');
    expect(issuePaths(missingAttendance.body)).toContain('scope.attendance');
    const missingTerm = await defineEntitlement('membership_benefit', {
      attendance: { mode: 'none' },
      renewal,
    });
    expect(issuePaths(missingTerm.body)).toContain('scope.term');
    const missingRenewal = await defineEntitlement('membership_benefit', {
      attendance: { mode: 'none' },
      term,
    });
    expect(issuePaths(missingRenewal.body)).toContain('scope.renewal');
    // the renewal key is required even when no notice is sent
    expect(
      (
        await defineEntitlement('membership_benefit', {
          attendance: { mode: 'none' },
          term,
          renewal: {},
        })
      ).status,
    ).toBe(400);
    // unlimited is never implied: it must be stated, with what it applies to
    expect(
      (
        await defineEntitlement('membership_benefit', {
          attendance: { mode: 'unlimited' },
          term,
          renewal,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await defineEntitlement('membership_benefit', {
          attendance: { mode: 'unlimited', appliesTo: {} },
          term,
          renewal,
        })
      ).status,
    ).toBe(400);
    const unlimited = await defineEntitlement('membership_benefit', {
      attendance: { mode: 'unlimited', appliesTo },
      term: { kind: 'from_confirmation', lengthDays: 365 },
      renewal: { noticeLeadDays: 14 },
    });
    expect(unlimited.status).toBe(201);
    expect(unlimited.body.scope.attendance).toEqual({ mode: 'unlimited', appliesTo });
    // a weekly session limit names the day its week starts on
    const weekly = (limit: Record<string, unknown>) =>
      defineEntitlement('membership_benefit', {
        attendance: { mode: 'included_sessions', appliesTo, limit },
        term,
        renewal,
      });
    expect((await weekly({ count: 2, period: 'week' })).status).toBe(400);
    expect((await weekly({ count: 2, period: 'month', weekStartsOn: 1 })).status).toBe(400);
    expect((await weekly({ count: 0, period: 'month' })).status).toBe(400);
    const included = await weekly({ count: 2, period: 'week', weekStartsOn: 1 });
    expect(included.status).toBe(201);
    // an update cannot drop an effect either
    const dropped = await t.http
      .patch(`/v1/entitlement-definitions/${included.body.id as string}`)
      .set(pm)
      .set('Idempotency-Key', key())
      .send({ expectedRevision: 1, scope: { term, renewal } });
    expect(dropped.status).toBe(400);
    expect(issuePaths(dropped.body)).toContain('scope.attendance');

    // the database refuses a membership benefit that omits or invents an attendance effect
    await rejectsWith(
      insertDefinition('membership_benefit', { term, renewal }),
      'entitlement_definitions_membership_benefit_scope',
    );
    await rejectsWith(
      insertDefinition('membership_benefit', { attendance: { mode: 'everything' }, term, renewal }),
      'entitlement_definitions_membership_benefit_scope',
    );
    await rejectsWith(
      insertDefinition('membership_benefit', { attendance: { mode: 'none' }, term, renewal: {} }),
      'entitlement_definitions_membership_benefit_scope',
    );
  });

  it('SPK-COND-002: a package definition without credits or an expiry choice is refused', async () => {
    const appliesTo = { programIds: [programId] };
    const noCredits = await defineEntitlement('package_credits', {
      appliesTo,
      expiry: { kind: 'none' },
    });
    expect(noCredits.status).toBe(400);
    expect(issuePaths(noCredits.body)).toContain('scope.credits');
    const noExpiry = await defineEntitlement('package_credits', { credits: 10, appliesTo });
    expect(issuePaths(noExpiry.body)).toContain('scope.expiry');
    expect(
      (
        await defineEntitlement('package_credits', {
          credits: 10,
          appliesTo,
          expiry: { kind: 'days_after_issue' },
        })
      ).status,
    ).toBe(400);
    expect(
      (await defineEntitlement('package_credits', { credits: 10, expiry: { kind: 'none' } }))
        .status,
    ).toBe(400);
    const never = await defineEntitlement('package_credits', {
      credits: 10,
      appliesTo,
      expiry: { kind: 'none' },
    });
    expect(never.status).toBe(201);
    // §4.3: what a package applies to exists in this organization
    const unknown = await defineEntitlement('package_credits', {
      credits: 5,
      appliesTo: { offeringIds: [newId()] },
      expiry: { kind: 'fixed_date', date: '2027-06-30' },
    });
    expect(unknown.status).toBe(400);
    expect(issuePaths(unknown.body)).toContain('scope.appliesTo.offeringIds');
    const target = await createOfferingFixture(t, {
      responsibleManagerPersonId: managerPersonId,
      programId,
    });
    const dated = await defineEntitlement('package_credits', {
      credits: 5,
      appliesTo: { offeringIds: [target.offeringId] },
      expiry: { kind: 'fixed_date', date: '2027-06-30' },
    });
    expect(dated.status).toBe(201);

    await rejectsWith(
      insertDefinition('package_credits', { appliesTo, expiry: { kind: 'none' } }),
      'entitlement_definitions_package_credits_scope',
    );
    await rejectsWith(
      insertDefinition('package_credits', { credits: 0, appliesTo, expiry: { kind: 'none' } }),
      'entitlement_definitions_package_credits_scope',
    );
    await rejectsWith(
      insertDefinition('package_credits', { credits: 'many', appliesTo, expiry: { kind: 'none' } }),
      'entitlement_definitions_package_credits_scope',
    );
    await rejectsWith(
      insertDefinition('package_credits', { credits: 3, appliesTo }),
      'entitlement_definitions_package_credits_scope',
    );
  });

  it('SPK-COND-003: party and rental scopes state resources, staffing and equipment together', async () => {
    const resources = { resourceIds: [newId(), newId()], count: 1 };
    const staffing = [
      { kind: 'organizer', role: 'party_host', count: 1, qualifications: ['first_aid'] },
    ];
    const party = {
      durationMinutes: 120,
      guestLimit: 16,
      resources,
      staffing,
      equipmentAssetIds: [newId()],
    };
    expect((await defineEntitlement('party_package', party)).status).toBe(201);
    // the staffing list may be empty but is always stated
    expect((await defineEntitlement('party_package', { ...party, staffing: [] })).status).toBe(201);
    const { staffing: _omit, ...noStaffing } = party;
    expect(issuePaths((await defineEntitlement('party_package', noStaffing)).body)).toContain(
      'scope.staffing',
    );
    expect(
      (
        await defineEntitlement('party_package', {
          ...party,
          resources: { resourceIds: [newId()], count: 2 },
        })
      ).status,
    ).toBe(400);
    expect((await defineEntitlement('rental_resource', { resources, staffing: [] })).status).toBe(
      201,
    );
    expect((await defineEntitlement('rental_resource', { resources })).status).toBe(400);

    await rejectsWith(
      insertDefinition('party_package', { ...party, equipmentAssetIds: undefined }),
      'entitlement_definitions_party_package_scope',
    );
    await rejectsWith(
      insertDefinition('rental_resource', { resources }),
      'entitlement_definitions_rental_resource_scope',
    );
  });

  it('SPK-COND-001 to 003: the database refuses a scope whose mode states no real effect (migration 0209)', async () => {
    const appliesTo = { programIds: [programId] };
    const term = { kind: 'offering_dates' };
    const renewal = { noticeLeadDays: null };
    const membership = 'entitlement_definitions_membership_benefit_scope';
    // unlimited or included sessions with no stated scope, included sessions with no limit
    await rejectsWith(
      insertDefinition('membership_benefit', { attendance: { mode: 'unlimited' }, term, renewal }),
      membership,
    );
    await rejectsWith(
      insertDefinition('membership_benefit', {
        attendance: { mode: 'unlimited', appliesTo: { offeringIds: [] } },
        term,
        renewal,
      }),
      membership,
    );
    await rejectsWith(
      insertDefinition('membership_benefit', {
        attendance: { mode: 'included_sessions', appliesTo },
        term,
        renewal,
      }),
      membership,
    );
    await rejectsWith(
      insertDefinition('membership_benefit', {
        attendance: { mode: 'included_sessions', appliesTo, limit: { count: 2, period: 'week' } },
        term,
        renewal,
      }),
      membership,
    );
    await rejectsWith(
      insertDefinition('membership_benefit', {
        attendance: { mode: 'none' },
        term: { kind: 'from_confirmation' },
        renewal,
      }),
      membership,
    );
    await rejectsWith(
      insertDefinition('membership_benefit', {
        attendance: { mode: 'none' },
        term,
        renewal: { noticeLeadDays: 'soon' },
      }),
      membership,
    );
    // a complete included-sessions membership is accepted
    await insertDefinition('membership_benefit', {
      attendance: {
        mode: 'included_sessions',
        appliesTo,
        limit: { count: 2, period: 'week', weekStartsOn: 1 },
      },
      term: { kind: 'from_confirmation', lengthDays: 30 },
      renewal: { noticeLeadDays: 7 },
    });
    const credits = 'entitlement_definitions_package_credits_scope';
    await rejectsWith(
      insertDefinition('package_credits', {
        credits: 3,
        appliesTo,
        expiry: { kind: 'days_after_issue' },
      }),
      credits,
    );
    await rejectsWith(
      insertDefinition('package_credits', {
        credits: 3,
        appliesTo,
        expiry: { kind: 'fixed_date' },
      }),
      credits,
    );
    await rejectsWith(
      insertDefinition('package_credits', { credits: 1.5, appliesTo, expiry: { kind: 'none' } }),
      credits,
    );
    await rejectsWith(
      insertDefinition('package_credits', { credits: 3, appliesTo: {}, expiry: { kind: 'none' } }),
      credits,
    );
    await insertDefinition('package_credits', {
      credits: 3,
      appliesTo,
      expiry: { kind: 'days_after_issue', days: 90 },
    });
    const staffing = [{ kind: 'organizer', role: 'party_host', count: 1, qualifications: [] }];
    const party = {
      durationMinutes: 120,
      guestLimit: 16,
      resources: { resourceIds: [newId()], count: 1 },
      staffing,
      equipmentAssetIds: [],
    };
    const partyCheck = 'entitlement_definitions_party_package_scope';
    await rejectsWith(insertDefinition('party_package', { ...party, resources: {} }), partyCheck);
    await rejectsWith(
      insertDefinition('party_package', {
        ...party,
        resources: { resourceIds: [newId()], count: 2 },
      }),
      partyCheck,
    );
    await rejectsWith(
      insertDefinition('party_package', { ...party, staffing: [{ kind: 'organizer' }] }),
      partyCheck,
    );
    await insertDefinition('party_package', party);
    const rentalCheck = 'entitlement_definitions_rental_resource_scope';
    await rejectsWith(
      insertDefinition('rental_resource', { resources: { resourceIds: [] }, staffing: [] }),
      rentalCheck,
    );
    await rejectsWith(
      insertDefinition('rental_resource', {
        resources: { resourceIds: [newId()], count: 1 },
        staffing: [{ kind: 'supervisor', count: 1, qualifications: [] }],
      }),
      rentalCheck,
    );
  });

  it('CAT-02: booking terms and tax or fee contents are complete and approved by the finance operator', async () => {
    const draft = (kind: string, content: unknown, auth: Auth = pm) =>
      t.http
        .post('/v1/policy-versions')
        .set(auth)
        .set('Idempotency-Key', key())
        .send({
          kind,
          key: `${kind.replace('_', '-')}-${newId().slice(-8)}`,
          title: `${kind} terms`,
          content,
          effectiveFrom: '2026-10-01T00:00:00Z',
        });
    const terms = {
      confirmationMode: 'request',
      installmentPolicyKey: null,
      setupMinutes: 15,
      accessConditions: 'Indoor shoes only',
      hostResponsibilities: null,
    };
    const { confirmationMode: _c, ...noMode } = terms;
    expect((await draft('booking_terms', noMode)).status).toBe(400);
    const { hostResponsibilities: _h, ...noHost } = terms;
    expect((await draft('booking_terms', noHost)).status).toBe(400);
    expect((await draft('booking_terms', { ...terms, depositPercent: 50 })).status).toBe(400);
    const created = await draft('booking_terms', terms);
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    const approve = (auth: Auth) =>
      t.http
        .post(`/v1/policy-versions/${id}/approve`)
        .set(auth)
        .set('Idempotency-Key', key())
        .send({});
    expect((await approve(pm)).status).toBe(403);
    expect((await approve(finance)).status).toBe(200);

    // a tax or fee is a rate or an amount with its currency, never both, with an explicit rounding
    const tax = { code: 'sales', label: 'Sales tax', kind: 'tax', rounding: 'half_up' };
    expect((await draft('tax_fee', tax)).status).toBe(400);
    expect(
      (await draft('tax_fee', { ...tax, rateBasisPoints: 825, amountMinor: 100, currency: 'USD' }))
        .status,
    ).toBe(400);
    expect((await draft('tax_fee', { ...tax, amountMinor: 100 })).status).toBe(400);
    expect((await draft('tax_fee', { ...tax, rateBasisPoints: 825, rounding: 'up' })).status).toBe(
      400,
    );
    const { rounding: _r, ...noRounding } = tax;
    expect((await draft('tax_fee', { ...noRounding, rateBasisPoints: 825 })).status).toBe(400);
    expect((await draft('tax_fee', { ...tax, rateBasisPoints: 825 })).status).toBe(201);
    const fee = await draft('tax_fee', {
      ...tax,
      code: 'cleaning',
      kind: 'fee',
      amountMinor: 2500,
      currency: 'USD',
    });
    expect(fee.status).toBe(201);
    const feeApproval = await t.http
      .post(`/v1/policy-versions/${fee.body.id as string}/approve`)
      .set(pm)
      .set('Idempotency-Key', key())
      .send({});
    expect(feeApproval.status).toBe(403);

    // eligibility and cancellation content keep their own keys; only the Package G keys are checked
    expect((await draft('eligibility', { maxAgeYears: 9, membershipRequired: {} })).status).toBe(
      400,
    );
    expect(
      (
        await draft('eligibility', {
          maxAgeYears: 9,
          membershipRequired: { programIds: [programId] },
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await draft('cancellation', {
          text: 'x',
          packageCreditReturn: { untilMinutesBeforeStart: -1 },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await draft('cancellation', {
          text: 'x',
          packageCreditReturn: { untilMinutesBeforeStart: 1440 },
        })
      ).status,
    ).toBe(201);
    expect((await draft('waitlist', { anything: true })).status).toBe(201);
  });

  it('SPK-COND-003: a party offering cannot publish without a party package definition and approved booking terms', async () => {
    await t.enableCapability('parties');
    const seat = await createEntitlementDefinitionFixture(t, { kind: 'seat' });
    const offering = await createOfferingFixture(t, {
      responsibleManagerPersonId: managerPersonId,
      programId,
      kind: 'party',
      publicationState: 'draft',
      entitlementDefinitionId: seat,
      bookingTermsKey: null,
    });
    const id = offering.offeringId;
    const publish = () =>
      t.http.post(`/v1/offerings/${id}/publish`).set(pm).set('Idempotency-Key', key()).send({});
    const codes = (res: { body: { details: { problems: Array<{ code: string }> } } }) =>
      res.body.details.problems.map((p) => p.code);
    const bare = await publish();
    expect(bare.status).toBe(400);
    expect(codes(bare)).toEqual(['ENTITLEMENT_DEFINITION_REQUIRED', 'BOOKING_TERMS_REQUIRED']);

    // name the terms and a party package definition; the terms are still only a draft
    // a definition naming a resource that does not exist cannot publish (SPK-COND-003, §4.3)
    const ghost = await defineEntitlement('party_package', {
      durationMinutes: 90,
      guestLimit: 12,
      resources: { resourceIds: [newId()], count: 1 },
      staffing: [],
      equipmentAssetIds: [newId()],
    });
    expect(ghost.status).toBe(201);
    const pitch = await seedPitchWithHalves(t.db, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      name: `Party pitch ${newId()}`,
    });
    const party = await defineEntitlement('party_package', {
      durationMinutes: 90,
      guestLimit: 12,
      resources: { resourceIds: [pitch.pitchId], count: 1 },
      staffing: [{ kind: 'organizer', role: 'party_host', count: 1, qualifications: [] }],
      equipmentAssetIds: [],
    });
    expect(party.status).toBe(201);
    {
      const withGhost = await t.http
        .patch(`/v1/offerings/${id}`)
        .set(pm)
        .set('Idempotency-Key', key())
        .send({ expectedRevision: 1, entitlementDefinitionId: ghost.body.id });
      expect(withGhost.status).toBe(200);
      const check = await t.http.get(`/v1/offerings/${id}/publication-check`).set(pm);
      expect(check.body.problems.map((p: { code: string }) => p.code)).toEqual([
        'booking_resource_unknown',
        'booking_equipment_unknown',
        'BOOKING_TERMS_REQUIRED',
      ]);
    }
    const termsKey = `party-${newId().slice(-8)}`;
    const patched = await t.http
      .patch(`/v1/offerings/${id}`)
      .set(pm)
      .set('Idempotency-Key', key())
      .send({
        expectedRevision: 2,
        bookingTermsKey: termsKey,
        entitlementDefinitionId: party.body.id,
      });
    expect(patched.status).toBe(200);
    expect(patched.body.staff.bookingTermsKey).toBe(termsKey);
    const termsDraft = await t.http
      .post('/v1/policy-versions')
      .set(pm)
      .set('Idempotency-Key', key())
      .send({
        kind: 'booking_terms',
        key: termsKey,
        title: 'Party booking terms',
        content: {
          confirmationMode: 'instant',
          installmentPolicyKey: 'party-deposit',
          accessConditions: null,
          hostResponsibilities: 'An adult host stays for the whole party',
        },
        effectiveFrom: '2026-10-01T00:00:00Z',
      });
    expect(termsDraft.status).toBe(201);
    expect(codes(await publish())).toEqual(['BOOKING_TERMS_REQUIRED']);
    const check = await t.http.get(`/v1/offerings/${id}/publication-check`).set(pm);
    expect(check.body.problems.map((p: { code: string }) => p.code)).toEqual([
      'BOOKING_TERMS_REQUIRED',
    ]);

    // approved terms whose deposit plan is not approved still block publication
    expect(
      (
        await t.http
          .post(`/v1/policy-versions/${termsDraft.body.id as string}/approve`)
          .set(finance)
          .set('Idempotency-Key', key())
          .send({})
      ).status,
    ).toBe(200);
    expect(codes(await publish())).toEqual(['booking_terms_installment_policy_missing']);
    await createPolicyVersionFixture(t, {
      kind: 'installment',
      key: 'party-deposit',
      content: { installments: 2 },
    });
    const published = await publish();
    expect(published.status).toBe(200);
    expect(published.body.bookingTermsPolicyVersionId).toBe(termsDraft.body.id);

    // IF-23: the snapshot carries the approved terms and the typed party package scope
    const snapshot = await lookup.getOffering(t.organizationId, id, t.clock.now());
    expect(snapshot?.bookingTerms).toMatchObject({
      id: termsDraft.body.id,
      kind: 'booking_terms',
      content: { confirmationMode: 'instant', installmentPolicyKey: 'party-deposit' },
    });
    const definition = snapshot?.entitlementDefinition;
    expect(definition?.kind).toBe('party_package');
    if (definition?.kind === 'party_package') {
      expect(definition.scope.guestLimit).toBe(12);
      expect(definition.scope.staffing).toEqual([
        { kind: 'organizer', role: 'party_host', count: 1, qualifications: [] },
      ]);
    }
    // public views never show staffing (§4.14)
    await t.http
      .post(`/v1/offerings/${id}/registration/open`)
      .set(pm)
      .set('Idempotency-Key', key())
      .send({});
    for (const reader of [customer, null]) {
      const req = t.http.get(`/v1/offerings/${id}`);
      const res = reader ? await req.set(reader) : await req;
      expect(res.status).toBe(200);
      expect(res.body.staff).toBeNull();
      expect(res.body.bookingTermsPolicyVersionId).toBe(termsDraft.body.id);
      expect(JSON.stringify(res.body)).not.toMatch(/staffing|party_host/);
    }
    // a published party offering keeps its terms: removing them is refused
    const current = await t.db
      .selectFrom('offerings')
      .select('revision')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    const removed = await t.http
      .patch(`/v1/offerings/${id}`)
      .set(pm)
      .set('Idempotency-Key', key())
      .send({ expectedRevision: current.revision, bookingTermsKey: null });
    expect(removed.status).toBe(400);
    expect(removed.body.details.problems.map((p: { code: string }) => p.code)).toContain(
      'BOOKING_TERMS_REQUIRED',
    );

    // the database refuses a party or rental beyond draft without terms, and terms on other kinds
    await rejectsWith(
      t.db.updateTable('offerings').set({ booking_terms_key: null }).where('id', '=', id).execute(),
      'offerings_booking_terms_required',
    );
    const term = await createOfferingFixture(t, {
      responsibleManagerPersonId: managerPersonId,
      programId,
    });
    await rejectsWith(
      t.db
        .updateTable('offerings')
        .set({ booking_terms_key: 'party-terms' })
        .where('id', '=', term.offeringId)
        .execute(),
      'offerings_booking_terms_only_for_bookings',
    );
  });

  it('SPK-COND-003: a rental needs a rental resource definition and approved terms; other kinds refuse booking terms', async () => {
    await t.enableCapability('rentals');
    const rental = await createOfferingFixture(t, {
      responsibleManagerPersonId: managerPersonId,
      programId,
      kind: 'rental',
      publicationState: 'draft',
      entitlementDefinitionId: await createEntitlementDefinitionFixture(t, { kind: 'seat' }),
    });
    const res = await t.http
      .post(`/v1/offerings/${rental.offeringId}/publish`)
      .set(pm)
      .set('Idempotency-Key', key())
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.details.problems.map((p: { code: string }) => p.code)).toEqual([
      'ENTITLEMENT_DEFINITION_REQUIRED',
    ]);
    // the fixture's own rental (a rental resource definition and approved terms) publishes
    const ready = await createOfferingFixture(t, {
      responsibleManagerPersonId: managerPersonId,
      programId,
      kind: 'rental',
      publicationState: 'draft',
    });
    expect(
      (
        await t.http
          .post(`/v1/offerings/${ready.offeringId}/publish`)
          .set(pm)
          .set('Idempotency-Key', key())
          .send({})
      ).status,
    ).toBe(200);
    const termWithTerms = await t.http
      .post('/v1/offerings')
      .set(pm)
      .set('Idempotency-Key', key())
      .send({
        programId,
        name: 'Term with terms',
        kind: 'term',
        facilityId: t.facilityId,
        startsOn: '2027-01-10',
        endsOn: '2027-03-07',
        bookingTermsKey: 'rental-terms',
      });
    expect(termWithTerms.status).toBe(400);
    expect(termWithTerms.body.details).toMatchObject({ path: 'bookingTermsKey' });
  });

  it('SPK-COND-001/002: membership and package offerings publish only with their own definition kind', async () => {
    await t.enableCapability('memberships');
    await t.enableCapability('session_packages');
    for (const [kind, required] of [
      ['membership', 'membership_benefit'],
      ['package', 'package_credits'],
    ] as const) {
      const wrong = await createOfferingFixture(t, {
        responsibleManagerPersonId: managerPersonId,
        programId,
        kind,
        publicationState: 'draft',
        entitlementDefinitionId: await createEntitlementDefinitionFixture(t, { kind: 'seat' }),
      });
      const refused = await t.http
        .post(`/v1/offerings/${wrong.offeringId}/publish`)
        .set(pm)
        .set('Idempotency-Key', key())
        .send({});
      expect(refused.status, kind).toBe(400);
      expect(refused.body.details.problems[0]).toMatchObject({
        code: 'ENTITLEMENT_DEFINITION_REQUIRED',
        field: 'entitlementDefinitionId',
      });
      const right = await createOfferingFixture(t, {
        responsibleManagerPersonId: managerPersonId,
        programId,
        kind,
        publicationState: 'draft',
      });
      const snapshot = await lookup.getOffering(t.organizationId, right.offeringId, t.clock.now());
      expect(snapshot?.entitlementDefinition?.kind).toBe(required);
      expect(snapshot?.bookingTerms).toBeNull();
      expect(
        (
          await t.http
            .post(`/v1/offerings/${right.offeringId}/publish`)
            .set(pm)
            .set('Idempotency-Key', key())
            .send({})
        ).status,
        kind,
      ).toBe(200);
    }
  });

  it('DEC-016: creating, copying or publishing a gated offering kind needs its capability; archive and close stay ungated', async () => {
    const expected = {
      membership: ['memberships', 'DEC-072'],
      package: ['session_packages', 'DEC-074'],
      rental: ['rentals', 'DEC-076'],
      party: ['parties', 'DEC-077'],
      pickup: ['pickup_sessions', 'DEC-082'],
    } as const;
    for (const [capability] of Object.values(expected)) await t.disableCapability(capability);
    for (const [kind, [capability, decision]] of Object.entries(expected)) {
      const res = await t.http
        .post('/v1/offerings')
        .set(pm)
        .set('Idempotency-Key', key())
        .send({
          programId,
          name: `Gated ${kind}`,
          kind,
          facilityId: t.facilityId,
          startsOn: '2027-01-10',
          endsOn: '2027-03-07',
        });
      expect(res.status, kind).toBe(403);
      expect(res.body.details).toMatchObject({
        code: 'CAPABILITY_DISABLED',
        capability,
        applicabilityReferences: ['DEC-016', decision],
      });
    }
    // ungated kinds are unaffected
    expect(
      (
        await t.http.post('/v1/offerings').set(pm).set('Idempotency-Key', key()).send({
          programId,
          name: 'Ungated camp',
          kind: 'camp',
          facilityId: t.facilityId,
          startsOn: '2027-01-10',
          endsOn: '2027-01-14',
        })
      ).status,
    ).toBe(201);

    // offerings that already exist (fixtures are never gated): copy and publish are refused
    const draftParty = await createOfferingFixture(t, {
      responsibleManagerPersonId: managerPersonId,
      programId,
      kind: 'party',
      publicationState: 'draft',
    });
    const copy = await t.http
      .post(`/v1/offerings/${draftParty.offeringId}/copy`)
      .set(pm)
      .set('Idempotency-Key', key())
      .send({});
    expect(copy.status).toBe(403);
    expect(copy.body.details).toMatchObject({ code: 'CAPABILITY_DISABLED', capability: 'parties' });
    const publish = await t.http
      .post(`/v1/offerings/${draftParty.offeringId}/publish`)
      .set(pm)
      .set('Idempotency-Key', key())
      .send({});
    expect(publish.status).toBe(403);
    expect(publish.body.details).toMatchObject({ code: 'CAPABILITY_DISABLED' });
    const check = await t.http
      .get(`/v1/offerings/${draftParty.offeringId}/publication-check`)
      .set(pm);
    expect(check.body).toMatchObject({
      publishable: false,
      problems: [expect.objectContaining({ code: 'capability_disabled', field: 'kind' })],
    });
    // archive (from draft) and close (a published one) never need the switch
    expect(
      (
        await t.http
          .post(`/v1/offerings/${draftParty.offeringId}/archive`)
          .set(pm)
          .set('Idempotency-Key', key())
          .send({})
      ).status,
    ).toBe(200);
    const openParty = await createOfferingFixture(t, {
      responsibleManagerPersonId: managerPersonId,
      programId,
      kind: 'party',
    });
    expect(
      (
        await t.http
          .post(`/v1/offerings/${openParty.offeringId}/close`)
          .set(pm)
          .set('Idempotency-Key', key())
          .send({ reason: 'Season over' })
      ).status,
    ).toBe(200);
    // nothing of the refused commands was recorded
    const copies = await t.db
      .selectFrom('offerings')
      .select('id')
      .where('copied_from_offering_id', '=', draftParty.offeringId)
      .execute();
    expect(copies).toEqual([]);

    // an administrator's switch (the fixture writes it here) lets the same commands through
    await t.enableCapability('parties');
    const allowed = await t.http
      .post(`/v1/offerings/${openParty.offeringId}/copy`)
      .set(pm)
      .set('Idempotency-Key', key())
      .send({});
    expect(allowed.status).toBe(201);
    expect(allowed.body.staff.bookingTermsKey).toBe(openParty.bookingTermsKey);
    await t.enableCapability('pickup_sessions');
  });
});
