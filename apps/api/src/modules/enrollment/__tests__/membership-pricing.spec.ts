import { newId } from '@sportspark/contracts';
import { json, seedOrganization } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { createEntitlementDefinitionFixture } from '../../catalog';
import { createPersonFixture } from '../../identity';
import { MEMBERSHIP_PRICING_PORT, type MembershipPricingPort } from '../enrollment.ports';
import { createEnrollmentFixture } from '../testing/enrollment-fixtures';
import { enrollmentTestApp, offering } from './support';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-02T15:00:00Z');

/**
 * MEMBERSHIP_PRICING_PORT (SPK-PAY-015, proposed amendment PA-04; DEC-098 pending): what finance
 * asks before applying a member price. The rule is the membership ledger's own (ENR-12,
 * SPK-COND-001): a confirmed membership whose term covers the instant and that no active
 * suspension covers. Dates and names are test data, not policy.
 */
describe('membership pricing port (SPK-PAY-015, SPK-COND-001, SPK-IAM-007)', () => {
  let t: TestApp;
  let port: MembershipPricingPort;
  let offeringId: string;
  let definitionId: string;
  let otherDefinitionId: string;
  const at = new Date(NOW);

  async function membership(
    personId: string,
    options: {
      from?: number;
      to?: number;
      entitlementDefinitionId?: string;
      status?: 'pending' | 'confirmed' | 'canceled';
    } = {},
  ): Promise<string> {
    const status = options.status ?? 'confirmed';
    const enrollmentId = await createEnrollmentFixture(t, {
      offeringId,
      participantPersonId: personId,
      intent: 'membership',
      entitlementDefinitionId: options.entitlementDefinitionId ?? definitionId,
      status,
    });
    if (status !== 'pending') {
      await t.db
        .updateTable('enrollments')
        .set({
          membership_starts_at: new Date(options.from ?? NOW - 30 * DAY),
          membership_ends_at: new Date(options.to ?? NOW + 335 * DAY),
        })
        .where('id', '=', enrollmentId)
        .execute();
    }
    return enrollmentId;
  }

  const suspend = (enrollmentId: string, personId: string, from: number, until: number | null) =>
    t.db
      .insertInto('membership_suspensions')
      .values({
        id: newId(),
        organization_id: t.organizationId,
        enrollment_id: enrollmentId,
        participant_person_id: personId,
        suspended_from: new Date(from),
        suspended_until: until === null ? null : new Date(until),
        reason: 'injury',
        created_by: json({ kind: 'system' }),
      })
      .execute();

  const person = () => createPersonFixture(t, { kind: 'child' });
  const standing = (personId: string, definition = definitionId, organizationId?: string) =>
    port.memberStanding(organizationId ?? t.organizationId, personId, definition, at);

  beforeAll(async () => {
    t = await enrollmentTestApp();
    port = t.app.get<MembershipPricingPort>(MEMBERSHIP_PRICING_PORT);
    offeringId = (await offering(t)).offeringId;
    definitionId = await createEntitlementDefinitionFixture(t, { kind: 'membership_benefit' });
    otherDefinitionId = await createEntitlementDefinitionFixture(t, {
      kind: 'membership_benefit',
    });
  });
  afterAll(async () => {
    await t.close();
  });

  it('SPK-PAY-015: a confirmed membership granting the named entitlement whose term covers the instant holds, and the answer names it', async () => {
    const member = await person();
    const enrollmentId = await membership(member);
    expect(await standing(member)).toEqual({
      holds: true,
      reason: 'active_membership',
      membershipEnrollmentId: enrollmentId,
    });
    // SPK-COND-001: a membership grants only what its entitlement states.
    expect(await standing(member, otherDefinitionId)).toEqual({
      holds: false,
      reason: 'no_active_membership',
      membershipEnrollmentId: null,
    });
    // Organization scope: the same ids in another organization hold nothing.
    const other = await seedOrganization(t.db);
    expect((await standing(member, definitionId, other.organizationId)).holds).toBe(false);
  });

  it('SPK-PAY-015: no membership, a lapsed one, one that has not started, a pending one and a canceled one do not hold', async () => {
    const none = await person();
    const lapsed = await person();
    await membership(lapsed, { from: NOW - 400 * DAY, to: NOW });
    const future = await person();
    await membership(future, { from: NOW + 1, to: NOW + 365 * DAY });
    const pending = await person();
    await membership(pending, { status: 'pending' });
    const canceled = await person();
    await membership(canceled, { status: 'canceled' });
    for (const personId of [none, lapsed, future, pending, canceled]) {
      expect(await standing(personId)).toEqual({
        holds: false,
        reason: 'no_active_membership',
        membershipEnrollmentId: null,
      });
    }
    // The term is half-open: it holds at its first instant.
    const starting = await person();
    await membership(starting, { from: NOW, to: NOW + 365 * DAY });
    expect((await standing(starting)).holds).toBe(true);
  });

  it('SPK-PAY-015: a suspension covering the instant means the membership does not hold, and says so; one that is over does not', async () => {
    const suspended = await person();
    const suspendedId = await membership(suspended);
    await suspend(suspendedId, suspended, NOW - DAY, null);
    expect(await standing(suspended)).toEqual({
      holds: false,
      reason: 'membership_suspended',
      membershipEnrollmentId: null,
    });
    const resumed = await person();
    const resumedId = await membership(resumed);
    await suspend(resumedId, resumed, NOW - 10 * DAY, NOW - DAY);
    expect(await standing(resumed)).toMatchObject({ holds: true, reason: 'active_membership' });
    // A second, unsuspended membership of the same person holds.
    const second = await membership(suspended);
    expect(await standing(suspended)).toEqual({
      holds: true,
      reason: 'active_membership',
      membershipEnrollmentId: second,
    });
  });

  it("SPK-IAM-007: the memberships of a record merged into the participant are the participant's", async () => {
    const survivor = await person();
    const duplicate = await person();
    const enrollmentId = await membership(duplicate);
    expect((await standing(survivor)).holds).toBe(false);
    await t.db
      .updateTable('persons')
      .set({ status: 'merged', merged_into_person_id: survivor })
      .where('id', '=', duplicate)
      .execute();
    expect(await standing(survivor)).toEqual({
      holds: true,
      reason: 'active_membership',
      membershipEnrollmentId: enrollmentId,
    });
    // An unknown person holds nothing.
    expect((await standing(newId())).holds).toBe(false);
  });
});
