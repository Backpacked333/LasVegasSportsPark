/**
 * Conditional capabilities as the clients present them (§1.6, §6.5 Package G; DEC-016,
 * DEC-072 to DEC-082). Whether an organization uses a capability is a per-organization switch that
 * starts off; `GET /v1/me/permissions` reports each switch and a gated command answers
 * ACCESS_DENIED with `details.code: 'CAPABILITY_DISABLED'` while it is off (K-12). The clients
 * never decide the switch: they show what the API reports.
 *
 * `CAPABILITY_PRESENTATION` names, for each capability, the decisions that may turn it on (its
 * applicability references: DEC-016 and its own Register E record). It mirrors `CAPABILITIES` in
 * packages/contracts; `contract-drift.spec.ts` fails when the two drift. The owner is the
 * decision register's (Product owner for DEC-016 and DEC-072 to DEC-082).
 */
import { ApiError } from './errors';
import type { Schema } from './types';

export type CapabilityId = Schema<'CapabilityId'>;

/** `details.code` of an ACCESS_DENIED answer for a capability that is turned off (K-12, DEC-092). */
export const CAPABILITY_DISABLED_CODE = 'CAPABILITY_DISABLED';

/** Query key prefix of `GET /v1/me/permissions` in both apps' caches (`apiQueryKey` shape). */
export const PERMISSIONS_QUERY_PREFIX = ['api', '/me/permissions'] as const;

export interface CapabilityPresentation {
  /** What is turned off, as a heading: "Rentals". */
  label: string;
  /** The decisions whose answer may turn it on (DEC-016 and its own record). */
  decisions: readonly string[];
  /** The decision register's owner of those decisions. */
  owner: string;
}

const PRODUCT_OWNER = 'Product owner';

export const CAPABILITY_PRESENTATION: Readonly<Record<CapabilityId, CapabilityPresentation>> = {
  memberships: { label: 'Memberships', decisions: ['DEC-016', 'DEC-072'], owner: PRODUCT_OWNER },
  session_packages: {
    label: 'Session packages',
    decisions: ['DEC-016', 'DEC-074'],
    owner: PRODUCT_OWNER,
  },
  rentals: { label: 'Rentals', decisions: ['DEC-016', 'DEC-076'], owner: PRODUCT_OWNER },
  parties: { label: 'Parties', decisions: ['DEC-016', 'DEC-077'], owner: PRODUCT_OWNER },
  tournaments: { label: 'Tournaments', decisions: ['DEC-016', 'DEC-078'], owner: PRODUCT_OWNER },
  point_of_sale: {
    label: 'Point of sale',
    decisions: ['DEC-016', 'DEC-079'],
    owner: PRODUCT_OWNER,
  },
  access_hardware: {
    label: 'Access hardware',
    decisions: ['DEC-016', 'DEC-080'],
    owner: PRODUCT_OWNER,
  },
  accounting: {
    label: 'Accounting export',
    decisions: ['DEC-016', 'DEC-081'],
    owner: PRODUCT_OWNER,
  },
  youth_progression: {
    label: 'Youth assessments and progression',
    decisions: ['DEC-016'],
    owner: PRODUCT_OWNER,
  },
  pickup_sessions: {
    label: 'Pickup sessions',
    decisions: ['DEC-016', 'DEC-082'],
    owner: PRODUCT_OWNER,
  },
  assistant: { label: 'Assistant', decisions: ['DEC-016'], owner: PRODUCT_OWNER },
  installments: {
    label: 'Installment plans',
    decisions: ['DEC-016', 'DEC-073'],
    owner: PRODUCT_OWNER,
  },
  supervised_pickup: {
    label: 'Supervised pickup',
    decisions: ['DEC-016', 'DEC-075'],
    owner: PRODUCT_OWNER,
  },
  advanced_fairness: {
    label: 'Advanced fixture fairness',
    decisions: ['DEC-016'],
    owner: PRODUCT_OWNER,
  },
  retention_tools: { label: 'Retention tools', decisions: ['DEC-016'], owner: PRODUCT_OWNER },
};

export const CAPABILITY_IDS = Object.keys(CAPABILITY_PRESENTATION) as readonly CapabilityId[];

export function isCapabilityId(value: unknown): value is CapabilityId {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(CAPABILITY_PRESENTATION, value)
  );
}

/**
 * True for the API's answer to a gated command of a capability the organization has turned off:
 * ACCESS_DENIED with `details.code: 'CAPABILITY_DISABLED'` (K-12). Not a restriction of the
 * principal, so it is shown as "turned off", never as "not available to you".
 */
export function isCapabilityDisabledError(error: unknown): error is ApiError {
  return error instanceof ApiError && error.isCapabilityDisabled;
}

export interface TurnedOff {
  /** The capability the API named, when it is one the client knows. */
  capability: CapabilityId | null;
  label: string;
  /** The decisions that may turn it on: the API's `applicabilityReferences`, else the catalogue's. */
  decisions: readonly string[];
  owner: string;
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const list = value.filter((v): v is string => typeof v === 'string' && v.length > 0);
  return list.length > 0 ? list : null;
}

/** What a turned-off state names for a capability (from the catalogue). */
export function turnedOffFor(capability: CapabilityId): TurnedOff {
  const known = CAPABILITY_PRESENTATION[capability];
  return { capability, label: known.label, decisions: known.decisions, owner: known.owner };
}

/**
 * What a turned-off state names for a CAPABILITY_DISABLED answer: the capability and the decisions
 * the API sent (`details.capability`, `details.applicabilityReferences`), completed from the
 * catalogue. Null for any other error.
 */
export function turnedOffFromError(error: unknown): TurnedOff | null {
  if (!isCapabilityDisabledError(error)) return null;
  const details = (error.details ?? {}) as {
    capability?: unknown;
    applicabilityReferences?: unknown;
  };
  const capability = isCapabilityId(details.capability) ? details.capability : null;
  const known = capability ? CAPABILITY_PRESENTATION[capability] : null;
  return {
    capability,
    label: known?.label ?? 'This capability',
    decisions: stringList(details.applicabilityReferences) ?? known?.decisions ?? ['DEC-016'],
    owner: known?.owner ?? PRODUCT_OWNER,
  };
}

/** The turned-off badge, e.g. "Rentals turned off" (as the assistant panel's "Assistant turned off"). */
export function turnedOffLabel(subject: string): string {
  return `${subject} turned off`;
}

/**
 * The turned-off explanation both apps show (SPK-UX-008, SPK-UX-010): what it means, who decides,
 * the decisions that may turn it on, and that everything else keeps working (§1.6).
 */
export function turnedOffMessage(decisions: readonly string[], owner = PRODUCT_OWNER): string {
  const which = decisions.length === 1 ? 'that decision' : 'one of these decisions';
  return (
    `This is turned off for this organization. Whether it is used is decided by the ` +
    `${owner.toLowerCase()} (${decisions.join(', ')}); a system administrator turns it on by ` +
    `naming ${which}. Everything else works without it.`
  );
}
