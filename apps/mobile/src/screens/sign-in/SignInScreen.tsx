/**
 * Sign-in entry (SCR-C-01, §4.13). The managed identity provider is DEC-018 (Technical
 * lead/account owners, §5.2), so production builds show the pending state. Development builds
 * offer the development sign-in instead (src/dev), which production bundles do not contain.
 */
import { DevSignIn } from '../../dev';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';

export function SignInScreen() {
  if (DevSignIn) return <DevSignIn />;
  return (
    <Screen>
      <StateView
        variant="pending-decision"
        subject="Account sign-in"
        decisions={['DEC-018']}
        owner="Technical lead/account owners"
      />
    </Screen>
  );
}
