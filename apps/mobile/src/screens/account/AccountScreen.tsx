/**
 * SCR-C-30 Account, the fifth destination (SPK-UX-002): who is signed in (`GET /v1/me`), the hub
 * sections (family, enrollments, payments, credits, forms, preferences, support), invitations,
 * account setup and recovery, and sign out. Account deletion and data requests are DEC-059
 * (Operator/privacy owner): not offered.
 *
 * Sections whose screens are built open them; forms are signed within a registration (SCR-C-13
 * has no list of its own), so that row says "Not available yet". Family shows how many people the
 * API says this account may act for; sections that need a linked participant record say so until
 * setup is finished. The conditional Package G sections (rentals and parties, memberships, session
 * packages, point-of-sale receipts) always open their screens, which sit behind their capability
 * switches; a switch `GET /v1/me/permissions` reports off is marked "Turned off" (DEC-016).
 *
 * States: loading; empty (new account: not linked yet, "Finish setting up"); ready; validation
 * failure: not applicable; permission restriction (sections depend on the person's record and
 * grants as the API reports them); stale version: not applicable at the hub, counts refresh on
 * return; offline (cached with age); processing: not applicable; success: not applicable; partial
 * completion: not permitted; recovery required: a registration checkout in `recovery_required`
 * (`GET /v1/me/registration-checkouts?status=recovery_required`) is pinned at the top, "Payment
 * received. We are completing your registration." with "Do not pay again", as on Home (SCR-C-03).
 */
import { presentationForError, type CapabilityId } from '@sportspark/api-client';
import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { usePermissions } from '../../api/permissions';
import { useApiQuery } from '../../api/useApiQuery';
import { packageGRoutes } from '../../features/package-g/routes';
import { registrationRoutes } from '../../features/registration/routes';
import { RECOVERY_PHRASE } from '../../features/today/status';
import { useApp } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { ListRow } from '../../ui/ListRow';
import { QueryBoundary, QueryErrorView } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';
import { spacing } from '../../ui/theme';
import { formatDateTime, personDisplayName, useMe, type MeData } from './components/account-data';

/** Hub sections in SPK-UX-002 order; `href: null` until the section's screen exists. */
const SECTIONS: readonly {
  screenId: string;
  title: string;
  href: string | null;
  needsPerson: boolean;
}[] = [
  { screenId: 'SCR-C-31', title: 'Family and permissions', href: '/family', needsPerson: true },
  {
    screenId: 'SCR-C-32',
    title: 'Enrollments and participation',
    href: '/enrollments',
    needsPerson: true,
  },
  { screenId: 'SCR-C-34', title: 'Payments and obligations', href: '/payments', needsPerson: true },
  {
    screenId: 'SCR-C-35',
    title: 'Credits and makeup sessions',
    href: '/credits',
    needsPerson: true,
  },
  // Forms are presented and signed within a registration (SCR-C-13); there is no list of them.
  { screenId: 'SCR-C-13', title: 'Forms and acknowledgments', href: null, needsPerson: true },
  { screenId: 'SCR-C-36', title: 'Preferences', href: '/preferences', needsPerson: true },
  { screenId: 'SCR-C-38', title: 'Support', href: '/support', needsPerson: false },
];

/**
 * Conditional Package G sections (§3.16, §6.5; DEC-016): always listed and opened, each screen
 * behind its capability switch; a switch the API reports off is marked "Turned off" here too.
 */
const CONDITIONAL_SECTIONS: readonly {
  key: string;
  title: string;
  detail: string;
  href: string;
  capabilities: readonly CapabilityId[];
}[] = [
  {
    key: 'bookings',
    title: 'Rentals and parties',
    detail: 'Your bookings',
    href: packageGRoutes.bookings(),
    capabilities: ['rentals', 'parties'],
  },
  {
    key: 'memberships',
    title: 'Memberships',
    detail: "Your and your family's memberships",
    href: packageGRoutes.memberships(),
    capabilities: ['memberships'],
  },
  {
    key: 'session-packages',
    title: 'Session packages',
    detail: 'Credits left and redemptions',
    href: packageGRoutes.sessionPackages(),
    capabilities: ['session_packages'],
  },
  {
    key: 'pos-receipts',
    title: 'Point-of-sale receipts',
    detail: 'Purchases at the facility desk',
    href: packageGRoutes.posReceipts(),
    capabilities: ['point_of_sale'],
  },
];

function ConditionalSections({ linked }: { linked: boolean }) {
  const router = useRouter();
  const permissions = usePermissions({ enabled: linked });
  return (
    <View accessibilityRole="list" accessibilityLabel="Bookings, memberships and packages">
      {CONDITIONAL_SECTIONS.map((section) => {
        // Known off only when the API answered and every capability of the section is off.
        const off =
          permissions.data !== undefined &&
          section.capabilities.every((c) => permissions.isCapabilityEnabled(c) === false);
        return (
          <ListRow
            key={section.key}
            title={section.title}
            detail={linked ? section.detail : 'Available after you finish setting up'}
            status={linked && off ? { tone: 'neutral', label: 'Turned off' } : undefined}
            onPress={linked ? () => router.push(section.href) : undefined}
            accessibilityHint={linked ? `Opens ${section.title}` : undefined}
            testID={`account-conditional-${section.key}`}
          />
        );
      })}
    </View>
  );
}

/**
 * A registration whose payment was received but whose completion failed (§4.11 checkout
 * `recovery_required`), pinned first so the customer does not pay again (journeys.md section 3).
 */
function RecoveryRequired() {
  const router = useRouter();
  const checkouts = useApiQuery({
    path: '/me/registration-checkouts',
    request: { query: { status: 'recovery_required', limit: 10 } },
  });
  if (checkouts.error && checkouts.data === undefined) {
    // Not available to this account: nothing to pin. Any other failure shows its code.
    if (presentationForError(checkouts.error) === 'unavailable') return null;
    return <QueryErrorView error={checkouts.error} onRetry={() => void checkouts.refetch()} />;
  }
  const items = checkouts.data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <View accessibilityRole="list" accessibilityLabel="Registrations being completed">
      {items.map((checkout) => (
        <ListRow
          key={checkout.id}
          title="Do not pay again"
          detail={`Payment received. Last update ${formatDateTime(checkout.updatedAt)}.`}
          status={{ tone: 'warning', label: RECOVERY_PHRASE }}
          onPress={() => router.push(registrationRoutes.outcome(checkout.id))}
          accessibilityHint="Opens the registration outcome"
          testID={`account-recovery-${checkout.id}`}
        />
      ))}
    </View>
  );
}

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
      {linked ? <RecoveryRequired /> : null}
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
          title="Invitations"
          detail={
            linked ? 'Open invitations you received' : 'Available after you finish setting up'
          }
          onPress={linked ? () => router.push('/invitations') : undefined}
          accessibilityHint={linked ? 'Opens Invitations' : undefined}
          testID="account-section-SCR-C-17"
        />
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
      <ConditionalSections linked={linked} />
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
