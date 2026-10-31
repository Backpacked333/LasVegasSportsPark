/**
 * Staff sign-in (§4.13, §4.14 MFA for privileged staff). The managed identity provider is DEC-018
 * (Technical lead/account owners), so production builds show the pending state; development builds
 * offer the development sign-in, which production bundles do not contain.
 */
import { Suspense } from 'react';
import { useLocation } from 'react-router';
import { DevSignIn } from '../../dev';
import { StateView } from '../../ui/StateView';

export function SignInScreen() {
  const location = useLocation();
  const expired = (location.state as { expired?: boolean } | null)?.expired === true;
  return (
    <main id="main" className="shell-main">
      <h1>Sportspark staff</h1>
      {expired ? <p role="status">Your session ended. Sign in again.</p> : null}
      {DevSignIn ? (
        <Suspense fallback={<StateView variant="loading" label="sign-in" />}>
          <DevSignIn />
        </Suspense>
      ) : (
        <StateView
          variant="pending-decision"
          subject="Staff sign-in"
          decisions={['DEC-018']}
          owner="Technical lead/account owners"
        />
      )}
    </main>
  );
}
