import { newId, systemPrincipal } from '@sportspark/contracts';
import { seedOrganization } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnitOfWork } from '../../../kernel';
import type { TestApp } from '../../../testing';
import { createPolicyVersionFixture } from '../../catalog';
import {
  BASKET_PORT,
  ENROLLMENT_PORT,
  type BasketPort,
  type EnrollmentPort,
} from '../enrollment.ports';
import {
  acknowledge,
  adult,
  basketWith,
  child,
  enrollmentTestApp,
  key,
  offering,
  post,
  staff,
  type Actor,
} from './support';

describe('registration: applications, baskets, enrollments (SPK-REG-001..007/009, SPK-AT-001/004)', () => {
  let t: TestApp;
  let parent: Actor;
  let frontDesk: Actor;
  let programManager: Actor;
  let uow: UnitOfWork;
  let enrollmentPort: EnrollmentPort;
  let basketPort: BasketPort;

  beforeAll(async () => {
    t = await enrollmentTestApp();
    parent = await adult(t);
    frontDesk = await staff(t, ['front_desk']);
    programManager = await staff(t, ['program_manager']);
    uow = t.app.get(UnitOfWork);
    enrollmentPort = t.app.get(ENROLLMENT_PORT);
    basketPort = t.app.get(BASKET_PORT);
  });
  afterAll(async () => {
    await t.close();
  });

  it('SPK-REG-001/002: an eligible youth application is accepted with explainable, versioned eligibility', async () => {
    const setup = await offering(t);
    const kid = await child(t, [parent]);
    const res = await post(t, '/v1/applications', parent.header, {
      offeringId: setup.offeringId,
      participantPersonId: kid,
      intent: 'youth',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: 'accepted',
      intent: 'youth',
      participantPersonId: kid,
      payerPersonId: parent.personId,
      requiresApproval: false,
      eligibility: {
        eligible: true,
        policyVersionId: setup.eligibilityPolicyVersionId,
        referenceDate: '2027-01-10',
        overridden: false,
      },
    });
    // The outstanding form is a warning that names its policy and the next action (SPK-REG-009).
    expect(res.body.eligibility.reasons).toEqual([
      expect.objectContaining({
        code: 'acknowledgment_missing',
        severity: 'warning',
        source: { type: 'policy_version', id: setup.formPolicyVersionId },
        requiredAction: 'complete_acknowledgment',
      }),
    ]);
  });

  it('SPK-REG-002: a failed evaluation keeps understandable reasons and permitted alternatives', async () => {
    const setup = await offering(t);
    const teen = await child(t, [parent], { dateOfBirth: '2010-02-01' });
    const res = await post(t, '/v1/applications', parent.header, {
      offeringId: setup.offeringId,
      participantPersonId: teen,
      intent: 'youth',
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('submitted');
    expect(res.body.eligibility.eligible).toBe(false);
    const age = res.body.eligibility.reasons.find(
      (r: { code: string }) => r.code === 'above_maximum_age',
    );
    expect(age).toMatchObject({
      severity: 'blocking',
      requiredAction: 'choose_age_appropriate_offering',
    });
    expect(age.message).toContain('2027-01-10');
    expect(res.body.eligibility.alternatives.map((a: { kind: string }) => a.kind)).toEqual(
      expect.arrayContaining(['other_offering', 'contact_staff']),
    );
    // The age is evaluated from the date of birth against the reference date, never a stored age (§4.5).
    expect(res.body.eligibility.referenceDate).toBe('2027-01-10');
  });

  it('SPK-REG-002: an override needs specific authority and a reason, and is audited', async () => {
    const setup = await offering(t);
    const teen = await child(t, [parent], { dateOfBirth: '2010-02-01' });
    const created = await post(t, '/v1/applications', parent.header, {
      offeringId: setup.offeringId,
      participantPersonId: teen,
      intent: 'youth',
    });
    const id = created.body.id as string;
    const noReason = await post(
      t,
      `/v1/applications/${id}/override-eligibility`,
      programManager.header,
      {
        expectedRevision: 1,
      },
    );
    expect(noReason.status).toBe(400);
    const desk = await post(t, `/v1/applications/${id}/override-eligibility`, frontDesk.header, {
      expectedRevision: 1,
      reason: 'Guardian asked',
    });
    expect(desk.status).toBe(403);
    const byParent = await post(t, `/v1/applications/${id}/override-eligibility`, parent.header, {
      expectedRevision: 1,
      reason: 'Please',
    });
    expect(byParent.status).toBe(403);
    const ok = await post(t, `/v1/applications/${id}/override-eligibility`, programManager.header, {
      expectedRevision: 1,
      reason: 'Played up last season with coach approval',
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      status: 'accepted',
      revision: 2,
      eligibility: { eligible: true, overridden: true },
      override: {
        reason: 'Played up last season with coach approval',
        actorPersonId: programManager.personId,
      },
    });
    expect(ok.body.override.originalReasons.map((r: { code: string }) => r.code)).toContain(
      'above_maximum_age',
    );
    const audit = await t.db
      .selectFrom('audit_records')
      .selectAll()
      .where('target_id', '=', id)
      .where('action', '=', 'enrollment.override_eligibility')
      .executeTakeFirstOrThrow();
    expect(audit).toMatchObject({
      reason: 'Played up last season with coach approval',
      before_revision: 1,
      after_revision: 2,
    });
    // A second override from the accepted state is not a valid transition.
    const again = await post(
      t,
      `/v1/applications/${id}/override-eligibility`,
      programManager.header,
      {
        expectedRevision: 2,
        reason: 'again',
      },
    );
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('INVALID_TRANSITION');
  });

  it('§4.9: a stale expected revision fails instead of overwriting newer work', async () => {
    const setup = await offering(t);
    const teen = await child(t, [parent], { dateOfBirth: '2010-02-01' });
    const created = await post(t, '/v1/applications', parent.header, {
      offeringId: setup.offeringId,
      participantPersonId: teen,
      intent: 'youth',
    });
    const stale = await post(
      t,
      `/v1/applications/${created.body.id as string}/override-eligibility`,
      programManager.header,
      {
        expectedRevision: 7,
        reason: 'stale',
      },
    );
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({
      code: 'STALE_REVISION',
      details: { expectedRevision: 7, currentRevision: 1 },
    });
  });

  it('§4.7 invariant 1: no cross-household or cross-organization access', async () => {
    const setup = await offering(t);
    const kid = await child(t, [parent]);
    const stranger = await adult(t);
    const denied = await post(t, '/v1/applications', stranger.header, {
      offeringId: setup.offeringId,
      participantPersonId: kid,
      intent: 'youth',
    });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('PARTICIPANT_AUTHORITY_REQUIRED');
    const created = await post(t, '/v1/applications', parent.header, {
      offeringId: setup.offeringId,
      participantPersonId: kid,
      intent: 'youth',
    });
    const id = created.body.id as string;
    // Another household learns nothing about the record's existence (§4.10).
    const hidden = await t.http.get(`/v1/applications/${id}`).set(stranger.header);
    expect(hidden.status).toBe(404);
    expect(hidden.body.code).toBe('NOT_FOUND');
    const missing = await t.http.get(`/v1/applications/${newId()}`).set(stranger.header);
    expect(missing.body.message).toBe(hidden.body.message);
    // Staff of another organization see nothing either (organization scope comes from the token).
    const other = await seedOrganization(t.db);
    const foreignStaff = await staff(t, ['general_manager'], other.organizationId);
    expect((await t.http.get(`/v1/applications/${id}`).set(foreignStaff.header)).status).toBe(404);
    const foreignBasket = await post(t, '/v1/baskets', foreignStaff.header, {
      ownerPersonId: parent.personId,
    });
    expect(foreignBasket.status).toBe(404);
  });

  it('SPK-AT-001: a returning parent registers two children in one all-or-nothing basket', async () => {
    const setup = await offering(t, { basePriceMinor: 12_500 });
    const camp = await offering(t, { kind: 'camp', basePriceMinor: 30_000 });
    const first = await child(t, [parent]);
    const second = await child(t, [parent], { dateOfBirth: '2018-05-20' });
    await acknowledge(t, setup, first, parent.personId);
    await acknowledge(t, camp, second, parent.personId);
    const basket = await basketWith(t, parent, [
      { participantPersonId: first, offeringId: setup.offeringId },
      { participantPersonId: second, offeringId: camp.offeringId },
    ]);
    const lines = basket.body['lines'] as Array<Record<string, unknown>>;
    // SPK-REG-004: each line keeps its own participant, entitlement, eligibility, price and policy.
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      participantPersonId: first,
      entitlementDefinitionId: setup.entitlementDefinitionId,
      price: { basePriceMinor: 12_500, currency: 'USD', priceRuleId: setup.priceRuleId },
      policies: { cancellationPolicyVersionId: setup.cancellationPolicyVersionId },
      outcome: 'pending',
    });
    expect(lines[1]).toMatchObject({
      participantPersonId: second,
      price: { basePriceMinor: 30_000 },
    });
    expect(basket.body['subtotalMinor']).toBe(42_500);
    const held = await post(t, `/v1/baskets/${basket.id}/hold`, parent.header, {
      expectedRevision: basket.revision,
    });
    expect(held.status).toBe(200);
    expect(held.body.status).toBe('held');
    expect(held.body.holds).toHaveLength(2);
    expect(new Date(held.body.holdExpiresAt).getTime() - t.clock.now().getTime()).toBe(10 * 60_000);
    const enrollmentIds = held.body.lines.map((l: { enrollmentId: string }) => l.enrollmentId);
    // A priced basket finishes through the finance checkout, never by itself.
    const complete = await post(t, `/v1/baskets/${basket.id}/complete`, parent.header, {
      expectedRevision: held.body.revision,
    });
    expect(complete.status).toBe(409);
    expect(complete.body.details.code).toBe('PAYMENT_REQUIRED');
    // Finance confirms each enrollment after payment facts (§4.11 step 8) through EnrollmentPort.
    const finance = systemPrincipal(t.organizationId, 'finance.checkout');
    await uow.run(async ({ trx }) => {
      await basketPort.startCheckout(trx, t.organizationId, basket.id, 'order-1', finance);
      for (const id of enrollmentIds) {
        await enrollmentPort.confirmEnrollment(trx, t.organizationId, id, {
          actor: finance,
          orderRef: 'order-1',
        });
      }
      await basketPort.finishCheckout(trx, t.organizationId, basket.id, 'fulfilled', finance);
    });
    const listed = await t.http
      .get(`/v1/enrollments?participantPersonId=${first}`)
      .set(parent.header);
    expect(listed.body.items).toEqual([
      expect.objectContaining({
        status: 'confirmed',
        orderRef: 'order-1',
        payerPersonId: parent.personId,
      }),
    ]);
    const pools = await t.db
      .selectFrom('capacity_pools')
      .selectAll()
      .where('offering_id', '=', setup.offeringId)
      .execute();
    expect(pools).toEqual([expect.objectContaining({ committed: 1, held: 0, capacity: 20 })]);
    const finished = await t.http.get(`/v1/baskets/${basket.id}`).set(parent.header);
    expect(finished.body.status).toBe('fulfilled');
  });

  it('SPK-REG-004: all-or-nothing fails the whole basket; partial fulfillment needs explicit acceptance', async () => {
    const setup = await offering(t);
    const ok = await child(t, [parent]);
    const tooOld = await child(t, [parent], { dateOfBirth: '2009-01-01' });
    await acknowledge(t, setup, ok, parent.personId);
    await acknowledge(t, setup, tooOld, parent.personId);
    const strict = await basketWith(t, parent, [
      { participantPersonId: ok, offeringId: setup.offeringId },
      { participantPersonId: tooOld, offeringId: setup.offeringId },
    ]);
    const failed = await post(t, `/v1/baskets/${strict.id}/hold`, parent.header, {});
    expect(failed.status).toBe(422);
    expect(failed.body.code).toBe('ELIGIBILITY_FAILED');
    expect(
      await t.db.selectFrom('holds').select('id').where('basket_id', '=', strict.id).execute(),
    ).toEqual([]);
    expect(
      await t.db
        .selectFrom('enrollments')
        .select('id')
        .where('basket_id', '=', strict.id)
        .execute(),
    ).toEqual([]);
    const notAccepted = await post(t, '/v1/baskets', parent.header, { fulfillmentMode: 'partial' });
    expect(notAccepted.status).toBe(400);
    await post(t, `/v1/baskets/${strict.id}/release`, parent.header, { reason: 'retry partially' });
    const partial = await basketWith(
      t,
      parent,
      [
        { participantPersonId: ok, offeringId: setup.offeringId },
        { participantPersonId: tooOld, offeringId: setup.offeringId },
      ],
      { fulfillmentMode: 'partial' },
    );
    const held = await post(t, `/v1/baskets/${partial.id}/hold`, parent.header, {});
    expect(held.status).toBe(200);
    expect(held.body.lines.map((l: { outcome: string }) => l.outcome)).toEqual(['held', 'failed']);
    expect(held.body.lines[1].outcomeReason).toContain('ELIGIBILITY_FAILED');
    expect(held.body.holds).toHaveLength(1);
  });

  it('SPK-AT-004: a second guardian gets DUPLICATE_ENTITLEMENT and never learns the other payer', async () => {
    const setup = await offering(t);
    const otherGuardian = await adult(t);
    const kid = await child(t, [parent, otherGuardian]);
    await acknowledge(t, setup, kid, parent.personId);
    const basket = await basketWith(t, parent, [
      { participantPersonId: kid, offeringId: setup.offeringId },
    ]);
    expect((await post(t, `/v1/baskets/${basket.id}/hold`, parent.header, {})).status).toBe(200);
    const second = await post(t, '/v1/applications', otherGuardian.header, {
      offeringId: setup.offeringId,
      participantPersonId: kid,
      intent: 'youth',
    });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('DUPLICATE_ENTITLEMENT');
    expect(JSON.stringify(second.body)).not.toContain(parent.personId);
    const otherBasket = await post(t, '/v1/baskets', otherGuardian.header, {});
    const line = await post(
      t,
      `/v1/baskets/${otherBasket.body.id as string}/lines`,
      otherGuardian.header,
      {
        participantPersonId: kid,
        offeringId: setup.offeringId,
        intent: 'youth',
      },
    );
    expect(line.status).toBe(409);
    expect(line.body.code).toBe('DUPLICATE_ENTITLEMENT');
    // The other guardian may see the child's participation, but not who registered or pays for it.
    const seen = await t.http
      .get(`/v1/enrollments?participantPersonId=${kid}`)
      .set(otherGuardian.header);
    expect(seen.status).toBe(200);
    expect(seen.body.items).toHaveLength(1);
    expect(seen.body.items[0]).toMatchObject({
      payerPersonId: null,
      basketId: null,
      registeredBy: { personId: null },
    });
    expect(JSON.stringify(seen.body)).not.toContain(parent.personId);
  });

  it('§4.9: holding a basket replays on the same idempotency key and never doubles the holds', async () => {
    const setup = await offering(t);
    const kid = await child(t, [parent]);
    await acknowledge(t, setup, kid, parent.personId);
    const basket = await basketWith(t, parent, [
      { participantPersonId: kid, offeringId: setup.offeringId },
    ]);
    const k = key();
    const first = await t.http
      .post(`/v1/baskets/${basket.id}/hold`)
      .set(parent.header)
      .set('Idempotency-Key', k)
      .send({});
    const replay = await t.http
      .post(`/v1/baskets/${basket.id}/hold`)
      .set(parent.header)
      .set('Idempotency-Key', k)
      .send({});
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.holds).toEqual(first.body.holds);
    expect(
      await t.db.selectFrom('holds').select('id').where('basket_id', '=', basket.id).execute(),
    ).toHaveLength(1);
    const conflict = await t.http
      .post(`/v1/baskets/${basket.id}/hold`)
      .set(parent.header)
      .set('Idempotency-Key', k)
      .send({ reason: 'different payload' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('SPK-REG-009: assisted registration records the staff actor apart from participant, payer and signer', async () => {
    const setup = await offering(t);
    const kid = await child(t, [parent]);
    const basket = await basketWith(
      t,
      parent,
      [{ participantPersonId: kid, offeringId: setup.offeringId }],
      {
        header: frontDesk.header,
      },
    );
    expect(basket.body).toMatchObject({
      ownerPersonId: parent.personId,
      payerPersonId: parent.personId,
      assistedByPersonId: frontDesk.personId,
      createdBy: { kind: 'staff', personId: frontDesk.personId },
    });
    // Staff cannot stand in for the guardian's acknowledgment: the hold waits for the real signer.
    const unsigned = await post(t, `/v1/baskets/${basket.id}/hold`, frontDesk.header, {});
    expect(unsigned.status).toBe(422);
    expect(unsigned.body).toMatchObject({
      code: 'MISSING_ACKNOWLEDGMENT',
      details: { policyVersionIds: [setup.formPolicyVersionId] },
    });
    await acknowledge(t, setup, kid, parent.personId);
    const held = await post(t, `/v1/baskets/${basket.id}/hold`, frontDesk.header, {});
    expect(held.status).toBe(200);
    const enrollment = await t.http
      .get(`/v1/enrollments/${held.body.lines[0].enrollmentId as string}`)
      .set(frontDesk.header);
    expect(enrollment.body).toMatchObject({
      participantPersonId: kid,
      payerPersonId: parent.personId,
      assistedByPersonId: frontDesk.personId,
      registeredBy: { kind: 'staff', personId: frontDesk.personId },
      status: 'pending',
    });
    const signer = await t.db
      .selectFrom('acknowledgments')
      .select(['signed_by_person_id', 'subject_person_id'])
      .where('subject_person_id', '=', kid)
      .executeTakeFirstOrThrow();
    expect(signer).toEqual({ signed_by_person_id: parent.personId, subject_person_id: kid });
    // The parent reading the same record sees every fact (they are the payer).
    const own = await t.http
      .get(`/v1/enrollments/${held.body.lines[0].enrollmentId as string}`)
      .set(parent.header);
    expect(own.body.payerPersonId).toBe(parent.personId);
  });

  it('SPK-REG-007: human approval comes before payment capture and confirmation', async () => {
    const setup = await offering(t, { basePriceMinor: 0 });
    await createPolicyVersionFixture(t, {
      kind: 'approval',
      key: 'registration',
      content: { offeringIds: [setup.offeringId] },
    });
    const kid = await child(t, [parent]);
    await acknowledge(t, setup, kid, parent.personId);
    const basket = await basketWith(t, parent, [
      { participantPersonId: kid, offeringId: setup.offeringId },
    ]);
    expect(
      (basket.body['lines'] as Array<{ applicationStatus: string }>)[0]?.applicationStatus,
    ).toBe('awaiting_review');
    const held = await post(t, `/v1/baskets/${basket.id}/hold`, parent.header, {});
    expect(held.status).toBe(200);
    expect(held.body.approvalPending).toBe(true);
    const blocked = await post(t, `/v1/baskets/${basket.id}/complete`, parent.header, {});
    expect(blocked.status).toBe(409);
    expect(blocked.body.details.code).toBe('APPROVAL_PENDING');
    await expect(
      uow.run(({ trx }) => basketPort.assertPaymentPermitted(trx, t.organizationId, basket.id)),
    ).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT', details: { code: 'APPROVAL_PENDING' } });
    const applicationId = held.body.lines[0].applicationId as string;
    const byDesk = await post(t, `/v1/applications/${applicationId}/accept`, frontDesk.header, {
      expectedRevision: 1,
    });
    expect(byDesk.status).toBe(403);
    const accepted = await post(
      t,
      `/v1/applications/${applicationId}/accept`,
      programManager.header,
      {
        expectedRevision: 1,
      },
    );
    expect(accepted.status).toBe(200);
    expect(accepted.body.status).toBe('accepted');
    const completed = await post(t, `/v1/baskets/${basket.id}/complete`, parent.header, {});
    expect(completed.status).toBe(200);
    expect(completed.body.status).toBe('fulfilled');
    expect(completed.body.lines[0].outcome).toBe('confirmed');
  });

  it('ApplicationMachine: review routes, decline and withdraw follow the canonical lifecycle', async () => {
    const setup = await offering(t);
    await createPolicyVersionFixture(t, {
      kind: 'approval',
      key: 'registration',
      version: 2,
      content: { offeringIds: [setup.offeringId] },
    });
    const a = await child(t, [parent]);
    const b = await child(t, [parent]);
    const first = await post(t, '/v1/applications', parent.header, {
      offeringId: setup.offeringId,
      participantPersonId: a,
      intent: 'youth',
    });
    expect(first.body.status).toBe('awaiting_review');
    const declined = await post(
      t,
      `/v1/applications/${first.body.id as string}/decline`,
      programManager.header,
      {
        expectedRevision: 1,
        reason: 'Group is for returning players',
      },
    );
    expect(declined.body).toMatchObject({
      status: 'declined',
      decisionReason: 'Group is for returning players',
    });
    const second = await post(t, '/v1/applications', parent.header, {
      offeringId: setup.offeringId,
      participantPersonId: b,
      intent: 'youth',
    });
    const withdrawn = await post(
      t,
      `/v1/applications/${second.body.id as string}/withdraw`,
      parent.header,
      {},
    );
    expect(withdrawn.body.status).toBe('withdrawn');
    const late = await post(
      t,
      `/v1/applications/${second.body.id as string}/accept`,
      programManager.header,
      { expectedRevision: 2 },
    );
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('INVALID_TRANSITION');
    // A declined application no longer blocks a new one (one live application per participant).
    const again = await post(t, '/v1/applications', parent.header, {
      offeringId: setup.offeringId,
      participantPersonId: a,
      intent: 'youth',
    });
    expect(again.status).toBe(201);
  });

  it('SPK-REG-010: a cancellation is previewed before it is committed, then releases the place', async () => {
    const setup = await offering(t, {
      basePriceMinor: 0,
      capacityUnits: [{ unit: 'seats', limit: 3 }],
    });
    const kid = await child(t, [parent]);
    await acknowledge(t, setup, kid, parent.personId);
    const basket = await basketWith(t, parent, [
      { participantPersonId: kid, offeringId: setup.offeringId },
    ]);
    await post(t, `/v1/baskets/${basket.id}/hold`, parent.header, {});
    const done = await post(t, `/v1/baskets/${basket.id}/complete`, parent.header, {});
    const enrollmentId = done.body.lines[0].enrollmentId as string;
    const preview = await t.http
      .get(`/v1/enrollments/${enrollmentId}/cancellation-preview`)
      .set(parent.header);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      status: 'confirmed',
      permitted: true,
      requiredApproval: false,
      existing: { offeringId: setup.offeringId, startsOn: '2027-01-10' },
      affectedDates: { startsOn: '2027-01-10', endsOn: '2027-03-20' },
      cancellationPolicyVersionId: setup.cancellationPolicyVersionId,
      financialConsequence: { kind: 'none' },
    });
    expect(preview.body.capacity.released).toEqual([
      expect.objectContaining({ unit: 'seats', quantity: 1 }),
    ]);
    const stranger = await adult(t);
    expect(
      (
        await t.http
          .get(`/v1/enrollments/${enrollmentId}/cancellation-preview`)
          .set(stranger.header)
      ).status,
    ).toBe(404);
    const canceled = await post(t, `/v1/enrollments/${enrollmentId}/cancel`, parent.header, {
      expectedRevision: 2,
      reason: 'Schedule changed',
    });
    expect(canceled.status).toBe(200);
    expect(canceled.body).toMatchObject({
      status: 'canceled',
      cancellationReason: 'Schedule changed',
      cancellationPolicyVersionId: setup.cancellationPolicyVersionId,
      cancellationConsequence: { kind: 'none' },
    });
    const pools = await t.db
      .selectFrom('capacity_pools')
      .select(['committed', 'held'])
      .where('offering_id', '=', setup.offeringId)
      .execute();
    expect(pools).toEqual([{ committed: 0, held: 0 }]);
    const after = await t.http
      .get(`/v1/enrollments/${enrollmentId}/cancellation-preview`)
      .set(parent.header);
    expect(after.body).toMatchObject({ permitted: false, capacity: { released: [] } });
  });

  it('staff role matrix: scheduler and finance cannot register or review; readers cannot write', async () => {
    const setup = await offering(t);
    const kid = await child(t, [parent]);
    const scheduler = await staff(t, ['scheduler']);
    const finance = await staff(t, ['finance_operator']);
    const coach = await staff(t, ['coach']);
    expect(
      (await post(t, '/v1/baskets', scheduler.header, { ownerPersonId: parent.personId })).status,
    ).toBe(403);
    expect(
      (
        await post(t, '/v1/applications', finance.header, {
          offeringId: setup.offeringId,
          participantPersonId: kid,
          intent: 'youth',
        })
      ).status,
    ).toBe(403);
    const created = await post(t, '/v1/applications', frontDesk.header, {
      offeringId: setup.offeringId,
      participantPersonId: kid,
      intent: 'youth',
      payerPersonId: parent.personId,
    });
    expect(created.status).toBe(201);
    expect(
      (await t.http.get(`/v1/applications/${created.body.id as string}`).set(finance.header))
        .status,
    ).toBe(200);
    expect(
      (await t.http.get(`/v1/applications/${created.body.id as string}`).set(coach.header)).status,
    ).toBe(404);
    expect((await t.http.get('/v1/applications').set(scheduler.header)).status).toBe(200);
  });

  it('EnrollmentMachine: cancel releases capacity, complete ends a confirmed enrollment, terminal states stay', async () => {
    const setup = await offering(t, {
      basePriceMinor: 0,
      capacityUnits: [{ unit: 'seats', limit: 1 }],
    });
    const kid = await child(t, [parent]);
    await acknowledge(t, setup, kid, parent.personId);
    const basket = await basketWith(t, parent, [
      { participantPersonId: kid, offeringId: setup.offeringId },
    ]);
    await post(t, `/v1/baskets/${basket.id}/hold`, parent.header, {});
    const done = await post(t, `/v1/baskets/${basket.id}/complete`, parent.header, {});
    const enrollmentId = done.body.lines[0].enrollmentId as string;
    const completed = await post(
      t,
      `/v1/enrollments/${enrollmentId}/complete`,
      programManager.header,
      { expectedRevision: 2 },
    );
    expect(completed.status).toBe(200);
    expect(completed.body).toMatchObject({ status: 'completed', revision: 3 });
    const cancelLate = await post(t, `/v1/enrollments/${enrollmentId}/cancel`, parent.header, {
      expectedRevision: 3,
      reason: 'moved',
    });
    expect(cancelLate.status).toBe(409);
    expect(cancelLate.body.code).toBe('INVALID_TRANSITION');

    const other = await child(t, [parent]);
    await acknowledge(t, setup, other, parent.personId);
    const second = await basketWith(t, parent, [
      { participantPersonId: other, offeringId: setup.offeringId },
    ]);
    const full = await post(t, `/v1/baskets/${second.id}/hold`, parent.header, {});
    expect(full.status).toBe(409);
    expect(full.body).toMatchObject({
      code: 'CAPACITY_UNAVAILABLE',
      nextAction: 'join_waitlist_or_choose_alternative',
    });
  });
});
