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
 */
import { NavLink } from 'react-router';
import { usePermissions } from '../api/permissions';
import { STAFF_AREAS } from '../navigation/areas';
import { useApp } from '../providers/AppProviders';
import { Button } from '../ui/Button';

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
  if (areas.length === 0) {
    return (
      <NavState
        testId="nav-none"
        text="No dashboard areas are available to your account. Ask an administrator if you expected to see some."
      />
    );
  }
  return (
    <ul aria-label="Areas">
      {areas.map((area) => (
        <li key={area.id}>
          <NavLink to={area.path} onClick={onNavigate}>
            {area.title}
          </NavLink>
        </li>
      ))}
    </ul>
  );
}
