/**
 * SCR-C-25 Team contributions (SPK-PAY-004, SPK-PAY-005, SPK-CAP-002, SPK-AT-022): totals shown
 * together, excess kept visible with the pending policy named, contributions with amount and
 * status only, the captain's request, and the empty, refused and error states.
 */
import { apiErrorBody, fakeResponse } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import {
  IDS,
  baseRoutes,
  contributionRequest,
  obligation,
  playerWorkspace,
} from '../../../features/teams/testing/fixtures';
import { createTeamsTestApp } from '../../../features/teams/testing/teams-test-app';
import { TeamContributionsScreen } from '../TeamContributionsScreen';

const page = (items: unknown[]) => ({ status: 200, body: { items, nextCursor: null } });

function renderContributions(options: Parameters<typeof createTeamsTestApp>[0] = {}) {
  const app = createTeamsTestApp({
    routes: baseRoutes({ 'GET /obligations': page([obligation()]) }),
    ...options,
  });
  render(<TeamContributionsScreen entryId={IDS.entry} />, { wrapper: app.wrapper });
  return app;
}

describe('SCR-C-25 TeamContributionsScreen', () => {
  it('SPK-PAY-004: shows total, received, allocated and remaining together, and contributions with amount and status only', async () => {
    const app = renderContributions();
    expect(
      await screen.findByLabelText(
        'Team total $900.00, received $300.00, allocated $300.00, remaining $600.00',
      ),
    ).toBeOnTheScreen();
    expect(
      screen.getByLabelText('Billing: Team obligation with player contributions'),
    ).toBeOnTheScreen();
    const contributions = screen.getByTestId(`contributions-${IDS.obligation}`);
    expect(within(contributions).getByLabelText('Paid on Oct 20, 2026')).toBeOnTheScreen();
    expect(within(contributions).getByText('Pat Player')).toBeOnTheScreen();
    expect(within(contributions).getByText('$100.00')).toBeOnTheScreen();
    expect(screen.queryByText(/card|account number|pm_/i)).toBeNull();
    expect(app.requestsTo('GET', '/obligations')[0]?.query).toEqual({
      teamEntryId: IDS.entry,
      limit: '50',
    });
  });

  it('SPK-PAY-005, SPK-AT-022: an excess stays visible and the pending overpayment policy is named', async () => {
    renderContributions({
      routes: baseRoutes({
        'GET /obligations': page([
          obligation({
            status: 'settled',
            totals: {
              amountMinor: 90000,
              receivedMinor: 95000,
              allocatedMinor: 90000,
              remainingMinor: 0,
              excessMinor: 5000,
              currency: 'USD',
            },
          }),
        ]),
      }),
    });
    expect(await screen.findByLabelText('Received beyond the total: $50.00')).toBeOnTheScreen();
    expect(screen.getByText(/still being decided \(DEC-008, POL-015\)/)).toBeOnTheScreen();
    // A settled obligation takes no new requests.
    expect(screen.queryByRole('button', { name: 'Request contribution' })).toBeNull();
  });

  it('SPK-CAP-002: the captain requests a contribution in minor units; the request grants no account access', async () => {
    const app = renderContributions({
      routes: baseRoutes({
        'GET /obligations': page([obligation()]),
        'POST /obligations/{id}/contribution-requests': {
          status: 201,
          body: contributionRequest({ requestedPersonId: IDS.player2, amountMinor: 2550 }),
        },
      }),
    });
    expect(
      await screen.findByText(/gives you no access to the player.s account/),
    ).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('radio', { name: 'Pat Player' }));
    fireEvent.changeText(screen.getByLabelText('Amount (USD)'), '25.50');
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Request contribution' }));
    });
    expect(
      await screen.findByLabelText('Contribution requested from Pat Player: $25.50'),
    ).toBeOnTheScreen();
    expect(app.bodiesOf('POST', '/obligations/{id}/contribution-requests')).toEqual([
      { requestedPersonId: IDS.player2, amountMinor: 2550 },
    ]);
    await app.settle();
  });

  it('checks the amount before sending and shows the API conflict when a request already exists', async () => {
    const app = renderContributions({
      routes: baseRoutes({
        'GET /obligations': page([obligation()]),
        'POST /obligations/{id}/contribution-requests': () =>
          fakeResponse(
            409,
            apiErrorBody('RESOURCE_CONFLICT', {
              message: 'This player already has an open contribution request.',
              nextAction: 'resolve_conflict',
              details: { code: 'CONTRIBUTION_ALREADY_REQUESTED' },
            }),
          ),
      }),
    });
    fireEvent.press(await screen.findByRole('radio', { name: 'Pat Player' }));
    fireEvent.changeText(screen.getByLabelText('Amount (USD)'), '25.555');
    fireEvent.press(screen.getByRole('button', { name: 'Request contribution' }));
    expect(
      screen.getByLabelText('Amount (USD). Enter an amount in USD, for example 25.00.'),
    ).toBeOnTheScreen();
    expect(app.requestsTo('POST', '/obligations/{id}/contribution-requests')).toHaveLength(0);

    fireEvent.changeText(screen.getByLabelText(/^Amount \(USD\)/), '25');
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Request contribution' }));
    });
    expect(
      await screen.findByText('This player already has an open contribution request.'),
    ).toBeOnTheScreen();
    expect(screen.getByText(/Error code: RESOURCE_CONFLICT/)).toBeOnTheScreen();
    expect(screen.getByText('Resolve the conflict')).toBeOnTheScreen();
  });

  it('empty: no team obligation means individual billing or no fee recorded yet', async () => {
    renderContributions({ routes: baseRoutes({ 'GET /obligations': page([]) }) });
    expect(await screen.findByRole('header', { name: 'No team obligation' })).toBeOnTheScreen();
  });

  it('SPK-CAP-002: a player the API refuses sees team totals as not available', async () => {
    renderContributions({
      routes: baseRoutes({
        'GET /team-entries/{id}': { status: 200, body: playerWorkspace() },
        'GET /obligations': () =>
          fakeResponse(404, apiErrorBody('NOT_FOUND', { nextAction: 'verify_reference' })),
      }),
    });
    expect(await screen.findByLabelText('Team totals not available')).toBeOnTheScreen();
    expect(screen.queryByText(/NOT_FOUND|\$900/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Request contribution' })).toBeNull();
  });

  it('shows the API error code when obligations cannot be read', async () => {
    renderContributions({
      routes: baseRoutes({
        'GET /obligations': () =>
          fakeResponse(500, apiErrorBody('INTERNAL_ERROR', { correlationId: 'corr-25' })),
      }),
    });
    expect(
      await screen.findByText(/Error code: INTERNAL_ERROR\. Reference: corr-25/),
    ).toBeOnTheScreen();
  });
});
