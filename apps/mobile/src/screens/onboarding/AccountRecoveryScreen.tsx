/**
 * SCR-C-02 Account recovery (SPK-IAM-002, §4.14 "Rate-limited recovery", SPK-AT-025 "Only
 * verified prior access restored"; §3.1 "Account recovery does not grant new family access").
 *
 * What the API supports today: recovery links an existing account to a new sign-in
 * (`POST /v1/accounts/{id}/relink`), performed by support staff, and never touches permissions.
 * Self-service recovery from the app belongs to the managed identity provider, DEC-018 (Technical
 * lead/account owners): shown as pending, with the staff route explained. After signing in again
 * the screen lists exactly the access the account holds (`GET /v1/me`), so the person can see that
 * nothing new was added.
 *
 * States: loading; empty (nothing in progress: signed out, how to recover); ready (restored access
 * listed); validation failure: not applicable here (no input; the identity provider owns it);
 * permission restriction (RATE_LIMITED shown with its code and next action); stale version: not
 * applicable (read only); offline (cached access with its age); processing: not applicable;
 * success (prior access listed, nothing new); partial completion: not permitted; recovery required
 * (INTEGRATION_UNAVAILABLE shown with its code and "Try again").
 */
import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { useApp } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { ListRow } from '../../ui/ListRow';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { spacing } from '../../ui/theme';
import { personDisplayName, useMe } from '../account/components/account-data';
import { Paragraph, SectionHeader } from '../account/components/forms';
import { PersonAccessLine } from '../account/components/PersonAccess';

const PRINCIPLE =
  'Recovering an account restores only the access that was verified before. It never adds family access.';

export function AccountRecoveryScreen() {
  const { session } = useApp();
  return (
    <Screen>
      <SectionHeader title="Recover your account" detail={PRINCIPLE} />
      {session.status === 'loading' ? (
        <StateView variant="loading" label="your account" />
      ) : session.status === 'signed_out' ? (
        <RecoverSignedOut />
      ) : (
        <RestoredAccess />
      )}
    </Screen>
  );
}

function RecoverSignedOut() {
  const router = useRouter();
  return (
    <View>
      <StateView
        variant="pending-decision"
        subject="Recovering your account from the app"
        decisions={['DEC-018']}
        owner="Technical lead/account owners"
      />
      <Paragraph>
        Until then, facility support staff can link your existing account to a new sign-in. Your
        access stays exactly as it was; nothing new is added.
      </Paragraph>
      <View style={styles.actions}>
        <Button label="Sign in" onPress={() => router.push('/sign-in')} />
      </View>
    </View>
  );
}

function RestoredAccess() {
  const me = useMe();
  return (
    <QueryBoundary
      query={me}
      label="your access"
      empty={{ title: 'No account details', description: '' }}
    >
      {(data) => (
        <View>
          <View style={styles.status}>
            <StatusBadge tone="success" label="Signed in" />
          </View>
          <SectionHeader
            title="Access on this account"
            detail="Only access recorded before is listed. Account recovery never adds permissions."
          />
          <ListRow
            title={data.person ? personDisplayName(data.person) : 'Your participant record'}
            detail={data.person ? 'Your own record' : 'Not linked to this account yet'}
            status={
              data.person
                ? { tone: 'success', label: 'Linked' }
                : { tone: 'warning', label: 'Not linked yet' }
            }
          />
          {data.authorities.length === 0 ? (
            <StateView
              variant="empty"
              title="No family access on this account"
              description="Permissions over other people appear here once they are recorded and verified."
            />
          ) : (
            <View accessibilityRole="list">
              {data.authorities.map((authority) => (
                <PersonAccessLine key={authority.subjectPersonId} authority={authority} />
              ))}
            </View>
          )}
          <Paragraph muted>
            If something you expect is missing, ask the front desk. Access is never restored from
            household membership alone.
          </Paragraph>
        </View>
      )}
    </QueryBoundary>
  );
}

const styles = StyleSheet.create({
  actions: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  status: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },
});
