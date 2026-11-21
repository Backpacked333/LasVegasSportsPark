/**
 * Phase 0 primitives of the parent-app redesign (handoff BUILD_PLAN Phase 0; ADR-008 **Proposed**;
 * SPK-UX-009): person colours, the household "who" chips, the toast with Undo, the
 * optimistic-write helper, the sheet that locks while processing, the filled answer control and
 * the avatar's photo fallback. Deterministic: Jest's fake timers drive every delay.
 */
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { useState } from 'react';
import { Pressable, Text } from 'react-native';
import { renderUi } from '../../testing/ui-actions';
import { Avatar } from '../Avatar';
import { useOptimisticWrite, type OptimisticWrite } from '../optimistic';
import { MemoryPersonFilterStore } from '../person-filter-store';
import { personColorOf, personColorSlots } from '../person-colors';
import {
  PersonChipRow,
  PersonFilterProvider,
  usePersonFilter,
  type FilterPerson,
} from '../PersonFilter';
import { SegmentedControl } from '../SegmentedControl';
import { Sheet } from '../Sheet';
import { classicTheme, legendsTheme } from '../theme';
import { TOAST_ACTION_DURATION_MS, TOAST_DURATION_MS, ToastProvider, useToast } from '../Toast';

const A = '0192f1a0-0000-7000-8000-0000000000a2';
const B = '0192f1a0-0000-7000-8000-0000000000a3';
const SELF = '0192f1a0-0000-7000-8000-0000000000a1';

describe('person colours (handoff "Person colours")', () => {
  it('gives the account holder their own colour and children pink, blue, … in creation order, the same in both themes', () => {
    const slots = personColorSlots([B, SELF, A], SELF);
    expect(slots.get(SELF)).toBe('self');
    expect(slots.get(A)).toBe(0);
    expect(slots.get(B)).toBe(1);
    expect(personColorOf(classicTheme, 0).accent).toBe('#B0306B');
    expect(personColorOf(classicTheme, 0).tint).toBe('#F8DDE8');
    expect(personColorOf(classicTheme, 1).accent).toBe('#1D409E');
    expect(personColorOf(classicTheme, 5)).toEqual(personColorOf(classicTheme, 0));
    expect(personColorOf(legendsTheme, 0)).not.toEqual(personColorOf(classicTheme, 0));
  });
});

const PEOPLE: FilterPerson[] = [
  { id: A, label: 'Maya', color: personColorOf(classicTheme, 0) },
  { id: B, label: 'Leo', color: personColorOf(classicTheme, 1) },
  { id: SELF, label: 'Me', color: personColorOf(classicTheme, 'self') },
];

function Filter({ people }: { people: FilterPerson[] }) {
  const { selected, select } = usePersonFilter(people);
  return (
    <>
      <PersonChipRow people={people} selected={selected} onSelect={select} />
      <Text testID="shown">{selected ?? 'everyone'}</Text>
    </>
  );
}

describe('PersonChipRow and usePersonFilter (Shell row 5)', () => {
  it('Everyone first, then each person; the choice is a radio state and is remembered on the device', async () => {
    const store = new MemoryPersonFilterStore();
    await renderUi(
      <PersonFilterProvider store={store}>
        <Filter people={PEOPLE} />
      </PersonFilterProvider>,
    );
    expect(screen.getByRole('radio', { name: 'Everyone', checked: true })).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('radio', { name: 'Leo' }));
    expect(screen.getByRole('radio', { name: 'Leo', checked: true })).toBeOnTheScreen();
    expect(screen.getByTestId('shown')).toHaveTextContent(B);
    expect(store.read()).toBe(B);
  });

  it('a remembered person no longer in the household reads as Everyone; one person hides the row', async () => {
    const store = new MemoryPersonFilterStore('someone-else');
    await renderUi(
      <PersonFilterProvider store={store}>
        <Filter people={PEOPLE} />
      </PersonFilterProvider>,
    );
    expect(screen.getByTestId('shown')).toHaveTextContent('everyone');
    screen.unmount();
    await renderUi(<Filter people={PEOPLE.slice(0, 1)} />);
    expect(screen.queryByRole('radio', { name: 'Everyone' })).toBeNull();
  });
});

function Trigger({ onUndo }: { onUndo: () => void }) {
  const toast = useToast();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => toast.show({ message: 'Saved.', action: { label: 'Undo', onPress: onUndo } })}
    >
      <Text>Save</Text>
    </Pressable>
  );
}

describe('Toast with an action (handoff "Toasts")', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('stays 5 s with Undo (2.4 s without), and the action runs once and hides it', async () => {
    const onUndo = jest.fn();
    expect(TOAST_DURATION_MS).toBe(2_400);
    await renderUi(
      <ToastProvider>
        <Trigger onUndo={onUndo} />
      </ToastProvider>,
    );
    fireEvent.press(screen.getByRole('button', { name: 'Save' }));
    act(() => jest.advanceTimersByTime(TOAST_ACTION_DURATION_MS - 1));
    expect(screen.getByRole('button', { name: 'Undo' })).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Undo' }));
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Saved.')).toBeNull();
  });
});

function Optimistic({ write }: { write: Omit<OptimisticWrite, 'apply' | 'revert'> }) {
  const run = useOptimisticWrite();
  const [on, setOn] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => run({ ...write, apply: () => setOn(true), revert: () => setOn(false) })}
    >
      <Text>{on ? 'On' : 'Off'}</Text>
    </Pressable>
  );
}

describe('useOptimisticWrite (handoff "Writes are optimistic, with Undo")', () => {
  it('shows the new state at once, reverts and offers Try again when the write fails', async () => {
    let fail = true;
    const commit = jest.fn(() => (fail ? Promise.reject(new Error('no')) : Promise.resolve()));
    render(
      <ToastProvider>
        <Optimistic write={{ commit, success: 'Saved.', failure: "Didn't save." }} />
      </ToastProvider>,
    );
    fireEvent.press(screen.getByRole('button', { name: 'Off' }));
    expect(screen.getByText('On')).toBeOnTheScreen();
    expect(await screen.findByText("Didn't save.")).toBeOnTheScreen();
    expect(screen.getByText('Off')).toBeOnTheScreen();
    fail = false;
    fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Saved.')).toBeOnTheScreen();
    expect(commit).toHaveBeenCalledTimes(2);
  });

  it('Undo puts the old state back and sends the inverse write after the write saved', async () => {
    const undo = jest.fn(() => Promise.resolve());
    render(
      <ToastProvider>
        <Optimistic
          write={{ commit: () => Promise.resolve(), undo, success: 'Saved.', failure: 'No.' }}
        />
      </ToastProvider>,
    );
    fireEvent.press(screen.getByRole('button', { name: 'Off' }));
    fireEvent.press(await screen.findByRole('button', { name: 'Undo' }));
    expect(screen.getByText('Off')).toBeOnTheScreen();
    await act(async () => {
      await Promise.resolve();
    });
    expect(undo).toHaveBeenCalledTimes(1);
  });
});

describe('Sheet that locks while processing (handoff "Sheets")', () => {
  it('ignores the close button and the backdrop while locked', async () => {
    const onClose = jest.fn();
    await renderUi(
      <Sheet open onClose={onClose} title="Pay" eyebrow="For Maya" locked>
        <Text>Paying…</Text>
      </Sheet>,
    );
    expect(screen.getByText('For Maya')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
    fireEvent.press(screen.getByTestId('sheet-backdrop', { includeHiddenElements: true }));
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('SegmentedControl filled (the answer control)', () => {
  it('marks the chosen answer checked with a glyph, nothing before an answer, and every segment disabled offline', async () => {
    const segments = [
      { value: 'a', label: 'Going' },
      { value: 'b', label: 'Not going' },
    ] as const;
    await renderUi(
      <SegmentedControl
        label="Is Maya going?"
        pattern="radio"
        variant="filled"
        segments={segments}
        value={null}
        onChange={() => undefined}
      />,
    );
    expect(screen.queryByRole('radio', { checked: true })).toBeNull();
    screen.unmount();
    await renderUi(
      <SegmentedControl
        label="Is Maya going?"
        pattern="radio"
        variant="filled"
        segments={segments}
        value="a"
        onChange={() => undefined}
        disabled
      />,
    );
    expect(screen.getByRole('radio', { name: 'Going', checked: true })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Not going' })).toBeDisabled();
  });
});

describe('Avatar (photo → initials on the person colour, optional ring)', () => {
  it('shows initials on the person colour, and initials again when the photo fails', async () => {
    await renderUi(
      <Avatar
        name="Maya Ortiz"
        personColor={personColorOf(classicTheme, 0)}
        photoUri="https://invalid.example/x.jpg"
        ring
        testID="avatar"
      />,
    );
    const photo = screen.getByTestId('avatar-photo');
    act(() => photo.props.onError?.({ nativeEvent: { error: 'not found' } }));
    expect(screen.getByText('MO')).toHaveStyle({ color: '#8E2152' });
  });
});
