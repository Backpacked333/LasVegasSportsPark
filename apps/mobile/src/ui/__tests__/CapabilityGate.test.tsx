/**
 * CapabilityGate and the turned-off state in the customer app (§1.6, K-12, DEC-016, SPK-UX-008):
 * children only while the organization's switch is on; off, the state names the decisions that may
 * turn it on; the permissions read's loading, error, not-available and offline states; a command
 * refused with CAPABILITY_DISABLED shows the same turned-off state and refreshes the switches.
 */
import { ApiError } from '@sportspark/api-client';
import {
  apiErrorBody,
  capabilityDisabledBody,
  fakePermissions,
  fakeResponse,
} from '@sportspark/api-client/testing';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { Text } from 'react-native';
import { useApiCommand } from '../../api/useApiCommand';
import { createTestApp, mePermissions } from '../../testing/test-app';
import { Button } from '../Button';
import { CapabilityGate } from '../CapabilityGate';
import { StateView } from '../StateView';

function Content() {
  return <Text>Your memberships</Text>;
}

describe('CapabilityGate (K-12, DEC-016)', () => {
  it('renders the children while the switch is on', async () => {
    const app = createTestApp({
      routes: { 'GET /me/permissions': mePermissions({ enabled: ['memberships'] }) },
    });
    render(
      <CapabilityGate capability="memberships">
        <Content />
      </CapabilityGate>,
      { wrapper: app.wrapper },
    );
    expect(await screen.findByText('Your memberships')).toBeOnTheScreen();
    expect(screen.queryByTestId('state-turned-off')).toBeNull();
  });

  it('shows "turned off" naming DEC-016 and the capability decision while the switch is off (the default)', async () => {
    const app = createTestApp();
    render(
      <CapabilityGate capability="memberships">
        <Content />
      </CapabilityGate>,
      { wrapper: app.wrapper },
    );
    const state = await screen.findByTestId('state-turned-off');
    expect(state).toHaveProp('accessibilityLiveRegion', 'polite');
    // Status is glyph plus text, never colour alone; the badge is what screen readers read.
    expect(within(state).getByLabelText('Memberships turned off')).toBeOnTheScreen();
    // The glyph is decorative: hidden from screen readers, shown on screen.
    expect(within(state).getByText('●', { includeHiddenElements: true })).toBeOnTheScreen();
    expect(
      within(state).getByText(
        'This is turned off for this organization. Whether it is used is decided by the product owner (DEC-016, DEC-072); a system administrator turns it on by naming one of these decisions. Everything else works without it.',
      ),
    ).toBeOnTheScreen();
    expect(screen.queryByText('Your memberships')).toBeNull();
  });

  it('whenOff="notice" keeps what the customer already has under the notice', async () => {
    const app = createTestApp();
    render(
      <CapabilityGate
        capability="point_of_sale"
        whenOff="notice"
        stillAvailable="Receipts of earlier purchases stay available here."
      >
        <Text>Receipt list</Text>
      </CapabilityGate>,
      { wrapper: app.wrapper },
    );
    expect(await screen.findByLabelText('Point of sale turned off')).toBeOnTheScreen();
    expect(
      screen.getByText('Receipts of earlier purchases stay available here.'),
    ).toBeOnTheScreen();
    expect(screen.getByText('Receipt list')).toBeOnTheScreen();
  });

  it('with several capabilities, renders the children when any one is on', async () => {
    const app = createTestApp({
      routes: { 'GET /me/permissions': mePermissions({ enabled: ['parties'] }) },
    });
    render(
      <CapabilityGate capability={['rentals', 'parties']}>
        <Content />
      </CapabilityGate>,
      { wrapper: app.wrapper },
    );
    expect(await screen.findByText('Your memberships')).toBeOnTheScreen();
  });

  it('shows the API error code with "Try again", and recovers on retry', async () => {
    let calls = 0;
    const app = createTestApp({
      routes: {
        'GET /me/permissions': () => {
          calls += 1;
          return calls === 1
            ? fakeResponse(500, apiErrorBody('INTERNAL_ERROR', { correlationId: 'corr-m1' }))
            : fakeResponse(200, fakePermissions({ enabled: ['memberships'] }));
        },
      },
    });
    render(
      <CapabilityGate capability="memberships">
        <Content />
      </CapabilityGate>,
      { wrapper: app.wrapper },
    );
    expect(
      await screen.findByText('Error code: INTERNAL_ERROR. Reference: corr-m1'),
    ).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Your memberships')).toBeOnTheScreen();
  });

  it('a permissions read the API refuses is "not available", never "exists but denied"', async () => {
    const app = createTestApp({
      routes: { 'GET /me/permissions': { status: 403, body: apiErrorBody('ACCESS_DENIED') } },
    });
    render(
      <CapabilityGate capability="memberships">
        <Content />
      </CapabilityGate>,
      { wrapper: app.wrapper },
    );
    expect(await screen.findByTestId('state-unavailable')).toBeOnTheScreen();
    expect(screen.getByLabelText('Not available')).toBeOnTheScreen();
  });

  it('offline with nothing loaded says so', async () => {
    const app = createTestApp({ reachable: false });
    render(
      <CapabilityGate capability="memberships">
        <Content />
      </CapabilityGate>,
      { wrapper: app.wrapper },
    );
    expect(
      await screen.findByText('Nothing has been loaded yet. Connect to see this information.'),
    ).toBeOnTheScreen();
    expect(screen.queryByText('Your memberships')).toBeNull();
  });
});

describe('a command refused with CAPABILITY_DISABLED (K-12)', () => {
  it('StateView "error" renders the turned-off state with the code, not "Something went wrong"', () => {
    const error = new ApiError({
      kind: 'api',
      status: 403,
      code: 'ACCESS_DENIED',
      message: 'This organization has not enabled rentals.',
      nextAction: 'contact_support_or_request_access',
      correlationId: 'corr-r',
      details: {
        code: 'CAPABILITY_DISABLED',
        capability: 'rentals',
        applicabilityReferences: ['DEC-016', 'DEC-076'],
      },
    });
    render(<StateView variant="error" error={error} />);
    expect(screen.getByTestId('state-turned-off')).toBeOnTheScreen();
    expect(screen.getByLabelText('Rentals turned off')).toBeOnTheScreen();
    expect(
      screen.getByText('Error code: ACCESS_DENIED (CAPABILITY_DISABLED). Reference: corr-r'),
    ).toBeOnTheScreen();
    expect(screen.queryByLabelText('Something went wrong')).toBeNull();
  });

  function BookButton() {
    const book = useApiCommand('post', '/bookings');
    return (
      <>
        <CapabilityGate capability="rentals">
          <Button
            label="Book"
            onPress={() => void book.submit({ body: {} as never }).catch(() => undefined)}
          />
        </CapabilityGate>
        {book.error ? <StateView variant="error" error={book.error} /> : null}
      </>
    );
  }

  it('shows the refusal as turned off and re-reads the switches, so the gate closes (DEC-016)', async () => {
    let reads = 0;
    const app = createTestApp({
      routes: {
        'GET /me/permissions': () => {
          reads += 1;
          return fakeResponse(200, fakePermissions({ enabled: reads === 1 ? ['rentals'] : [] }));
        },
        'POST /bookings': {
          status: 403,
          body: capabilityDisabledBody('rentals', ['DEC-016', 'DEC-076']),
        },
      },
    });
    render(<BookButton />, { wrapper: app.wrapper });
    fireEvent.press(await screen.findByRole('button', { name: 'Book' }));
    await waitFor(() => expect(reads).toBe(2));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Book' })).toBeNull());
    expect(screen.getAllByLabelText('Rentals turned off')).toHaveLength(2);
    const sent = app.fake.requests.find((r) => r.route === '/bookings');
    expect(sent?.headers['idempotency-key']).toBeTruthy();
  });
});
