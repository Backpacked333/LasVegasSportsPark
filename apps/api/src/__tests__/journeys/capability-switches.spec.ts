import { CAPABILITY_IDS } from '@sportspark/contracts';
import { describe, expect, it } from 'vitest';
import type { TestApp } from '../../testing';
import {
  createAcknowledgmentFixture,
  createOfferingFixture,
  createProgramFixture,
  type OfferingFixture,
} from '../../modules/catalog';
import { MEMBERSHIP_LIFECYCLE_JOB } from '../../modules/enrollment/services/enrollment-jobs';
import {
  FAKE_PAYMENTS_PROVIDER,
  FAKE_PAYMENTS_SIGNATURE_HEADER,
  FakePaymentProvider,
  FakePaymentTokens,
} from '../../modules/finance';
import {
  adult,
  disableCapability,
  drain,
  enableCapability,
  get,
  journeyApp,
  ok,
  post,
  processInbox,
  staff,
  type Actor,
} from './support';

/**
 * K-12, DEC-016 (Package G, §6.5): every capability starts off for an organization; only a system
 * administrator switches one, naming DEC-016 or the capability's own decision record, and the
 * change is audited. Switching off stops new commitments (a new line, and checkout of a line held
 * before the switch, before any payment is attempted) while reads, cancellations, refunds,
 * expiry and provider outcomes of what already exists keep working. `/v1/me/permissions` reflects
 * the switch. Memberships (DEC-072) is the capability exercised; prices and terms are test data.
 */

interface Capability {
  capability: string;
  enabled: boolean;
  decisionReference: string | null;
  revision: number | null;
}

interface MePermissions {
  capabilities: Array<{ id: string; enabled: boolean }>;
}

describe('K-12 capability switches (assembled application)', () => {
  it('DEC-016: off by default; administrator-only with an applicability reference; switching off stops new commitments but never what already exists', async () => {
    const t: TestApp = await journeyApp({ clockStart: '2026-11-09T16:00:00Z' });
    try {
      const admin = await staff(t, ['system_administrator']);
      const gm = await staff(t, ['general_manager']);
      const pm = await staff(t, ['program_manager']);
      const finance = await staff(t, ['finance_operator']);

      // Every capability is off for a new organization, and the permission view says so.
      const listed = await ok<{ items: Capability[] }>(
        get(t, '/v1/admin/capabilities', admin.header),
      );
      expect(listed.items.map((c) => c.capability)).toEqual([...CAPABILITY_IDS]);
      expect(listed.items.every((c) => !c.enabled && c.revision === null)).toBe(true);
      const membershipsSwitch = async (actor: Actor) =>
        (await ok<MePermissions>(get(t, '/v1/me/permissions', actor.header))).capabilities.find(
          (c) => c.id === 'memberships',
        );
      expect(await membershipsSwitch(pm)).toMatchObject({ enabled: false });

      // A membership definition and offering exist; selling one is refused while off.
      const program = await createProgramFixture(t, { ageBand: { minAgeYears: 18 } });
      const target = await createOfferingFixture(t, {
        responsibleManagerPersonId: pm.personId,
        programId: program,
        kind: 'session',
        basePriceMinor: 2_500,
      });
      const enableAs = (actor: Actor, decisionReference: string) =>
        post(t, '/v1/admin/capabilities/memberships/enable', actor.header, {
          decisionReference,
          reason: 'Memberships offered from November',
        });
      expect((await enableAs(gm, 'DEC-072')).status).toBe(403);
      const related = await enableAs(admin, 'DEC-057');
      expect(related.status).toBe(400);
      expect(related.body.details).toMatchObject({
        code: 'NOT_AN_APPLICABILITY_DECISION',
        applicabilityReferences: ['DEC-016', 'DEC-072'],
      });
      await enableCapability(t, admin, 'memberships', 'DEC-072');
      expect(await membershipsSwitch(pm)).toMatchObject({ enabled: true });
      const audit = await ok<{ items: Array<Record<string, unknown>> }>(
        get(t, '/v1/audit-records?targetType=capability&targetId=memberships', admin.header),
      );
      expect(audit.items).toEqual([
        expect.objectContaining({
          action: 'core.manage_capabilities.enable',
          afterRevision: 1,
          actor: expect.objectContaining({ personId: admin.personId }),
        }),
      ]);

      const definition = await ok<{ id: string }>(
        post(t, '/v1/entitlement-definitions', pm.header, {
          name: 'Monthly membership',
          kind: 'membership_benefit',
          scope: {
            attendance: {
              mode: 'included_sessions',
              appliesTo: { offeringIds: [target.offeringId] },
              limit: { count: 2, period: 'week', weekStartsOn: 1 },
            },
            term: { kind: 'offering_dates' },
            renewal: { noticeLeadDays: null },
          },
          equivalenceScope: 'none',
        }),
        201,
      );
      const membership = await createOfferingFixture(t, {
        responsibleManagerPersonId: pm.personId,
        programId: program,
        kind: 'membership',
        publicationState: 'draft',
        entitlementDefinitionId: definition.id,
        basePriceMinor: 9_000,
        capacityUnits: [{ unit: 'seats', limit: 500 }],
        startsOn: '2026-11-01',
        endsOn: '2026-11-30',
      });
      await ok(post(t, `/v1/offerings/${membership.offeringId}/publish`, pm.header, {}));
      await ok(post(t, `/v1/offerings/${membership.offeringId}/registration/open`, pm.header, {}));

      const buyer = async () => {
        const actor = await adult(t);
        await acknowledge(t, actor, membership);
        return actor;
      };
      const heldBasket = async (actor: Actor) => {
        const basket = await ok<{ id: string }>(
          post(t, '/v1/baskets', actor.header, { ownerPersonId: actor.personId }),
          201,
        );
        const line = await ok<{ revision: number }>(addLine(t, actor, basket.id, membership), 201);
        await ok(
          post(t, `/v1/baskets/${basket.id}/hold`, actor.header, {
            expectedRevision: line.revision,
          }),
        );
        const quote = await ok<{ id: string }>(
          post(t, '/v1/registration-quotes', actor.header, { basketId: basket.id }),
          201,
        );
        return { basketId: basket.id, quoteId: quote.id };
      };
      const checkout = (actor: Actor, quoteId: string, token: string) =>
        post(t, '/v1/registration-checkouts', actor.header, {
          quoteId,
          payment: { method: 'provider', paymentMethodToken: token },
        });
      const membershipsOf = async (actor: Actor) =>
        (
          await ok<{ items: Array<{ enrollmentId: string; status: string; revision?: number }> }>(
            get(t, '/v1/me/memberships', actor.header),
          )
        ).items;
      const paymentsOf = async (actor: Actor) =>
        (
          await ok<{ items: Array<{ id: string; status: string }> }>(
            get(t, '/v1/me/payments', actor.header),
          )
        ).items;

      // Before the switch goes off: one membership bought and paid; one paid by a method whose
      // outcome arrives later; one basket held but not yet paid.
      const paid = await buyer();
      const paidBasket = await heldBasket(paid);
      expect(
        (
          await ok<{ status: string }>(
            checkout(paid, paidBasket.quoteId, FakePaymentTokens.succeed),
            201,
          )
        ).status,
      ).toBe('completed');
      await drain(t);
      const [paidMembership] = await membershipsOf(paid);
      expect(paidMembership).toMatchObject({ status: 'confirmed' });

      const pending = await buyer();
      const pendingBasket = await heldBasket(pending);
      const processing = await ok<{ status: string }>(
        checkout(pending, pendingBasket.quoteId, FakePaymentTokens.processing),
        201,
      );
      expect(processing.status).not.toBe('completed');
      const [pendingPayment] = await paymentsOf(pending);
      expect(pendingPayment).toBeDefined();

      const late = await buyer();
      const lateBasket = await heldBasket(late);

      // The administrator switches memberships off (DEC-016), and the permission view follows.
      await disableCapability(t, admin, 'memberships', 'DEC-016');
      expect(await membershipsSwitch(pm)).toMatchObject({ enabled: false });

      // No new line.
      const newcomer = await buyer();
      const basket = await ok<{ id: string }>(
        post(t, '/v1/baskets', newcomer.header, { ownerPersonId: newcomer.personId }),
        201,
      );
      const refusedLine = await addLine(t, newcomer, basket.id, membership);
      expect(refusedLine.status).toBe(403);
      expect(refusedLine.body.details).toMatchObject({
        code: 'CAPABILITY_DISABLED',
        capability: 'memberships',
      });
      // The line held before the switch cannot be checked out, and no payment is attempted.
      const provider = t.app.get(FakePaymentProvider);
      const chargesBefore = provider.chargeCount();
      const refusedCheckout = await checkout(late, lateBasket.quoteId, FakePaymentTokens.succeed);
      expect(refusedCheckout.status).toBe(403);
      expect(refusedCheckout.body.details).toMatchObject({
        code: 'CAPABILITY_DISABLED',
        capability: 'memberships',
      });
      expect(provider.chargeCount()).toBe(chargesBefore);
      expect(await paymentsOf(late)).toEqual([]);
      // ...but its holder may still read and release it.
      expect(
        (await ok<{ status: string }>(get(t, `/v1/baskets/${lateBasket.basketId}`, late.header)))
          .status,
      ).toBe('held');
      await ok(
        post(t, `/v1/baskets/${lateBasket.basketId}/release`, late.header, {
          reason: 'No longer sold',
        }),
      );

      // A provider outcome for a payment started before the switch still completes it.
      provider.settlePayment(pendingPayment!.id, 'succeeded');
      const event = provider.paymentWebhook(pendingPayment!.id);
      const delivered = await t.http
        .post(`/v1/webhooks/payments/${FAKE_PAYMENTS_PROVIDER}`)
        .set(FAKE_PAYMENTS_SIGNATURE_HEADER, event.signature)
        .send(event.body as object);
      expect(delivered.status, JSON.stringify(delivered.body)).toBeLessThan(300);
      await processInbox(t);
      expect(await membershipsOf(pending)).toEqual([
        expect.objectContaining({ status: 'confirmed' }),
      ]);

      // Reads, refunds and cancellations of what exists keep working.
      const [paidPayment] = await paymentsOf(paid);
      const refund = await ok<{ status: string }>(
        post(t, `/v1/payments/${paidPayment!.id}/refunds`, finance.header, {
          amountMinor: 9_000,
          reason: 'Membership withdrawn',
        }),
        201,
      );
      expect(refund.status).toBe('succeeded');
      const enrollment = await ok<{ revision: number }>(
        get(t, `/v1/enrollments/${paidMembership!.enrollmentId}`, pm.header),
      );
      const preview = await ok<{
        financialConsequence: { kind: string; amountMinor: number | null; currency: string | null };
      }>(get(t, `/v1/enrollments/${paidMembership!.enrollmentId}/cancellation-preview`, pm.header));
      const consequence = preview.financialConsequence;
      const canceled = await ok<{ status: string }>(
        post(t, `/v1/enrollments/${paidMembership!.enrollmentId}/cancel`, pm.header, {
          reason: 'Memberships are no longer offered',
          expectedRevision: enrollment.revision,
          acceptedConsequence: {
            kind: consequence.kind,
            amountMinor: consequence.amountMinor,
            currency: consequence.currency,
          },
        }),
      );
      expect(canceled.status).toBe('canceled');

      // Expiry is never gated: the lifecycle job completes the other membership at its term end.
      t.clock.set(new Date('2026-12-02T08:00:00Z'));
      const [job] = await t.runPeriodicJobs([MEMBERSHIP_LIFECYCLE_JOB]);
      expect(job, JSON.stringify(job)).toMatchObject({ ran: true, failed: false });
      await drain(t);
      expect(await membershipsOf(pending)).toEqual([
        expect.objectContaining({ status: 'completed' }),
      ]);
    } finally {
      await t.close();
    }
  });
});

async function acknowledge(t: TestApp, actor: Actor, offering: OfferingFixture): Promise<void> {
  await createAcknowledgmentFixture(t, {
    subjectPersonId: actor.personId,
    policyVersionId: offering.formPolicyVersionId,
    signedByPersonId: actor.personId,
  });
}

function addLine(t: TestApp, actor: Actor, basketId: string, offering: OfferingFixture) {
  return post(t, `/v1/baskets/${basketId}/lines`, actor.header, {
    participantPersonId: actor.personId,
    offeringId: offering.offeringId,
    intent: 'membership',
  });
}
