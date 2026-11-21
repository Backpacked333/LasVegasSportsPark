/**
 * Gallery specimens of the parent-app redesign's Phase 0 primitives (handoff BUILD_PLAN Phase 0):
 * person colours, avatars with a ring, the household "who" chips (one, three and six people), the
 * answer control (filled segmented control, also disabled), the toast with Undo and an error toast
 * with Try again, an optimistic write, and a sheet that locks while it processes.
 */
import { useState } from 'react';
import { View } from 'react-native';
import { Avatar } from '../ui/Avatar';
import { Button } from '../ui/Button';
import { useOptimisticWrite } from '../ui/optimistic';
import { personColorOf } from '../ui/person-colors';
import { PersonChipRow, type FilterPerson } from '../ui/PersonFilter';
import { SegmentedControl } from '../ui/SegmentedControl';
import { Sheet } from '../ui/Sheet';
import { StatusBadge, type StatusTone } from '../ui/StatusBadge';
import { Text } from '../ui/Text';
import { useToast } from '../ui/Toast';
import { useTheme } from '../ui/theme';
import { Caption, Row, Specimens } from './specimen';

const NAMES = ['Maya', 'Leo', 'Ava', 'Kai', 'Zoe'] as const;
const TONES: readonly StatusTone[] = ['success', 'warning', 'danger', 'info', 'neutral', 'pending'];
const ANSWERS = [
  { value: 'available', label: 'Going' },
  { value: 'tentative', label: 'Maybe' },
  { value: 'unavailable', label: 'Not going' },
] as const;

function useFamily(count: number): FilterPerson[] {
  const theme = useTheme();
  const children = NAMES.slice(0, Math.max(0, count - 1)).map((name, index) => ({
    id: `child-${index}`,
    label: name,
    color: personColorOf(theme, index),
  }));
  return count === 0
    ? []
    : [...children, { id: 'self', label: 'Me', color: personColorOf(theme, 'self') }];
}

export function HouseholdSpecimens() {
  const theme = useTheme();
  const toast = useToast();
  const write = useOptimisticWrite();
  const three = useFamily(3);
  const six = useFamily(6);
  const one = useFamily(1);
  const [who, setWho] = useState<string | null>(null);
  const [answer, setAnswer] = useState<(typeof ANSWERS)[number]['value'] | null>('available');
  const [saved, setSaved] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Specimens title="Person colours and avatars" subtitle="One colour per person, everywhere">
        <Row>
          {(['self', 0, 1, 2, 3, 4] as const).map((slot) => (
            <Avatar
              key={String(slot)}
              name={slot === 'self' ? 'Dana Ortiz' : `${NAMES[slot]} Ortiz`}
              personColor={personColorOf(theme, slot)}
              size="md"
            />
          ))}
        </Row>
        <Row>
          <Avatar name="Maya Ortiz" personColor={personColorOf(theme, 0)} size="lg" ring />
          <Avatar name="Leo Ortiz" personColor={personColorOf(theme, 1)} size="lg" ring />
          <Avatar name="Broken photo" photoUri="https://invalid.example/none.jpg" size="lg" ring />
        </Row>
        <Caption>
          Initials on the person colour; a ring in it. A photo that fails falls back.
        </Caption>
      </Specimens>

      <Specimens title="Who filter (PersonChipRow)" subtitle="Everyone first; selected is night">
        <PersonChipRow people={three} selected={who} onSelect={setWho} testID="gallery-who" />
        <Caption>Six people scroll sideways:</Caption>
        <PersonChipRow
          people={six}
          selected={null}
          onSelect={() => undefined}
          testID="gallery-who-six"
        />
        <Caption>{`One person: ${one.length} chip, so the row is hidden.`}</Caption>
        <PersonChipRow people={one} selected={null} onSelect={() => undefined} />
      </Specimens>

      <Specimens title="StatusBadge tones" subtitle="Glyph and word, never colour alone">
        <Row>
          {TONES.map((tone) => (
            <StatusBadge key={tone} tone={tone} label={tone[0]?.toUpperCase() + tone.slice(1)} />
          ))}
        </Row>
      </Specimens>

      <Specimens title="Answer control" subtitle="SegmentedControl variant filled">
        <SegmentedControl
          label="Is Maya going?"
          pattern="radio"
          variant="filled"
          segments={ANSWERS}
          value={answer}
          onChange={setAnswer}
        />
        <SegmentedControl
          label="Is Maya going? (offline)"
          pattern="radio"
          variant="filled"
          segments={ANSWERS}
          value="available"
          onChange={() => undefined}
          disabled
        />
        <Text variant="footnote" tone="muted">
          Answering needs a connection.
        </Text>
      </Specimens>

      <Specimens title="Toasts and optimistic writes" subtitle="2.4 s plain, 5 s with an action">
        <Row>
          <Button
            label="Toast with Undo"
            variant="secondary"
            onPress={() =>
              toast.show({
                message: 'Saved: Maya is going. The coach can see it.',
                action: { label: 'Undo', onPress: () => toast.show({ message: 'Undone.' }) },
              })
            }
          />
          <Button
            label="Error toast"
            variant="secondary"
            onPress={() =>
              toast.show({
                message: "Maya's answer didn't save.",
                tone: 'danger',
                action: { label: 'Try again', onPress: () => undefined },
              })
            }
          />
        </Row>
        <Button
          label={saved ? 'Saved (optimistic)' : 'Save optimistically'}
          variant="tonal"
          onPress={() =>
            write({
              apply: () => setSaved(true),
              revert: () => setSaved(false),
              commit: () => new Promise((resolve) => setTimeout(resolve, 600)),
              undo: () => Promise.resolve(),
              success: 'Saved. Undo for 5 seconds.',
              failure: "That didn't save.",
            })
          }
        />
      </Specimens>

      <Specimens title="Sheet that locks" subtitle="No grabber, close or scrim while processing">
        <Button label="Open a sheet that locks" variant="secondary" onPress={() => setOpen(true)} />
        <Sheet
          open={open}
          onClose={() => setOpen(false)}
          title="Liability waiver"
          eyebrow="For Leo · needed before Junior Skills"
          locked={busy}
          testID="gallery-locked-sheet"
        >
          <View>
            <Text variant="callout">Press the button: the sheet locks for two seconds.</Text>
          </View>
          <Button
            label={busy ? 'Processing…' : 'Process'}
            busy={busy}
            onPress={() => {
              setBusy(true);
              setTimeout(() => setBusy(false), 2000);
            }}
          />
        </Sheet>
      </Specimens>
    </>
  );
}
