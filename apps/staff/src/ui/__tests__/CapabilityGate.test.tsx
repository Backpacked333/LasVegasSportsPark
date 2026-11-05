/**
 * CapabilityGate and the turned-off state (§1.6, K-12, DEC-016, SPK-UX-008): children only while
 * the organization's switch is on; off, the state names the decisions that may turn it on; the
 * permissions read's loading, error and offline states; a command refused with
 * CAPABILITY_DISABLED shows the same turned-off state and refreshes the switches.
 */
import { ApiError } from '@sportspark/api-client';
import {
  apiErrorBody,
  capabilityDisabledBody,
  fakePermissions,
  fakeResponse,
} from '@sportspark/api-client/testing';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { useApiCommand } from '../../api/useApiCommand';
import { createTestApp, mePermissions } from '../../testing/test-app';
import { CapabilityGate } from '../CapabilityGate';
import { CommandError } from '../CommandFeedback';
import { StateView } from '../StateView';

function Content() {
  return <p>Rental bookings</p>;
}

describe('CapabilityGate (K-12, DEC-016)', () => {
  it('renders the children while the switch is on', async () => {
    const app = createTestApp({
      routes: { 'GET /me/permissions': mePermissions({ enabled: ['rentals'] }) },
    });
    render(
      <CapabilityGate capability="rentals">
        <Content />
      </CapabilityGate>,
      { wrapper: app.wrapper },
    );
    expect(await screen.findByText('Rental bookings')).toBeInTheDocument();
    expect(screen.queryByTestId('state-turned-off')).toBeNull();
  });

  it('shows "turned off" naming DEC-016 and the capability decision while the switch is off (the default)', async () => {
    const app = createTestApp();
    render(
      <CapabilityGate capability="rentals">
        <Content />
      </CapabilityGate>,
      { wrapper: app.wrapper },
    );
    const state = await screen.findByTestId('state-turned-off');
    expect(state).toHaveAttribute('aria-live', 'polite');
    expect(state).toHaveTextContent('Rentals turned off');
    expect(state).toHaveTextContent(
      'This is turned off for this organization. Whether it is used is decided by the product owner (DEC-016, DEC-076); a system administrator turns it on by naming one of these decisions. Everything else works without it.',
    );
    // Status is glyph plus text, never colour alone.
    expect(state.querySelector('[data-tone="neutral"]')).toHaveTextContent('●Rentals turned off');
    expect(screen.queryByText('Rental bookings')).toBeNull();
  });

  it('whenOff="notice" keeps the children (existing records stay readable) under the notice', async () => {
    const app = createTestApp();
    render(
      <CapabilityGate
        capability="memberships"
        whenOff="notice"
        stillAvailable="Existing memberships stay listed."
      >
        <p>Membership list</p>
      </CapabilityGate>,
      { wrapper: app.wrapper },
    );
    expect(await screen.findByTestId('state-turned-off')).toHaveTextContent(
      'Memberships turned off',
    );
    expect(screen.getByText('Existing memberships stay listed.')).toBeInTheDocument();
    expect(screen.getByText('Membership list')).toBeInTheDocument();
  });

  it('with several capabilities, renders the children when any one is on', async () => {
    const on = createTestApp({
      routes: { 'GET /me/permissions': mePermissions({ enabled: ['parties'] }) },
    });
    const { unmount } = render(
      <CapabilityGate capability={['rentals', 'parties']}>
        <Content />
      </CapabilityGate>,
      { wrapper: on.wrapper },
    );
    expect(await screen.findByText('Rental bookings')).toBeInTheDocument();
    unmount();

    const off = createTestApp();
    render(
      <CapabilityGate capability={['rentals', 'parties']}>
        <Content />
      </CapabilityGate>,
      { wrapper: off.wrapper },
    );
    const state = await screen.findByTestId('state-turned-off');
    expect(state).toHaveTextContent('Rentals and Parties turned off');
    expect(state).toHaveTextContent('(DEC-016, DEC-076, DEC-077)');
  });

  it('shows loading while the switches are read, never a guess', async () => {
    const pending: ((response: Response) => void)[] = [];
    const app = createTestApp({
      routes: {
        'GET /me/permissions': () => new Promise<Response>((resolve) => pending.push(resolve)),
      },
    });
    const release = () => {
      for (const resolve of pending) {
        resolve(fakeResponse(200, fakePermissions({ enabled: ['rentals'] })));
      }
    };
    render(
      <CapabilityGate capability="rentals">
        <Content />
      </CapabilityGate>,
      { wrapper: app.wrapper },
    );
    expect(
      await screen.findByRole('progressbar', { name: 'Loading whether rentals is turned on' }),
    ).toBeInTheDocument();
    // The read is out (the session loads first): still loading, neither content nor "turned off".
    await waitFor(() => expect(pending).toHaveLength(1));
    expect(
      screen.getByRole('progressbar', { name: 'Loading whether rentals is turned on' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Rental bookings')).toBeNull();
    expect(screen.queryByTestId('state-turned-off')).toBeNull();
    release();
    expect(await screen.findByText('Rental bookings')).toBeInTheDocument();
  });

  it('shows the API error code with "Try again", and recovers on retry', async () => {
    let calls = 0;
    const app = createTestApp({
      routes: {
        'GET /me/permissions': () => {
          calls += 1;
          return calls === 1
            ? fakeResponse(500, apiErrorBody('INTERNAL_ERROR', { correlationId: 'corr-p1' }))
            : fakeResponse(200, fakePermissions({ enabled: ['rentals'] }));
        },
      },
    });
    render(
      <CapabilityGate capability="rentals">
        <Content />
      </CapabilityGate>,
      { wrapper: app.wrapper },
    );
    expect(
      await screen.findByText('Error code: INTERNAL_ERROR. Reference: corr-p1'),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Rental bookings')).toBeInTheDocument();
  });

  it('a permissions read the API refuses is "not available", never "exists but denied"', async () => {
    const app = createTestApp({
      routes: { 'GET /me/permissions': { status: 403, body: apiErrorBody('ACCESS_DENIED') } },
    });
    render(
      <CapabilityGate capability="rentals">
        <Content />
      </CapabilityGate>,
      { wrapper: app.wrapper },
    );
    expect(await screen.findByTestId('state-unavailable')).toHaveTextContent('Not available');
  });

  it('offline with nothing loaded says so, with the age unknown', async () => {
    const app = createTestApp({ online: false });
    render(
      <CapabilityGate capability="rentals">
        <Content />
      </CapabilityGate>,
      { wrapper: app.wrapper },
    );
    expect(await screen.findByTestId('state-offline-stale')).toHaveTextContent(
      'Nothing has been loaded yet. Connect to see this information.',
    );
  });
});

describe('a command refused with CAPABILITY_DISABLED (K-12)', () => {
  it('StateView "error" renders the turned-off state with the code, not "Something went wrong"', () => {
    const error = new ApiError({
      kind: 'api',
      status: 403,
      code: 'ACCESS_DENIED',
      message: 'This organization has not enabled point of sale.',
      nextAction: 'contact_support_or_request_access',
      correlationId: 'corr-9',
      details: {
        code: 'CAPABILITY_DISABLED',
        capability: 'point_of_sale',
        applicabilityReferences: ['DEC-016', 'DEC-079'],
      },
    });
    render(<StateView variant="error" error={error} />);
    const state = screen.getByTestId('state-turned-off');
    expect(state).toHaveTextContent('Point of sale turned off');
    expect(state).toHaveTextContent('(DEC-016, DEC-079)');
    expect(state).toHaveTextContent(
      'Error code: ACCESS_DENIED (CAPABILITY_DISABLED). Reference: corr-9',
    );
    expect(screen.queryByText('Something went wrong')).toBeNull();
    expect(screen.queryByText('Not available to you')).toBeNull();
  });

  function BookButton() {
    const book = useApiCommand('post', '/bookings');
    return (
      <>
        <CapabilityGate capability="rentals">
          <button
            type="button"
            onClick={() => void book.submit({ body: {} as never }).catch(() => undefined)}
          >
            Book
          </button>
        </CapabilityGate>
        {book.error ? <CommandError error={book.error} /> : null}
      </>
    );
  }

  it('shows the refusal as turned off and re-reads the switches, so the gate closes (DEC-016)', async () => {
    let reads = 0;
    const app = createTestApp({
      routes: {
        'GET /me/permissions': () => {
          reads += 1;
          // The switch was on when the page loaded and turned off before the command.
          return fakeResponse(200, fakePermissions({ enabled: reads === 1 ? ['rentals'] : [] }));
        },
        'POST /bookings': {
          status: 403,
          body: capabilityDisabledBody('rentals', ['DEC-016', 'DEC-076']),
        },
      },
    });
    render(<BookButton />, { wrapper: app.wrapper });
    await userEvent.click(await screen.findByRole('button', { name: 'Book' }));
    await waitFor(() => expect(reads).toBe(2));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Book' })).toBeNull());
    const states = screen.getAllByTestId('state-turned-off');
    // The gate and the command's own answer say the same thing.
    expect(states).toHaveLength(2);
    for (const state of states) expect(state).toHaveTextContent('Rentals turned off');
    expect(
      screen.getByText(/Error code: ACCESS_DENIED \(CAPABILITY_DISABLED\)/),
    ).toBeInTheDocument();
  });
});
