/**
 * SPK-UX-005 navigation areas the principal may use, from `GET /v1/me/permissions` `areas` (K-05):
 * an area is listed when the API marks it visible (one of its actions is allowed by a held staff
 * role and not only through a capability that is turned off). The client does not decide which
 * areas a role sees, and a page opened directly still renders the API's ACCESS_DENIED as "not
 * available".
 *
 * States (SPK-UX-008): loading; error with the code and "Load areas again" (pages and the
 * workspace stay reachable by address); offline with nothing loaded; no area visible ("none
 * available"). Areas already loaded stay listed while offline (the cached read).
 *
 * Attention counts (`GET /v1/me/attention`, park UI redesign): beside an area, how many items wait
 * for the viewer there, as the owning module's own list answers the viewer. The pill is outside
 * the link (aria-hidden) so the link's accessible name stays the area title; the same count is
 * said in visually hidden text after it. An area the API leaves out shows no pill (never a zero
 * for a list the viewer cannot read), and nothing is shown while the read fails.
 */
import type { Schema } from '@sportspark/api-client';
import { NavLink } from 'react-router';
import { usePermissions } from '../api/permissions';
import { useApiQuery } from '../api/useApiQuery';
import { STAFF_AREAS, STAFF_AREA_GROUPS } from '../navigation/areas';
import { useApp } from '../providers/AppProviders';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import './area-nav.css';

/** Re-read the counts every two minutes while the dashboard is open. */
const ATTENTION_REFRESH_MS = 120_000;

function AttentionPill({
  title,
  count,
}: {
  title: string;
  count: Schema<'AttentionAreaCount'> | undefined;
}) {
  if (!count || count.count === 0) return null;
  const shown = `${count.count}${count.capped ? '+' : ''}`;
  return (
    <>
      <span className="nav-count" aria-hidden="true" data-testid={`nav-count-${count.area}`}>
        {shown}
      </span>
      <span className="nav-count-text">
        {title}: {shown} {count.counts}
      </span>
    </>
  );
}

/**
 * The navigation's own compact states: distinct words and test ids from the page's StateView, so
 * the page below keeps the only "Something went wrong" or "Try again" on screen.
 */
function NavState({
  testId,
  text,
  onRetry,
}: {
  testId: string;
  text: string;
  onRetry?: () => void;
}) {
  return (
    <div className="nav-state" data-testid={testId} aria-live="polite">
      <p className="caption">{text}</p>
      {onRetry ? (
        <Button variant="secondary" onClick={onRetry}>
          Load areas again
        </Button>
      ) : null}
    </div>
  );
}

export function AreaNav({ onNavigate }: { onNavigate: () => void }) {
  const permissions = usePermissions();
  const { online } = useApp();
  const { query } = permissions;
  const attention = useApiQuery({
    path: '/me/attention',
    enabled: query.data !== undefined,
    staleTime: ATTENTION_REFRESH_MS,
    refetchInterval: ATTENTION_REFRESH_MS,
  });
  const countOf = new Map((attention.data?.areas ?? []).map((a) => [a.area, a]));

  if (query.data === undefined) {
    const retry = () => void query.refetch();
    if (
      (query.error && query.error.isOffline) ||
      (!query.error && (query.fetchStatus === 'paused' || !online))
    ) {
      return (
        <NavState
          testId="nav-offline"
          text="No connection: your areas load when you are connected."
          onRetry={retry}
        />
      );
    }
    if (query.error) {
      return (
        <NavState
          testId="nav-error"
          text={`Your areas could not be loaded. Error code: ${query.error.code}${
            query.error.correlationId ? `. Reference: ${query.error.correlationId}` : ''
          }.`}
          onRetry={retry}
        />
      );
    }
    return <NavState testId="nav-loading" text="Loading your areas…" />;
  }

  const areas = STAFF_AREAS.filter((area) => permissions.isAreaVisible(area.id) === true);
  // SPK-UX-005: keep the permitted queue reachable when Administration is not visible.
  const showSupportCases =
    permissions.isPermitted('support.read_case') === true &&
    permissions.isAreaVisible('admin') !== true;
  if (areas.length === 0 && !showSupportCases) {
    return (
      <NavState
        testId="nav-none"
        text="No dashboard areas are available to your account. Ask an administrator if you expected to see some."
      />
    );
  }
  // One "Areas" list holding a labelled sub-list per sidebar group (Operate, Compete, Grow,
  // Business); an empty group is left out.
  return (
    <>
      {areas.length > 0 ? (
        <ul aria-label="Areas" className="nav-groups">
          {STAFF_AREA_GROUPS.map((group) => {
            const inGroup = areas.filter((area) => area.group === group);
            if (inGroup.length === 0) return null;
            const labelId = `nav-group-${group}`;
            return (
              <li key={group} className="nav-group">
                <span className="nav-group-label" id={labelId}>
                  {group}
                </span>
                <ul aria-labelledby={labelId}>
                  {inGroup.map((area) => (
                    <li key={area.id} className="nav-item">
                      <NavLink to={area.path} onClick={onNavigate}>
                        {({ isActive }) => (
                          <>
                            <Icon name={area.icon} filled={isActive} />
                            <span>{area.title}</span>
                          </>
                        )}
                      </NavLink>
                      <AttentionPill title={area.title} count={countOf.get(area.id)} />
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ul>
      ) : null}
      {showSupportCases ? (
        <ul aria-label="Support navigation" className="nav-groups">
          <li className="nav-group">
            <span className="nav-group-label" id="nav-group-support">
              Support
            </span>
            <ul aria-labelledby="nav-group-support">
              <li className="nav-item">
                <NavLink to="/support/cases" onClick={onNavigate}>
                  {({ isActive }) => (
                    <>
                      <Icon name="support_agent" filled={isActive} />
                      <span>Support cases</span>
                    </>
                  )}
                </NavLink>
              </li>
            </ul>
          </li>
        </ul>
      ) : null}
    </>
  );
}
