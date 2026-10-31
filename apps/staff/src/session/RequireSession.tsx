/** Routes inside the shell need a session; otherwise the sign-in page (§4.13 session expiry). */
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useApp } from '../providers/AppProviders';
import { StateView } from '../ui/StateView';

export function RequireSession({ children }: { children: ReactNode }) {
  const { session } = useApp();
  const location = useLocation();
  if (session.status === 'loading') return <StateView variant="loading" label="your session" />;
  if (session.status === 'signed_out') {
    return (
      <Navigate
        to="/sign-in"
        replace
        state={{ from: location.pathname, expired: session.expired }}
      />
    );
  }
  return <>{children}</>;
}
