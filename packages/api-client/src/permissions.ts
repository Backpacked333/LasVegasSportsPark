/**
 * A read-only view of `GET /v1/me/permissions` (K-05, SPK-UX-005 "visibility depends on
 * permissions", §4.14 least privilege), shared by both apps' `usePermissions` hooks.
 *
 * It answers what the API said about the principal's roles: which actions their staff roles allow
 * outright (and in which facilities), which actions are allowed per record through self,
 * relationship or team authority, which navigation areas show, and which capability switches are
 * on. It is a view of roles, not of records: screens use it to choose what to offer, and still
 * render the API's ACCESS_DENIED or protected NOT_FOUND on a record as "not available". The client
 * never decides authorization from it.
 */
import type { CapabilityId } from './capabilities';
import type { Schema } from './types';

export type MePermissions = Schema<'MePermissions'>;
export type NavigationAreaId = Schema<'NavigationArea'>;

/** The fourteen SPK-UX-005 areas in specification order (the API's `NAVIGATION_AREA_IDS`). */
export const NAVIGATION_AREAS: readonly NavigationAreaId[] = [
  'today',
  'schedule',
  'leagues',
  'programs',
  'teams',
  'people',
  'registrations',
  'arrival',
  'staff',
  'finance',
  'communications',
  'facilities',
  'reports',
  'admin',
];

export type ActionPermission =
  /** A held staff role allows it; `facilityIds: null` means every facility of the organization. */
  | { kind: 'outright'; facilityIds: readonly string[] | null }
  /**
   * Allowed per record: on oneself (`self`), over a subject person with a grant
   * (`subjectPermission`), or with a role on the team entry (`teamRole`). The API checks the
   * record on every request.
   */
  | {
      kind: 'conditional';
      self: boolean;
      subjectPermission: string | null;
      teamRole: string | null;
    };

export interface PermissionsView {
  /**
   * How the principal holds an action, or null when the API listed it neither outright nor
   * conditionally. With `facilityId`, an outright action scoped to other facilities is null.
   */
  actionPermission(
    actionId: string,
    options?: { facilityId?: string | null },
  ): ActionPermission | null;
  /** Allowed outright by a held staff role (in `facilityId`, when given). */
  isPermitted(actionId: string, facilityId?: string | null): boolean;
  isAreaVisible(area: NavigationAreaId): boolean;
  /** The visible areas in the API's (specification) order. */
  visibleAreas: readonly NavigationAreaId[];
  /** Whether the organization's switch is on. An id the API did not list is off. */
  isCapabilityEnabled(capability: CapabilityId): boolean;
}

export function permissionsView(data: MePermissions): PermissionsView {
  const outright = new Map(data.actions.map((a) => [a.id, a.facilityIds ?? null]));
  const conditional = new Map(data.conditionalActions.map((a) => [a.id, a]));
  const visible = data.areas.filter((a) => a.visible).map((a) => a.id);
  const visibleSet = new Set<string>(visible);
  const enabled = new Set<string>(data.capabilities.filter((c) => c.enabled).map((c) => c.id));

  function actionPermission(
    actionId: string,
    options: { facilityId?: string | null } = {},
  ): ActionPermission | null {
    if (outright.has(actionId)) {
      const facilityIds = outright.get(actionId) ?? null;
      const facilityId = options.facilityId ?? null;
      if (facilityIds === null || facilityId === null || facilityIds.includes(facilityId)) {
        return { kind: 'outright', facilityIds };
      }
    }
    const c = conditional.get(actionId);
    if (c) {
      return {
        kind: 'conditional',
        self: c.self,
        subjectPermission: c.subjectPermission ?? null,
        teamRole: c.teamRole ?? null,
      };
    }
    return null;
  }

  return {
    actionPermission,
    isPermitted: (actionId, facilityId) =>
      actionPermission(actionId, { facilityId })?.kind === 'outright',
    isAreaVisible: (area) => visibleSet.has(area),
    visibleAreas: visible,
    isCapabilityEnabled: (capability) => enabled.has(capability),
  };
}
