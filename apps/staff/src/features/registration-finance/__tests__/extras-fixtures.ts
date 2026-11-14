/**
 * Fixtures for the proposed amendments PA-03 (SPK-PAY-014: price tiers and add-ons) and PA-07
 * (SPK-REG-012: uniforms). Tiers, add-ons, sizes and prices are test data, not policy.
 */
import type { Schema } from '@sportspark/api-client';
import { ENROLLMENT_ID, NOW, OFFERING_ID, PERSON_ID } from './fixtures';

export const TIER_WEEK_ID = '0192f1a0-0000-7000-8000-000000004001';
export const TIER_DAYS_ID = '0192f1a0-0000-7000-8000-000000004002';
export const ADDON_LUNCH_ID = '0192f1a0-0000-7000-8000-000000004101';
export const ADDON_SHIRT_ID = '0192f1a0-0000-7000-8000-000000004102';
export const UNIFORM_ID = '0192f1a0-0000-7000-8000-000000004201';
export const UNIFORM_ORDER_ID = '0192f1a0-0000-7000-8000-000000004301';
export const SESSION_MON_ID = '0192f1a0-0000-7000-8000-000000004401';
export const SESSION_TUE_ID = '0192f1a0-0000-7000-8000-000000004402';
export const SESSION_WED_ID = '0192f1a0-0000-7000-8000-000000004403';

export function tier(overrides: Partial<Schema<'PriceRuleTier'>> = {}): Schema<'PriceRuleTier'> {
  return {
    id: TIER_WEEK_ID,
    code: 'full_week',
    name: 'Full week',
    sequence: 1,
    attendance: 'all_sessions',
    minSessions: null,
    maxSessions: null,
    priceMinor: 30000,
    memberPriceMinor: null,
    availableUntil: null,
    ...overrides,
  };
}

export const TWO_DAYS = tier({
  id: TIER_DAYS_ID,
  code: 'two_days',
  name: 'Two days',
  sequence: 2,
  attendance: 'chosen_sessions',
  minSessions: 2,
  maxSessions: 2,
  priceMinor: 13000,
});

export function addon(overrides: Partial<Schema<'OfferingAddon'>> = {}): Schema<'OfferingAddon'> {
  return {
    id: ADDON_LUNCH_ID,
    offeringId: OFFERING_ID,
    code: 'lunch',
    name: 'Lunch',
    description: null,
    priceMinor: 900,
    currency: 'USD',
    chargeLines: [],
    selection: 'per_session',
    capacity: null,
    status: 'active',
    revision: 1,
    createdAt: NOW,
    ...overrides,
  };
}

export const SHIRT = addon({
  id: ADDON_SHIRT_ID,
  code: 'shirt',
  name: 'Camp shirt',
  priceMinor: 1500,
  selection: 'per_registration',
  capacity: 40,
});

export function uniform(
  overrides: Partial<Schema<'OfferingUniform'>> = {},
): Schema<'OfferingUniform'> {
  return {
    id: UNIFORM_ID,
    offeringId: OFFERING_ID,
    itemKey: 'club-kit-2026',
    name: 'Club kit',
    sizes: ['YS', 'YM', 'YL'],
    requirement: 'required',
    priceMinor: 2500,
    currency: 'USD',
    chargeLines: [],
    returningHolderFree: true,
    status: 'active',
    revision: 1,
    createdAt: NOW,
    ...overrides,
  };
}

export function purchaseOptions(
  overrides: Partial<Schema<'OfferingPurchaseOptions'>> = {},
): Schema<'OfferingPurchaseOptions'> {
  return {
    offeringId: OFFERING_ID,
    priceRuleId: '0192f1a0-0000-7000-8000-000000002201',
    pricingBasis: 'term',
    currency: 'USD',
    tiers: [tier(), TWO_DAYS],
    addons: [addon(), SHIRT],
    uniform: uniform(),
    ...overrides,
  };
}

export function campSession(
  id: string,
  sequence: number,
  start: string,
): Schema<'OfferingSession'> {
  return {
    id,
    offeringId: OFFERING_ID,
    sequence,
    title: `Day ${sequence}`,
    scheduledStart: start,
    scheduledEnd: start.replace('T16:', 'T23:'),
    schedulingEventId: null,
    capacityOverride: null,
    location: null,
    status: 'scheduled',
    canceledAt: null,
    cancelReason: null,
    revision: 1,
    createdAt: NOW,
  };
}

export const CAMP_SESSIONS = [
  campSession(SESSION_MON_ID, 1, '2026-11-02T16:00:00.000Z'),
  campSession(SESSION_TUE_ID, 2, '2026-11-03T16:00:00.000Z'),
  campSession(SESSION_WED_ID, 3, '2026-11-04T16:00:00.000Z'),
];

export function uniformOrder(
  overrides: Partial<Schema<'UniformOrder'>> = {},
): Schema<'UniformOrder'> {
  return {
    id: UNIFORM_ORDER_ID,
    enrollmentId: ENROLLMENT_ID,
    offeringId: OFFERING_ID,
    offeringUniformId: UNIFORM_ID,
    teamEntryId: null,
    participantPersonId: PERSON_ID,
    participantDisplayName: 'Alex Rivera',
    itemKey: 'club-kit-2026',
    name: 'Club kit',
    size: 'YM',
    priceMinor: 2500,
    currency: 'USD',
    status: 'paid',
    orderedAt: '2026-10-20T16:00:00.000Z',
    paidAt: '2026-10-20T16:05:00.000Z',
    handedOverAt: null,
    handedOverBy: null,
    canceledAt: null,
    revision: 2,
    ...overrides,
  };
}
