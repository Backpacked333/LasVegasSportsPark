/**
 * SCR-C-30, the fifth destination, "You" (SPK-UX-002 as amended by PA-11, **Proposed**: family,
 * registrations, payments, credits, forms, preferences and support, grouped by topic). The tab
 * draws the large title; the hub opens with who is signed in (`GET /v1/me`: an initials avatar
 * and the name), then grouped rows, then "Sign out":
 *
 * - Family: Family and permissions, Invitations.
 * - Bookings and plans: Registrations, Waitlists, then the conditional Package G rows (Rentals
 *   and parties, Memberships, Class packs), then Cart while a registration is in progress.
 * - Money: Payments, Credits and makeups, and the Package G In-person receipts.
 * - Forms: Forms and waivers (forms signed for this person and the people they manage,
 *   FormsScreen; forms still to sign are presented within a registration, SCR-C-13).
 * - Settings: Notifications and calendar, Appearance (the Legends mode switch: dark with a gold
 *   accent, kept on this device), Account setup, Access after recovery.
 * - Help: Support.
 *
 * Family counts the people the Family screen lists: those the API says this account may act for
 * now (`GET /v1/me` authorities) and those over whom it holds only grants paused by a review or
 * starting later (`GET /v1/me/access-grants?direction=held`), so it never says "No family members
 * yet" while Family lists someone as "Under review". Rows that need a linked participant record
 * say so until setup is finished.
 *
 * Package G rows (§3.16, DEC-016) show only while their capability switch is on: `GET
 * /v1/me/permissions` must say so (PA-11 SPK-UX-011: no entry point to a capability that is
 * turned off; while the switches are unknown or failed to load there is no row either). Records
 * the customer already holds stay readable at their own links. Cart shows while `GET
 * /v1/me/baskets` lists a basket in progress (the header's Cart button reads the same list).
 *
 * Account deletion and data requests are DEC-059 (Operator/privacy owner): not offered, and not
 * shown.
 *
 * States: loading; empty (new account: not linked yet, "Finish setting up"); ready; validation
 * failure: not applicable; permission restriction (rows depend on the person's record and grants
 * as the API reports them); stale version: not applicable at the hub, counts refresh on return;
 * offline (cached with age); processing: not applicable; success: not applicable; partial
 * completion: not permitted; recovery required: a registration checkout in `recovery_required`
 * (`GET /v1/me/registration-checkouts?status=recovery_required`) is pinned at the top, "Payment
 * received. We are completing your registration." with "Do not pay again", as on Home (SCR-C-03).
 *
 * Legends mode is a display preference of the device, not account data: signed out, or while the
 * account is loading or failed to load, it is offered on its own under "Appearance", above the
 * sign-in prompt too.
 */
import { presentationForError, type CapabilityId } from '@sportspark/api-client';
import { useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { usePermissions } from '../../api/permissions';
import { useApiPages } from '../../api/useApiPages';
import { useApiQuery } from '../../api/useApiQuery';
import { packageGRoutes } from '../../features/package-g/routes';
import { basketInProgress, useMyBaskets } from '../../features/registration/in-progress';
import { registrationRoutes } from '../../features/registration/routes';
import { RECOVERY_PHRASE } from '../../features/today/status';
import { useApp } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { Avatar } from '../../ui/Avatar';
import { Button } from '../../ui/Button';
import { ListRow } from '../../ui/ListRow';
import { QueryBoundary, QueryErrorView } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { Section } from '../../ui/Section';
import { StatusBadge } from '../../ui/StatusBadge';
import { SwitchRow } from '../../ui/SwitchRow';
import { layout, makeStyles, spacing, type, useLegendsMode } from '../../ui/theme';
import { grantKey, HELD_GRANTS_REQUEST, managedPeople, type GrantView } from '../family/grants';
import { formatDateTime, personDisplayName, useMe, type MeData } from './components/account-data';

/** A row of the hub: what it opens, and whether it needs a linked participant record. */
interface HubRow {
  key: string;
  title: string;
  /** The line under the title when the row is available. */
  detail?: string;
  href: string;
  needsPerson: boolean;
  testID: string;
}

/** A conditional Package G row (§3.16, §6.5; DEC-016): listed only while a switch is on. */
interface ConditionalRow extends HubRow {
  capabilities: readonly CapabilityId[];
}

const FAMILY_ROWS: readonly HubRow[] = [
  {
    key: 'family',
    title: 'Family and permissions',
    href: '/family',
    needsPerson: true,
    testID: 'account-section-SCR-C-31',
  },
  {
    key: 'invitations',
    title: 'Invitations',
    detail: 'Open invitations you received',
    href: '/invitations',
    needsPerson: true,
    testID: 'account-section-SCR-C-17',
  },
];

const BOOKING_ROWS: readonly HubRow[] = [
  {
    key: 'registrations',
    title: 'Registrations',
    href: '/enrollments',
    needsPerson: true,
    testID: 'account-section-SCR-C-32',
  },
  {
    key: 'waitlists',
    title: 'Waitlists',
    href: registrationRoutes.waitlists(),
    needsPerson: true,
    testID: 'account-section-waitlists',
  },
];

const BOOKING_CONDITIONAL: readonly ConditionalRow[] = [
  {
    key: 'bookings',
    title: 'Rentals and parties',
    detail: 'Your bookings',
    href: packageGRoutes.bookings(),
    needsPerson: true,
    capabilities: ['rentals', 'parties'],
    testID: 'account-conditional-bookings',
  },
  {
    key: 'memberships',
    title: 'Memberships',
    detail: "Your and your family's memberships",
    href: packageGRoutes.memberships(),
    needsPerson: true,
    capabilities: ['memberships'],
    testID: 'account-conditional-memberships',
  },
  {
    key: 'session-packages',
    title: 'Class packs',
    detail: 'Classes left and classes used',
    href: packageGRoutes.sessionPackages(),
    needsPerson: true,
    capabilities: ['session_packages'],
    testID: 'account-conditional-session-packages',
  },
];

const MONEY_ROWS: readonly HubRow[] = [
  {
    key: 'payments',
    title: 'Payments',
    href: '/payments',
    needsPerson: true,
    testID: 'account-section-SCR-C-34',
  },
  {
    key: 'credits',
    title: 'Credits and makeups',
    href: '/credits',
    needsPerson: true,
    testID: 'account-section-SCR-C-35',
  },
];

const MONEY_CONDITIONAL: readonly ConditionalRow[] = [
  {
    key: 'pos-receipts',
    title: 'In-person receipts',
    detail: 'Purchases at the facility desk',
    href: packageGRoutes.posReceipts(),
    needsPerson: true,
    capabilities: ['point_of_sale'],
    testID: 'account-conditional-pos-receipts',
  },
];

const FORMS_ROWS: readonly HubRow[] = [
  {
    key: 'forms',
    title: 'Forms and waivers',
    href: '/forms',
    needsPerson: true,
    testID: 'account-section-SCR-C-13',
  },
];

const NOTIFICATIONS_ROW: HubRow = {
  key: 'preferences',
  title: 'Notifications and calendar',
  href: '/preferences',
  needsPerson: true,
  testID: 'account-section-SCR-C-36',
};

const SETUP_ROWS: readonly HubRow[] = [
  {
    key: 'setup',
    title: 'Account setup',
    detail: 'Your participant record and verified email or phone',
    href: '/onboarding',
    needsPerson: false,
    testID: 'account-setup',
  },
  {
    key: 'recovery',
    title: 'Access after recovery',
    detail: 'What this account may access, and what recovery restores',
    href: '/recovery',
    needsPerson: false,
    testID: 'account-recovery-access',
  },
];

const HELP_ROWS: readonly HubRow[] = [
  {
    key: 'support',
    title: 'Support',
    href: '/support',
    needsPerson: false,
    testID: 'account-section-SCR-C-38',
  },
];

function Row({ row, linked, detail }: { row: HubRow; linked: boolean; detail?: string }) {
  const router = useRouter();
  const blocked = row.needsPerson && !linked;
  return (
    <ListRow
      title={row.title}
      detail={blocked ? 'Available after you finish setting up' : (detail ?? row.detail)}
      onPress={blocked ? undefined : () => router.push(row.href)}
      accessibilityHint={blocked ? undefined : `Opens ${row.title}`}
      testID={row.testID}
    />
  );
}

/** A group of the hub: a titled card whose rows screen readers hear as one list. */
function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Section title={title}>
      <View accessibilityRole="list" accessibilityLabel={title}>
        {children}
      </View>
    </Section>
  );
}

/**
 * The Package G rows whose switch `GET /v1/me/permissions` reports on (any of the row's
 * capabilities). None while the switches are unknown, failed to load, or setup is not finished.
 */
function useConditionalRows(linked: boolean) {
  const permissions = usePermissions({ enabled: linked });
  return (rows: readonly ConditionalRow[]) =>
    linked && permissions.data !== undefined
      ? rows.filter((row) =>
          row.capabilities.some((c) => permissions.isCapabilityEnabled(c) === true),
        )
      : [];
}

/** The newest basket still in progress, or null (none, or the list is not known). */
function useCartInProgress(linked: boolean): string | null {
  const baskets = useMyBaskets(linked);
  return baskets.data?.items.find(basketInProgress)?.id ?? null;
}

/** Legends mode (SPK-UX-009): role switch, name "Legends mode", state also in words. */
function LegendsModeRow() {
  const { legends, setLegends } = useLegendsMode();
  return (
    <SwitchRow
      label="Legends mode"
      description="Appearance: a dark look with gold accents"
      value={legends}
      onChange={setLegends}
      testID="account-legends-mode"
    />
  );
}

/** Appearance on its own: signed out, or while the account is not loaded. */
function AppearanceGroup() {
  return (
    <Group title="Appearance">
      <LegendsModeRow />
    </Group>
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

const people = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`;

/**
 * The Family row, from the same sources as the Family screen (`managedPeople`). While the held
 * grants are not loaded (or failed) it names only what `GET /v1/me` says, and never "No family
 * members yet", since a paused grant may still be listed there.
 */
export function familyDetail(me: MeData, held: readonly GrantView[] | undefined): string {
  const now = me.authorities.length;
  if (held === undefined) {
    return now > 0 ? `You may act for ${people(now)}` : 'People you manage and their permissions';
  }
  const later = managedPeople(me, held).length - now;
  if (now === 0 && later === 0) return 'No family members yet';
  if (later === 0) return `You may act for ${people(now)}`;
  const paused = 'with permissions under review, paused or starting later';
  if (now === 0) return `${people(later)} ${paused}`;
  return `You may act for ${people(now)}; ${later} more ${paused}`;
}

/** Who is signed in: an initials avatar, the name, and whether the account is linked. */
function ProfileHeader({ me }: { me: MeData }) {
  const styles = useStyles();
  const name = me.person ? personDisplayName(me.person) : 'Your account';
  const detail = me.person ? 'Signed in' : 'Signed in. Your account is not linked to a person yet.';
  const status = me.person
    ? ({ tone: 'success', label: 'Linked' } as const)
    : ({ tone: 'warning', label: 'Setup not finished' } as const);
  return (
    <View
      style={styles.profile}
      accessible
      accessibilityLabel={`${name}, ${detail}, ${status.label}`}
      testID="account-profile"
    >
      <Avatar name={name} id={me.person?.id} size="lg" decorative />
      <View style={styles.profileText}>
        <Text style={styles.name}>{name}</Text>
        <Text style={styles.detail}>{detail}</Text>
        <StatusBadge {...status} />
      </View>
    </View>
  );
}

function AccountHub({ me }: { me: MeData }) {
  const router = useRouter();
  const { signOut } = useApp();
  const linked = me.person !== null;
  const held = useApiPages({
    path: '/me/access-grants',
    request: HELD_GRANTS_REQUEST,
    keyOf: grantKey,
    enabled: linked,
  });
  const conditional = useConditionalRows(linked);
  const cart = useCartInProgress(linked);
  const row = (r: HubRow, detail?: string) => (
    <Row key={r.key} row={r} linked={linked} detail={detail} />
  );
  return (
    <View>
      {linked ? <RecoveryRequired /> : null}
      <ProfileHeader me={me} />
      {linked ? null : (
        <View style={styles.actions}>
          <Button label="Finish setting up" onPress={() => router.push('/onboarding')} />
        </View>
      )}
      <Group title="Family">
        {row(FAMILY_ROWS[0] as HubRow, familyDetail(me, held.data))}
        {row(FAMILY_ROWS[1] as HubRow)}
      </Group>
      <Group title="Bookings and plans">
        {BOOKING_ROWS.map((r) => row(r))}
        {conditional(BOOKING_CONDITIONAL).map((r) => row(r))}
        {cart ? (
          <ListRow
            title="Cart"
            detail="The registration you started"
            onPress={() => router.push(registrationRoutes.basket(cart))}
            accessibilityHint="Opens Cart"
            testID="account-cart"
          />
        ) : null}
      </Group>
      <Group title="Money">
        {MONEY_ROWS.map((r) => row(r))}
        {conditional(MONEY_CONDITIONAL).map((r) => row(r))}
      </Group>
      <Group title="Forms">{FORMS_ROWS.map((r) => row(r))}</Group>
      <Group title="Settings">
        {row(NOTIFICATIONS_ROW)}
        <LegendsModeRow />
        {SETUP_ROWS.map((r) => row(r))}
      </Group>
      <Group title="Help">{HELP_ROWS.map((r) => row(r))}</Group>
      <View style={styles.actions}>
        <Button label="Sign out" variant="secondary" onPress={() => void signOut()} />
      </View>
    </View>
  );
}

function SignedInAccount() {
  const me = useMe();
  return (
    <>
      <QueryBoundary
        query={me}
        label="your account"
        empty={{ title: 'No account details', description: '' }}
      >
        {(data) => <AccountHub me={data} />}
      </QueryBoundary>
      {/* Until the hub (with its Settings) is shown, the display preference stays on offer. */}
      {me.data === undefined ? <AppearanceGroup /> : null}
    </>
  );
}

export function AccountScreen() {
  const { session } = useApp();
  return (
    <Screen>
      {/* A display preference of this device: offered signed out too, above the sign-in prompt. */}
      {session.status === 'signed_in' ? null : <AppearanceGroup />}
      <RequireSession what="your account">
        <SignedInAccount />
      </RequireSession>
    </Screen>
  );
}

const styles = StyleSheet.create({
  actions: { padding: spacing.lg },
});

const useStyles = makeStyles(({ colors }) => ({
  profile: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: layout.gutter,
    paddingVertical: spacing.md,
  },
  profileText: { flex: 1, gap: spacing.xs, alignItems: 'flex-start' },
  name: { ...type.title1, color: colors.text },
  detail: { ...type.footnote, color: colors.textMuted },
}));
