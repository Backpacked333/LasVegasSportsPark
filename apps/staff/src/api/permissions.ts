/**
 * The principal's permissions and the organization's capability switches from
 * `GET /v1/me/permissions` (K-05, SPK-UX-005 "visibility depends on permissions"; K-12, DEC-016).
 *
 * One cached read per session: never stale on its own (the cache is cleared on sign-in and
 * sign-out), re-read whenever the dashboard window regains focus, and re-read after any command
 * answers ACCESS_DENIED `CAPABILITY_DISABLED` (`onCapabilityDisabled` in AppProviders). It is a view
 * of roles, not of records: use it to choose what to offer (navigation, buttons), and still render
 * the API's ACCESS_DENIED or protected NOT_FOUND on a record as "not available". The client never
 * decides authorization from it.
 *
 * While nothing has loaded, every question answers `undefined` (unknown), never a guess.
 */
import {
  permissionsView,
  type ActionPermission,
  type CapabilityId,
  type MePermissions,
  type NavigationAreaId,
} from '@sportspark/api-client';
import { useMemo } from 'react';
import { useApp } from '../providers/AppProviders';
import { useApiQuery, type ApiQueryResult } from './useApiQuery';

export type { ActionPermission, MePermissions, NavigationAreaId };

export interface PermissionsState {
  /** The read itself, for `QueryBoundary` or the SPK-UX-008 states. */
  query: ApiQueryResult<'/me/permissions'>;
  data: MePermissions | undefined;
  /** Outright (staff role, with facility scope) or conditional (per record), null: neither. */
  actionPermission(
    actionId: string,
    options?: { facilityId?: string | null },
  ): ActionPermission | null | undefined;
  /** Allowed outright by a held staff role (in `facilityId`, when given). */
  isPermitted(actionId: string, facilityId?: string | null): boolean | undefined;
  isAreaVisible(area: NavigationAreaId): boolean | undefined;
  visibleAreas: readonly NavigationAreaId[] | undefined;
  /** Whether the organization's switch is on (DEC-016); undefined until the read answers. */
  isCapabilityEnabled(capability: CapabilityId): boolean | undefined;
}

export function usePermissions(): PermissionsState {
  const { session } = useApp();
  const query = useApiQuery({
    path: '/me/permissions',
    enabled: session.status === 'signed_in',
    staleTime: Infinity,
    refetchOnWindowFocus: 'always',
  });
  const data = query.data;
  const view = useMemo(() => (data ? permissionsView(data) : null), [data]);
  return {
    query,
    data,
    actionPermission: (actionId, options) => view?.actionPermission(actionId, options),
    isPermitted: (actionId, facilityId) => view?.isPermitted(actionId, facilityId),
    isAreaVisible: (area) => view?.isAreaVisible(area),
    visibleAreas: view?.visibleAreas,
    isCapabilityEnabled: (capability) => view?.isCapabilityEnabled(capability),
  };
}
