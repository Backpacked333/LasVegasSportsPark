/**
 * The signed-in account's permissions and the organization's capability switches from
 * `GET /v1/me/permissions` (K-05; K-12, DEC-016), for the customer app.
 *
 * One cached read per session: never stale on its own (the cache is cleared on sign-in and
 * sign-out), re-read whenever the app returns to the foreground (`focusManager` on `AppState`),
 * and re-read after any command answers ACCESS_DENIED `CAPABILITY_DISABLED`
 * (`onCapabilityDisabled` in AppProviders). It is a view of roles, not of records: screens use it
 * to choose what to offer, and still render the API's ACCESS_DENIED or protected NOT_FOUND as "not
 * available". A customer's actions are conditional (on themselves, through a grant over a family
 * member, or through a team role); the API checks the record every time.
 *
 * Read it only on screens that need it (it is not read at start-up). While nothing has loaded,
 * every question answers `undefined` (unknown), never a guess.
 */
import {
  permissionsView,
  type ActionPermission,
  type CapabilityId,
  type MePermissions,
} from '@sportspark/api-client';
import { useMemo } from 'react';
import { useApp } from '../providers/AppProviders';
import { useApiQuery, type ApiQueryResult } from './useApiQuery';

export type { ActionPermission, MePermissions };

export interface PermissionsState {
  /** The read itself, for `QueryBoundary` or the SPK-UX-008 states. */
  query: ApiQueryResult<'/me/permissions'>;
  data: MePermissions | undefined;
  /** Outright (staff role) or conditional (per record); null: neither. */
  actionPermission(actionId: string): ActionPermission | null | undefined;
  /** Whether the organization's switch is on (DEC-016); undefined until the read answers. */
  isCapabilityEnabled(capability: CapabilityId): boolean | undefined;
}

export function usePermissions(options: { enabled?: boolean } = {}): PermissionsState {
  const { session } = useApp();
  const query = useApiQuery({
    path: '/me/permissions',
    enabled: session.status === 'signed_in' && options.enabled !== false,
    staleTime: Infinity,
    refetchOnWindowFocus: 'always',
  });
  const data = query.data;
  const view = useMemo(() => (data ? permissionsView(data) : null), [data]);
  return {
    query,
    data,
    actionPermission: (actionId) => view?.actionPermission(actionId),
    isCapabilityEnabled: (capability) => view?.isCapabilityEnabled(capability),
  };
}
