/**
 * SCR-C-38 Support request and case history (SPK-SUPPORT-001..003): the API's support cases are
 * staff-only, so the screen says in-app requests are not available, never calls the case routes,
 * shows the configured facility contact (or the pending DEC-015 when none is configured), and
 * says a support note never replaces the change itself.
 */
import { fireEvent, render, screen } from '@testing-library/react-native';
import { Linking } from 'react-native';
import { createRouterMock } from '../../../features/money/testing/fixtures';
import {
  createMoneyTestApp as createTestApp,
  settleApps,
} from '../../../features/money/testing/money-test-app';
import { SupportScreen } from '../SupportScreen';
import { readSupportContact } from '../../../config/app-config';

const mockRouter = createRouterMock();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => mockRouter,
}));

describe('SCR-C-38 SupportScreen', () => {
  afterEach(settleApps);
  beforeEach(() => mockRouter.push.mockClear());

  it('SPK-SUPPORT-002: says in-app requests and history are not available and never calls the staff-only case routes', async () => {
    const app = createTestApp();
    render(<SupportScreen />, { wrapper: app.wrapper });
    expect(
      await screen.findByLabelText('Support requests in the app are not available yet'),
    ).toBeOnTheScreen();
    expect(screen.getByText(/help without your password/)).toBeOnTheScreen();
    expect(app.fake.requests.some((r) => r.path.startsWith('/cases'))).toBe(false);
  });

  it('DEC-015: with no configured contact, shows the pending decision and invents no number or hours', async () => {
    const app = createTestApp();
    render(<SupportScreen />, { wrapper: app.wrapper });
    expect(await screen.findByText('Ask at the front desk.')).toBeOnTheScreen();
    expect(
      screen.getByText(
        /The facility’s support phone, email and hours is not available yet: it depends on DEC-015/,
      ),
    ).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Call the facility' })).toBeNull();
  });

  it('shows the configured contact with labelled call and email buttons', async () => {
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    const app = createTestApp({
      config: {
        supportContact: {
          phone: '+1 (555) 010-0000',
          email: 'desk@example.test',
          hours: 'Daily 8 to 8',
        },
      },
    });
    render(<SupportScreen />, { wrapper: app.wrapper });
    expect(await screen.findByLabelText('Phone: +1 (555) 010-0000')).toBeOnTheScreen();
    expect(screen.getByLabelText('Hours: Daily 8 to 8')).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Call the facility' }));
    expect(openURL).toHaveBeenCalledWith('tel:+15550100000');
    fireEvent.press(screen.getByRole('button', { name: 'Email the facility' }));
    expect(openURL).toHaveBeenCalledWith('mailto:desk@example.test');
    expect(screen.queryByLabelText('Waiting on a decision')).toBeNull();
    openURL.mockRestore();
  });

  it('SPK-SUPPORT-003: says support never replaces the change and links to where changes are made', async () => {
    const app = createTestApp();
    render(<SupportScreen />, { wrapper: app.wrapper });
    expect(
      await screen.findByText(/A conversation with support never replaces the change itself/),
    ).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Open enrollments' }));
    expect(mockRouter.push).toHaveBeenCalledWith('/enrollments');
    fireEvent.press(screen.getByRole('button', { name: 'Open payments' }));
    expect(mockRouter.push).toHaveBeenCalledWith('/payments');
  });

  it('reads the support contact only when the operator configured a phone or email', () => {
    expect(readSupportContact(undefined)).toBeNull();
    expect(readSupportContact({ phone: null, email: '  ', hours: 'Daily' })).toBeNull();
    expect(readSupportContact({ phone: ' 555 ', email: null, hours: null })).toEqual({
      phone: '555',
      email: null,
      hours: null,
    });
  });
});
