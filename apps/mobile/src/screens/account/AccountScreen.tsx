/**
 * SCR-C-30 Account (SPK-UX-002). Shell: who is signed in (`GET /v1/me`), sign out, and the hub
 * sections (family, enrollments, payments, credits, forms, preferences, support) that their screen
 * groups build. Account deletion and data requests are DEC-059 (Operator/privacy owner): not offered.
 */
import { View } from 'react-native';
import { useApiQuery } from '../../api/useApiQuery';
import { useApp } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { ListRow } from '../../ui/ListRow';
import { Placeholder } from '../../ui/Placeholder';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';

const SECTIONS = [
  ['SCR-C-31', 'Family and permissions'],
  ['SCR-C-32', 'Enrollments and participation'],
  ['SCR-C-34', 'Payments and obligations'],
  ['SCR-C-35', 'Credits and makeup sessions'],
  ['SCR-C-13', 'Forms and acknowledgments'],
  ['SCR-C-36', 'Preferences'],
  ['SCR-C-38', 'Support'],
] as const;

function SignedInAccount() {
  const { signOut } = useApp();
  const me = useApiQuery({ path: '/me' });
  return (
    <QueryBoundary
      query={me}
      label="your account"
      empty={{ title: 'No account details', description: '' }}
    >
      {(data) => (
        <View>
          <ListRow
            title={data.person ? `${data.person.givenName} ${data.person.familyName}` : 'Account'}
            detail={
              data.person ? 'Signed in' : 'Signed in. Your account is not linked to a person yet.'
            }
          />
          {SECTIONS.map(([screenId, title]) => (
            <Placeholder
              key={screenId}
              screenId={screenId}
              title={title}
              purpose="Account section."
            />
          ))}
          <StateView
            variant="pending-decision"
            subject="Account deletion and data requests"
            decisions={['DEC-059']}
            owner="Operator/privacy owner"
          />
          <View style={{ padding: 16 }}>
            <Button label="Sign out" variant="secondary" onPress={() => void signOut()} />
          </View>
        </View>
      )}
    </QueryBoundary>
  );
}

export function AccountScreen() {
  return (
    <Screen>
      <RequireSession what="your account">
        <SignedInAccount />
      </RequireSession>
    </Screen>
  );
}
