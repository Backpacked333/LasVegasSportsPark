/**
 * SCR-C-37 Youth feedback and development record (SPK-YOUTH-005, SPK-YOUTH-006): pending DEC-003,
 * DEC-054 and DEC-055, with no API endpoint yet. The screen sends no request and invents no skill
 * area, scale or feedback.
 */
import { render, screen } from '@testing-library/react-native';
import {
  createMoneyTestApp as createTestApp,
  settleApps,
} from '../../../features/money/testing/money-test-app';
import { YouthFeedbackScreen } from '../YouthFeedbackScreen';

describe('SCR-C-37 YouthFeedbackScreen', () => {
  afterEach(settleApps);

  it('SPK-YOUTH-005: shows the pending decisions and their owners, and sends no request', async () => {
    const app = createTestApp();
    render(<YouthFeedbackScreen />, { wrapper: app.wrapper });
    expect(await screen.findByLabelText('Waiting on a decision')).toBeOnTheScreen();
    expect(
      screen.getByText(
        /Feedback and development records is not available yet: it depends on DEC-003, DEC-054, DEC-055/,
      ),
    ).toBeOnTheScreen();
    expect(
      screen.getByText(
        /DEC-003, DEC-055: Program manager\. DEC-054: Program manager; Operator\/privacy owner/,
      ),
    ).toBeOnTheScreen();
    expect(app.fake.requests).toHaveLength(0);
  });

  it('SPK-YOUTH-005/006: says private notes never appear and a recommendation is not a guarantee', async () => {
    const app = createTestApp();
    render(<YouthFeedbackScreen />, { wrapper: app.wrapper });
    expect(await screen.findByText('Private coaching notes never appear here.')).toBeOnTheScreen();
    expect(screen.getByText(/does not\s+guarantee a place/)).toBeOnTheScreen();
    expect(app.fake.requests).toHaveLength(0);
  });

  it('asks a signed-out user to sign in', async () => {
    const app = createTestApp({ session: null });
    render(<YouthFeedbackScreen />, { wrapper: app.wrapper });
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeOnTheScreen();
  });
});
