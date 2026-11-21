/**
 * Handoff M 5c Care notes editor (from the child profile M 3e; SPK-DISC-005, SPK-IAM-003, §4.10,
 * §4.14; ADR-008 visual system v2, **Proposed**). Operational notes only, never a diagnosis.
 *
 * - Allergies as chips with their severity ("✕ Peanuts · severe"), each removable, and "+ Add"
 *   (a name and mild / moderate / severe). Allergies are what the desk and coaches see as red
 *   flags (staff 2a, 2d).
 * - "If it happens": the instruction a coach reads in an emergency; "Other notes for coaches".
 * - The blue box says who can read the notes, from the roles the API names (`visibleToRoles`),
 *   and that every read is logged (`readAudited`).
 * - "Show a red allergy flag at check-in": the desk shows allergy notes as a flag already; turning
 *   it off is not in the API, so the box is shown checked and fixed: **Proposed**.
 * - Save sends the changes the way the API corrects notes (`care-notes-model.ts`: a changed or
 *   removed note is retired with its revision and a reason, the new text recorded). Closing with
 *   unsaved changes asks "Save changes?" first (Save, Discard, Keep editing).
 * - Reading the notes is protected and audited (`GET /v1/people/{id}/care-notes`): NOT_FOUND is
 *   "not available" with no hint that notes exist. Offline, saving waits for a connection.
 */
import type { Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useContext, useState } from 'react';
import { Pressable, View } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { useApiQuery } from '../../api/useApiQuery';
import { useHousehold } from '../../features/home/household';
import { useApi, useConnectivity } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { LiveText } from '../../ui/announce';
import { Avatar } from '../../ui/Avatar';
import { Button } from '../../ui/Button';
import { TextField } from '../../ui/Field';
import { Icon } from '../../ui/Icon';
import { personColorOf } from '../../ui/person-colors';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { Sheet } from '../../ui/Sheet';
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
  type,
  useTheme,
} from '../../ui/theme';
import {
  allergyText,
  careChanges,
  draftOf,
  sameDraft,
  SEVERITIES,
  whoSees,
  type CareDraft,
  type Severity,
} from './care-notes-model';

type PersonCareNotes = Schema<'PersonCareNotes'>;

const RETIRE_REASON = 'Changed by the family in the app';

function Editor({
  personId,
  givenName,
  notes,
}: {
  personId: string;
  givenName: string;
  notes: PersonCareNotes;
}) {
  const styles = useStyles();
  const theme = useTheme();
  const router = useRouter();
  const api = useApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const insets = useContext(SafeAreaInsetsContext);
  const offline = useConnectivity().reachable === false;
  const { people } = useHousehold();
  const member = people.find((p) => p.id === personId);
  const original = draftOf(notes.notes);
  const [draft, setDraft] = useState<CareDraft>(original);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newSeverity, setNewSeverity] = useState<Severity | null>('severe');
  const [asking, setAsking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const dirty = !sameDraft(original, draft);

  const close = () => (router.canGoBack() ? router.back() : router.replace('/account'));
  const requestClose = () => (dirty ? setAsking(true) : close());

  const save = async () => {
    setSaving(true);
    setFailed(false);
    try {
      for (const change of careChanges(notes.notes, draft)) {
        if (change.kind === 'retire') {
          await api.post('/care-notes/{id}/retire', {
            path: { id: change.note.id },
            body: { expectedRevision: change.note.revision, reason: RETIRE_REASON },
            intent: api.newIntent(),
          });
        } else {
          await api.post('/people/{id}/care-notes', {
            path: { id: personId },
            body: { kind: change.noteKind, body: change.body },
            intent: api.newIntent(),
          });
        }
      }
      await queryClient.invalidateQueries({ queryKey: ['api', '/people/{id}/care-notes'] });
      toast.show({ message: `Saved ${givenName}'s care notes.` });
      close();
    } catch {
      // What saved stays saved; the notes are read again so the screen shows them as they are.
      setFailed(true);
      await queryClient.invalidateQueries({ queryKey: ['api', '/people/{id}/care-notes'] });
    } finally {
      setSaving(false);
    }
  };

  const addAllergy = () => {
    if (!newName.trim()) return;
    setDraft((d) => ({
      ...d,
      allergies: [
        ...d.allergies,
        {
          noteId: null,
          name: newName.trim(),
          severity: newSeverity,
          text: allergyText(newName, newSeverity),
        },
      ],
    }));
    setNewName('');
    setAdding(false);
  };

  return (
    <View testID="care-notes-editor">
      <View style={[styles.bar, { paddingTop: (insets?.top ?? 0) + spacing.xs }]}>
        <Pressable
          onPress={requestClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
          style={styles.barButton}
          testID="care-close"
        >
          <Icon name="close" size={24} color={theme.colors.text} />
        </Pressable>
        <Avatar
          name={givenName}
          id={personId}
          personColor={member ? personColorOf(theme, member.slot) : undefined}
          size={32}
          decorative
        />
        <Text style={styles.barTitle} accessibilityRole="header" numberOfLines={1}>
          {`${givenName}'s care notes`}
        </Text>
        <Pressable
          onPress={() => void save()}
          disabled={!dirty || saving || offline}
          accessibilityRole="button"
          accessibilityLabel="Save"
          accessibilityState={{ disabled: !dirty || saving || offline, busy: saving }}
          style={styles.barButton}
          testID="care-save"
        >
          <Text style={[styles.save, !dirty || offline ? styles.saveDisabled : null]}>
            {saving ? 'Saving…' : 'Save'}
          </Text>
        </Pressable>
      </View>

      <View style={styles.body}>
        <Text style={styles.label} accessibilityRole="header">
          Allergies
        </Text>
        <View style={styles.chips}>
          {draft.allergies.map((a, index) => (
            <View
              key={`${a.noteId ?? 'new'}-${index}`}
              style={[styles.chip, { backgroundColor: theme.toneBackgrounds.danger }]}
            >
              <Text style={[styles.chipText, { color: theme.colors.danger }]}>
                {`✕ ${a.name}${a.severity ? ` · ${a.severity}` : ''}`}
              </Text>
              <Pressable
                onPress={() =>
                  setDraft((d) => ({ ...d, allergies: d.allergies.filter((_, i) => i !== index) }))
                }
                accessibilityRole="button"
                accessibilityLabel={`Remove ${a.name}`}
                hitSlop={10}
              >
                <Icon name="close" size={18} color={theme.colors.danger} />
              </Pressable>
            </View>
          ))}
          {adding ? null : (
            <Pressable
              onPress={() => setAdding(true)}
              accessibilityRole="button"
              accessibilityLabel="Add an allergy"
              style={styles.addChip}
              testID="care-add-allergy"
            >
              <Text style={styles.addChipText}>+ Add</Text>
            </Pressable>
          )}
        </View>
        {adding ? (
          <View style={styles.adding}>
            <TextField label="Allergy" value={newName} onChangeText={setNewName} />
            <SegmentedControl<Severity>
              label="How severe"
              pattern="radio"
              segments={SEVERITIES.map((s) => ({
                value: s,
                label: s[0]?.toUpperCase() + s.slice(1),
              }))}
              value={newSeverity}
              onChange={setNewSeverity}
            />
            <View style={styles.row}>
              <Button label="Cancel" variant="secondary" onPress={() => setAdding(false)} />
              <Button label="Add allergy" disabled={!newName.trim()} onPress={addAllergy} />
            </View>
          </View>
        ) : null}

        <View style={styles.box}>
          <TextField
            label="If it happens"
            value={draft.ifItHappens}
            onChangeText={(t) => setDraft((d) => ({ ...d, ifItHappens: t }))}
            multiline
            maxLength={500}
            testID="care-if-it-happens"
          />
        </View>
        <TextField
          label="Other notes for coaches"
          value={draft.other}
          onChangeText={(t) => setDraft((d) => ({ ...d, other: t }))}
          multiline
          maxLength={500}
          testID="care-other"
        />

        <View
          style={[styles.info, { backgroundColor: theme.toneBackgrounds.info }]}
          accessible
          testID="care-who-sees"
        >
          <Icon name="visibility" size={20} color={theme.colors.info} />
          <Text style={[styles.infoText, { color: theme.colors.info }]}>
            <Text style={styles.bold}>Who sees this: </Text>
            {`${whoSees(givenName, notes.visibleToRoles)}, when they need them.${notes.readAudited ? " Each time someone reads it, it's logged." : ''}`}
          </Text>
        </View>

        <View
          style={styles.flagRow}
          accessible
          accessibilityLabel="Show a red allergy flag at check-in, on. Choosing this is proposed."
        >
          <View style={[styles.check, { backgroundColor: theme.colors.primary }]}>
            <Icon name="check" size={16} color={theme.colors.primaryText} />
          </View>
          <Text variant="callout" style={styles.flex}>
            Show a red allergy flag at check-in
          </Text>
          <StatusBadge tone="pending" label="Proposed" />
        </View>

        {offline ? (
          <Text variant="footnote" tone="muted">
            Saving needs a connection.
          </Text>
        ) : null}
        {failed ? (
          <LiveText
            announcement="Some changes didn't save. Check the notes and try Save again."
            style={styles.error}
          >
            Some changes didn&apos;t save. Check the notes and try Save again.
          </LiveText>
        ) : null}
      </View>

      <Sheet open={asking} onClose={() => setAsking(false)} title="Save changes?">
        <View style={styles.sheet}>
          <Text variant="body">{`Your changes to ${givenName}'s care notes are not saved yet.`}</Text>
          <Button
            label="Save"
            block
            disabled={offline}
            onPress={() => {
              setAsking(false);
              void save();
            }}
          />
          <Button
            label="Discard"
            variant="destructive"
            block
            onPress={() => {
              setAsking(false);
              close();
            }}
          />
          <Button label="Keep editing" variant="text" block onPress={() => setAsking(false)} />
        </View>
      </Sheet>
    </View>
  );
}

export function CareNotesEditorScreen({ personId }: { personId: string | undefined }) {
  const { names } = useHousehold();
  const notes = useApiQuery({
    path: '/people/{id}/care-notes',
    request: { path: { id: personId ?? '' } },
    enabled: !!personId,
  });
  const givenName = personId ? (names.get(personId) ?? 'Family member') : 'Family member';
  return (
    <Screen>
      <RequireSession what="care notes">
        <QueryBoundary
          query={notes}
          label="the care notes"
          empty={{ title: 'Not available', description: '' }}
        >
          {(data) => (
            <Editor
              key={data.notes.map((n) => `${n.id}:${n.revision}`).join(',')}
              personId={data.personId}
              givenName={givenName}
              notes={data}
            />
          )}
        </QueryBoundary>
      </RequireSession>
    </Screen>
  );
}

/** Route entry: `/people/<id>/care-notes` (an opaque id only). */
export function CareNotesEditorRoute() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  return <CareNotesEditorScreen personId={typeof id === 'string' ? id : undefined} />;
}

const useStyles = makeStyles(({ colors }) => ({
  flex: { flex: 1 },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
  },
  barButton: {
    minWidth: MIN_TOUCH_SIZE,
    minHeight: MIN_TOUCH_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  barTitle: { flex: 1, ...fonts.bold, fontSize: 18, lineHeight: 24, color: colors.text },
  save: { ...fonts.semibold, fontSize: 16, color: colors.primary },
  saveDisabled: { color: colors.textMuted },
  body: { paddingHorizontal: layout.gutter, gap: spacing.md },
  label: { ...type.title3, ...fonts.semibold, color: colors.text, marginTop: spacing.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 40,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
  },
  chipText: { ...fonts.bold, fontSize: 15 },
  addChip: {
    minHeight: 40,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.control,
    justifyContent: 'center',
  },
  addChipText: { ...fonts.semibold, fontSize: 15, color: colors.primary },
  adding: { gap: spacing.sm },
  row: { flexDirection: 'row', gap: spacing.sm },
  box: {
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
  },
  info: {
    flexDirection: 'row',
    gap: 10,
    padding: 14,
    borderRadius: radius.md,
  },
  infoText: { flex: 1, ...type.callout },
  bold: { ...fonts.bold },
  flagRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 44 },
  check: {
    width: 24,
    height: 24,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  error: { ...type.callout, color: colors.danger },
  sheet: { gap: spacing.md },
}));
