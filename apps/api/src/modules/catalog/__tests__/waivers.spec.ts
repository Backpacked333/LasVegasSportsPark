import { newId } from '@sportspark/contracts';
import { isCheckViolation, isForeignKeyViolation, json, seedOrganization } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../testing';
import {
  authHeaderForPerson,
  createOrganizationPeople,
  createPersonFixture,
  createStaffMemberFixture,
} from '../../identity';
import { CatalogModule } from '../catalog.module';
import {
  OFFERING_LOOKUP_PORT,
  POLICY_PORT,
  type OfferingLookupPort,
  type PolicyPort,
} from '../catalog.ports';
import { WAIVER_RENEWED_REASON } from '../services/acknowledgments.service';
import {
  createAcknowledgmentFixture,
  createOfferingFixture,
  createPolicyVersionFixture,
  fixtureWaiverContent,
} from '../testing/catalog-fixtures';

type Auth = { Authorization: string };
const key = () => `k-${newId()}`;
const waiverKey = () => `waiver-${newId().slice(-8)}`;
const LONG_AGO = new Date('2026-01-01T00:00:00Z');

/**
 * Liability waivers (SPK-REG-011, proposed amendment PA-01; capability `liability_waivers`,
 * DEC-095). The rule values used here (warn or block, re-acceptance, renewal months, who may
 * override) are content of the test's own waiver versions: none is a constant of the system.
 */
describe('liability waivers (SPK-REG-011, SPK-REG-009; proposed amendment PA-01)', () => {
  let t: TestApp;
  let pm: Auth & { personId: string };
  let frontDesk: Auth & { personId: string };
  let coach: Auth;
  let port: PolicyPort;

  const staff = async (role: 'program_manager' | 'front_desk' | 'coach') => {
    const member = await createStaffMemberFixture(t, { roles: [role] });
    return { ...(await authHeaderForPerson(t, member.personId)), personId: member.personId };
  };
  const waiver = (
    policyKey: string,
    rule: Parameters<typeof fixtureWaiverContent>[0] = {},
    over: { version?: number; title?: string; effectiveFrom?: Date } = {},
  ) =>
    createPolicyVersionFixture(t, {
      kind: 'waiver',
      key: policyKey,
      title: over.title ?? 'Liability waiver',
      version: over.version ?? 1,
      effectiveFrom: over.effectiveFrom ?? LONG_AGO,
      content: fixtureWaiverContent(rule),
    });
  const accept = (auth: Auth, body: Record<string, unknown>) =>
    t.http.post('/v1/waiver-acceptances').set(auth).set('Idempotency-Key', key()).send(body);
  const override = (auth: Auth, body: Record<string, unknown>) =>
    t.http.post('/v1/waiver-overrides').set(auth).set('Idempotency-Key', key()).send(body);
  const waiversOf = (auth: Auth, personId: string) =>
    t.http.get(`/v1/people/${personId}/waivers`).set(auth);

  beforeAll(async () => {
    t = await createTestApp({
      imports: [CatalogModule],
      principalResolver: 'module',
      clockStart: '2026-11-14T12:00:00Z',
      capabilities: ['liability_waivers'],
    });
    pm = await staff('program_manager');
    frontDesk = await staff('front_desk');
    coach = await staff('coach');
    port = t.app.get<PolicyPort>(POLICY_PORT);
  });
  afterAll(async () => {
    await t.close();
  });

  it('SPK-REG-011: a waiver is a versioned document; each acceptance records the person covered, who accepted, the version, the time and the method, and earlier versions and acceptances are kept', async () => {
    const policyKey = waiverKey();
    const people = await createOrganizationPeople(t, {
      guardianPermissions: ['view', 'complete_forms'],
    });
    const guardian = await authHeaderForPerson(t, people.adult.personId);

    // a waiver family is drafted and approved through the policy version commands
    const draft = await t.http
      .post('/v1/policy-versions')
      .set(pm)
      .set('Idempotency-Key', key())
      .send({
        kind: 'waiver',
        key: policyKey,
        title: 'Liability waiver',
        content: fixtureWaiverContent(),
        effectiveFrom: '2026-11-01T00:00:00Z',
      });
    expect(draft.status).toBe(201);
    expect(draft.body).toMatchObject({ kind: 'waiver', version: 1, approvalStatus: 'draft' });
    // a waiver version states every value of its rule; none is assumed
    const incomplete = await t.http
      .post('/v1/policy-versions')
      .set(pm)
      .set('Idempotency-Key', key())
      .send({
        kind: 'waiver',
        key: policyKey,
        title: 'Liability waiver',
        content: { text: 'wording' },
        effectiveFrom: '2026-11-01T00:00:00Z',
      });
    expect(incomplete.status).toBe(400);
    const approved = await t.http
      .post(`/v1/policy-versions/${draft.body.id}/approve`)
      .set(pm)
      .set('Idempotency-Key', key())
      .send({});
    expect(approved.status).toBe(200);
    const v1 = draft.body.id as string;

    expect(
      await port.waiverStatus(t.organizationId, people.child.personId, policyKey, t.clock.now()),
    ).toMatchObject({ status: 'missing', reason: 'never_accepted', acceptance: null });

    const self = await accept(guardian, { subjectPersonId: people.adult.personId, policyKey });
    expect(self.status).toBe(201);
    expect(self.body).toMatchObject({
      subjectPersonId: people.adult.personId,
      signedByPersonId: people.adult.personId,
      policyVersionId: v1,
      basis: 'self',
      method: 'digital',
      paperDatedOn: null,
      recordedByKind: 'customer',
      recordedByPersonId: null,
      signedAt: '2026-11-14T12:00:00.000Z',
    });
    const forChild = await accept(guardian, { subjectPersonId: people.child.personId, policyKey });
    expect(forChild.status).toBe(201);
    expect(forChild.body).toMatchObject({
      subjectPersonId: people.child.personId,
      signedByPersonId: people.adult.personId,
      basis: 'guardian',
      method: 'digital',
    });
    // already current: a second acceptance of the same version is refused
    const again = await accept(guardian, { subjectPersonId: people.child.personId, policyKey });
    expect(again.status).toBe(409);
    expect(again.body.details).toMatchObject({ code: 'WAIVER_ALREADY_CURRENT' });

    const current = await port.waiverStatus(
      t.organizationId,
      people.child.personId,
      policyKey,
      t.clock.now(),
    );
    expect(current).toMatchObject({
      status: 'current',
      reason: null,
      validUntil: null,
      rule: { reacceptOnNewVersion: false, renewEveryMonths: null, enforcement: 'warn' },
      currentVersion: { policyVersionId: v1, version: 1 },
      acceptance: {
        acknowledgmentId: forChild.body.id,
        policyVersionId: v1,
        version: 1,
        signedByPersonId: people.adult.personId,
        method: 'digital',
        acceptedAt: '2026-11-14T12:00:00.000Z',
      },
    });

    // the wording changes: version 2 is approved; version 1 and its acceptances are kept, and
    // (this version's rule) the earlier acceptance still counts
    t.clock.advance(86_400_000);
    const v2 = await waiver(policyKey, {}, { version: 2, title: 'Liability waiver (2027)' });
    const read = await waiversOf(guardian, people.child.personId);
    expect(read.status).toBe(200);
    expect(read.body.evaluated).toBe(true);
    const entry = read.body.waivers.find((w: { policyKey: string }) => w.policyKey === policyKey);
    expect(entry).toMatchObject({
      title: 'Liability waiver (2027)',
      status: 'current',
      currentVersion: { policyVersionId: v2, version: 2 },
      acceptance: { policyVersionId: v1, version: 1 },
      overrides: [],
    });
    expect(entry.history).toHaveLength(1);
    expect((await t.http.get(`/v1/policy-versions/${v1}`).set(guardian)).body).toMatchObject({
      version: 1,
      approvalStatus: 'approved',
    });
    // accepting the new wording adds an acceptance; the earlier one stays in the history
    const newer = await accept(guardian, { subjectPersonId: people.child.personId, policyKey });
    expect(newer.status).toBe(201);
    expect(newer.body.policyVersionId).toBe(v2);
    const after = await waiversOf(guardian, people.child.personId);
    const history = after.body.waivers.find(
      (w: { policyKey: string }) => w.policyKey === policyKey,
    ).history;
    expect(history.map((a: { version: number; status: string }) => [a.version, a.status])).toEqual([
      [2, 'active'],
      [1, 'active'],
    ]);
    // a digital acceptance is always of the version in force
    const other = await createOrganizationPeople(t);
    const stale = await accept(await authHeaderForPerson(t, other.adult.personId), {
      subjectPersonId: other.adult.personId,
      policyKey,
      policyVersionId: v1,
    });
    expect(stale.status).toBe(400);
    expect(stale.body.details).toMatchObject({ code: 'WAIVER_VERSION_NOT_IN_FORCE' });
    t.clock.set('2026-11-14T12:00:00Z');
  });

  it('SPK-REG-009: a paper acceptance is only ever a staff entry naming the staff member and the date on the paper, and never appears as a digital signature by the customer', async () => {
    const policyKey = waiverKey();
    const version = await waiver(policyKey);
    const people = await createOrganizationPeople(t, {
      guardianPermissions: ['view', 'complete_forms'],
    });
    const guardian = await authHeaderForPerson(t, people.adult.personId);

    // a customer can never record a paper acceptance, for themselves or for a child
    const customerPaper = await accept(guardian, {
      subjectPersonId: people.adult.personId,
      policyKey,
      method: 'paper',
      paperDatedOn: '2026-11-10',
    });
    expect(customerPaper.status).toBe(403);
    expect(customerPaper.body.details).toMatchObject({ code: 'PAPER_WAIVER_STAFF_ONLY' });
    // paper states its date; digital never does
    expect(
      (
        await accept(frontDesk, {
          subjectPersonId: people.child.personId,
          policyKey,
          method: 'paper',
          signedByPersonId: people.adult.personId,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await accept(guardian, {
          subjectPersonId: people.adult.personId,
          policyKey,
          paperDatedOn: '2026-11-10',
        })
      ).status,
    ).toBe(400);
    // staff name the signer and are never the signer (the existing rule holds for paper too)
    const noSigner = await accept(frontDesk, {
      subjectPersonId: people.child.personId,
      policyKey,
      method: 'paper',
      paperDatedOn: '2026-11-10',
    });
    expect(noSigner.status).toBe(400);
    const staffSigns = await accept(frontDesk, {
      subjectPersonId: people.child.personId,
      policyKey,
      method: 'paper',
      paperDatedOn: '2026-11-10',
      signedByPersonId: frontDesk.personId,
    });
    expect(staffSigns.status).toBe(403);
    // a named signer without complete_forms over the child is refused
    const unrelated = await createPersonFixture(t, { kind: 'adult' });
    const noAuthority = await accept(frontDesk, {
      subjectPersonId: people.child.personId,
      policyKey,
      method: 'paper',
      paperDatedOn: '2026-11-10',
      signedByPersonId: unrelated,
    });
    expect(noAuthority.status).toBe(403);
    expect(noAuthority.body.code).toBe('PARTICIPANT_AUTHORITY_REQUIRED');
    // a child cannot sign for themselves on paper either
    const childSigns = await accept(frontDesk, {
      subjectPersonId: people.child.personId,
      policyKey,
      method: 'paper',
      paperDatedOn: '2026-11-10',
      signedByPersonId: people.child.personId,
    });
    expect(childSigns.status).toBe(403);
    // the paper is not dated in the future, nor before the waiver version existed
    for (const paperDatedOn of ['2026-11-20', '2025-06-01']) {
      const refused = await accept(frontDesk, {
        subjectPersonId: people.child.personId,
        policyKey,
        method: 'paper',
        paperDatedOn,
        signedByPersonId: people.adult.personId,
      });
      expect(refused.status).toBe(400);
      expect(refused.body.details).toMatchObject({ path: 'paperDatedOn' });
    }
    // a coach has no desk role
    expect(
      (
        await accept(coach, {
          subjectPersonId: people.child.personId,
          policyKey,
          method: 'paper',
          paperDatedOn: '2026-11-10',
          signedByPersonId: people.adult.personId,
        })
      ).status,
    ).toBe(403);

    const paper = await accept(frontDesk, {
      subjectPersonId: people.child.personId,
      policyKey,
      method: 'paper',
      paperDatedOn: '2026-11-10',
      signedByPersonId: people.adult.personId,
      evidence: { storedIn: 'front desk binder' },
    });
    expect(paper.status).toBe(201);
    expect(paper.body).toMatchObject({
      policyVersionId: version,
      subjectPersonId: people.child.personId,
      signedByPersonId: people.adult.personId,
      basis: 'guardian',
      method: 'paper',
      paperDatedOn: '2026-11-10',
      recordedByKind: 'staff',
      recordedByPersonId: frontDesk.personId,
      // the time of the staff entry, stamped by the server: never a signature time
      signedAt: '2026-11-14T12:00:00.000Z',
    });
    // the guardian reads it as what it is: a staff entry from paper, with the staff member named
    const read = await waiversOf(guardian, people.child.personId);
    const entry = read.body.waivers.find((w: { policyKey: string }) => w.policyKey === policyKey);
    expect(entry).toMatchObject({
      status: 'current',
      acceptance: {
        method: 'paper',
        paperDatedOn: '2026-11-10',
        recordedByKind: 'staff',
        recordedByPersonId: frontDesk.personId,
        acceptedAt: '2026-11-10T00:00:00.000Z',
      },
    });
    const audit = await t.db
      .selectFrom('audit_records')
      .select(['details'])
      .where('target_id', '=', paper.body.id)
      .where('action', '=', 'catalog.acknowledgment_recorded')
      .executeTakeFirstOrThrow();
    expect(audit.details).toMatchObject({
      method: 'paper',
      paperDatedOn: '2026-11-10',
      assistedByStaff: true,
      waiverPolicyKey: policyKey,
    });
    // signing on the desk tablet stays digital: staff assist, the guardian is the signer
    const tabletKey = waiverKey();
    await waiver(tabletKey);
    const tablet = await accept(frontDesk, {
      subjectPersonId: people.child.personId,
      policyKey: tabletKey,
      signedByPersonId: people.adult.personId,
      evidence: { channel: 'desk_tablet' },
    });
    expect(tablet.status).toBe(201);
    expect(tablet.body).toMatchObject({
      method: 'digital',
      paperDatedOn: null,
      recordedByKind: 'staff',
      recordedByPersonId: frontDesk.personId,
      signedByPersonId: people.adult.personId,
    });
    // a waiver is never recorded through the general acknowledgment command (no method there)
    const other = await createOrganizationPeople(t);
    const bypass = await t.http
      .post('/v1/acknowledgments')
      .set(await authHeaderForPerson(t, other.adult.personId))
      .set('Idempotency-Key', key())
      .send({ subjectPersonId: other.adult.personId, policyVersionId: version });
    expect(bypass.status).toBe(400);
    expect(bypass.body.details).toMatchObject({ code: 'USE_WAIVER_ACCEPTANCE' });
  });

  it('SPK-REG-011: an acceptance lapses when the version in force requires re-acceptance of a new version', async () => {
    const policyKey = waiverKey();
    const v1 = await waiver(policyKey);
    const person = await createPersonFixture(t, { kind: 'adult' });
    await createAcknowledgmentFixture(t, {
      subjectPersonId: person,
      policyVersionId: v1,
      signedByPersonId: person,
      signedAt: new Date('2026-06-01T00:00:00Z'),
    });
    expect(
      (await port.waiverStatus(t.organizationId, person, policyKey, t.clock.now())).status,
    ).toBe('current');
    const v2 = await waiver(
      policyKey,
      { reacceptOnNewVersion: true },
      { version: 2, effectiveFrom: new Date('2026-11-01T00:00:00Z') },
    );
    const lapsed = await port.waiverStatus(t.organizationId, person, policyKey, t.clock.now());
    expect(lapsed).toMatchObject({
      status: 'lapsed',
      reason: 'new_version',
      lapsedAt: '2026-11-01T00:00:00.000Z',
      currentVersion: { policyVersionId: v2 },
      acceptance: { policyVersionId: v1 },
    });
    // judged at an instant before the new version took effect, the acceptance was current
    expect(
      (
        await port.waiverStatus(
          t.organizationId,
          person,
          policyKey,
          new Date('2026-10-01T00:00:00Z'),
        )
      ).status,
    ).toBe('current');
    const stranger = newId();
    const many = await port.waiverStatuses(
      t.organizationId,
      [person, stranger],
      policyKey,
      t.clock.now(),
    );
    expect(many.get(person)?.status).toBe('lapsed');
    expect(many.get(stranger)?.status).toBe('missing');
  });

  it('SPK-REG-011: an acceptance lapses under periodic renewal, and accepting again closes the lapsed one and keeps it', async () => {
    const policyKey = waiverKey();
    await waiver(policyKey, { renewEveryMonths: 12 });
    const people = await createOrganizationPeople(t);
    const adult = await authHeaderForPerson(t, people.adult.personId);
    const first = await accept(adult, { subjectPersonId: people.adult.personId, policyKey });
    expect(first.status).toBe(201);
    expect(
      await port.waiverStatus(t.organizationId, people.adult.personId, policyKey, t.clock.now()),
    ).toMatchObject({ status: 'current', validUntil: '2027-11-14T12:00:00.000Z' });
    try {
      t.clock.set('2027-11-14T12:00:00Z');
      expect(
        await port.waiverStatus(t.organizationId, people.adult.personId, policyKey, t.clock.now()),
      ).toMatchObject({
        status: 'lapsed',
        reason: 'renewal_due',
        lapsedAt: '2027-11-14T12:00:00.000Z',
      });
      const renewed = await accept(adult, { subjectPersonId: people.adult.personId, policyKey });
      expect(renewed.status).toBe(201);
      expect(renewed.body.id).not.toBe(first.body.id);
      const read = await waiversOf(adult, people.adult.personId);
      const entry = read.body.waivers.find((w: { policyKey: string }) => w.policyKey === policyKey);
      expect(entry).toMatchObject({
        status: 'current',
        acceptance: { acknowledgmentId: renewed.body.id },
        validUntil: '2028-11-14T12:00:00.000Z',
      });
      expect(
        entry.history.map((a: { acknowledgmentId: string; status: string }) => [
          a.acknowledgmentId,
          a.status,
        ]),
      ).toEqual([
        [renewed.body.id, 'active'],
        [first.body.id, 'withdrawn'],
      ]);
      expect(entry.history[1].withdrawnReason).toBe(WAIVER_RENEWED_REASON);
    } finally {
      t.clock.set('2026-11-14T12:00:00Z');
    }
  });

  it('SPK-REG-011: a missing or lapsed waiver warns or blocks by the approved rule, and a block is overridden only by a role the waiver names, with a recorded reason', async () => {
    const warnKey = waiverKey();
    const blockKey = waiverKey();
    await waiver(warnKey, { enforcement: 'warn' });
    const blockVersion = await waiver(blockKey, {
      enforcement: 'block',
      overrideRoles: ['program_manager'],
    });
    const manager = (await createStaffMemberFixture(t, { roles: ['program_manager'] })).personId;
    const offering = await createOfferingFixture(t, { responsibleManagerPersonId: manager });
    const person = await createPersonFixture(t, { kind: 'adult' });
    const activities = [{ type: 'offering' as const, id: offering.offeringId }];
    const findings = () =>
      port.waiverFindings(t.organizationId, {
        personIds: [person],
        policyKeys: [warnKey, blockKey],
        at: t.clock.now(),
        activities,
      });
    expect((await findings()).map((f) => [f.policyKey, f.status, f.severity, f.override])).toEqual([
      [warnKey, 'missing', 'warning', null],
      [blockKey, 'missing', 'blocking', null],
    ]);

    const body = { personId: person, activity: activities[0], reason: 'Paper form is on its way' };
    // a waiver that only warns needs no override, and none is recorded
    const warnOverride = await override(pm, { ...body, policyKey: warnKey });
    expect(warnOverride.status).toBe(400);
    expect(warnOverride.body.details).toMatchObject({ code: 'WAIVER_NOT_BLOCKING' });
    // the approved waiver names who may override: the front desk is not among them
    const deskOverride = await override(frontDesk, { ...body, policyKey: blockKey });
    expect(deskOverride.status).toBe(403);
    expect(deskOverride.body.details).toMatchObject({ code: 'WAIVER_OVERRIDE_NOT_PERMITTED' });
    expect((await override(coach, { ...body, policyKey: blockKey })).status).toBe(403);
    // a reason is required; nobody overrides for themselves; the activity exists
    expect(
      (await override(pm, { personId: person, policyKey: blockKey, activity: activities[0] }))
        .status,
    ).toBe(400);
    expect(
      (await override(pm, { ...body, personId: pm.personId, policyKey: blockKey })).status,
    ).toBe(403);
    expect(
      (
        await override(pm, {
          ...body,
          policyKey: blockKey,
          activity: { type: 'offering', id: newId() },
        })
      ).status,
    ).toBe(404);

    const recorded = await override(pm, { ...body, policyKey: blockKey });
    expect(recorded.status).toBe(201);
    expect(recorded.body).toMatchObject({
      personId: person,
      policyKey: blockKey,
      policyVersionId: blockVersion,
      waiverStatus: 'missing',
      activity: activities[0],
      reason: 'Paper form is on its way',
      actorPersonId: pm.personId,
      occurredAt: '2026-11-14T12:00:00.000Z',
    });
    const overridden = (await findings()).find((f) => f.policyKey === blockKey);
    expect(overridden).toMatchObject({
      status: 'missing',
      severity: 'warning',
      override: { id: recorded.body.id },
    });
    // the override is for that activity only
    const elsewhere = await port.waiverFindings(t.organizationId, {
      personIds: [person],
      policyKeys: [blockKey],
      at: t.clock.now(),
      activities: [{ type: 'offering', id: newId() }],
    });
    expect(elsewhere[0]).toMatchObject({ severity: 'blocking', override: null });
    // staff see the override on the person; it is audited and announced
    const read = await waiversOf(frontDesk, person);
    expect(
      read.body.waivers.find((w: { policyKey: string }) => w.policyKey === blockKey).overrides,
    ).toHaveLength(1);
    const audit = await t.db
      .selectFrom('audit_records')
      .select(['action', 'reason'])
      .where('target_id', '=', recorded.body.id)
      .executeTakeFirstOrThrow();
    expect(audit).toMatchObject({
      action: 'catalog.waiver_override_recorded',
      reason: 'Paper form is on its way',
    });
    const event = await t.db
      .selectFrom('outbox_events')
      .select('payload')
      .where('event_type', '=', 'catalog.waiver_override_recorded')
      .where('aggregate_id', '=', recorded.body.id)
      .executeTakeFirstOrThrow();
    expect(event.payload).toMatchObject({ personId: person, policyKey: blockKey });

    // once accepted there is no finding, and nothing left to override
    await createAcknowledgmentFixture(t, {
      subjectPersonId: person,
      policyVersionId: blockVersion,
      signedByPersonId: person,
    });
    expect((await findings()).map((f) => f.policyKey)).toEqual([warnKey]);
    const current = await override(pm, { ...body, policyKey: blockKey });
    expect(current.status).toBe(400);
    expect(current.body.details).toMatchObject({ code: 'WAIVER_NOT_BLOCKING' });
  });

  it("SPK-REG-011 / SPK-IAM-003: a person's waivers are read by staff, the person and a guardian holding complete_forms; anyone else gets not found", async () => {
    const policyKey = waiverKey();
    await waiver(policyKey);
    const family = await createOrganizationPeople(t, {
      guardianPermissions: ['view', 'complete_forms'],
    });
    const viewOnly = await createOrganizationPeople(t, { guardianPermissions: ['view'] });
    const stranger = await createOrganizationPeople(t);
    const read = async (personId: string, childId: string) =>
      (await waiversOf(await authHeaderForPerson(t, personId), childId)).status;
    expect(await read(family.adult.personId, family.child.personId)).toBe(200);
    expect(await read(family.adult.personId, family.adult.personId)).toBe(200);
    expect((await waiversOf(frontDesk, family.child.personId)).status).toBe(200);
    // view alone is not enough; a stranger and an unknown person get the same answer
    const denied = await waiversOf(
      await authHeaderForPerson(t, viewOnly.adult.personId),
      viewOnly.child.personId,
    );
    expect(denied.status).toBe(404);
    expect(denied.body.code).toBe('NOT_FOUND');
    expect(await read(stranger.adult.personId, family.child.personId)).toBe(404);
    expect(await read(stranger.adult.personId, newId())).toBe(404);
    expect((await waiversOf(frontDesk, newId())).status).toBe(404);
    // a guardian without complete_forms cannot accept for the child either
    const refused = await accept(await authHeaderForPerson(t, viewOnly.adult.personId), {
      subjectPersonId: viewOnly.child.personId,
      policyKey,
    });
    expect(refused.status).toBe(404);
    // the missing waiver is listed with the version to accept
    const listed = await waiversOf(
      await authHeaderForPerson(t, family.adult.personId),
      family.child.personId,
    );
    expect(
      listed.body.waivers.find((w: { policyKey: string }) => w.policyKey === policyKey),
    ).toMatchObject({ status: 'missing', reason: 'never_accepted', history: [], overrides: [] });
  });

  it('SPK-REG-011: an offering requires a waiver by policy key; a copy keeps the requirement', async () => {
    const policyKey = waiverKey();
    const version = await waiver(policyKey, { enforcement: 'block' });
    const offering = await createOfferingFixture(t, { responsibleManagerPersonId: pm.personId });
    const set = (auth: Auth, policyKeys: string[]) =>
      t.http
        .post(`/v1/offerings/${offering.offeringId}/required-waivers`)
        .set(auth)
        .set('Idempotency-Key', key())
        .send({ policyKeys });
    expect((await set(frontDesk, [policyKey])).status).toBe(403);
    // a requirement nobody could satisfy is refused
    const unknown = await set(pm, ['no-such-waiver']);
    expect(unknown.status).toBe(400);
    expect(unknown.body.details).toMatchObject({ code: 'WAIVER_NOT_IN_FORCE' });
    const ok = await set(pm, [policyKey]);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({
      offeringId: offering.offeringId,
      waivers: [
        {
          policyKey,
          enforcement: 'block',
          currentVersion: {
            policyVersionId: version,
            version: 1,
            title: 'Liability waiver',
            effectiveFrom: '2026-01-01T00:00:00.000Z',
          },
        },
      ],
    });
    const customer = await authHeaderForPerson(
      t,
      (await createOrganizationPeople(t)).adult.personId,
    );
    const seen = await t.http
      .get(`/v1/offerings/${offering.offeringId}/required-waivers`)
      .set(customer);
    expect(seen.status).toBe(200);
    expect(seen.body.waivers.map((w: { policyKey: string }) => w.policyKey)).toEqual([policyKey]);
    const lookup = t.app.get<OfferingLookupPort>(OFFERING_LOOKUP_PORT);
    expect(
      (await lookup.getOffering(t.organizationId, offering.offeringId, t.clock.now()))
        ?.requiredWaiverKeys,
    ).toEqual([policyKey]);
    const copy = await t.http
      .post(`/v1/offerings/${offering.offeringId}/copy`)
      .set(pm)
      .set('Idempotency-Key', key())
      .send({ name: 'Next term', startsOn: '2027-04-11' });
    expect(copy.status).toBe(201);
    expect(
      (await lookup.getOffering(t.organizationId, copy.body.id, t.clock.now()))?.requiredWaiverKeys,
    ).toEqual([policyKey]);
    // a draft offering's requirement is staff-only
    expect(
      (await t.http.get(`/v1/offerings/${copy.body.id}/required-waivers`).set(customer)).status,
    ).toBe(403);
    const cleared = await set(pm, []);
    expect(cleared.body.waivers).toEqual([]);
    const audits = await t.db
      .selectFrom('audit_records')
      .select('details')
      .where('target_id', '=', offering.offeringId)
      .where('action', '=', 'catalog.offering_required_waivers_changed')
      .orderBy('occurred_at')
      .orderBy('id')
      .execute();
    expect(audits.map((a) => a.details)).toEqual([
      { before: [], after: [policyKey] },
      { before: [policyKey], after: [] },
    ]);
  });

  it('SPK-REG-011 with liability waivers turned off: no waiver is drafted, accepted, required or overridden, nothing is evaluated, and forms behave as before', async () => {
    const policyKey = waiverKey();
    const version = await waiver(policyKey, {
      enforcement: 'block',
      overrideRoles: ['program_manager'],
    });
    const offering = await createOfferingFixture(t, { responsibleManagerPersonId: pm.personId });
    const people = await createOrganizationPeople(t);
    const adult = await authHeaderForPerson(t, people.adult.personId);
    await t.http
      .post(`/v1/offerings/${offering.offeringId}/required-waivers`)
      .set(pm)
      .set('Idempotency-Key', key())
      .send({ policyKeys: [policyKey] });
    await t.disableCapability('liability_waivers');
    try {
      const disabled = (response: { status: number; body: { details?: unknown } }) => {
        expect(response.status).toBe(403);
        expect(response.body.details).toMatchObject({
          code: 'CAPABILITY_DISABLED',
          capability: 'liability_waivers',
        });
      };
      disabled(await accept(adult, { subjectPersonId: people.adult.personId, policyKey }));
      disabled(
        await override(pm, {
          personId: people.adult.personId,
          policyKey,
          activity: { type: 'offering', id: offering.offeringId },
          reason: 'x',
        }),
      );
      disabled(
        await t.http
          .post(`/v1/offerings/${offering.offeringId}/required-waivers`)
          .set(pm)
          .set('Idempotency-Key', key())
          .send({ policyKeys: [] }),
      );
      disabled(
        await t.http.post('/v1/policy-versions').set(pm).set('Idempotency-Key', key()).send({
          kind: 'waiver',
          key: waiverKey(),
          title: 'Liability waiver',
          content: fixtureWaiverContent(),
          effectiveFrom: '2026-11-01T00:00:00Z',
        }),
      );
      // nothing is evaluated or shown
      expect(
        await port.waiverFindings(t.organizationId, {
          personIds: [people.adult.personId],
          policyKeys: [policyKey],
          at: t.clock.now(),
          activities: [],
        }),
      ).toEqual([]);
      expect((await waiversOf(adult, people.adult.personId)).body).toEqual({
        personId: people.adult.personId,
        evaluated: false,
        waivers: [],
      });
      expect(
        (await t.http.get(`/v1/offerings/${offering.offeringId}/required-waivers`).set(adult)).body,
      ).toEqual({ offeringId: offering.offeringId, waivers: [] });
      // today's form behaviour is untouched: a form is acknowledged as before, and the response
      // says it is digital
      const form = await createPolicyVersionFixture(t, { kind: 'form' });
      const acknowledged = await t.http
        .post('/v1/acknowledgments')
        .set(adult)
        .set('Idempotency-Key', key())
        .send({ subjectPersonId: people.adult.personId, policyVersionId: form });
      expect(acknowledged.status).toBe(201);
      expect(acknowledged.body).toMatchObject({ method: 'digital', paperDatedOn: null });
      expect(await port.hasAcknowledgment(t.organizationId, people.adult.personId, form)).toBe(
        true,
      );
      // an approved waiver version stays readable
      expect((await t.http.get(`/v1/policy-versions/${version}`).set(adult)).status).toBe(200);
    } finally {
      await t.enableCapability('liability_waivers');
    }
  });

  describe('database integrity (migration 0220)', () => {
    const ack = (over: Record<string, unknown>) => ({
      id: newId(),
      organization_id: t.organizationId,
      basis: 'self' as const,
      recorded_by: json({ kind: 'staff' }),
      signed_at: t.clock.now(),
      evidence: json({}),
      withdrawn_at: null,
      withdrawn_reason: null,
      ...over,
    });

    it('SPK-REG-009: the database refuses a paper acceptance that is not a staff entry with a paper date, and a paper date on a digital one', async () => {
      const version = await waiver(waiverKey());
      const person = await createPersonFixture(t, { kind: 'adult' });
      const base = {
        subject_person_id: person,
        policy_version_id: version,
        signed_by_person_id: person,
      };
      const insert = (over: Record<string, unknown>) =>
        t.db
          .insertInto('acknowledgments')
          .values(ack({ ...base, ...over }) as never)
          .execute();
      // paper recorded by the customer
      await expect(
        insert({
          method: 'paper',
          paper_dated_on: '2026-11-10',
          recorded_by_kind: 'customer',
          recorded_by_person_id: person,
        }),
      ).rejects.toSatisfy(isCheckViolation);
      // paper recorded by the system
      await expect(
        insert({
          method: 'paper',
          paper_dated_on: '2026-11-10',
          recorded_by_kind: 'system',
          recorded_by_person_id: null,
        }),
      ).rejects.toSatisfy(isCheckViolation);
      // paper by staff without naming the staff member
      await expect(
        insert({
          method: 'paper',
          paper_dated_on: '2026-11-10',
          recorded_by_kind: 'staff',
          recorded_by_person_id: null,
        }),
      ).rejects.toSatisfy(isCheckViolation);
      // paper by named staff without the date on the paper
      await expect(
        insert({
          method: 'paper',
          paper_dated_on: null,
          recorded_by_kind: 'staff',
          recorded_by_person_id: frontDesk.personId,
        }),
      ).rejects.toSatisfy(isCheckViolation);
      // digital with a paper date
      await expect(
        insert({
          method: 'digital',
          paper_dated_on: '2026-11-10',
          recorded_by_kind: 'customer',
          recorded_by_person_id: person,
        }),
      ).rejects.toSatisfy(isCheckViolation);
      // an unknown method
      await expect(
        insert({ method: 'fax', recorded_by_kind: 'customer', recorded_by_person_id: person }),
      ).rejects.toSatisfy(isCheckViolation);
      // staff are still never the signer, on paper too
      await expect(
        insert({
          subject_person_id: frontDesk.personId,
          signed_by_person_id: frontDesk.personId,
          method: 'paper',
          paper_dated_on: '2026-11-10',
          recorded_by_kind: 'staff',
          recorded_by_person_id: frontDesk.personId,
        }),
      ).rejects.toSatisfy(isCheckViolation);
      // the valid staff entry is accepted, and neither its method nor its date can be rewritten
      const id = await createAcknowledgmentFixture(t, {
        ...{ subjectPersonId: person, policyVersionId: version, signedByPersonId: person },
        recordedByKind: 'staff',
        recordedByPersonId: frontDesk.personId,
        method: 'paper',
        paperDatedOn: '2026-11-10',
      });
      await expect(
        t.db
          .updateTable('acknowledgments')
          .set({ method: 'digital' } as never)
          .where('id', '=', id)
          .execute(),
      ).rejects.toThrow(/signer evidence/);
      await expect(
        t.db
          .updateTable('acknowledgments')
          .set({ paper_dated_on: '2026-11-11' } as never)
          .where('id', '=', id)
          .execute(),
      ).rejects.toThrow(/signer evidence/);
    });

    it('acknowledgments recorded before the migration satisfy the new check through the column defaults', async () => {
      const form = await createPolicyVersionFixture(t, { kind: 'form' });
      const person = await createPersonFixture(t, { kind: 'adult' });
      const id = newId();
      // the columns a writer that predates the migration knows about
      await t.db
        .insertInto('acknowledgments')
        .values({
          id,
          organization_id: t.organizationId,
          subject_person_id: person,
          policy_version_id: form,
          signed_by_person_id: person,
          basis: 'self',
          recorded_by: json({ kind: 'customer' }),
          recorded_by_kind: 'customer',
          recorded_by_person_id: person,
          signed_at: t.clock.now(),
          withdrawn_at: null,
          withdrawn_reason: null,
        })
        .execute();
      const row = await t.db
        .selectFrom('acknowledgments')
        .select(['method', 'paper_dated_on'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ method: 'digital', paper_dated_on: null });
    });

    it('SPK-REG-011: a waiver override is append-only, never for oneself, and never points at another organization', async () => {
      const policyKey = waiverKey();
      const version = await waiver(policyKey);
      const person = await createPersonFixture(t, { kind: 'adult' });
      const other = await seedOrganization(t.db);
      const foreignPerson = await createPersonFixture(t, {
        kind: 'adult',
        organizationId: other.organizationId,
      });
      const foreignVersion = await createPolicyVersionFixture(t, {
        kind: 'waiver',
        organizationId: other.organizationId,
      });
      const row = (over: Record<string, unknown>) => ({
        id: newId(),
        organization_id: t.organizationId,
        person_id: person,
        policy_key: policyKey,
        policy_version_id: version,
        waiver_status: 'missing' as const,
        activity_type: 'offering' as const,
        activity_id: newId(),
        reason: 'reason',
        actor: json({ kind: 'staff' }),
        actor_person_id: pm.personId,
        occurred_at: t.clock.now(),
        ...over,
      });
      const insert = (over: Record<string, unknown>) =>
        t.db
          .insertInto('waiver_overrides')
          .values(row(over) as never)
          .execute();
      const id = newId();
      await insert({ id });
      await expect(
        t.db
          .updateTable('waiver_overrides')
          .set({ reason: 'edited' })
          .where('id', '=', id)
          .execute(),
      ).rejects.toThrow(/append-only/);
      await expect(
        t.db.deleteFrom('waiver_overrides').where('id', '=', id).execute(),
      ).rejects.toThrow(/append-only/);
      await expect(insert({ person_id: foreignPerson })).rejects.toSatisfy(isForeignKeyViolation);
      await expect(insert({ actor_person_id: foreignPerson })).rejects.toSatisfy(
        isForeignKeyViolation,
      );
      await expect(insert({ policy_version_id: foreignVersion })).rejects.toSatisfy(
        isForeignKeyViolation,
      );
      await expect(insert({ actor_person_id: person })).rejects.toSatisfy(isCheckViolation);
      await expect(insert({ reason: '   ' })).rejects.toSatisfy(isCheckViolation);
      await expect(insert({ waiver_status: 'current' })).rejects.toSatisfy(isCheckViolation);
      await expect(insert({ activity_type: 'team_entry' })).rejects.toSatisfy(isCheckViolation);
    });

    it("SPK-REG-011: a required waiver cannot be attached to another organization's offering, and its key is well formed", async () => {
      const other = await seedOrganization(t.db);
      const foreignManager = await createPersonFixture(t, {
        kind: 'adult',
        organizationId: other.organizationId,
      });
      const foreign = await createOfferingFixture(t, {
        responsibleManagerPersonId: foreignManager,
        organizationId: other.organizationId,
        facilityId: other.facilityId,
      });
      const mine = await createOfferingFixture(t, { responsibleManagerPersonId: pm.personId });
      const insert = (offeringId: string, policyKey: string) =>
        t.db
          .insertInto('offering_required_waivers')
          .values({
            organization_id: t.organizationId,
            offering_id: offeringId,
            policy_key: policyKey,
            added_by: json({ kind: 'staff' }),
          })
          .execute();
      await expect(insert(foreign.offeringId, 'liability')).rejects.toSatisfy(
        isForeignKeyViolation,
      );
      await expect(insert(mine.offeringId, 'Not A Key')).rejects.toSatisfy(isCheckViolation);
      await insert(mine.offeringId, 'liability');
      await expect(insert(mine.offeringId, 'liability')).rejects.toThrow();
    });

    it('the policy kind check accepts a waiver and still refuses an unknown kind', async () => {
      await expect(createPolicyVersionFixture(t, { kind: 'pledge' as never })).rejects.toSatisfy(
        isCheckViolation,
      );
      await expect(waiver(waiverKey())).resolves.toEqual(expect.any(String));
    });
  });
});
