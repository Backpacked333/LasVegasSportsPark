/**
 * Redesign handoff Phase 0 primitives (staff): StatusBadge's six tones, Avatar, Toast with Undo,
 * Drawer, BottomSheet, SegmentedControl, Skeleton, OfflineBanner and Flash (SPK-UX-008,
 * SPK-UX-009: glyph + words, labelled controls, focus moved in and returned).
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestApp } from '../../testing/test-app';
import { Avatar, initialsOf, personColour } from '../Avatar';
import { BottomSheet, SHEET_DISMISS_PX } from '../BottomSheet';
import { Drawer } from '../Drawer';
import { Flash } from '../Flash';
import { OfflineBanner } from '../OfflineBanner';
import { SegmentedControl } from '../SegmentedControl';
import { Skeleton, SkeletonGroup } from '../Skeleton';
import { StatusBadge } from '../StatusBadge';
import { TOAST_MS, TOAST_UNDO_MS, ToastProvider, useToast, type ToastInput } from '../Toast';

afterEach(() => vi.useRealTimers());

describe('StatusBadge six tones (handoff status table)', () => {
  it('pairs each tone with its glyph and words; error is the danger tone', () => {
    const { container } = render(
      <>
        {(['success', 'warning', 'error', 'info', 'neutral', 'pending'] as const).map((t) => (
          <StatusBadge key={t} tone={t} label={t} size="sm" />
        ))}
      </>,
    );
    const glyphs = [...container.querySelectorAll('.badge')].map((b) => b.textContent);
    expect(glyphs).toEqual(['✓success', '▲warning', '✕error', 'ℹinfo', '●neutral', '◷pending']);
    expect(container.querySelectorAll('.badge')[2]).toHaveAttribute('data-tone', 'danger');
    expect(container.querySelector('.badge-sm')).not.toBeNull();
  });
});

describe('Avatar', () => {
  it('shows the photo, and initials on the person colour when there is none or it fails', () => {
    const { rerender } = render(<Avatar name="Maya Ortiz" personKey="p1" photoUrl="/m.jpg" />);
    const img = screen.getByRole('img', { name: 'Maya Ortiz' });
    expect(img.querySelector('img')).not.toBeNull();
    fireEvent.error(img.querySelector('img')!);
    expect(screen.getByText('MO')).toBeInTheDocument();
    rerender(<Avatar name="T. Nguyen" personKey="p2" ring decorative />);
    expect(screen.getByText('TN').parentElement).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('TN').parentElement).toHaveAttribute('data-ring', 'true');
  });

  it('keeps one colour per person and reads initials', () => {
    expect(personColour('abc')).toBe(personColour('abc'));
    expect(personColour('abc')).toBeGreaterThanOrEqual(1);
    expect(personColour('abc')).toBeLessThanOrEqual(5);
    expect(initialsOf('Jordan Reyes')).toBe('JR');
    expect(initialsOf('Cher')).toBe('C');
  });
});

function ToastHarness({ input }: { input: ToastInput }) {
  const toast = useToast();
  return (
    <button type="button" onClick={() => toast.show(input)}>
      show
    </button>
  );
}

function renderWithToasts(node: React.ReactNode) {
  const app = createTestApp();
  return render(<app.wrapper>{<ToastProvider>{node}</ToastProvider>}</app.wrapper>);
}

describe('Toast with Undo (handoff "Toasts")', () => {
  it('stays 5 s with Undo, which runs the undo; one at a time, a new one replaces the old', () => {
    vi.useFakeTimers();
    const onUndo = vi.fn();
    const onClose = vi.fn();
    renderWithToasts(
      <>
        <ToastHarness input={{ message: 'Assigned', onUndo, onClose }} />
        <ToastHarness input={{ message: 'Second' }} />
      </>,
    );
    const [first, second] = screen.getAllByRole('button', { name: 'show' });
    fireEvent.click(first!);
    expect(screen.getByRole('status')).toHaveTextContent('Assigned');
    fireEvent.click(second!);
    expect(onClose).toHaveBeenCalledWith('replaced');
    expect(screen.getAllByTestId('toast')).toHaveLength(1);
    expect(screen.getByTestId('toast')).toHaveTextContent('Second');
    act(() => vi.advanceTimersByTime(TOAST_MS));
    expect(screen.queryByTestId('toast')).toBeNull();

    fireEvent.click(first!);
    act(() => vi.advanceTimersByTime(TOAST_UNDO_MS - 100));
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('toast')).toBeNull();
  });

  it('writes the time left in the Undo label when it counts down; errors are alerts', () => {
    vi.useFakeTimers();
    renderWithToasts(
      <>
        <ToastHarness
          input={{
            message: '4 games cancelled',
            onUndo: () => undefined,
            durationMs: 120_000,
            countdown: true,
          }}
        />
        <ToastHarness input={{ message: 'Did not save', tone: 'error' }} />
      </>,
    );
    fireEvent.click(screen.getAllByRole('button', { name: 'show' })[0]!);
    expect(screen.getByRole('button', { name: 'Undo (2:00)' })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'show' })[1]!);
    expect(screen.getByRole('alert')).toHaveTextContent('Did not save');
  });
});

function DrawerHarness({ locked = false }: { locked?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        labelledBy="d-title"
        locked={locked}
        header={<h3 id="d-title">Session</h3>}
        footer={<button type="button">Last</button>}
      >
        <button type="button">First inside</button>
      </Drawer>
    </>
  );
}

describe('Drawer (S 3a)', () => {
  it('moves focus in, keeps Tab inside, closes on Escape and returns focus to the opener', async () => {
    const user = userEvent.setup();
    render(<DrawerHarness />);
    const opener = screen.getByRole('button', { name: 'Open' });
    await user.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Session' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    await user.tab();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Last' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
  });

  it('closes from ✕ and the scrim, but not while locked', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<DrawerHarness />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await user.click(screen.getByTestId('drawer-scrim'));
    expect(screen.queryByRole('dialog')).toBeNull();
    unmount();
    render(<DrawerHarness locked />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await user.click(screen.getByTestId('drawer-scrim'));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
  });
});

describe('BottomSheet (S 1d)', () => {
  it('closes when dragged down past the threshold, not on a short drag', () => {
    const onClose = vi.fn();
    render(
      <BottomSheet open onClose={onClose} title="Fix" titleId="s-title">
        <p>Body</p>
      </BottomSheet>,
    );
    expect(screen.getByRole('dialog', { name: 'Fix' })).toBeInTheDocument();
    const handle = screen.getByTestId('sheet-handle');
    fireEvent.pointerDown(handle, { clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientY: 140, pointerId: 1 });
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(handle, { clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientY: 100 + SHEET_DISMISS_PX + 10, pointerId: 1 });
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('SegmentedControl', () => {
  it('is a radio group; arrow keys move and choose', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [v, setV] = useState<'later' | 'date'>('later');
      return (
        <SegmentedControl
          label="Make-up"
          value={v}
          onChange={setV}
          segments={[
            { value: 'later', label: 'Decide later' },
            { value: 'date', label: 'Pick a date now' },
          ]}
        />
      );
    }
    render(<Harness />);
    const later = screen.getByRole('radio', { name: 'Decide later' });
    expect(later).toHaveAttribute('aria-checked', 'true');
    later.focus();
    await user.keyboard('{ArrowRight}');
    const date = screen.getByRole('radio', { name: 'Pick a date now' });
    expect(date).toHaveAttribute('aria-checked', 'true');
    expect(date).toHaveFocus();
  });
});

describe('Skeleton, OfflineBanner, Flash', () => {
  it('a loading region is announced once, its blocks are decorative', () => {
    render(
      <SkeletonGroup label="the next hour">
        <Skeleton />
        <Skeleton />
      </SkeletonGroup>,
    );
    expect(screen.getByRole('status', { name: 'Loading the next hour' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
  });

  it('the offline banner states the last good time and the queued count, glyph + words', () => {
    render(
      <OfflineBanner lastGood="8:41 AM" queued={{ count: 2, noun: 'check-in' }}>
        Payments need a connection.
      </OfflineBanner>,
    );
    const banner = screen.getByRole('alert');
    expect(banner).toHaveTextContent('▲You are offline');
    expect(banner).toHaveTextContent(
      'Showing information from 8:41 AM. Payments need a connection.',
    );
    expect(screen.getByTestId('offline-queued')).toHaveTextContent('2 check-ins waiting to sync');
  });

  it('a changed number flashes, the first render does not', () => {
    vi.useFakeTimers();
    const { rerender } = render(<Flash value={1}>1</Flash>);
    expect(screen.getByText('1')).not.toHaveAttribute('data-flash');
    rerender(<Flash value={2}>2</Flash>);
    expect(screen.getByText('2')).toHaveAttribute('data-flash', 'true');
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByText('2')).not.toHaveAttribute('data-flash');
  });
});
