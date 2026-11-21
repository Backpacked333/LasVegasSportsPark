/**
 * Handoff M 3h Add a child (from You › Add, and from first sign-in for a new family; INTERACTIONS
 * 2f row 2; SPK-IAM-001, SPK-IAM-003, §4.14; ADR-008 visual system v2, **Proposed**):
 *
 * - First name, last name (prefilled with the account holder's) and birth date ("Used for age
 *   groups only"). The button stays grey until first name and birth date are filled, and its label
 *   uses the typed name ("Add Sofia").
 * - The child's colour in the calendar: person colours are given in the order children are added
 *   (`src/ui/person-colors.ts`), so the next free one is shown as theirs and the colours already
 *   used are faded. Choosing another colour needs it stored with the person, which the API does
 *   not do: **Proposed**. A photo is **Proposed** too (the API stores no photos).
 * - Adding creates the child record (`POST /v1/people`, kind `child`: a self-service adult may
 *   create a child record and becomes their guardian) and adds them to the household
 *   (`POST /v1/households/{id}/members`), each with its own idempotency key; then the account and
 *   household reads are refreshed so the new avatar is on You and a new chip in the who filter
 *   everywhere. "Allergies or care notes · Add" goes on to the care notes editor (M 5c) once the
 *   child exists. Offline, adding waits for a connection.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useRouter, type Href } from 'expo-router';
import { useContext, useState } from 'react';
import { Pressable, View } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { useHousehold } from '../../features/home/household';
import { useConnectivity } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { CommandError } from '../../ui/CommandError';
import { DateField } from '../../ui/DateField';
import { TextField } from '../../ui/Field';
import { Icon } from '../../ui/Icon';
import { Screen } from '../../ui/Screen';
import { StatusBadge } from '../../ui/StatusBadge';
import { Text } from '../../ui/Text';
import { useToast } from '../../ui/Toast';
import {
  fonts,
  layout,
  makeStyles,
  MIN_TOUCH_SIZE,
  radius,
  spacing,
  useTheme,
} from '../../ui/theme';
import { peopleRoutes } from '../account/YouHub';

/** The add button's words: "Add Sofia" once a first name is typed, "Add" before. */
export function addLabel(givenName: string): string {
  const name = givenName.trim();
  return name ? `Add ${name}` : 'Add';
}

function AddChild() {
  const styles = useStyles();
  const theme = useTheme();
  const router = useRouter();
  const toast = useToast();
  const queryClient = useQueryClient();
  const insets = useContext(SafeAreaInsetsContext);
  const offline = useConnectivity().reachable === false;
  const { me, people } = useHousehold();
  const households = useApiQuery({ path: '/me/households' });
  const [given, setGiven] = useState('');
  const [family, setFamily] = useState(me.data?.person?.familyName ?? '');
  const [birth, setBirth] = useState<string | null>(null);
  const [thenCare, setThenCare] = useState(false);
  const create = useApiCommand('post', '/people');
  const join = useApiCommand('post', '/households/{id}/members');
  const children = people.filter((p) => !p.self);
  const nextSlot = children.length;
  const ready =
    given.trim() !== '' && birth !== null && (family.trim() !== '' || !!me.data?.person);
  const busy = create.isProcessing || join.isProcessing;

  const add = async () => {
    try {
      const person = await create.submit({
        body: {
          kind: 'child',
          givenName: given.trim(),
          familyName: (family.trim() || me.data?.person?.familyName) ?? '',
          dateOfBirth: birth ?? undefined,
        },
      });
      const householdId = households.data?.items[0]?.id;
      if (householdId) {
        await join.submit({ path: { id: householdId }, body: { personId: person.id } });
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['api', '/me'] }),
        queryClient.invalidateQueries({ queryKey: ['api', '/me/households'] }),
        queryClient.invalidateQueries({ queryKey: ['person-names'] }),
      ]);
      toast.show({ message: `${given.trim()} added to your family.` });
      if (thenCare) router.replace(peopleRoutes.careNotes(person.id));
      else if (router.canGoBack()) router.back();
      else router.replace('/account' as Href);
    } catch {
      // Shown below; the form keeps what was typed.
    }
  };

  const error = create.error ?? join.error;
  return (
    <View testID="add-child">
      <View style={[styles.bar, { paddingTop: (insets?.top ?? 0) + spacing.xs }]}>
        <Pressable
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/account' as Href))}
          accessibilityRole="button"
          accessibilityLabel="Close"
          style={styles.barButton}
          disabled={busy}
        >
          <Icon name="close" size={24} color={theme.colors.text} />
        </Pressable>
        <Text style={styles.barTitle} accessibilityRole="header">
          Add a child
        </Text>
        <View style={styles.barButton} />
      </View>

      <View style={styles.body}>
        <View
          style={styles.photo}
          accessible
          accessibilityLabel="Photo, optional. Proposed: photos are not stored yet."
        >
          <View style={styles.photoCircle}>
            <Icon name="add_a_photo" size={30} color={theme.colors.primary} />
          </View>
          <Text variant="footnote" tone="muted">
            Photo helps staff at check-in · optional
          </Text>
          <StatusBadge tone="pending" label="Proposed" />
        </View>
        <View style={styles.names}>
          <TextField
            label="First name"
            value={given}
            onChangeText={setGiven}
            autoCapitalize="words"
            style={styles.flex}
            testID="add-child-given"
          />
          <TextField
            label="Last name"
            value={family}
            onChangeText={setFamily}
            autoCapitalize="words"
            style={styles.flex}
            testID="add-child-family"
          />
        </View>
        <DateField
          label="Birth date"
          hint="Used for age groups only."
          value={birth}
          onChange={setBirth}
          testID="add-child-birth"
        />
        <View style={styles.colours} testID="add-child-colours">
          <Text style={styles.label}>Their colour in your calendar</Text>
          <View style={styles.swatches}>
            {theme.personColors.map((color, index) => {
              const used = index < nextSlot;
              const theirs = index === nextSlot % theme.personColors.length;
              return (
                <View
                  key={color.accent}
                  style={[
                    styles.swatch,
                    { backgroundColor: color.accent },
                    used ? styles.swatchUsed : null,
                    theirs ? styles.swatchTheirs : null,
                  ]}
                  accessible
                  accessibilityLabel={
                    theirs ? 'Their colour' : used ? 'Already used' : 'Another colour'
                  }
                />
              );
            })}
          </View>
          <Text variant="footnote" tone="muted">
            {children.length > 0
              ? `Faded colours are already used by ${children.map((c) => c.givenName).join(' and ')}.`
              : 'Each child keeps their colour everywhere in the app.'}
          </Text>
          <View style={styles.proposedLine}>
            <StatusBadge tone="pending" label="Proposed" />
            <Text variant="footnote" tone="muted" style={styles.flex}>
              Choosing another colour
            </Text>
          </View>
        </View>
        <Pressable
          onPress={() => setThenCare((v) => !v)}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: thenCare }}
          accessibilityLabel="Allergies or care notes: add them next"
          style={styles.care}
          testID="add-child-care"
        >
          <Icon name="medical_information" size={22} color={theme.colors.danger} />
          <Text style={styles.careText}>Allergies or care notes</Text>
          <Text style={styles.careAdd}>{thenCare ? '✓ Next' : 'Add'}</Text>
        </Pressable>
        {error ? <CommandError error={error} onRetry={() => void add()} /> : null}
        {offline ? (
          <Text variant="footnote" tone="muted">
            Adding a child needs a connection.
          </Text>
        ) : null}
        <Button
          label={addLabel(given)}
          size="lg"
          block
          disabled={!ready || offline}
          busy={busy}
          onPress={() => void add()}
          testID="add-child-submit"
        />
      </View>
    </View>
  );
}

export function AddChildScreen() {
  return (
    <Screen>
      <RequireSession what="adding a child">
        <AddChild />
      </RequireSession>
    </Screen>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  flex: { flex: 1 },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
  },
  barButton: {
    minWidth: MIN_TOUCH_SIZE,
    minHeight: MIN_TOUCH_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  barTitle: {
    flex: 1,
    textAlign: 'center',
    ...fonts.bold,
    fontSize: 17,
    lineHeight: 22,
    color: colors.text,
  },
  body: { paddingHorizontal: layout.gutter, gap: spacing.lg },
  photo: { alignItems: 'center', gap: spacing.sm },
  photoCircle: {
    width: 88,
    height: 88,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: colors.control,
    alignItems: 'center',
    justifyContent: 'center',
  },
  names: { flexDirection: 'row', gap: spacing.md },
  colours: { gap: spacing.sm },
  label: { ...fonts.semibold, fontSize: 14, lineHeight: 18, color: colors.text },
  swatches: { flexDirection: 'row', gap: spacing.md },
  swatch: { width: 40, height: 40, borderRadius: radius.pill },
  swatchUsed: { opacity: 0.35 },
  swatchTheirs: { borderWidth: 3, borderColor: colors.text },
  proposedLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  care: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 56,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
  },
  careText: { flex: 1, ...fonts.bold, fontSize: 16, color: colors.text },
  careAdd: { ...fonts.semibold, fontSize: 15, color: colors.primary },
}));
