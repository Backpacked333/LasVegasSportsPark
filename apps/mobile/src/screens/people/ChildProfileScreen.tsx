/**
 * Handoff M 3e Child profile (from You › a child; INTERACTIONS 2f row 1; SPK-IAM-003, SPK-REG-011,
 * SPK-ENTRY-007, §4.14; ADR-008 visual system v2, **Proposed**):
 *
 * - The photo ring in the child's person colour (the same as the who chips and Calendar) around
 *   their initials; the camera badge opens "Add a photo", which is **Proposed**: the API stores no
 *   profile photos yet, so nothing is uploaded. The name, age, birth date and their colour in
 *   words (`GET /v1/people/{id}`). Edit changes the name and birth date
 *   (`PATCH /v1/people/{id}` with the record's revision; STALE_REVISION reloads).
 * - Activities: the child's registrations (`GET /v1/enrollments?participantPersonId=`), each with
 *   its kind stripe and when, and their waitlist places (`GET /v1/me/waitlist-entries`, "#1 in
 *   line"); a row opens the registration.
 * - Forms: the first form that needs signing or ends soon (`GET /v1/people/{id}/waivers`), "▲ Ends
 *   Dec 3 · renew" with Renew (the Sign sheet), else "✓ Signed".
 * - Care notes: a one-line summary (`GET /v1/people/{id}/care-notes`; protected, every read
 *   logged, so read only here where the parent asked to see the child) opening the editor (M 5c).
 * - Who can pick up: the adults holding the `collect` permission over the child
 *   (`GET /v1/people/{id}/authority`); this feeds the coach's release check (staff 3g). Changing
 *   who may collect is done with the desk (supervised pickup is DEC-075).
 */
import type { Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { useHousehold } from '../../features/home/household';
import { SignSheet } from '../../features/waivers/SignSheet';
import { formatDay } from '../../features/today/time';
import { useNow } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { Avatar } from '../../ui/Avatar';
import { Button } from '../../ui/Button';
import { CommandError } from '../../ui/CommandError';
import { DateField } from '../../ui/DateField';
import { TextField } from '../../ui/Field';
import { Icon } from '../../ui/Icon';
import { personColorOf } from '../../ui/person-colors';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { Sheet } from '../../ui/Sheet';
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
  type,
  useTheme,
} from '../../ui/theme';
import { peopleRoutes } from '../account/YouHub';
import { careSummary } from './care-notes-model';

type Person = Schema<'Person'>;
type PersonWaiver = Schema<'PersonWaiver'>;

const COLOUR_WORDS = ['pink', 'blue', 'orange', 'teal', 'purple'];

/** Whole years on `today` for a birth date. */
export function ageOn(birth: string, today: Date): number {
  const [y, m, d] = birth.split('-').map(Number) as [number, number, number];
  const ty = today.getUTCFullYear();
  const beforeBirthday =
    today.getUTCMonth() + 1 < m || (today.getUTCMonth() + 1 === m && today.getUTCDate() < d);
  return ty - y - (beforeBirthday ? 1 : 0);
}

/** "Mar 14, 2018". */
export function birthWords(birth: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${birth}T12:00:00Z`));
}

/** The form to show on the profile: one to sign first, else the one ending soonest. */
export function formToShow(waivers: readonly PersonWaiver[]): PersonWaiver | null {
  const toSign = waivers.find((w) => w.status !== 'current' && w.currentVersion !== null);
  if (toSign) return toSign;
  return (
    [...waivers]
      .filter((w) => w.validUntil)
      .sort((a, b) => (a.validUntil ?? '').localeCompare(b.validUntil ?? ''))[0] ??
    waivers[0] ??
    null
  );
}

function ProfileCard({ children, testID }: { children: React.ReactNode; testID: string }) {
  const theme = useTheme();
  const styles = useStyles();
  return (
    <View style={[elevation(theme, 'card'), styles.card]} testID={testID}>
      {children}
    </View>
  );
}

function EditSheet({
  person,
  open,
  onClose,
}: {
  person: Person;
  open: boolean;
  onClose: () => void;
}) {
  const styles = useStyles();
  const queryClient = useQueryClient();
  const [given, setGiven] = useState(person.givenName);
  const [family, setFamily] = useState(person.familyName);
  const [birth, setBirth] = useState<string | null>(person.dateOfBirth);
  const save = useApiCommand('patch', '/people/{id}', {
    invalidate: [['api', '/people/{id}'], ['api', '/me'], ['person-names']],
  });
  const submit = async () => {
    try {
      await save.submit({
        path: { id: person.id },
        body: {
          givenName: given.trim(),
          familyName: family.trim(),
          dateOfBirth: birth,
          expectedRevision: person.revision,
        },
      });
      onClose();
    } catch {
      // Shown below.
    }
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={`Edit ${person.givenName}`}
      locked={save.isProcessing}
    >
      <View style={styles.sheet}>
        <TextField label="First name" value={given} onChangeText={setGiven} />
        <TextField label="Last name" value={family} onChangeText={setFamily} />
        <DateField label="Birth date" value={birth} onChange={setBirth} />
        <Button
          label="Save"
          block
          busy={save.isProcessing}
          disabled={!given.trim() || !family.trim()}
          onPress={() => void submit()}
        />
        {save.error ? (
          <CommandError
            error={save.error}
            onRetry={() => void submit()}
            onReload={() => {
              save.reset();
              void queryClient.invalidateQueries({ queryKey: ['api', '/people/{id}'] });
              onClose();
            }}
          />
        ) : null}
      </View>
    </Sheet>
  );
}

function Profile({ person }: { person: Person }) {
  const styles = useStyles();
  const theme = useTheme();
  const router = useRouter();
  const now = useNow();
  const { people, me } = useHousehold();
  const member = people.find((p) => p.id === person.id);
  const color = member ? personColorOf(theme, member.slot) : undefined;
  const [editing, setEditing] = useState(false);
  const [photo, setPhoto] = useState(false);
  const [signing, setSigning] = useState(false);
  const renewRef = useRef<View>(null);

  const enrollments = useApiQuery({
    path: '/enrollments',
    request: { query: { participantPersonId: person.id, limit: 50 } },
  });
  const waitlists = useApiQuery({
    path: '/me/waitlist-entries',
    request: { query: { limit: 50 } },
  });
  const waivers = useApiQuery({
    path: '/people/{id}/waivers',
    request: { path: { id: person.id } },
  });
  const notes = useApiQuery({
    path: '/people/{id}/care-notes',
    request: { path: { id: person.id } },
  });
  const authority = useApiQuery({
    path: '/people/{id}/authority',
    request: { path: { id: person.id } },
  });

  useEffect(() => setEditing(false), [person.revision]);

  const active = (enrollments.data?.items ?? []).filter(
    (e) => e.status === 'confirmed' || e.status === 'pending',
  );
  const waiting = (waitlists.data?.items ?? []).filter(
    (w) => w.participantPersonId === person.id && w.status === 'waiting',
  );
  const form = waivers.data ? formToShow(waivers.data.waivers) : null;
  const formNeeds = form ? form.status !== 'current' && form.currentVersion !== null : false;
  const collectors = [
    ...new Set(
      (authority.data?.grants ?? [])
        .filter((g) => g.permission === 'collect' && g.status === 'effective')
        .map((g) => (g.actorDisplayName ?? '').split(' ')[0] ?? '')
        .filter(Boolean),
    ),
  ];
  const age = person.dateOfBirth ? ageOn(person.dateOfBirth, now) : null;
  const colourWord =
    member && typeof member.slot === 'number'
      ? COLOUR_WORDS[member.slot % COLOUR_WORDS.length]
      : null;
  const facts = [
    age !== null ? `${age} ${age === 1 ? 'year' : 'years'}` : null,
    person.dateOfBirth ? `born ${birthWords(person.dateOfBirth)}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <View testID="child-profile">
      <View style={styles.editRow}>
        <Pressable
          onPress={() => setEditing(true)}
          accessibilityRole="button"
          accessibilityLabel={`Edit ${person.givenName}'s details`}
          style={styles.link}
          testID="child-edit"
        >
          <Text style={styles.linkText}>Edit</Text>
        </Pressable>
      </View>
      <View style={styles.head}>
        <View>
          <Avatar
            name={`${person.givenName} ${person.familyName}`}
            id={person.id}
            personColor={color}
            ring
            size={104}
            decorative
          />
          <Pressable
            onPress={() => setPhoto(true)}
            accessibilityRole="button"
            accessibilityLabel="Add a photo"
            style={styles.camera}
            testID="child-photo"
          >
            <Icon name="photo_camera" size={18} color={theme.colors.primary} />
          </Pressable>
        </View>
        <Text style={styles.name} accessibilityRole="header">
          {`${person.givenName} ${person.familyName}`}
        </Text>
        <Text variant="callout" tone="muted">
          {facts}
          {colourWord && color ? (
            <>
              {facts ? ' · ' : ''}colour <Text style={{ color: color.accent }}>●</Text> {colourWord}
            </>
          ) : null}
        </Text>
      </View>

      <ProfileCard testID="child-activities">
        <View style={styles.cardHead}>
          <Text style={styles.cardTitle}>Activities</Text>
          <Text variant="footnote" tone="muted">{`${active.length + waiting.length} active`}</Text>
        </View>
        {active.map((e) => (
          <Pressable
            key={e.id}
            onPress={() => router.push(`/enrollments/${e.id}` as Href)}
            accessibilityRole="button"
            accessibilityLabel={`${e.offering?.name ?? 'Activity'}, ${e.status === 'pending' ? 'pending' : 'registered'}`}
            style={styles.activity}
          >
            <View
              style={[
                styles.stripe,
                {
                  backgroundColor:
                    e.offering?.kind === 'season'
                      ? theme.kindColors.league
                      : theme.kindColors.program,
                },
              ]}
            />
            <View style={styles.flex}>
              <Text style={styles.rowTitle}>{e.offering?.name ?? 'Activity'}</Text>
              {e.offering ? (
                <Text variant="footnote" tone="muted">
                  {`${formatDay(`${e.offering.startsOn}T12:00:00Z`, 'UTC')} to ${formatDay(`${e.offering.endsOn}T12:00:00Z`, 'UTC')}`}
                </Text>
              ) : null}
            </View>
            <Icon name="chevron_right" size={22} color={theme.colors.primary} />
          </Pressable>
        ))}
        {waiting.map((w) => (
          <View key={w.id} style={styles.activity} accessible>
            <View style={[styles.stripe, { backgroundColor: theme.colors.pending }]} />
            <View style={styles.flex}>
              <Text style={styles.rowTitle}>{w.offeringName ?? 'Waitlist'}</Text>
              <Text variant="footnote" tone="muted">
                {w.position ? `Waitlist · #${w.position} in line` : 'Waitlist'}
              </Text>
            </View>
          </View>
        ))}
        {active.length + waiting.length === 0 && enrollments.data ? (
          <Text variant="callout" tone="muted">
            Nothing yet. Find leagues, classes and camps in Explore.
          </Text>
        ) : null}
      </ProfileCard>

      <ProfileCard testID="child-records">
        {form ? (
          <View style={styles.record} ref={renewRef} collapsable={false}>
            <View
              style={[
                styles.recordIcon,
                { backgroundColor: theme.toneBackgrounds[formNeeds ? 'warning' : 'success'] },
              ]}
            >
              <Icon
                name="edit_document"
                size={20}
                color={formNeeds ? theme.colors.warning : theme.colors.success}
              />
            </View>
            <View style={styles.flex}>
              <Text style={styles.rowTitle}>{form.title}</Text>
              <Text
                variant="footnote"
                style={{ color: formNeeds ? theme.colors.warning : theme.colors.success }}
              >
                {formNeeds
                  ? `▲ ${form.validUntil ? `Ends ${formatDay(form.validUntil, 'UTC').split(', ')[1]} · renew` : 'To sign'}`
                  : `✓ Signed${form.validUntil ? ` until ${formatDay(form.validUntil, 'UTC').split(', ')[1]}` : ''}`}
              </Text>
            </View>
            {formNeeds ? (
              <Button
                label={form.acceptance ? 'Renew' : 'Sign'}
                variant="tonal"
                onPress={() => setSigning(true)}
                testID="child-renew"
              />
            ) : null}
          </View>
        ) : null}
        <Pressable
          onPress={() => router.push(peopleRoutes.careNotes(person.id))}
          accessibilityRole="button"
          accessibilityLabel={`Care notes. ${notes.data ? careSummary(notes.data.notes) : ''}`}
          style={[styles.record, form ? styles.divider : null]}
          testID="child-care-notes"
        >
          <View style={[styles.recordIcon, { backgroundColor: theme.toneBackgrounds.danger }]}>
            <Icon name="medical_information" size={20} color={theme.colors.danger} />
          </View>
          <View style={styles.flex}>
            <Text style={styles.rowTitle}>Care notes</Text>
            <Text variant="footnote" tone="muted" numberOfLines={1}>
              {notes.data ? careSummary(notes.data.notes) : ' '}
            </Text>
          </View>
          <Icon name="chevron_right" size={22} color={theme.colors.primary} />
        </Pressable>
        <View
          style={[styles.record, styles.divider]}
          accessible
          accessibilityLabel={`Who can pick up: ${collectors.length > 0 ? collectors.join(', ') : 'ask the desk'}`}
          testID="child-pickup"
        >
          <View style={[styles.recordIcon, { backgroundColor: theme.colors.surface }]}>
            <Icon name="escalator_warning" size={20} color={theme.colors.text} />
          </View>
          <View style={styles.flex}>
            <Text style={styles.rowTitle}>Who can pick up</Text>
            <Text variant="footnote" tone="muted">
              {collectors.length > 0 ? collectors.join(', ') : 'Ask the front desk to add someone'}
            </Text>
          </View>
        </View>
      </ProfileCard>

      <EditSheet person={person} open={editing} onClose={() => setEditing(false)} />
      <Sheet open={photo} onClose={() => setPhoto(false)} title="Add a photo">
        <View style={styles.sheet} testID="child-photo-proposed">
          <StatusBadge tone="pending" label="Proposed" />
          <Text variant="body">
            A photo helps staff at check-in. Adding one from your camera or library is coming; the
            app does not store photos yet, so staff see {person.givenName}&apos;s initials for now.
          </Text>
        </View>
      </Sheet>
      <SignSheet
        open={signing && form !== null}
        onClose={() => setSigning(false)}
        person={form ? { id: person.id, givenName: person.givenName, waiver: form } : null}
        siblings={[]}
        signerName={
          me.data?.person ? `${me.data.person.givenName} ${me.data.person.familyName}` : ''
        }
        onSigned={() => void waivers.refetch()}
        returnFocusTo={renewRef}
      />
    </View>
  );
}

export function ChildProfileScreen({ personId }: { personId: string | undefined }) {
  const person = useApiQuery({
    path: '/people/{id}',
    request: { path: { id: personId ?? '' } },
    enabled: !!personId,
  });
  return (
    <Screen>
      <RequireSession what="this profile">
        <QueryBoundary
          query={person}
          label="the profile"
          empty={{ title: 'Not available', description: '' }}
        >
          {(data) => <Profile person={data} />}
        </QueryBoundary>
      </RequireSession>
    </Screen>
  );
}

/** Route entry: `/people/<id>` (an opaque id only). */
export function ChildProfileRoute() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  return <ChildProfileScreen personId={typeof id === 'string' ? id : undefined} />;
}

const useStyles = makeStyles(({ colors }) => ({
  flex: { flex: 1, gap: 2 },
  editRow: { flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: layout.gutter },
  link: { minHeight: MIN_TOUCH_SIZE, justifyContent: 'center' },
  linkText: { ...fonts.semibold, fontSize: 15, color: colors.primary },
  head: { alignItems: 'center', gap: spacing.xs, paddingHorizontal: layout.gutter },
  camera: {
    position: 'absolute',
    right: -2,
    bottom: 2,
    width: 34,
    height: 34,
    borderRadius: radius.pill,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: { ...type.title1, ...fonts.bold, color: colors.text, marginTop: spacing.sm },
  card: {
    marginHorizontal: layout.gutter,
    marginTop: spacing.lg,
    paddingHorizontal: 14,
    paddingVertical: spacing.sm,
    borderRadius: radius.lg,
  },
  cardHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.xs,
  },
  cardTitle: { ...fonts.bold, fontSize: 17, lineHeight: 22, color: colors.text },
  activity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 56,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
    paddingVertical: spacing.sm,
  },
  stripe: { width: 4, alignSelf: 'stretch', borderRadius: 4 },
  rowTitle: { ...fonts.bold, fontSize: 16, lineHeight: 21, color: colors.text },
  record: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 60,
    paddingVertical: spacing.sm,
  },
  divider: { borderTopWidth: 1, borderTopColor: colors.divider },
  recordIcon: {
    width: 38,
    height: 38,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheet: { gap: spacing.md },
}));
