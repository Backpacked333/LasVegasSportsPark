import {
  newId,
  type CapacityUnit,
  type ChargeLine,
  type DiscountEligibilityRules,
  type OfferingKind,
  type PolicyKind,
  type PublicationState,
} from '@sportspark/contracts';
import { json, type Db } from '@sportspark/db';
import type { Clock } from '../../../kernel';

/**
 * Catalog fixtures for downstream module tests (enrollment, finance, competition, entry,
 * reporting). Rows are written directly through Kysely so they are fast and need no HTTP; the
 * shapes mirror what the services write. The context is structural: a `TestApp` satisfies it.
 */
export interface CatalogFixtureContext {
  db: Db;
  clock: Clock;
  organizationId: string;
  facilityId: string;
}

const FIXTURE_ACTOR = { kind: 'system', actorLabel: 'fixtures' };

let counter = 0;
const next = (): number => (counter += 1);

export async function createProgramFixture(
  ctx: CatalogFixtureContext,
  input: {
    name?: string;
    activityType?: string;
    format?: string | null;
    ageBand?: { minAgeYears?: number; maxAgeYears?: number };
    status?: 'draft' | 'active' | 'archived';
    organizationId?: string;
  } = {},
): Promise<string> {
  const id = newId();
  await ctx.db
    .insertInto('programs')
    .values({
      id,
      organization_id: input.organizationId ?? ctx.organizationId,
      name: input.name ?? `Program ${next()}`,
      description: null,
      activity_type: input.activityType ?? 'soccer',
      format: input.format === undefined ? '7v7' : input.format,
      age_band: json(input.ageBand ?? { minAgeYears: 6, maxAgeYears: 12 }),
      status: input.status ?? 'active',
      created_by: json(FIXTURE_ACTOR),
    })
    .execute();
  return id;
}

export async function createPolicyVersionFixture(
  ctx: CatalogFixtureContext,
  input: {
    kind: PolicyKind;
    key?: string;
    version?: number;
    title?: string;
    content?: Record<string, unknown>;
    approved?: boolean;
    effectiveFrom?: Date;
    effectiveTo?: Date | null;
    organizationId?: string;
  },
): Promise<string> {
  const id = newId();
  const approved = input.approved ?? true;
  const now = ctx.clock.now();
  await ctx.db
    .insertInto('policy_versions')
    .values({
      id,
      organization_id: input.organizationId ?? ctx.organizationId,
      kind: input.kind,
      key: input.key ?? `${input.kind}-${next()}`,
      version: input.version ?? 1,
      title: input.title ?? `${input.kind} policy`,
      content: json(input.content ?? { text: `${input.kind} policy wording` }),
      effective_from: input.effectiveFrom ?? new Date(now.getTime() - 86_400_000),
      effective_to: input.effectiveTo ?? null,
      approval_status: approved ? 'approved' : 'draft',
      approved_by: approved ? json(FIXTURE_ACTOR) : null,
      approved_at: approved ? now : null,
      retired_at: null,
      retired_reason: null,
      created_by: json(FIXTURE_ACTOR),
    })
    .execute();
  return id;
}

export async function createEntitlementDefinitionFixture(
  ctx: CatalogFixtureContext,
  input: {
    name?: string;
    kind?:
      | 'team_entry'
      | 'roster_place'
      | 'seat'
      | 'session_seat'
      | 'camp_group_place'
      | 'rental_resource'
      | 'package_credits'
      | 'membership_benefit';
    equivalenceScope?: 'offering' | 'program' | 'program_period' | 'session' | 'none';
    status?: 'active' | 'archived';
    organizationId?: string;
  } = {},
): Promise<string> {
  const id = newId();
  await ctx.db
    .insertInto('entitlement_definitions')
    .values({
      id,
      organization_id: input.organizationId ?? ctx.organizationId,
      name: input.name ?? `Entitlement ${next()}`,
      description: null,
      kind: input.kind ?? 'seat',
      scope: json({ sessionsIncluded: 'all' }),
      equivalence_scope: input.equivalenceScope ?? 'offering',
      equivalence_rule: json({}),
      status: input.status ?? 'active',
      created_by: json(FIXTURE_ACTOR),
    })
    .execute();
  return id;
}

export interface OfferingFixture {
  offeringId: string;
  programId: string;
  facilityId: string;
  eligibilityPolicyVersionId: string;
  cancellationPolicyVersionId: string;
  formPolicyVersionId: string;
  entitlementDefinitionId: string;
  priceRuleId: string | null;
  responsibleManagerPersonId: string;
}

export interface CreateOfferingFixture {
  /** An active adult person of the organization (e.g. a staff member) responsible for the offering. */
  responsibleManagerPersonId: string;
  programId?: string;
  facilityId?: string;
  name?: string;
  kind?: OfferingKind;
  publicationState?: PublicationState;
  startsOn?: string;
  endsOn?: string;
  registrationOpensAt?: Date | null;
  registrationClosesAt?: Date | null;
  capacityUnits?: CapacityUnit[];
  /** Price in minor units for the price rule created with the offering; null creates no rule. */
  basePriceMinor?: number | null;
  currency?: string;
  chargeLines?: ChargeLine[];
  eligibilityPolicyVersionId?: string;
  cancellationPolicyVersionId?: string;
  formPolicyVersionId?: string;
  entitlementDefinitionId?: string;
  organizationId?: string;
}

/**
 * A fully configured offering (every SPK-CAT-001 field) in the requested publication state, with
 * approved eligibility/cancellation/form policies, an entitlement definition and a price rule
 * effective since yesterday, so downstream modules can quote and enroll against it immediately.
 */
export async function createOfferingFixture(
  ctx: CatalogFixtureContext,
  input: CreateOfferingFixture,
): Promise<OfferingFixture> {
  const organizationId = input.organizationId ?? ctx.organizationId;
  const facilityId = input.facilityId ?? ctx.facilityId;
  const now = ctx.clock.now();
  const programId = input.programId ?? (await createProgramFixture(ctx, { organizationId }));
  const eligibilityPolicyVersionId =
    input.eligibilityPolicyVersionId ??
    (await createPolicyVersionFixture(ctx, { kind: 'eligibility', organizationId }));
  const cancellationPolicyVersionId =
    input.cancellationPolicyVersionId ??
    (await createPolicyVersionFixture(ctx, { kind: 'cancellation', organizationId }));
  const formPolicyVersionId =
    input.formPolicyVersionId ??
    (await createPolicyVersionFixture(ctx, { kind: 'form', organizationId }));
  const entitlementDefinitionId =
    input.entitlementDefinitionId ??
    (await createEntitlementDefinitionFixture(ctx, { organizationId }));
  const state = input.publicationState ?? 'registration_open';
  const published = state !== 'draft';
  const offeringId = newId();
  const startsOn = input.startsOn ?? '2027-01-10';
  const endsOn = input.endsOn ?? '2027-03-20';
  await ctx.db
    .insertInto('offerings')
    .values({
      id: offeringId,
      organization_id: organizationId,
      program_id: programId,
      facility_id: facilityId,
      name: input.name ?? `Offering ${next()}`,
      description: 'Fixture offering',
      kind: input.kind ?? 'term',
      activity_type: 'soccer',
      format: '7v7',
      location: json({ label: 'Main complex' }),
      starts_on: startsOn,
      ends_on: endsOn,
      registration_opens_at:
        input.registrationOpensAt === undefined
          ? new Date(now.getTime() - 86_400_000)
          : input.registrationOpensAt,
      registration_closes_at:
        input.registrationClosesAt === undefined
          ? new Date(now.getTime() + 30 * 86_400_000)
          : input.registrationClosesAt,
      eligibility_reference_date: null,
      eligibility_policy_version_id: eligibilityPolicyVersionId,
      entitlement_definition_id: entitlementDefinitionId,
      capacity_units: json(input.capacityUnits ?? [{ unit: 'seats', limit: 20 }]),
      cancellation_policy_version_id: cancellationPolicyVersionId,
      responsible_manager_person_id: input.responsibleManagerPersonId,
      publication_state: state,
      published_at: published ? now : null,
      registration_opened_at:
        state === 'registration_open' || state === 'registration_paused' ? now : null,
      closed_at: state === 'closed' ? now : null,
      archived_at: state === 'archived' ? now : null,
      copied_from_offering_id: null,
      created_by: json(FIXTURE_ACTOR),
    })
    .execute();
  await ctx.db
    .insertInto('offering_required_forms')
    .values({
      organization_id: organizationId,
      offering_id: offeringId,
      policy_version_id: formPolicyVersionId,
      sequence: 1,
    })
    .execute();
  let priceRuleId: string | null = null;
  if (input.basePriceMinor !== null) {
    priceRuleId = await createPriceRuleFixture(ctx, {
      offeringId,
      basePriceMinor: input.basePriceMinor ?? 15_000,
      currency: input.currency ?? 'USD',
      chargeLines: input.chargeLines,
      effectiveFrom: new Date(now.getTime() - 86_400_000),
      organizationId,
    });
  }
  return {
    offeringId,
    programId,
    facilityId,
    eligibilityPolicyVersionId,
    cancellationPolicyVersionId,
    formPolicyVersionId,
    entitlementDefinitionId,
    priceRuleId,
    responsibleManagerPersonId: input.responsibleManagerPersonId,
  };
}

export async function createPriceRuleFixture(
  ctx: CatalogFixtureContext,
  input: {
    offeringId: string;
    basePriceMinor: number;
    currency?: string;
    chargeLines?: ChargeLine[];
    effectiveFrom?: Date;
    effectiveTo?: Date | null;
    version?: number;
    organizationId?: string;
  },
): Promise<string> {
  const id = newId();
  const organizationId = input.organizationId ?? ctx.organizationId;
  const latest = await ctx.db
    .selectFrom('price_rules')
    .select((eb) => eb.fn.max('version').as('version'))
    .where('organization_id', '=', organizationId)
    .where('offering_id', '=', input.offeringId)
    .executeTakeFirst();
  await ctx.db
    .insertInto('price_rules')
    .values({
      id,
      organization_id: organizationId,
      offering_id: input.offeringId,
      version: input.version ?? (latest?.version ?? 0) + 1,
      effective_from: input.effectiveFrom ?? ctx.clock.now(),
      effective_to: input.effectiveTo ?? null,
      base_price_minor: input.basePriceMinor,
      currency: input.currency ?? 'USD',
      charge_lines: json(input.chargeLines ?? []),
      created_by: json(FIXTURE_ACTOR),
    })
    .execute();
  return id;
}

export async function createOfferingSessionFixture(
  ctx: CatalogFixtureContext,
  input: {
    offeringId: string;
    sequence?: number;
    scheduledStart: Date;
    scheduledEnd: Date;
    schedulingEventId?: string | null;
    status?: 'scheduled' | 'canceled' | 'completed';
    organizationId?: string;
  },
): Promise<string> {
  const id = newId();
  const organizationId = input.organizationId ?? ctx.organizationId;
  const latest = await ctx.db
    .selectFrom('offering_sessions')
    .select((eb) => eb.fn.max('sequence').as('sequence'))
    .where('organization_id', '=', organizationId)
    .where('offering_id', '=', input.offeringId)
    .executeTakeFirst();
  const status = input.status ?? 'scheduled';
  await ctx.db
    .insertInto('offering_sessions')
    .values({
      id,
      organization_id: organizationId,
      offering_id: input.offeringId,
      sequence: input.sequence ?? (latest?.sequence ?? 0) + 1,
      title: null,
      scheduled_start: input.scheduledStart,
      scheduled_end: input.scheduledEnd,
      scheduling_event_id: input.schedulingEventId ?? null,
      capacity_override: null,
      status,
      canceled_at: status === 'canceled' ? ctx.clock.now() : null,
      cancel_reason: status === 'canceled' ? 'fixture' : null,
    })
    .execute();
  return id;
}

export async function createDiscountFixture(
  ctx: CatalogFixtureContext,
  input: {
    code?: string | null;
    name?: string;
    amountKind?: 'percentage' | 'fixed';
    amountValue?: number;
    currency?: string | null;
    eligibilityRules?: DiscountEligibilityRules;
    stackingRule?: 'exclusive' | 'stackable';
    stackingPriority?: number;
    capMinor?: number | null;
    redemptionLimit?: number | null;
    perPersonLimit?: number | null;
    rounding?: 'half_up' | 'half_even' | 'down' | 'up';
    allocationMethod?: 'proportional' | 'largest_first' | 'first_line' | 'even';
    effectiveFrom?: Date;
    effectiveTo?: Date | null;
    status?: 'draft' | 'active' | 'retired';
    organizationId?: string;
  } = {},
): Promise<string> {
  const id = newId();
  const organizationId = input.organizationId ?? ctx.organizationId;
  const code = input.code === undefined ? `CODE${next()}` : input.code;
  const amountKind = input.amountKind ?? 'percentage';
  await ctx.db
    .insertInto('discount_definitions')
    .values({
      id,
      organization_id: organizationId,
      code,
      name: input.name ?? code ?? `Automatic ${next()}`,
      description: null,
      kind: code ? 'promo_code' : 'automatic',
      amount_kind: amountKind,
      amount_value: input.amountValue ?? (amountKind === 'percentage' ? 1000 : 500),
      currency:
        input.currency === undefined ? (amountKind === 'fixed' ? 'USD' : null) : input.currency,
      eligibility_rules: json(input.eligibilityRules ?? {}),
      stacking_rule: input.stackingRule ?? 'exclusive',
      stacking_priority: input.stackingPriority ?? 100,
      cap_minor: input.capMinor ?? null,
      redemption_limit: input.redemptionLimit ?? null,
      per_person_limit: input.perPersonLimit ?? null,
      rounding: input.rounding ?? 'half_up',
      allocation_method: input.allocationMethod ?? 'proportional',
      effective_from: input.effectiveFrom ?? new Date(ctx.clock.now().getTime() - 86_400_000),
      effective_to: input.effectiveTo ?? null,
      status: input.status ?? 'active',
      created_by: json(FIXTURE_ACTOR),
    })
    .execute();
  await ctx.db
    .insertInto('discount_redemptions')
    .values({
      organization_id: organizationId,
      discount_definition_id: id,
      redemption_limit: input.redemptionLimit ?? null,
    })
    .execute();
  return id;
}

export async function createAcknowledgmentFixture(
  ctx: CatalogFixtureContext,
  input: {
    subjectPersonId: string;
    policyVersionId: string;
    signedByPersonId: string;
    recordedByKind?: 'customer' | 'staff' | 'system';
    recordedByPersonId?: string | null;
    status?: 'active' | 'withdrawn';
    organizationId?: string;
  },
): Promise<string> {
  const id = newId();
  const status = input.status ?? 'active';
  await ctx.db
    .insertInto('acknowledgments')
    .values({
      id,
      organization_id: input.organizationId ?? ctx.organizationId,
      subject_person_id: input.subjectPersonId,
      policy_version_id: input.policyVersionId,
      signed_by_person_id: input.signedByPersonId,
      basis: input.signedByPersonId === input.subjectPersonId ? 'self' : 'guardian',
      recorded_by: json(FIXTURE_ACTOR),
      recorded_by_kind: input.recordedByKind ?? 'customer',
      recorded_by_person_id:
        input.recordedByPersonId === undefined ? input.signedByPersonId : input.recordedByPersonId,
      signed_at: ctx.clock.now(),
      evidence: json({ channel: 'fixture' }),
      status,
      withdrawn_at: status === 'withdrawn' ? ctx.clock.now() : null,
      withdrawn_reason: status === 'withdrawn' ? 'fixture' : null,
    })
    .execute();
  return id;
}
