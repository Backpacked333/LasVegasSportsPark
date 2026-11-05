/**
 * SCR-C-25 a player's own contribution in a release build: the payment provider is not selected
 * (DEC-019, Technical lead/account owners), so paying shows that pending decision; a payment
 * already on its way for the line is still shown with "Do not pay again" (SPK-PAY-007).
 */
import { render, screen } from '@testing-library/react-native';
import { IDS, contributionRequest, paymentAttempt } from '../../../features/teams/testing/fixtures';
import { createTeamsTestApp } from '../../../features/teams/testing/teams-test-app';
import { ContributionScreen } from '../ContributionScreen';

// Release bundles drop the development module (`__DEV__` is false); stand in for that here.
jest.mock('../../../features/teams/dev', () => ({ DEV_CONTRIBUTION_PAYMENT_METHODS: null }));

describe('SCR-C-25 ContributionScreen (release build)', () => {
  it('DEC-019: shows the pending decision and, above it, a payment on its way for this line', async () => {
    const app = createTeamsTestApp({
      routes: {
        'GET /contribution-requests/{id}': { status: 200, body: contributionRequest() },
        'GET /me/payments': {
          status: 200,
          body: { items: [paymentAttempt({ status: 'processing' })], nextCursor: null },
        },
      },
    });
    render(<ContributionScreen requestId={IDS.contribution} />, { wrapper: app.wrapper });
    expect(await screen.findByTestId('contribution-live-attempt')).toBeOnTheScreen();
    expect(screen.getByLabelText('Payment processing')).toBeOnTheScreen();
    expect(
      screen.getByText(/Paying in the app is not available yet: it depends on DEC-019/),
    ).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: /^Pay / })).toBeNull();
    await app.settle();
  });
});
