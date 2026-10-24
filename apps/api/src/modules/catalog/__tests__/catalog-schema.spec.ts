import { newId } from '@sportspark/contracts';
import {
  isCheckViolation,
  isExclusionViolation,
  isForeignKeyViolation,
  isUniqueViolation,
  json,
  seedOrganization,
  type Db,
} from '@sportspark/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../testing';
import { createPersonFixture, createStaffMemberFixture } from '../../identity';
import { CatalogModule } from '../catalog.module';
import {
  createAcknowledgmentFixture,
  createDiscountFixture,
  createOfferingFixture,
  createPolicyVersionFixture,
  createPriceRuleFixture,
  createProgramFixture,
} from '../testing/catalog-fixtures';

/**
 * Integrity invariants proven at the database (§4.7, CLAUDE.md "Integrity that matters is
 * enforced in the database"): rows are written through Kysely, bypassing the services.
 */
describe('catalog schema invariants (migrations 0200, 0201)', () => {
  let t: TestApp;
  let db: Db;
  let org: string;
  let manager: string;
  let otherOrg: { organizationId: string; facilityId: string };
  const actor = json({ kind: 'system', actorLabel: 'schema-test' });

  beforeAll(async () => {
    t = await createTestApp({
      imports: [CatalogModule],
      principalResolver: 'module',
      clockStart: '2026-10-23T12:00:00Z',
    });
    db = t.db;
    org = t.organizationId;
    manager = (await createStaffMemberFixture(t, { roles: ['program_manager'] })).personId;
    otherOrg = await seedOrganization(db);
  });
  afterAll(async () => {
    await t.close();
  });

  it('§4.4 PolicyVersion: approved content is immutable, never returns to draft, retired is final', async () => {
    const draft = await createPolicyVersionFixture(t, { kind: 'eligibility', approved: false });
    await db
      .updateTable('policy_versions')
      .set({ content: json({ text: 'edited while draft' }) })
      .where('id', '=', draft)
      .execute();
    const approved = await createPolicyVersionFixture(t, { kind: 'eligibility' });
    await expect(
      db
        .updateTable('policy_versions')
        .set({ content: json({ text: 'tampered' }) })
        .where('id', '=', approved)
        .execute(),
    ).rejects.toThrow(/immutable once approved/);
    await expect(
      db
        .updateTable('policy_versions')
        .set({ title: 'renamed' })
        .where('id', '=', approved)
        .execute(),
    ).rejects.toThrow(/immutable once approved/);
    await expect(
      db
        .updateTable('policy_versions')
        .set({ approval_status: 'draft', approved_at: null, approved_by: null })
        .where('id', '=', approved)
        .execute(),
    ).rejects.toThrow(/cannot return to draft/);
    // retiring is allowed; un-retiring is not
    await db
      .updateTable('policy_versions')
      .set({ approval_status: 'retired', retired_at: t.clock.now(), retired_reason: 'superseded' })
      .where('id', '=', approved)
      .execute();
    await expect(
      db
        .updateTable('policy_versions')
        .set({ approval_status: 'approved', retired_at: null })
        .where('id', '=', approved)
        .execute(),
    ).rejects.toThrow(/is retired/);
    // approval status and approval columns must agree
    await expect(
      createPolicyVersionFixture(t, { kind: 'form', approved: true, effectiveTo: new Date(0) }),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      db
        .updateTable('policy_versions')
        .set({ approval_status: 'approved' })
        .where('id', '=', draft)
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('§4.4: one policy version number per (kind, key); kinds are the ten policy kinds', async () => {
    const key = `family-${newId().slice(0, 8)}`;
    await createPolicyVersionFixture(t, { kind: 'refund', key, version: 1 });
    await expect(
      createPolicyVersionFixture(t, { kind: 'refund', key, version: 1 }),
    ).rejects.toSatisfy(isUniqueViolation);
    await expect(
      createPolicyVersionFixture(t, { kind: 'dress_code' as never, key }),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('SPK-PAY-001: one effective price rule per offering per instant (exclusion on the effective range)', async () => {
    const offering = await createOfferingFixture(t, {
      responsibleManagerPersonId: manager,
      basePriceMinor: null,
    });
    const jan = new Date('2027-01-01T00:00:00Z');
    const feb = new Date('2027-02-01T00:00:00Z');
    const mar = new Date('2027-03-01T00:00:00Z');
    await createPriceRuleFixture(t, {
      offeringId: offering.offeringId,
      basePriceMinor: 10_000,
      effectiveFrom: jan,
      effectiveTo: mar,
    });
    // overlapping bounded window
    await expect(
      createPriceRuleFixture(t, {
        offeringId: offering.offeringId,
        basePriceMinor: 12_000,
        effectiveFrom: feb,
        effectiveTo: null,
      }),
    ).rejects.toSatisfy(isExclusionViolation);
    // adjacent half-open windows do not overlap
    await createPriceRuleFixture(t, {
      offeringId: offering.offeringId,
      basePriceMinor: 12_000,
      effectiveFrom: mar,
      effectiveTo: null,
    });
    // anything after March now collides with the open-ended rule
    await expect(
      createPriceRuleFixture(t, {
        offeringId: offering.offeringId,
        basePriceMinor: 9_000,
        effectiveFrom: new Date('2028-01-01T00:00:00Z'),
        effectiveTo: new Date('2028-02-01T00:00:00Z'),
      }),
    ).rejects.toSatisfy(isExclusionViolation);
  });

  it('SPK-PAY-002: a price rule never changes; its window may only be closed or shortened', async () => {
    const offering = await createOfferingFixture(t, {
      responsibleManagerPersonId: manager,
      basePriceMinor: null,
    });
    const id = await createPriceRuleFixture(t, {
      offeringId: offering.offeringId,
      basePriceMinor: 10_000,
      effectiveFrom: new Date('2027-01-01T00:00:00Z'),
      effectiveTo: null,
    });
    await expect(
      db.updateTable('price_rules').set({ base_price_minor: 1 }).where('id', '=', id).execute(),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.updateTable('price_rules').set({ currency: 'EUR' }).where('id', '=', id).execute(),
    ).rejects.toThrow(/immutable/);
    await expect(
      db
        .updateTable('price_rules')
        .set({ charge_lines: json([{ code: 'tax', label: 'Tax', kind: 'tax', basisPoints: 800 }]) })
        .where('id', '=', id)
        .execute(),
    ).rejects.toThrow(/immutable/);
    await expect(
      db
        .updateTable('price_rules')
        .set({ effective_from: new Date('2026-12-01T00:00:00Z') })
        .where('id', '=', id)
        .execute(),
    ).rejects.toThrow(/immutable/);
    // closing the open window and shortening it are permitted; extending is not
    await db
      .updateTable('price_rules')
      .set({ effective_to: new Date('2027-06-01T00:00:00Z') })
      .where('id', '=', id)
      .execute();
    await db
      .updateTable('price_rules')
      .set({ effective_to: new Date('2027-05-01T00:00:00Z') })
      .where('id', '=', id)
      .execute();
    await expect(
      db
        .updateTable('price_rules')
        .set({ effective_to: new Date('2027-07-01T00:00:00Z') })
        .where('id', '=', id)
        .execute(),
    ).rejects.toThrow(/cannot be extended/);
    await expect(
      db.updateTable('price_rules').set({ effective_to: null }).where('id', '=', id).execute(),
    ).rejects.toThrow(/cannot be extended/);
    await expect(
      createPriceRuleFixture(t, {
        offeringId: offering.offeringId,
        basePriceMinor: -1,
        effectiveFrom: new Date('2030-01-01T00:00:00Z'),
      }),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('SPK-PAY-002 / §4.4: price rules and approved policy versions are never deleted; an approved window is never extended (migration 0201)', async () => {
    const offering = await createOfferingFixture(t, { responsibleManagerPersonId: manager });
    await expect(
      db.deleteFrom('price_rules').where('offering_id', '=', offering.offeringId).execute(),
    ).rejects.toThrow(/append-only/);
    expect(
      await db
        .selectFrom('price_rules')
        .select('id')
        .where('offering_id', '=', offering.offeringId)
        .execute(),
    ).toHaveLength(1);

    // an approved version no record references still cannot be deleted; a draft can be discarded
    const approved = await createPolicyVersionFixture(t, {
      kind: 'refund',
      effectiveTo: new Date('2027-06-01T00:00:00Z'),
    });
    await expect(
      db.deleteFrom('policy_versions').where('id', '=', approved).execute(),
    ).rejects.toThrow(/cannot be deleted/);
    const draft = await createPolicyVersionFixture(t, { kind: 'refund', approved: false });
    await db.deleteFrom('policy_versions').where('id', '=', draft).execute();

    // the approved window may be shortened, never extended or reopened
    const setEffectiveTo = (id: string, value: Date | null) =>
      db.updateTable('policy_versions').set({ effective_to: value }).where('id', '=', id).execute();
    await setEffectiveTo(approved, new Date('2027-05-01T00:00:00Z'));
    await expect(setEffectiveTo(approved, new Date('2027-07-01T00:00:00Z'))).rejects.toThrow(
      /cannot extend its effective window/,
    );
    await expect(setEffectiveTo(approved, null)).rejects.toThrow(
      /cannot extend its effective window/,
    );
    const openEnded = await createPolicyVersionFixture(t, { kind: 'refund' });
    await setEffectiveTo(openEnded, new Date('2027-01-01T00:00:00Z'));

    // a retired version's window is final, and a retired version is not deleted either
    await db
      .updateTable('policy_versions')
      .set({ approval_status: 'retired', retired_at: t.clock.now(), retired_reason: 'superseded' })
      .where('id', '=', approved)
      .execute();
    await expect(setEffectiveTo(approved, new Date('2027-04-01T00:00:00Z'))).rejects.toThrow(
      /effective window is final/,
    );
    await expect(
      db.deleteFrom('policy_versions').where('id', '=', approved).execute(),
    ).rejects.toThrow(/cannot be deleted/);
  });

  it('§4.7 invariant 7: the redemption counter can never exceed the limit, even by a direct update', async () => {
    const id = await createDiscountFixture(t, { redemptionLimit: 2 });
    const bump = () =>
      db
        .updateTable('discount_redemptions')
        .set({ redeemed_count: sql`redeemed_count + 1` })
        .where('organization_id', '=', org)
        .where('discount_definition_id', '=', id)
        .where((eb) =>
          eb.or([
            eb('redemption_limit', 'is', null),
            eb('redeemed_count', '<', eb.ref('redemption_limit')),
          ]),
        )
        .returning('redeemed_count')
        .executeTakeFirst();
    expect((await bump())?.redeemed_count).toBe(1);
    expect((await bump())?.redeemed_count).toBe(2);
    expect(await bump()).toBeUndefined(); // conditional update refuses at the limit
    await expect(
      db
        .updateTable('discount_redemptions')
        .set({ redeemed_count: 3 })
        .where('discount_definition_id', '=', id)
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      db
        .updateTable('discount_redemptions')
        .set({ redemption_limit: 1 })
        .where('discount_definition_id', '=', id)
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      db
        .updateTable('discount_redemptions')
        .set({ redeemed_count: -1 })
        .where('discount_definition_id', '=', id)
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('§4.7 invariant 5: one redeem and one release per reference; the ledger is append-only', async () => {
    const id = await createDiscountFixture(t);
    const reference = newId();
    const entry = (kind: 'redeem' | 'release') => ({
      id: newId(),
      organization_id: org,
      discount_definition_id: id,
      kind,
      reference_type: 'order_line',
      reference_id: reference,
      person_id: null,
      amount_minor: 500,
      currency: 'USD',
      actor,
      occurred_at: t.clock.now(),
    });
    const first = entry('redeem');
    await db.insertInto('discount_redemption_entries').values(first).execute();
    await expect(
      db.insertInto('discount_redemption_entries').values(entry('redeem')).execute(),
    ).rejects.toSatisfy(isUniqueViolation);
    await db.insertInto('discount_redemption_entries').values(entry('release')).execute();
    await expect(
      db
        .updateTable('discount_redemption_entries')
        .set({ amount_minor: 1 })
        .where('id', '=', first.id)
        .execute(),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.deleteFrom('discount_redemption_entries').where('id', '=', first.id).execute(),
    ).rejects.toThrow(/append-only/);
  });

  it('SPK-PAY-003: promo codes are unique per organization regardless of case; shape checks hold', async () => {
    await createDiscountFixture(t, { code: 'Spring26' });
    await expect(createDiscountFixture(t, { code: 'SPRING26' })).rejects.toSatisfy(
      isUniqueViolation,
    );
    await expect(
      createDiscountFixture(t, { amountKind: 'percentage', amountValue: 10_001 }),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      createDiscountFixture(t, { amountKind: 'fixed', currency: null }),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('SPK-REG-009: the database refuses rewriting acknowledgment signer evidence, reopening a withdrawal and deleting', async () => {
    const policy = await createPolicyVersionFixture(t, { kind: 'form' });
    const adult = await createPersonFixture(t, { kind: 'adult' });
    const child = await createPersonFixture(t, { kind: 'child' });
    const other = await createPersonFixture(t, { kind: 'adult' });
    const id = await createAcknowledgmentFixture(t, {
      subjectPersonId: child,
      policyVersionId: policy,
      signedByPersonId: adult,
    });
    const rewrite = (values: Record<string, unknown>) =>
      db
        .updateTable('acknowledgments')
        .set(values as never)
        .where('id', '=', id)
        .execute();
    for (const values of [
      { signed_at: new Date('2000-01-01T00:00:00Z') },
      { evidence: json({ forged: true }) },
      { signed_by_person_id: other },
      { recorded_by_kind: 'system' },
      { basis: 'self', signed_by_person_id: child },
    ]) {
      await expect(rewrite(values)).rejects.toThrow(/cannot be rewritten/);
    }
    await expect(db.deleteFrom('acknowledgments').where('id', '=', id).execute()).rejects.toThrow(
      /append-only/,
    );
    // the one allowed change: active -> withdrawn, final
    await rewrite({ status: 'withdrawn', withdrawn_at: t.clock.now(), withdrawn_reason: 'test' });
    await expect(
      rewrite({ status: 'active', withdrawn_at: null, withdrawn_reason: null }),
    ).rejects.toThrow(/withdrawal is final/);
    await expect(rewrite({ withdrawn_reason: 'changed' })).rejects.toThrow(/withdrawal is final/);
    const row = await db
      .selectFrom('acknowledgments')
      .select(['status', 'signed_by_person_id'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ status: 'withdrawn', signed_by_person_id: adult });
  });

  it('SPK-REG-009: one active acknowledgment per (subject, policy); a staff recorder is never the signer', async () => {
    const policy = await createPolicyVersionFixture(t, { kind: 'form' });
    const adult = await createPersonFixture(t, { kind: 'adult' });
    const child = await createPersonFixture(t, { kind: 'child' });
    const staff = await createStaffMemberFixture(t, { roles: ['front_desk'] });
    const first = await createAcknowledgmentFixture(t, {
      subjectPersonId: child,
      policyVersionId: policy,
      signedByPersonId: adult,
    });
    await expect(
      createAcknowledgmentFixture(t, {
        subjectPersonId: child,
        policyVersionId: policy,
        signedByPersonId: adult,
      }),
    ).rejects.toSatisfy(isUniqueViolation);
    // a withdrawn acknowledgment does not block a fresh one
    await db
      .updateTable('acknowledgments')
      .set({ status: 'withdrawn', withdrawn_at: t.clock.now(), withdrawn_reason: 'test' })
      .where('id', '=', first)
      .execute();
    await createAcknowledgmentFixture(t, {
      subjectPersonId: child,
      policyVersionId: policy,
      signedByPersonId: adult,
    });
    // the staff actor who records cannot be the signer
    const other = await createPersonFixture(t, { kind: 'child' });
    await expect(
      createAcknowledgmentFixture(t, {
        subjectPersonId: other,
        policyVersionId: policy,
        signedByPersonId: staff.personId,
        recordedByKind: 'staff',
        recordedByPersonId: staff.personId,
      }),
    ).rejects.toSatisfy(isCheckViolation);
    // ... but may record a guardian's signature
    await createAcknowledgmentFixture(t, {
      subjectPersonId: other,
      policyVersionId: policy,
      signedByPersonId: adult,
      recordedByKind: 'staff',
      recordedByPersonId: staff.personId,
    });
    // basis must agree with who signed
    await expect(
      db
        .insertInto('acknowledgments')
        .values({
          id: newId(),
          organization_id: org,
          subject_person_id: adult,
          policy_version_id: policy,
          signed_by_person_id: adult,
          basis: 'guardian',
          recorded_by: actor,
          recorded_by_kind: 'customer',
          recorded_by_person_id: adult,
          signed_at: t.clock.now(),
          withdrawn_at: null,
          withdrawn_reason: null,
        })
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
    // the signer must be a person of the same organization
    const foreign = await createPersonFixture(t, {
      kind: 'adult',
      organizationId: otherOrg.organizationId,
    });
    const freshChild = await createPersonFixture(t, { kind: 'child' });
    await expect(
      createAcknowledgmentFixture(t, {
        subjectPersonId: freshChild,
        policyVersionId: policy,
        signedByPersonId: foreign,
      }),
    ).rejects.toSatisfy(isForeignKeyViolation);
  });

  it('SPK-CAT-004: an offering beyond draft must carry its required configuration', async () => {
    const programId = await createProgramFixture(t);
    const bare = () => ({
      id: newId(),
      organization_id: org,
      program_id: programId,
      facility_id: t.facilityId,
      name: 'Bare',
      description: null,
      kind: 'term' as const,
      activity_type: 'soccer',
      format: null,
      starts_on: '2027-01-01',
      ends_on: '2027-02-01',
      registration_opens_at: null,
      registration_closes_at: null,
      eligibility_reference_date: null,
      eligibility_policy_version_id: null,
      entitlement_definition_id: null,
      cancellation_policy_version_id: null,
      responsible_manager_person_id: null,
      published_at: t.clock.now(),
      registration_opened_at: null,
      closed_at: null,
      archived_at: null,
      copied_from_offering_id: null,
      created_by: actor,
    });
    await db
      .insertInto('offerings')
      .values({ ...bare(), publication_state: 'draft' })
      .execute();
    await expect(
      db
        .insertInto('offerings')
        .values({ ...bare(), publication_state: 'published' })
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      db
        .insertInto('offerings')
        .values({ ...bare(), publication_state: 'live' as never })
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      db
        .insertInto('offerings')
        .values({ ...bare(), publication_state: 'draft', ends_on: '2026-12-31' })
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it("§4.3: an offering cannot reference another organization's program, policy or manager", async () => {
    const foreignProgram = await createProgramFixture(t, {
      organizationId: otherOrg.organizationId,
    });
    await expect(
      createOfferingFixture(t, {
        responsibleManagerPersonId: manager,
        programId: foreignProgram,
        publicationState: 'draft',
        basePriceMinor: null,
      }),
    ).rejects.toSatisfy(isForeignKeyViolation);
    const foreignPolicy = await createPolicyVersionFixture(t, {
      kind: 'eligibility',
      organizationId: otherOrg.organizationId,
    });
    await expect(
      createOfferingFixture(t, {
        responsibleManagerPersonId: manager,
        eligibilityPolicyVersionId: foreignPolicy,
        publicationState: 'draft',
        basePriceMinor: null,
      }),
    ).rejects.toSatisfy(isForeignKeyViolation);
    const foreignManager = await createPersonFixture(t, {
      kind: 'adult',
      organizationId: otherOrg.organizationId,
    });
    await expect(
      createOfferingFixture(t, {
        responsibleManagerPersonId: foreignManager,
        publicationState: 'draft',
        basePriceMinor: null,
      }),
    ).rejects.toSatisfy(isForeignKeyViolation);
  });

  it('§4.4 Session: one sequence per offering, ordered interval, cancellation columns agree', async () => {
    const offering = await createOfferingFixture(t, { responsibleManagerPersonId: manager });
    const row = (overrides: Record<string, unknown>) => ({
      id: newId(),
      organization_id: org,
      offering_id: offering.offeringId,
      sequence: 1,
      title: null,
      scheduled_start: new Date('2027-01-10T17:00:00Z'),
      scheduled_end: new Date('2027-01-10T18:00:00Z'),
      scheduling_event_id: null,
      capacity_override: null,
      canceled_at: null,
      cancel_reason: null,
      ...overrides,
    });
    await db.insertInto('offering_sessions').values(row({})).execute();
    await expect(db.insertInto('offering_sessions').values(row({})).execute()).rejects.toSatisfy(
      isUniqueViolation,
    );
    await expect(
      db
        .insertInto('offering_sessions')
        .values(row({ sequence: 2, scheduled_end: new Date('2027-01-10T16:00:00Z') }))
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      db
        .insertInto('offering_sessions')
        .values(row({ sequence: 3, status: 'canceled' }))
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('§4.4 Approval: approvals are append-only facts', async () => {
    const policy = await createPolicyVersionFixture(t, { kind: 'hold' });
    const id = newId();
    await db
      .insertInto('approvals')
      .values({
        id,
        organization_id: org,
        subject_type: 'policy_version',
        subject_id: policy,
        decision: 'approved',
        actor,
        actor_person_id: manager,
        reason: null,
        occurred_at: t.clock.now(),
      })
      .execute();
    await expect(
      db.updateTable('approvals').set({ decision: 'rejected' }).where('id', '=', id).execute(),
    ).rejects.toThrow(/append-only/);
    await expect(db.deleteFrom('approvals').where('id', '=', id).execute()).rejects.toThrow(
      /append-only/,
    );
  });
});
