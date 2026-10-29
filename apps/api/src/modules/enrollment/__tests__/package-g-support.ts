import type { OfferingKind } from '@sportspark/contracts';
import { json } from '@sportspark/db';
import type { TestApp } from '../../../testing';
import { createEntitlementDefinitionFixture, createPolicyVersionFixture } from '../../catalog';
import { offering, type OfferingSetup } from './support';

/**
 * Package G test helpers (ENR-10 to ENR-14; not a spec file). The catalog's typed scopes are
 * CAT-02's: these helpers write a complete scope for the entitlement kind (every key stated, as
 * CAT-02 and migration 0205 require), so the same tests run on the core branch and after the
 * catalog work item is merged. Values here are test values, never policy defaults.
 */

type DefinitionKind = 'package_credits' | 'membership_benefit' | 'rental_resource';

export async function definitionWithScope(
  t: TestApp,
  kind: DefinitionKind,
  scope: Record<string, unknown>,
  equivalenceScope: 'offering' | 'none' = 'offering',
): Promise<string> {
  const id = await createEntitlementDefinitionFixture(t, { kind, equivalenceScope });
  await t.db
    .updateTable('entitlement_definitions')
    .set({ scope: json(scope) })
    .where('id', '=', id)
    .execute();
  return id;
}

/** A registration-open `package` offering whose credits apply to the given offerings/programs. */
export async function packageOffering(
  t: TestApp,
  input: {
    credits: number;
    appliesTo: { offeringIds?: string[]; programIds?: string[] };
    expiry?: Record<string, unknown>;
    basePriceMinor?: number | null;
    capacity?: number;
    cancellationPolicyVersionId?: string;
  },
): Promise<OfferingSetup & { definitionId: string }> {
  const definitionId = await definitionWithScope(t, 'package_credits', {
    credits: input.credits,
    appliesTo: input.appliesTo,
    expiry: input.expiry ?? { kind: 'none' },
  });
  const setup = await offering(t, {
    kind: 'package',
    entitlementDefinitionId: definitionId,
    basePriceMinor: input.basePriceMinor === undefined ? 0 : input.basePriceMinor,
    capacityUnits: [{ unit: 'seats', limit: input.capacity ?? 50 }],
    ageBand: { minAgeYears: 18 },
    cancellationPolicyVersionId: input.cancellationPolicyVersionId,
  });
  return { ...setup, definitionId };
}

/** A registration-open `membership` offering with the given benefit scope. */
export async function membershipOffering(
  t: TestApp,
  scope: Record<string, unknown>,
  input: { basePriceMinor?: number | null; startsOn?: string; endsOn?: string } = {},
): Promise<OfferingSetup & { definitionId: string }> {
  const definitionId = await definitionWithScope(t, 'membership_benefit', scope);
  const setup = await offering(t, {
    kind: 'membership',
    entitlementDefinitionId: definitionId,
    basePriceMinor: input.basePriceMinor === undefined ? 0 : input.basePriceMinor,
    capacityUnits: [{ unit: 'seats', limit: 500 }],
    ageBand: { minAgeYears: 18 },
    startsOn: input.startsOn,
    endsOn: input.endsOn,
  });
  return { ...setup, definitionId };
}

/** An offering of `kind` adults may book sessions in (sessions are created by the caller). */
export async function adultOffering(
  t: TestApp,
  kind: OfferingKind,
  input: { basePriceMinor?: number | null; programId?: string } = {},
): Promise<OfferingSetup> {
  return offering(t, {
    kind,
    basePriceMinor: input.basePriceMinor === undefined ? 2_000 : input.basePriceMinor,
    capacityUnits: [{ unit: 'seats', limit: 10 }],
    ageBand: { minAgeYears: 18 },
    programId: input.programId,
  });
}

/** An approved cancellation policy version with the given content (POL-007, POL-039). */
export async function cancellationPolicy(
  t: TestApp,
  content: Record<string, unknown>,
): Promise<string> {
  return createPolicyVersionFixture(t, { kind: 'cancellation', content });
}
