/**
 * Handoff M 2f "You · one family hub" (INTERACTIONS 2f rows 1 to 6; SPK-UX-002, SPK-IAM-003,
 * SPK-PAY-005, SPK-REG-011; ADR-008 visual system v2, **Proposed**):
 *
 * - The family first: the account holder with the household's name and size ("Ortiz household ·
 *   3 people", `GET /v1/me/households`) and Edit (Family and permissions), then each child the
 *   API lets this account view, in their person colour, with a "!" flag on whoever needs something
 *   (a fee to pay or a form to sign: the same reads as Home's To do). A child opens their profile
 *   (M 3e); "Add" starts Add a child (M 3h).
 * - Money as two tiles: Due now (the family's open fees; one fee opens the Pay sheet, several the
 *   Payments list; nothing due reads "✓ All paid") and Credits (`GET /v1/people/{id}/money-summary`
 *   `creditsAvailable`).
 * - One grouped list: Registrations (how many are active), Forms (▲ "1 to sign"; one form to sign
 *   opens its sign sheet directly), Payments & receipts, Memberships & class packs (only while
 *   that capability is on), Care & allergy notes; then Notifications, Legends mode (a switch, kept
 *   on this device) and Help & contact the desk (a sheet with Call, Email and Opening hours from the
 *   configured support contact; DEC-015 pending when none is configured).
 */
import type { Schema } from '@sportspark/api-client';
import { useRouter, type Href } from 'expo-router';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Linking, Pressable, View } from 'react-native';
import { usePermissions } from '../../api/permissions';
import { useApiQuery } from '../../api/useApiQuery';
import { pendingMessage } from '../../copy/pending';
import { useHousehold, type HouseholdPerson } from '../../features/home/household';
import { todoItems, useTodoReads, type TodoItem } from '../../features/home/todo';
import { PaySheet } from '../../features/money/PaySheet';
import { useApiReads, useSignedIn } from '../../features/today/queries';
import { SignSheet } from '../../features/waivers/SignSheet';
import { packageGRoutes } from '../../features/package-g/routes';
import { useApp, useNow } from '../../providers/AppProviders';
import { Avatar } from '../../ui/Avatar';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { personColorOf } from '../../ui/person-colors';
import { Sheet } from '../../ui/Sheet';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { Text } from '../../ui/Text';
import {
  elevation,
  fonts,
  layout,
  makeStyles,
  MIN_TOUCH_SIZE,
  radius,
  spacing,
  tabular,
  useLegendsMode,
  useTheme,
} from '../../ui/theme';
import type { MeData } from './components/account-data';

type Obligation = Schema<'Obligation'>;

/** "$120", "$120.50": whole dollars without cents. */
export function tileMoney(minor: number, currency: string): string {
  const whole = minor % 100 === 0;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(minor / 100);
}

/** The people who need something: their fees to pay and forms to sign (Home's To do). */
export function needsSomething(items: readonly TodoItem[]): Set<string> {
  return new Set(items.filter((i) => i.kind !== 'join').map((i) => i.personId));
}

/** People routes of the redesign (opaque ids only, §4.14). */
export const peopleRoutes = {
  profile: (personId: string) => ({ pathname: '/people/[id]', params: { id: personId } }) as Href,
  careNotes: (personId: string) =>
    ({ pathname: '/people/[id]/care-notes', params: { id: personId } }) as Href,
  add: () => '/people/new' as Href,
};

function FamilyCard({
  me,
  people,
  flagged,
}: {
  me: MeData;
  people: readonly HouseholdPerson[];
  flagged: ReadonlySet<string>;
}) {
  const styles = useStyles();
  const theme = useTheme();
  const router = useRouter();
  const households = useApiQuery({ path: '/me/households' });
  const household = households.data?.items[0];
  const self = people.find((p) => p.self);
  const children = people.filter((p) => !p.self);
  const name = me.person ? `${me.person.givenName} ${me.person.familyName}` : 'Your account';
  const size = household ? household.members.length + household.otherMemberCount : people.length;
  const line = household
    ? `${household.name} · ${size} ${size === 1 ? 'person' : 'people'}`
    : `${size} ${size === 1 ? 'person' : 'people'}`;
  return (
    <View style={[elevation(theme, 'card'), styles.family]} testID="you-family">
      <View style={styles.holder}>
        <Avatar
          name={name}
          id={me.person?.id}
          personColor={self ? personColorOf(theme, self.slot) : undefined}
          size={52}
          decorative
        />
        <View style={styles.flex}>
          <Text style={styles.holderName} accessibilityRole="header">
            {name}
          </Text>
          <Text variant="footnote" tone="muted">
            {line}
          </Text>
        </View>
        <Pressable
          onPress={() => router.push('/family')}
          accessibilityRole="button"
          accessibilityLabel="Edit family and permissions"
          style={styles.link}
          hitSlop={8}
          testID="you-family-edit"
        >
          <Text style={styles.linkText}>Edit</Text>
        </Pressable>
      </View>
      <View style={styles.children} accessibilityRole="list">
        {children.map((child) => {
          const flag = flagged.has(child.id);
          return (
            <Pressable
              key={child.id}
              onPress={() => router.push(peopleRoutes.profile(child.id))}
              accessibilityRole="button"
              accessibilityLabel={`${child.givenName}${flag ? ', needs something' : ''}`}
              accessibilityHint="Opens their profile"
              style={styles.child}
              testID={`you-child-${child.id}`}
            >
              <View>
                <Avatar
                  name={child.givenName}
                  id={child.id}
                  personColor={personColorOf(theme, child.slot)}
                  size={52}
                  decorative
                />
                {flag ? (
                  <View style={styles.flag}>
                    <Text style={styles.flagText}>!</Text>
                  </View>
                ) : null}
              </View>
              <Text style={styles.childName}>{child.givenName}</Text>
            </Pressable>
          );
        })}
        <Pressable
          onPress={() => router.push(peopleRoutes.add())}
          accessibilityRole="button"
          accessibilityLabel="Add a child"
          style={styles.child}
          testID="you-add-child"
        >
          <View style={styles.addCircle}>
            <Icon name="add" size={24} color={theme.colors.primary} />
          </View>
          <Text style={[styles.childName, styles.addText]}>Add</Text>
        </Pressable>
      </View>
    </View>
  );
}

function Tile({
  label,
  value,
  detail,
  onPress,
  accessibilityLabel,
  testID,
}: {
  label: string;
  value: string;
  detail: ReactNode;
  onPress?: () => void;
  accessibilityLabel: string;
  testID: string;
}) {
  const styles = useStyles();
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessible
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [
        elevation(theme, 'card'),
        styles.tile,
        pressed ? styles.pressed : null,
      ]}
      testID={testID}
    >
      <Text style={styles.tileLabel}>{label}</Text>
      <Text style={styles.tileValue}>{value}</Text>
      {detail}
    </Pressable>
  );
}

/** One row of the grouped list: an icon tile, the title, what is beside it, and a chevron. */
function HubRow({
  icon,
  title,
  trailing,
  tone,
  onPress,
  first,
  testID,
  spoken,
}: {
  icon: string;
  title: string;
  trailing?: ReactNode;
  tone?: 'warning' | 'night';
  onPress?: () => void;
  first?: boolean;
  testID: string;
  spoken?: string;
}) {
  const styles = useStyles();
  const theme = useTheme();
  const tileStyle =
    tone === 'warning'
      ? { backgroundColor: theme.toneBackgrounds.warning }
      : tone === 'night'
        ? { backgroundColor: theme.colors.night }
        : { backgroundColor: theme.colors.surface };
  const iconColor =
    tone === 'warning'
      ? theme.colors.warning
      : tone === 'night'
        ? theme.colors.floodlight
        : theme.colors.text;
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole="button"
      accessibilityLabel={spoken ?? title}
      style={({ pressed }) => [
        styles.row,
        first ? null : styles.rowDivider,
        pressed ? styles.pressed : null,
      ]}
      testID={testID}
    >
      <View style={[styles.rowIcon, tileStyle]}>
        <Icon name={icon} size={20} color={iconColor} />
      </View>
      <Text style={styles.rowTitle}>{title}</Text>
      {trailing}
      <Icon name="chevron_right" size={22} color={theme.colors.primary} />
    </Pressable>
  );
}

/** Help & contact the desk (INTERACTIONS 2f row 6): Call, Email, Opening hours. */
function HelpSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const styles = useStyles();
  const router = useRouter();
  const { services } = useApp();
  const contact = services.config.supportContact ?? null;
  return (
    <Sheet open={open} onClose={onClose} title="Help & contact the desk">
      <View style={styles.sheetBody} testID="you-help">
        {contact ? (
          <>
            {contact.phone ? (
              <Button
                label="Call the desk"
                icon="call"
                block
                accessibilityHint={`Calls ${contact.phone}`}
                onPress={() =>
                  void Linking.openURL(`tel:${contact.phone?.replace(/[^\d+]/g, '')}`).catch(
                    () => undefined,
                  )
                }
              />
            ) : null}
            {contact.email ? (
              <Button
                label="Email"
                icon="mail"
                variant="secondary"
                block
                accessibilityHint={`Writes to ${contact.email}`}
                onPress={() =>
                  void Linking.openURL(`mailto:${contact.email}`).catch(() => undefined)
                }
              />
            ) : null}
            <View style={styles.hours} accessible testID="you-help-hours">
              <Text style={styles.hoursTitle}>Opening hours</Text>
              <Text variant="callout" tone="muted">
                {contact.hours ?? 'Ask the front desk.'}
              </Text>
            </View>
          </>
        ) : (
          <StateView
            variant="pending-decision"
            subject="The facility’s support phone, email and hours"
            decisions={['DEC-015']}
            owner="Technical lead/operator"
            message={pendingMessage('DEC-015')}
          />
        )}
        <Button
          label="Write to the desk"
          variant="secondary"
          block
          onPress={() => {
            onClose();
            router.push('/support');
          }}
        />
      </View>
    </Sheet>
  );
}

/** Care & allergy notes: one child opens theirs; several ask whose first. */
function CareNotesSheet({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: readonly HouseholdPerson[];
}) {
  const styles = useStyles();
  const theme = useTheme();
  const router = useRouter();
  return (
    <Sheet open={open} onClose={onClose} title="Whose care notes?">
      <View style={styles.sheetBody}>
        {children.map((child) => (
          <Pressable
            key={child.id}
            onPress={() => {
              onClose();
              router.push(peopleRoutes.careNotes(child.id));
            }}
            accessibilityRole="button"
            accessibilityLabel={`${child.givenName}'s care notes`}
            style={styles.chooser}
          >
            <Avatar
              name={child.givenName}
              id={child.id}
              personColor={personColorOf(theme, child.slot)}
              size={36}
              decorative
            />
            <Text style={styles.rowTitle}>{child.givenName}</Text>
            <Icon name="chevron_right" size={22} color={theme.colors.primary} />
          </Pressable>
        ))}
      </View>
    </Sheet>
  );
}

export function YouHub({ me, linked }: { me: MeData; linked: boolean }) {
  const styles = useStyles();
  const theme = useTheme();
  const router = useRouter();
  const now = useNow();
  const signedIn = useSignedIn();
  const { legends, setLegends } = useLegendsMode();
  const permissions = usePermissions({ enabled: linked });
  const { people, selfId } = useHousehold();
  const reads = useTodoReads(people, selfId);
  const todo = todoItems({
    obligations: reads.obligations,
    waivers: reads.waivers,
    invitations: reads.invitations,
    selfId,
    now,
  });
  const flagged = needsSomething(todo);
  const children = people.filter((p) => !p.self);
  const fees = todo.filter((i): i is Extract<TodoItem, { kind: 'pay' }> => i.kind === 'pay');
  const forms = todo.filter((i): i is Extract<TodoItem, { kind: 'sign' }> => i.kind === 'sign');
  const due = fees.reduce((sum, f) => sum + f.obligation.totals.remainingMinor, 0);
  const currency = fees[0]?.obligation.totals.currency ?? 'USD';
  const summary = useApiQuery({
    path: '/people/{id}/money-summary',
    request: { path: { id: selfId ?? '' } },
    enabled: signedIn && !!selfId && linked,
  });
  const credits = summary.data?.creditsAvailable[0];
  const enrollmentRequests = useMemo(
    () => children.map((c) => ({ query: { participantPersonId: c.id, limit: 50 } })),
    [children],
  );
  const enrollments = useApiReads('/enrollments', enrollmentRequests, signedIn && linked);
  const active = enrollments
    .flatMap((r) => r.data?.items ?? [])
    .filter((e) => e.status === 'confirmed' || e.status === 'pending').length;
  const enrollmentsKnown = enrollments.length > 0 && enrollments.every((r) => r.data);
  const memberships = permissions.data
    ? ['memberships', 'session_packages'].some(
        (c) => permissions.isCapabilityEnabled(c as never) === true,
      )
    : false;

  const [paying, setPaying] = useState<Obligation | null>(null);
  const [signing, setSigning] = useState<Extract<TodoItem, { kind: 'sign' }> | null>(null);
  const [help, setHelp] = useState(false);
  const [careChooser, setCareChooser] = useState(false);
  const payTrigger = useRef<View>(null);
  const formsTrigger = useRef<View>(null);
  const nameOf = (personId: string) =>
    people.find((p) => p.id === personId)?.givenName ?? 'Family member';
  const signPerson = signing
    ? {
        id: signing.personId,
        givenName: nameOf(signing.personId),
        waiver: signing.waiver,
      }
    : null;

  const payDue = () => {
    if (fees.length === 1) setPaying(fees[0]?.obligation ?? null);
    else router.push('/payments');
  };

  return (
    <View testID="you-hub">
      <FamilyCard me={me} people={people} flagged={flagged} />
      <View style={styles.tiles}>
        <View style={styles.flex} ref={payTrigger}>
          <Tile
            label="Due now"
            value={tileMoney(due, currency)}
            detail={
              due > 0 ? (
                <Text style={styles.tileLink}>Pay →</Text>
              ) : (
                <Text style={styles.tileDone}>✓ All paid</Text>
              )
            }
            onPress={due > 0 ? payDue : undefined}
            accessibilityLabel={
              due > 0 ? `Due now, ${tileMoney(due, currency)}. Pay` : 'Due now, nothing. All paid'
            }
            testID="you-due"
          />
        </View>
        <View style={styles.flex}>
          <Tile
            label="Credits"
            value={credits ? tileMoney(credits.amountMinor, credits.currency) : '$0'}
            detail={
              <Text variant="footnote" tone="muted">
                Used first at checkout
              </Text>
            }
            onPress={() => router.push('/credits')}
            accessibilityLabel={`Credits, ${credits ? tileMoney(credits.amountMinor, credits.currency) : 'none'}`}
            testID="you-credits"
          />
        </View>
      </View>

      <View style={[styles.group, styles.groupFirst]} accessibilityRole="list">
        <HubRow
          first
          icon="assignment"
          title="Registrations"
          trailing={
            enrollmentsKnown ? <Text style={styles.trailing}>{`${active} active`}</Text> : null
          }
          spoken={enrollmentsKnown ? `Registrations, ${active} active` : 'Registrations'}
          onPress={() => router.push('/enrollments')}
          testID="you-registrations"
        />
        <View ref={formsTrigger} collapsable={false}>
          <HubRow
            icon="edit_document"
            tone={forms.length > 0 ? 'warning' : undefined}
            title="Forms"
            trailing={
              forms.length > 0 ? (
                <StatusBadge tone="warning" label={`${forms.length} to sign`} />
              ) : null
            }
            spoken={forms.length > 0 ? `Forms, ${forms.length} to sign` : 'Forms'}
            onPress={() => {
              if (forms.length === 1) setSigning(forms[0] ?? null);
              else router.push('/forms');
            }}
            testID="you-forms"
          />
        </View>
        <HubRow
          icon="receipt_long"
          title="Payments & receipts"
          onPress={() => router.push('/payments')}
          testID="you-payments"
        />
        {memberships ? (
          <HubRow
            icon="card_membership"
            title="Memberships & class packs"
            onPress={() => router.push(packageGRoutes.memberships())}
            testID="you-memberships"
          />
        ) : null}
        <HubRow
          icon="medical_information"
          title="Care & allergy notes"
          onPress={() => {
            if (children.length === 1 && children[0])
              router.push(peopleRoutes.careNotes(children[0].id));
            else if (children.length > 1) setCareChooser(true);
            else router.push('/family');
          }}
          testID="you-care-notes"
        />
      </View>

      <View style={styles.group} accessibilityRole="list">
        <HubRow
          first
          icon="notifications"
          title="Notifications"
          onPress={() => router.push('/notifications')}
          testID="you-notifications"
        />
        <Pressable
          onPress={() => setLegends(!legends)}
          accessibilityRole="switch"
          accessibilityLabel="Legends mode"
          accessibilityHint="Appearance: night green with floodlight accents"
          accessibilityState={{ checked: legends }}
          style={({ pressed }) => [styles.row, styles.rowDivider, pressed ? styles.pressed : null]}
          testID="account-legends-mode"
        >
          <View style={[styles.rowIcon, { backgroundColor: theme.colors.night }]}>
            <Icon name="dark_mode" size={20} color={theme.colors.floodlight} />
          </View>
          <Text style={styles.rowTitle}>Legends mode</Text>
          <View style={[styles.track, legends ? styles.trackOn : null]}>
            <View style={[styles.thumb, legends ? styles.thumbOn : null]} />
          </View>
        </Pressable>
        <HubRow
          icon="support_agent"
          title="Help & contact the desk"
          onPress={() => setHelp(true)}
          testID="you-help-row"
        />
      </View>

      <PaySheet
        open={paying !== null}
        onClose={() => setPaying(null)}
        obligation={paying}
        subtitle={paying ? paying.description : ''}
        onPaid={() => reads.refetch()}
        returnFocusTo={payTrigger}
      />
      <SignSheet
        open={signing !== null}
        onClose={() => setSigning(null)}
        person={signPerson}
        siblings={[]}
        context={signing ? signing.title : ''}
        signerName={me.person ? `${me.person.givenName} ${me.person.familyName}` : ''}
        onSigned={() => reads.refetch()}
        returnFocusTo={formsTrigger}
      />
      <HelpSheet open={help} onClose={() => setHelp(false)} />
      <CareNotesSheet
        open={careChooser}
        onClose={() => setCareChooser(false)}
        children={children}
      />
    </View>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  flex: { flex: 1 },
  family: {
    marginHorizontal: layout.gutter,
    marginTop: spacing.sm,
    padding: spacing.lg,
    gap: 14,
    borderRadius: radius.lg,
  },
  holder: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  holderName: { ...fonts.bold, fontSize: 19, lineHeight: 24, color: colors.text },
  link: { minHeight: MIN_TOUCH_SIZE, justifyContent: 'center' },
  linkText: { ...fonts.semibold, fontSize: 14, color: colors.primary },
  children: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.lg },
  child: { alignItems: 'center', gap: 6, minWidth: MIN_TOUCH_SIZE },
  childName: { ...fonts.semibold, fontSize: 13, lineHeight: 18, color: colors.text },
  flag: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 20,
    height: 20,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.warningBorder,
    borderWidth: 2,
    borderColor: colors.background,
  },
  flagText: { ...fonts.extrabold, fontSize: 11, lineHeight: 14, color: colors.warning },
  addCircle: {
    width: 52,
    height: 52,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: colors.control,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addText: { color: colors.primary },
  tiles: {
    flexDirection: 'row',
    gap: spacing.md,
    marginHorizontal: layout.gutter,
    marginTop: spacing.md,
  },
  tile: { padding: 14, gap: spacing.xs, borderRadius: radius.lg },
  tileLabel: { ...fonts.semibold, fontSize: 13, lineHeight: 18, color: colors.textMuted },
  tileValue: { ...tabular({}), ...fonts.bold, fontSize: 24, lineHeight: 30, color: colors.text },
  tileLink: { ...fonts.semibold, fontSize: 13, lineHeight: 18, color: colors.primary },
  tileDone: { ...fonts.semibold, fontSize: 13, lineHeight: 18, color: colors.success },
  pressed: { opacity: 0.75 },
  group: {
    marginHorizontal: layout.gutter,
    marginTop: spacing.md,
    paddingHorizontal: 14,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
  },
  groupFirst: { marginTop: spacing.xl },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    minHeight: 56,
  },
  rowDivider: { borderTopWidth: 1, borderTopColor: colors.divider },
  rowIcon: {
    width: 38,
    height: 38,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowTitle: { flex: 1, ...fonts.bold, fontSize: 16, lineHeight: 21, color: colors.text },
  trailing: { ...fonts.regular, fontSize: 15, lineHeight: 20, color: colors.textMuted },
  track: {
    width: 50,
    height: 30,
    borderRadius: radius.pill,
    backgroundColor: colors.control,
    padding: 3,
  },
  trackOn: { backgroundColor: colors.primary },
  thumb: { width: 24, height: 24, borderRadius: radius.pill, backgroundColor: colors.background },
  thumbOn: { alignSelf: 'flex-end', backgroundColor: colors.primaryText },
  sheetBody: { gap: spacing.md },
  hours: { gap: spacing.xs, paddingVertical: spacing.sm },
  hoursTitle: { ...fonts.semibold, fontSize: 15, color: colors.text },
  chooser: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 56,
  },
}));
