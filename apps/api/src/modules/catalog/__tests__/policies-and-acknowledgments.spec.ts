import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../testing';
import {
  authHeaderForPerson,
  createAccountFixture,
  createOrganizationPeople,
  createPersonFixture,
  createStaffMemberFixture,
} from '../../identity';
import { CatalogModule } from '../catalog.module';
import { POLICY_PORT, type PolicyPort } from '../catalog.ports';
import { createPolicyVersionFixture } from '../testing/catalog-fixtures';

const key = () => `k-${newId()}`;

describe('policy versions and acknowledgments (§4.4 Policies, SPK-REG-002, SPK-REG-009, SPK-PAY-003)', () => {
  let t: TestApp;
  let pm: { Authorization: string };
  let league: { Authorization: string };
  let finance: { Authorization: string };
  let frontDesk: { Authorization: string; personId: string };
  let port: PolicyPort;

  beforeAll(async () => {
    t = await createTestApp({
      imports: [CatalogModule],
      principalResolver: 'module',
      clockStart: '2026-10-23T12:00:00Z',
    });
    pm = await authHeaderForPerson(
      t,
      (await createStaffMemberFixture(t, { roles: ['program_manager'] })).personId,
    );
    league = await authHeaderForPerson(
      t,
      (await createStaffMemberFixture(t, { roles: ['league_manager'] })).personId,
    );
    finance = await authHeaderForPerson(
      t,
      (await createStaffMemberFixture(t, { roles: ['finance_operator'] })).personId,
    );
    const desk = await createStaffMemberFixture(t, { roles: ['front_desk'] });
    frontDesk = { ...(await authHeaderForPerson(t, desk.personId)), personId: desk.personId };
    port = t.app.get<PolicyPort>(POLICY_PORT);
  });
  afterAll(async () => {
    await t.close();
  });

  const createVersion = (auth: { Authorization: string }, body: Record<string, unknown>) =>
    t.http
      .post('/v1/policy-versions')
      .set(auth)
      .set('Idempotency-Key', key())
      .send({
        title: 'Policy',
        content: { text: 'wording' },
        effectiveFrom: '2026-11-01T00:00:00Z',
        ...body,
      });

  it('SPK-REG-002: versions of a policy family are numbered; approval is per kind and retires nothing automatically', async () => {
    const familyKey = `youth-eligibility-${newId().slice(-6)}`;
    const v1 = await createVersion(pm, {
      kind: 'eligibility',
      key: familyKey,
      content: { maxAgeYears: 12 },
    });
    expect(v1.status).toBe(201);
    expect(v1.body).toMatchObject({
      kind: 'eligibility',
      key: familyKey,
      version: 1,
      approvalStatus: 'draft',
    });
    const v2 = await createVersion(pm, {
      kind: 'eligibility',
      key: familyKey,
      content: { maxAgeYears: 13 },
      effectiveFrom: '2027-01-01T00:00:00Z',
    });
    expect(v2.body.version).toBe(2);

    // the wrong role for the kind is denied; the right one records an approval fact
    const financeTry = await t.http
      .post(`/v1/policy-versions/${v1.body.id}/approve`)
      .set(finance)
      .set('Idempotency-Key', key())
      .send({});
    expect(financeTry.status).toBe(403);
    expect(
      (
        await t.http
          .post(`/v1/policy-versions/${v1.body.id}/approve`)
          .set(frontDesk)
          .set('Idempotency-Key', key())
          .send({})
      ).status,
    ).toBe(403);
    const approved = await t.http
      .post(`/v1/policy-versions/${v1.body.id}/approve`)
      .set(league)
      .set('Idempotency-Key', key())
      .send({ reason: 'Board decision 2026-10' });
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ approvalStatus: 'approved', revision: 2 });
    expect(approved.body.approvedAt).not.toBeNull();
    const approvals = await t.http
      .get(`/v1/policy-versions/${v1.body.id}/approvals`)
      .set(frontDesk);
    expect(approvals.body).toHaveLength(1);
    expect(approvals.body[0]).toMatchObject({
      decision: 'approved',
      reason: 'Board decision 2026-10',
    });
    const event = await t.db
      .selectFrom('outbox_events')
      .select('payload')
      .where('event_type', '=', 'catalog.policy_version_approved')
      .where('aggregate_id', '=', v1.body.id)
      .executeTakeFirstOrThrow();
    expect(event.payload).toMatchObject({ kind: 'eligibility', key: familyKey, version: 1 });

    // approving v2 leaves v1 approved; the current version depends on the instant
    const approvedV2 = await t.http
      .post(`/v1/policy-versions/${v2.body.id}/approve`)
      .set(pm)
      .set('Idempotency-Key', key())
      .send({});
    expect(approvedV2.status).toBe(200);
    expect(
      (await t.http.get(`/v1/policy-versions/${v1.body.id}`).set(pm)).body.approvalStatus,
    ).toBe('approved');
    expect(
      (
        await port.currentPolicyVersion(
          t.organizationId,
          'eligibility',
          familyKey,
          new Date('2026-12-01T00:00:00Z'),
        )
      )?.version,
    ).toBe(1);
    expect(
      (
        await port.currentPolicyVersion(
          t.organizationId,
          'eligibility',
          familyKey,
          new Date('2027-02-01T00:00:00Z'),
        )
      )?.version,
    ).toBe(2);
    expect(
      await port.currentPolicyVersion(
        t.organizationId,
        'eligibility',
        familyKey,
        new Date('2026-10-01T00:00:00Z'),
      ),
    ).toBeNull();

    // retiring is explicit; a retired version is final and never current
    const retired = await t.http
      .post(`/v1/policy-versions/${v1.body.id}/retire`)
      .set(pm)
      .set('Idempotency-Key', key())
      .send({ reason: 'Replaced by version 2', expectedRevision: 2 });
    expect(retired.status).toBe(200);
    expect(retired.body).toMatchObject({
      approvalStatus: 'retired',
      retiredReason: 'Replaced by version 2',
    });
    expect(
      await port.currentPolicyVersion(
        t.organizationId,
        'eligibility',
        familyKey,
        new Date('2026-12-01T00:00:00Z'),
      ),
    ).toBeNull();
    const retireAgain = await t.http
      .post(`/v1/policy-versions/${v1.body.id}/retire`)
      .set(pm)
      .set('Idempotency-Key', key())
      .send({ reason: 'twice' });
    expect(retireAgain.status).toBe(409);
    expect(retireAgain.body.code).toBe('INVALID_TRANSITION');
    const approveRetired = await t.http
      .post(`/v1/policy-versions/${v1.body.id}/approve`)
      .set(pm)
      .set('Idempotency-Key', key())
      .send({});
    expect(approveRetired.status).toBe(409);
    const stale = await t.http
      .post(`/v1/policy-versions/${v2.body.id}/retire`)
      .set(pm)
      .set('Idempotency-Key', key())
      .send({ reason: 'x', expectedRevision: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVISION');
    const listed = await t.http
      .get(`/v1/policy-versions?kind=eligibility&key=${familyKey}`)
      .set(frontDesk);
    expect(listed.body.items.map((p: { version: number }) => p.version)).toEqual([1, 2]);
  });

  it('SPK-PAY-002 / §4.4: retiring a version may shorten its approved window from now on, never extend or backdate it', async () => {
    // approved window [2026-10-22, 2026-12-31); the clock is 2026-10-23T12:00Z
    const id = await createPolicyVersionFixture(t, {
      kind: 'eligibility',
      effectiveTo: new Date('2026-12-31T00:00:00Z'),
    });
    const retire = (effectiveTo: string) =>
      t.http
        .post(`/v1/policy-versions/${id}/retire`)
        .set(pm)
        .set('Idempotency-Key', key())
        .send({ reason: 'Superseded', expectedRevision: 1, effectiveTo });
    const extended = await retire('2030-01-01T00:00:00Z');
    expect(extended.status).toBe(400);
    expect(extended.body.details).toMatchObject({ path: 'effectiveTo' });
    const backdated = await retire('2026-10-23T00:00:00Z');
    expect(backdated.status).toBe(400);
    expect(backdated.body.details).toMatchObject({ path: 'effectiveTo' });
    const stored = await t.db
      .selectFrom('policy_versions')
      .select(['approval_status', 'effective_to'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(stored.approval_status).toBe('approved');
    expect(new Date(stored.effective_to as Date).toISOString()).toBe('2026-12-31T00:00:00.000Z');
    const shortened = await retire('2026-11-30T00:00:00Z');
    expect(shortened.status).toBe(200);
    expect(shortened.body).toMatchObject({
      approvalStatus: 'retired',
      effectiveTo: '2026-11-30T00:00:00.000Z',
    });
  });

  it('SPK-PAY-003: financial policy kinds are approved by the finance operator only', async () => {
    const draft = await createVersion(finance, {
      kind: 'discount',
      key: 'sibling-rules',
      content: { stacking: 'exclusive' },
    });
    expect(draft.status).toBe(201);
    expect(
      (
        await t.http
          .post(`/v1/policy-versions/${draft.body.id}/approve`)
          .set(pm)
          .set('Idempotency-Key', key())
          .send({})
      ).status,
    ).toBe(403);
    expect(
      (
        await t.http
          .post(`/v1/policy-versions/${draft.body.id}/approve`)
          .set(league)
          .set('Idempotency-Key', key())
          .send({})
      ).status,
    ).toBe(403);
    const ok = await t.http
      .post(`/v1/policy-versions/${draft.body.id}/approve`)
      .set(finance)
      .set('Idempotency-Key', key())
      .send({});
    expect(ok.status).toBe(200);
    for (const kind of ['cancellation', 'refund', 'overpayment', 'installment']) {
      const v = await createVersion(pm, { kind, key: `fin-${kind}` });
      expect(
        (
          await t.http
            .post(`/v1/policy-versions/${v.body.id}/approve`)
            .set(pm)
            .set('Idempotency-Key', key())
            .send({})
        ).status,
      ).toBe(403);
      expect(
        (
          await t.http
            .post(`/v1/policy-versions/${v.body.id}/approve`)
            .set(finance)
            .set('Idempotency-Key', key())
            .send({})
        ).status,
      ).toBe(200);
    }
    for (const kind of ['waitlist', 'hold', 'approval', 'form']) {
      const v = await createVersion(league, { kind, key: `part-${kind}` });
      expect(
        (
          await t.http
            .post(`/v1/policy-versions/${v.body.id}/approve`)
            .set(finance)
            .set('Idempotency-Key', key())
            .send({})
        ).status,
      ).toBe(403);
      expect(
        (
          await t.http
            .post(`/v1/policy-versions/${v.body.id}/approve`)
            .set(pm)
            .set('Idempotency-Key', key())
            .send({})
        ).status,
      ).toBe(200);
    }
    expect((await createVersion(frontDesk, { kind: 'hold', key: 'desk' })).status).toBe(403);
  });

  it('§4.14: customers read approved wording but never drafts', async () => {
    const people = await createOrganizationPeople(t);
    const customer = await authHeaderForPerson(t, people.adult.personId);
    const approved = await createPolicyVersionFixture(t, { kind: 'form' });
    const draft = await createPolicyVersionFixture(t, { kind: 'form', approved: false });
    expect((await t.http.get(`/v1/policy-versions/${approved}`).set(customer)).status).toBe(200);
    expect((await t.http.get(`/v1/policy-versions/${draft}`).set(customer)).status).toBe(403);
    expect((await t.http.get(`/v1/policy-versions/${draft}`).set(frontDesk)).status).toBe(200);
    expect((await t.http.get('/v1/policy-versions').set(customer)).status).toBe(403);
  });

  describe('acknowledgments (SPK-REG-009, POL-037)', () => {
    it('an adult acknowledges for themselves; a guardian holding complete_forms acknowledges for a child', async () => {
      const people = await createOrganizationPeople(t, {
        guardianPermissions: ['view', 'register', 'complete_forms'],
      });
      const guardian = await authHeaderForPerson(t, people.adult.personId);
      const form = await createPolicyVersionFixture(t, {
        kind: 'form',
        key: `waiver-${newId().slice(-6)}`,
      });

      const self = await t.http
        .post('/v1/acknowledgments')
        .set(guardian)
        .set('Idempotency-Key', key())
        .send({
          subjectPersonId: people.adult.personId,
          policyVersionId: form,
          evidence: { channel: 'app' },
        });
      expect(self.status).toBe(201);
      expect(self.body).toMatchObject({
        basis: 'self',
        signedByPersonId: people.adult.personId,
        recordedByKind: 'customer',
        recordedByPersonId: null,
        status: 'active',
      });

      const forChild = await t.http
        .post('/v1/acknowledgments')
        .set(guardian)
        .set('Idempotency-Key', key())
        .send({ subjectPersonId: people.child.personId, policyVersionId: form });
      expect(forChild.status).toBe(201);
      expect(forChild.body).toMatchObject({
        basis: 'guardian',
        signedByPersonId: people.adult.personId,
      });
      expect(await port.hasAcknowledgment(t.organizationId, people.child.personId, form)).toBe(
        true,
      );

      const duplicate = await t.http
        .post('/v1/acknowledgments')
        .set(guardian)
        .set('Idempotency-Key', key())
        .send({ subjectPersonId: people.child.personId, policyVersionId: form });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.code).toBe('RESOURCE_CONFLICT');

      // a customer never records somebody else's signature
      const impersonate = await t.http
        .post('/v1/acknowledgments')
        .set(guardian)
        .set('Idempotency-Key', key())
        .send({
          subjectPersonId: people.child.personId,
          policyVersionId: form,
          signedByPersonId: people.child.personId,
        });
      expect(impersonate.status).toBe(400);

      // withdrawal by the signer; the next acknowledgment is a new record
      const withdrawn = await t.http
        .post(`/v1/acknowledgments/${forChild.body.id}/withdraw`)
        .set(guardian)
        .set('Idempotency-Key', key())
        .send({ reason: 'Signed the wrong child' });
      expect(withdrawn.status).toBe(200);
      expect(withdrawn.body).toMatchObject({
        status: 'withdrawn',
        withdrawnReason: 'Signed the wrong child',
        revision: 2,
      });
      expect(await port.hasAcknowledgment(t.organizationId, people.child.personId, form)).toBe(
        false,
      );
      const again = await t.http
        .post('/v1/acknowledgments')
        .set(guardian)
        .set('Idempotency-Key', key())
        .send({ subjectPersonId: people.child.personId, policyVersionId: form });
      expect(again.status).toBe(201);
      expect(again.body.id).not.toBe(forChild.body.id);
      const list = await t.http
        .get(`/v1/acknowledgments?subjectPersonId=${people.child.personId}&includeWithdrawn=true`)
        .set(guardian);
      expect(list.body.map((a: { status: string }) => a.status).sort()).toEqual([
        'active',
        'withdrawn',
      ]);
      const events = await t.db
        .selectFrom('outbox_events')
        .select(['event_type', 'payload'])
        .where('aggregate_id', '=', forChild.body.id)
        .execute();
      expect(events.map((e) => e.event_type).sort()).toEqual([
        'catalog.acknowledgment_recorded',
        'catalog.acknowledgment_withdrawn',
      ]);
      expect(
        events.find((e) => e.event_type === 'catalog.acknowledgment_recorded')?.payload,
      ).toMatchObject({
        basis: 'guardian',
        assistedByStaff: false,
      });
    });

    it('SPK-IAM-003: without complete_forms the record is not found; a stranger sees nothing; a child cannot self-sign', async () => {
      const people = await createOrganizationPeople(t, {
        guardianPermissions: ['view', 'register'],
      });
      const guardian = await authHeaderForPerson(t, people.adult.personId);
      const form = await createPolicyVersionFixture(t, { kind: 'form' });
      const denied = await t.http
        .post('/v1/acknowledgments')
        .set(guardian)
        .set('Idempotency-Key', key())
        .send({ subjectPersonId: people.child.personId, policyVersionId: form });
      expect(denied.status).toBe(404);
      expect(denied.body.code).toBe('NOT_FOUND');
      const stranger = await createOrganizationPeople(t);
      const strangerAuth = await authHeaderForPerson(t, stranger.adult.personId);
      const foreign = await t.http
        .post('/v1/acknowledgments')
        .set(strangerAuth)
        .set('Idempotency-Key', key())
        .send({ subjectPersonId: people.child.personId, policyVersionId: form });
      expect(foreign.status).toBe(404);
      expect(
        (
          await t.http
            .get(`/v1/acknowledgments?subjectPersonId=${people.child.personId}`)
            .set(strangerAuth)
        ).status,
      ).toBe(404);
      expect(
        (
          await t.http
            .get(`/v1/acknowledgments?subjectPersonId=${people.child.personId}`)
            .set(guardian)
        ).status,
      ).toBe(200);
      // a child with their own account cannot acknowledge for themselves
      const childAccount = await createAccountFixture(t, { personId: people.child.personId });
      const childAuth = {
        Authorization: `Bearer ${await t.identityProvider.mint({ subject: childAccount.subject })}`,
      };
      const childSelf = await t.http
        .post('/v1/acknowledgments')
        .set(childAuth)
        .set('Idempotency-Key', key())
        .send({ subjectPersonId: people.child.personId, policyVersionId: form });
      expect(childSelf.status).toBe(403);
      expect(childSelf.body.code).toBe('PARTICIPANT_AUTHORITY_REQUIRED');
      // only approved wording can be acknowledged
      const draft = await createPolicyVersionFixture(t, { kind: 'form', approved: false });
      const unapproved = await t.http
        .post('/v1/acknowledgments')
        .set(guardian)
        .set('Idempotency-Key', key())
        .send({ subjectPersonId: people.adult.personId, policyVersionId: draft });
      expect(unapproved.status).toBe(400);
    });

    it('SPK-REG-009: staff record the guardian as signer and themselves as the actor; staff can never be the signer', async () => {
      const people = await createOrganizationPeople(t, {
        guardianPermissions: ['view', 'complete_forms'],
      });
      const form = await createPolicyVersionFixture(t, { kind: 'form' });
      const assisted = await t.http
        .post('/v1/acknowledgments')
        .set(frontDesk)
        .set('Idempotency-Key', key())
        .send({
          subjectPersonId: people.child.personId,
          policyVersionId: form,
          signedByPersonId: people.adult.personId,
          evidence: { channel: 'desk_tablet' },
        });
      expect(assisted.status).toBe(201);
      expect(assisted.body).toMatchObject({
        basis: 'guardian',
        signedByPersonId: people.adult.personId,
        recordedByKind: 'staff',
        recordedByPersonId: frontDesk.personId,
      });
      const event = await t.db
        .selectFrom('outbox_events')
        .select('payload')
        .where('event_type', '=', 'catalog.acknowledgment_recorded')
        .where('aggregate_id', '=', assisted.body.id)
        .executeTakeFirstOrThrow();
      expect(event.payload).toMatchObject({
        assistedByStaff: true,
        signedByPersonId: people.adult.personId,
      });

      const other = await createPersonFixture(t, { kind: 'child' });
      const staffAsSigner = await t.http
        .post('/v1/acknowledgments')
        .set(frontDesk)
        .set('Idempotency-Key', key())
        .send({
          subjectPersonId: other,
          policyVersionId: form,
          signedByPersonId: frontDesk.personId,
        });
      expect(staffAsSigner.status).toBe(403);
      expect(staffAsSigner.body.code).toBe('ACCESS_DENIED');
      const noSigner = await t.http
        .post('/v1/acknowledgments')
        .set(frontDesk)
        .set('Idempotency-Key', key())
        .send({ subjectPersonId: other, policyVersionId: form });
      expect(noSigner.status).toBe(400);
      // a named signer without complete_forms is refused too
      const unrelated = await createPersonFixture(t, { kind: 'adult' });
      const noAuthority = await t.http
        .post('/v1/acknowledgments')
        .set(frontDesk)
        .set('Idempotency-Key', key())
        .send({ subjectPersonId: other, policyVersionId: form, signedByPersonId: unrelated });
      expect(noAuthority.status).toBe(403);
      expect(noAuthority.body.code).toBe('PARTICIPANT_AUTHORITY_REQUIRED');
      // a coach has no desk role: denied even with a valid signer
      const coach = await authHeaderForPerson(
        t,
        (await createStaffMemberFixture(t, { roles: ['coach'] })).personId,
      );
      const coachTry = await t.http
        .post('/v1/acknowledgments')
        .set(coach)
        .set('Idempotency-Key', key())
        .send({
          subjectPersonId: people.child.personId,
          policyVersionId: form,
          signedByPersonId: people.adult.personId,
        });
      expect(coachTry.status).toBe(403);
    });

    it('SPK-REG-009: the signing time is server-stamped for customers; staff may backdate a paper form only within the policy and with evidence', async () => {
      const people = await createOrganizationPeople(t, {
        guardianPermissions: ['view', 'complete_forms'],
      });
      const guardian = await authHeaderForPerson(t, people.adult.personId);
      const form = await createPolicyVersionFixture(t, { kind: 'form' });
      const record = (auth: Record<string, string>, body: Record<string, unknown>) =>
        t.http
          .post('/v1/acknowledgments')
          .set(auth)
          .set('Idempotency-Key', key())
          .send({ subjectPersonId: people.child.personId, policyVersionId: form, ...body });

      const customerBackdated = await record(guardian, { signedAt: '2001-01-01T00:00:00Z' });
      expect(customerBackdated.status).toBe(400);
      expect(customerBackdated.body.code).toBe('VALIDATION_FAILED');
      const customerFuture = await record(guardian, { signedAt: '2099-01-01T00:00:00Z' });
      expect(customerFuture.status).toBe(400);

      const staff = (body: Record<string, unknown>) =>
        record(frontDesk, { signedByPersonId: people.adult.personId, ...body });
      const future = await staff({
        signedAt: '2026-10-23T12:00:01Z',
        evidence: { channel: 'paper', documentRef: 'box-7' },
      });
      expect(future.status).toBe(400);
      expect(future.body.details).toMatchObject({ code: 'signed_in_future' });
      const beforePolicy = await staff({
        signedAt: '1990-05-05T00:00:00Z',
        evidence: { channel: 'paper', documentRef: 'box-7' },
      });
      expect(beforePolicy.status).toBe(400);
      expect(beforePolicy.body.details).toMatchObject({ code: 'signed_before_policy' });
      const noEvidence = await staff({ signedAt: '2026-10-22T18:00:00Z' });
      expect(noEvidence.status).toBe(400);
      expect(noEvidence.body.details).toMatchObject({ path: 'evidence' });
      expect(
        await t.db
          .selectFrom('acknowledgments')
          .select('id')
          .where('subject_person_id', '=', people.child.personId)
          .where('policy_version_id', '=', form)
          .execute(),
      ).toHaveLength(0);

      const paper = await staff({
        signedAt: '2026-10-22T18:00:00Z',
        evidence: { channel: 'paper', documentRef: 'box-7' },
      });
      expect(paper.status, JSON.stringify(paper.body)).toBe(201);
      expect(paper.body.signedAt).toBe('2026-10-22T18:00:00.000Z');
      const audit = await t.db
        .selectFrom('audit_records')
        .select(['details', 'occurred_at'])
        .where('target_id', '=', paper.body.id)
        .where('action', '=', 'catalog.acknowledgment_recorded')
        .executeTakeFirstOrThrow();
      expect(audit.details).toMatchObject({
        retrospective: true,
        signedAt: '2026-10-22T18:00:00.000Z',
      });

      // without signedAt the server stamps the clock, for customers and staff alike
      const other = await createOrganizationPeople(t, {
        guardianPermissions: ['view', 'complete_forms'],
      });
      const stamped = await t.http
        .post('/v1/acknowledgments')
        .set(await authHeaderForPerson(t, other.adult.personId))
        .set('Idempotency-Key', key())
        .send({ subjectPersonId: other.child.personId, policyVersionId: form });
      expect(stamped.status).toBe(201);
      expect(stamped.body.signedAt).toBe(t.clock.now().toISOString());
    });
  });
});
