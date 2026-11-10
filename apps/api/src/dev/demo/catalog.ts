import { FakePaymentTokens } from '../../modules/finance';
import { DemoRequestError, type DemoSession } from './client';
import { localDate, localInstant, type DemoContext } from './context';

export const DEMO_CURRENCY = 'USD';

export interface DemoOfferingInput {
  /** Prefix of the policy keys (`<slug>-eligibility`, ...): lower-case letters, digits, `-`. */
  slug: string;
  program: {
    name: string;
    description: string;
    format: string;
    ageBand: { minAgeYears?: number; maxAgeYears?: number };
  };
  entitlementName: string;
  offering: {
    name: string;
    description: string;
    kind: 'term' | 'season';
    locationLabel: string;
    resourceIds: string[];
    startDayOffset: number;
    endDayOffset: number;
    seats: number;
  };
  basePriceMinor: number;
  wording: { eligibility: string; cancellation: string; form: string };
}

export interface DemoOffering {
  programId: string;
  offeringId: string;
  formPolicyVersionId: string;
}

/**
 * A policy version drafted by the program manager and approved by the role that owns its kind
 * (catalog.approve_financial_policy: finance; catalog.approve_participation_policy: league or
 * program management). The approver is never the author.
 */
async function approvedPolicy(
  ctx: DemoContext,
  slug: string,
  kind: 'eligibility' | 'cancellation' | 'form',
  text: string,
): Promise<string> {
  const draft = await ctx.api.post<{ id: string }>('/policy-versions', ctx.staff.program, {
    kind,
    key: `${slug}-${kind}`,
    title: `Demo ${kind} wording (synthetic)`,
    content: { text },
    effectiveFrom: localInstant(ctx, -60, '09:00'),
  });
  const approver = kind === 'cancellation' ? ctx.staff.finance : ctx.staff.league;
  await ctx.api.post(`/policy-versions/${draft.id}/approve`, approver, {});
  return draft.id;
}

/**
 * Finance prices an offering from now on. A price rule never covers instants already passed
 * (SPK-PAY-002), and publication needs the open registration window priced, so the rule starts a
 * moment ahead and the seed waits for that moment before it publishes.
 */
async function priceFromNow(
  ctx: DemoContext,
  offeringId: string,
  basePriceMinor: number,
): Promise<void> {
  const path = `/offerings/${offeringId}/price-rules`;
  const margins = [500, 3_000, 15_000];
  for (const [attempt, marginMs] of margins.entries()) {
    const effectiveFrom = new Date(ctx.clock.now().getTime() + marginMs);
    const response = await ctx.api.request<{ details?: { path?: string } }>(
      'POST',
      path,
      ctx.staff.finance,
      {
        effectiveFrom: effectiveFrom.toISOString(),
        basePriceMinor,
        currency: DEMO_CURRENCY,
        chargeLines: [],
      },
    );
    if (response.status === 201) {
      await ctx.waitUntil(effectiveFrom);
      return;
    }
    // "effectiveFrom is in the past" means the request took longer than the margin: try a wider
    // one. Any other refusal, and the last attempt's, stops the seed with the API's answer.
    const tooLate = response.status === 400 && response.body?.details?.path === 'effectiveFrom';
    if (!tooLate || attempt === margins.length - 1) {
      throw new DemoRequestError('POST', path, response.status, response.body);
    }
  }
}

/**
 * A program and one offering of it, taken through the whole publication path (SPK-CAT-001..004):
 * entitlement definition, approved eligibility, cancellation and form policies, capacity, a price
 * rule from finance (SPK-PAY-001: prices come from the catalog), publication by the responsible
 * program manager, then registration opened.
 */
export async function publishOffering(
  ctx: DemoContext,
  input: DemoOfferingInput,
): Promise<DemoOffering> {
  const { api } = ctx;
  const manager: DemoSession = ctx.staff.program;
  const program = await api.post<{ id: string }>('/programs', manager, {
    name: input.program.name,
    description: input.program.description,
    activityType: 'soccer',
    format: input.program.format,
    ageBand: input.program.ageBand,
    status: 'active',
  });
  const entitlement = await api.post<{ id: string }>('/entitlement-definitions', manager, {
    name: input.entitlementName,
    kind: 'seat',
    equivalenceScope: 'offering',
  });
  const eligibility = await approvedPolicy(
    ctx,
    input.slug,
    'eligibility',
    input.wording.eligibility,
  );
  const cancellation = await approvedPolicy(
    ctx,
    input.slug,
    'cancellation',
    input.wording.cancellation,
  );
  const form = await approvedPolicy(ctx, input.slug, 'form', input.wording.form);

  const { startDayOffset, endDayOffset } = input.offering;
  let offering = await api.post<{ id: string; staff: { revision: number } }>(
    '/offerings',
    manager,
    {
      programId: program.id,
      name: input.offering.name,
      description: input.offering.description,
      kind: input.offering.kind,
      facilityId: ctx.facilityId,
      location: { label: input.offering.locationLabel, resourceIds: input.offering.resourceIds },
      startsOn: localDate(ctx, startDayOffset),
      endsOn: localDate(ctx, endDayOffset),
      registrationOpensAt: localInstant(ctx, startDayOffset - 14, '09:00'),
      registrationClosesAt: localInstant(ctx, Math.min(endDayOffset, 28), '21:00'),
      eligibilityReferenceDate: localDate(ctx, startDayOffset),
      eligibilityPolicyVersionId: eligibility,
      entitlementDefinitionId: entitlement.id,
      capacityUnits: [{ unit: 'seats', limit: input.offering.seats }],
      requiredFormPolicyVersionIds: [form],
      cancellationPolicyVersionId: cancellation,
      responsibleManagerPersonId: manager.personId,
    },
  );
  await priceFromNow(ctx, offering.id, input.basePriceMinor);
  offering = await api.post(`/offerings/${offering.id}/publish`, manager, {
    expectedRevision: offering.staff.revision,
    reason: 'Demo offering published (synthetic example)',
  });
  await api.post(`/offerings/${offering.id}/registration/open`, manager, {
    expectedRevision: offering.staff.revision,
  });
  return { programId: program.id, offeringId: offering.id, formPolicyVersionId: form };
}

/**
 * One family or player registers and pays (SPK-REG-001..004, §4.11): the payer's basket is held,
 * quoted by the server and paid through the deterministic fake provider's success path (§5.2).
 */
export async function checkoutBasket(
  ctx: DemoContext,
  payer: DemoSession,
  basketId: string,
  hold: { expectedRevision: number } | null,
): Promise<{ checkoutId: string; orderId: string | null }> {
  if (hold) await ctx.api.post(`/baskets/${basketId}/hold`, payer, hold);
  const quote = await ctx.api.post<{ id: string }>('/registration-quotes', payer, { basketId });
  const checkout = await ctx.api.post<{ id: string; status: string; orderId?: string | null }>(
    '/registration-checkouts',
    payer,
    {
      quoteId: quote.id,
      payment: { method: 'provider', paymentMethodToken: FakePaymentTokens.succeed },
    },
  );
  if (checkout.status !== 'completed') {
    throw new Error(`demo seed: checkout ${checkout.id} is ${checkout.status}, not completed`);
  }
  // Confirmation is a durable follow-up (§4.12): run it before the next registration.
  await ctx.drain();
  return { checkoutId: checkout.id, orderId: checkout.orderId ?? null };
}
