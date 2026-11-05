/**
 * SPK-UX-008 state primitives (web), status never by colour alone, and the keyboard alternative to
 * drag interactions (SPK-UX-009).
 */
import { ApiError } from '@sportspark/api-client';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ReorderableList } from '../ReorderableList';
import { STATUS_GLYPHS, StatusBadge } from '../StatusBadge';
import { StateView } from '../StateView';

const NOW = new Date('2026-10-24T12:00:00Z');
const error = (code: string, nextAction: string) =>
  new ApiError({
    kind: 'api',
    status: 409,
    code,
    message: 'Safe message.',
    nextAction,
    correlationId: 'corr-7',
  });

describe('StateView (SPK-UX-008)', () => {
  it('loading is a busy progress indicator naming what loads', () => {
    render(<StateView variant="loading" label="assignments" />);
    expect(screen.getByRole('progressbar', { name: 'Loading assignments' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
  });

  it('empty names what would appear and the permitted way to create it', async () => {
    const onAction = vi.fn();
    render(
      <StateView
        variant="empty"
        title="No exports"
        description="Exports you request appear here."
        actionLabel="Request an export"
        onAction={onAction}
      />,
    );
    expect(screen.getByRole('heading', { name: 'No exports' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Request an export' }));
    expect(onAction).toHaveBeenCalledOnce();
  });

  it('error shows the code, the correlation reference and the recovery action', async () => {
    const onAction = vi.fn();
    render(
      <StateView
        variant="error"
        error={error('STALE_REVISION', 'reload_and_retry')}
        onAction={onAction}
      />,
    );
    expect(screen.getByText('Error code: STALE_REVISION. Reference: corr-7')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(onAction).toHaveBeenCalledOnce();
  });

  it('offline-stale shows the age and the actions that need a connection', () => {
    render(
      <StateView
        variant="offline-stale"
        offline
        updatedAt={new Date('2026-10-24T10:00:00Z')}
        now={NOW}
        unavailableActions={['pickup authorisation']}
      />,
    );
    expect(screen.getByText('You are offline')).toBeInTheDocument();
    expect(screen.getByText('Showing information from 2 hours ago.')).toBeInTheDocument();
    expect(screen.getByText('Needs a connection: pickup authorisation.')).toBeInTheDocument();
  });

  it('unavailable never says a record exists or is denied (§4.10)', () => {
    render(<StateView variant="unavailable" />);
    const text = screen.getByText(/This is not available/).textContent ?? '';
    expect(text).not.toMatch(/permission|denied|exists/i);
  });

  it('pending-decision names the decision and owner', () => {
    render(
      <StateView
        variant="pending-decision"
        subject="Staff sign-in"
        decisions={['DEC-018']}
        owner="Technical lead/account owners"
      />,
    );
    expect(
      screen.getByText(/Staff sign-in is not available yet: it depends on DEC-018/),
    ).toBeInTheDocument();
  });
});

describe('StatusBadge (SPK-UX-009)', () => {
  it('pairs a distinct decorative glyph with the status text', () => {
    expect(new Set(Object.values(STATUS_GLYPHS)).size).toBe(Object.keys(STATUS_GLYPHS).length);
    const { container } = render(<StatusBadge tone="danger" label="Severity: critical" />);
    expect(screen.getByText('Severity: critical')).toBeInTheDocument();
    expect(container.querySelector('[aria-hidden="true"]')?.textContent).toBe(STATUS_GLYPHS.danger);
  });
});

describe('ReorderableList: keyboard alternative to drag (SPK-UX-009)', () => {
  function Harness() {
    const [items, setItems] = useState(['Red', 'Blue', 'Green']);
    return (
      <ReorderableList
        label="Teams in division"
        items={items}
        getKey={(i) => i}
        getLabel={(i) => i}
        onMove={(from, to) =>
          setItems((current) => {
            const next = [...current];
            const [moved] = next.splice(from, 1);
            next.splice(to, 0, moved as string);
            return next;
          })
        }
      />
    );
  }
  const order = () =>
    within(screen.getByRole('list', { name: 'Teams in division' }))
      .getAllByRole('listitem')
      .map((li) => li.getAttribute('aria-label'));

  it('moves items with buttons and with Alt+Arrow keys, and announces each move', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.getByRole('button', { name: 'Move Red up' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Move Red down' }));
    expect(order()).toEqual([
      'Blue, position 1 of 3',
      'Red, position 2 of 3',
      'Green, position 3 of 3',
    ]);
    expect(screen.getByTestId('reorder-announcement')).toHaveTextContent(
      'Red moved to position 2 of 3.',
    );

    const green = screen.getByRole('listitem', { name: 'Green, position 3 of 3' });
    green.focus();
    fireEvent.keyDown(green, { key: 'ArrowUp', altKey: true });
    expect(order()).toEqual([
      'Blue, position 1 of 3',
      'Green, position 2 of 3',
      'Red, position 3 of 3',
    ]);
    // Plain arrows keep their normal meaning (scrolling, screen reader navigation).
    fireEvent.keyDown(screen.getByRole('listitem', { name: 'Blue, position 1 of 3' }), {
      key: 'ArrowDown',
    });
    expect(order()[0]).toBe('Blue, position 1 of 3');
  });
});
