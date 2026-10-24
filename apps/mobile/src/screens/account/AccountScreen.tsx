/**
 * SCR-C-30 Account, the fifth destination (SPK-UX-002): who is signed in (`GET /v1/me`), the hub
 * sections (family, enrollments, payments, credits, forms, preferences, support), account setup
 * and recovery, and sign out. Account deletion and data requests are DEC-059 (Operator/privacy
 * owner): not offered.
 *
 * Sections whose screens are built open them; the others say "Not available yet" (their screen
 * groups add the route). Family shows how many people the API says this account may act for;
 * sections that need a linked participant record say so until setup is finished.
 *
 * States: loading; empty (new account: not linked yet, "Finish setting up"); ready; validation
 * failure: not applicable; permission restriction (sections depend on the person's record and
 * grants as the API reports them); stale version: not applicable at the hub, counts refresh on
 * return; offline (cached with age); processing: not applicable; success: not applicable; partial
 * completion: not permitted; recovery required: an unresolved recovery-required registration
 * cannot be listed yet (the API has no read of a customer's checkouts; reported).
 */
import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { useApp } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { ListRow } from '../../ui/ListRow';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';
import { spacing } from '../../ui/theme';
import { personDisplayName, useMe, type MeData } from './components/account-data';

/** Hub sections in SPK-UX-002 order; `href: null` until the section's screen exists. */
const SECTIONS: readonly {
  screenId: string;
  title: string;
  href: string | null;
  needsPerson: boolean;
}[] = [
  { screenId: 'SCR-C-31', title: 'Family and permissions', href: '/family', needsPerson: true },
  { screenId: 'SCR-C-32', title: 'Enrollments and participation', href: null, needsPerson: true },
  { screenId: 'SCR-C-34', title: 'Payments and obligations', href: null, needsPerson: true },
  { screenId: 'SCR-C-35', title: 'Credits and makeup sessions', href: null, needsPerson: true },
  { screenId: 'SCR-C-13', title: 'Forms and acknowledgments', href: null, needsPerson: true },
  { screenId: 'SCR-C-36', title: 'Preferences', href: '/preferences', needsPerson: true },
  { screenId: 'SCR-C-38', title: 'Support', href: null, needsPerson: false },
];

function familyDetail(me: MeData): string {
  const n = me.authorities.length;
  if (n === 0) return 'No family members yet';
  return `You may act for ${n} ${n === 1 ? 'person' : 'people'}`;
}

function AccountHub({ me }: { me: MeData }) {
  const router = useRouter();
  const { signOut } = useApp();
  const linked = me.person !== null;
  return (
    <View>
      <ListRow
        title={me.person ? personDisplayName(me.person) : 'Your account'}
        detail={me.person ? 'Signed in' : 'Signed in. Your account is not linked to a person yet.'}
        status={
          linked
            ? { tone: 'success', label: 'Linked' }
            : { tone: 'warning', label: 'Setup not finished' }
        }
      />
      {linked ? null : (
        <View style={styles.actions}>
          <Button label="Finish setting up" onPress={() => router.push('/onboarding')} />
        </View>
      )}
      <View accessibilityRole="list" accessibilityLabel="Account sections">
        {SECTIONS.map((section) => {
          const blocked = section.needsPerson && !linked;
          const available = section.href !== null && !blocked;
          const detail = blocked
            ? 'Available after you finish setting up'
            : section.href === null
              ? undefined
              : section.screenId === 'SCR-C-31'
                ? familyDetail(me)
                : undefined;
          return (
            <ListRow
              key={section.screenId}
              title={section.title}
              detail={detail}
              status={
                section.href === null ? { tone: 'neutral', label: 'Not available yet' } : undefined
              }
              onPress={available ? () => router.push(section.href as string) : undefined}
              accessibilityHint={available ? `Opens ${section.title}` : undefined}
              testID={`account-section-${section.screenId}`}
            />
          );
        })}
        <ListRow
          title="Account setup"
          detail="Your participant record and verified email or phone"
          onPress={() => router.push('/onboarding')}
          accessibilityHint="Opens account setup"
        />
        <ListRow
          title="Access after recovery"
          detail="What this account may access, and what recovery restores"
          onPress={() => router.push('/recovery')}
          accessibilityHint="Opens account recovery"
        />
      </View>
      <StateView
        variant="pending-decision"
        subject="Account deletion and data requests"
        decisions={['DEC-059']}
        owner="Operator/privacy owner"
      />
      <View style={styles.actions}>
        <Button label="Sign out" variant="secondary" onPress={() => void signOut()} />
      </View>
    </View>
  );
}

function SignedInAccount() {
  const me = useMe();
  return (
    <QueryBoundary
      query={me}
      label="your account"
      empty={{ title: 'No account details', description: '' }}
    >
      {(data) => <AccountHub me={data} />}
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

const styles = StyleSheet.create({
  actions: { padding: spacing.lg },
});
