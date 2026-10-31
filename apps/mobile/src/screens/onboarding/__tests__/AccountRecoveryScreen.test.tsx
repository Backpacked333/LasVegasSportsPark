/**
 * SCR-C-02 Account recovery (SPK-IAM-002, §4.14 rate-limited recovery, SPK-AT-025 "Only verified
 * prior access restored", §3.1 "Account recovery does not grant new family access").
 */
import { render, screen } from '@testing-library/react-native';
import { createTestApp } from '../../../testing/test-app';
import {
  apiError,
  CHILD,
  CHILD_TWO,
  me,
  namesRoute,
  ok,
  person,
} from '../../account/__tests__/fixtures';
import { AccountRecoveryScreen } from '../AccountRecoveryScreen';

describe('SCR-C-02 AccountRecoveryScreen', () => {
  it('signed out: states the recovery rule, shows self-service recovery as pending DEC-018 and offers sign-in', async () => {
    const app = createTestApp({ session: null });
    render(<AccountRecoveryScreen />, { wrapper: app.wrapper });
    expect(
      await screen.findByText(
        /restores only the access that was verified before\. It never adds family access/,
      ),
    ).toBeOnTheScreen();
    expect(
      screen.getByText(
        /Recovering your account from the app is not available yet: it depends on DEC-018/,
      ),
    ).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeOnTheScreen();
    expect(app.fake.requests).toHaveLength(0);
  });

  it('SPK-AT-025: after signing in again, lists exactly the access the API reports and nothing else', async () => {
    const app = createTestApp({
      routes: {
        'GET /me': ok(
          me({
            authorities: [
              { subjectPersonId: CHILD, permissions: ['view', 'register', 'pay'] },
              { subjectPersonId: CHILD_TWO, permissions: ['collect'] },
            ],
          }),
        ),
        // CHILD_TWO is collect-only: the API leaves the name out for this account.
        'GET /person-names': namesRoute([person(CHILD, 'Sam', 'Morgan', 'child')]),
      },
    });
    render(<AccountRecoveryScreen />, { wrapper: app.wrapper });
    expect(await screen.findByLabelText('Sam Morgan: View, Register and Pay')).toBeOnTheScreen();
    expect(screen.getByLabelText('Name not available to you: Collect')).toBeOnTheScreen();
    expect(screen.getByLabelText('Alex Morgan, Your own record, Linked')).toBeOnTheScreen();
    expect(screen.getByText(/Account recovery never adds permissions/)).toBeOnTheScreen();
    expect(screen.queryByText(/NOT_FOUND/)).toBeNull();
    // Names only, through GET /person-names: no person record (date of birth, contacts) is read,
    // and no other household is looked up.
    expect(app.fake.requests.some((r) => r.route === '/people/{id}')).toBe(false);
    expect(app.fake.requests.filter((r) => r.route === '/person-names').length).toBe(2);
    expect(app.fake.requests.every((r) => r.route === '/me' || r.route === '/person-names')).toBe(
      true,
    );
  });

  it('shows "No family access on this account" when the API lists none (success: nothing new)', async () => {
    const app = createTestApp({ routes: { 'GET /me': ok(me({})) } });
    render(<AccountRecoveryScreen />, { wrapper: app.wrapper });
    expect(
      await screen.findByRole('header', { name: 'No family access on this account' }),
    ).toBeOnTheScreen();
  });

  it('a failed GET /me (RATE_LIMITED) shows its code and Try again', async () => {
    const app = createTestApp({
      routes: {
        'GET /me': () =>
          apiError(429, 'RATE_LIMITED', {
            message: 'Too many attempts. Wait before trying again.',
            nextAction: 'retry_later',
          }),
      },
    });
    render(<AccountRecoveryScreen />, { wrapper: app.wrapper });
    expect(
      await screen.findByText('Too many attempts. Wait before trying again.'),
    ).toBeOnTheScreen();
    expect(screen.getByText(/Error code: RATE_LIMITED/)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeOnTheScreen();
  });

  it('a failed GET /me (INTEGRATION_UNAVAILABLE) shows its code and Try again', async () => {
    const app = createTestApp({
      routes: {
        'GET /me': () =>
          apiError(503, 'INTEGRATION_UNAVAILABLE', {
            message: 'Sign-in is currently unavailable.',
            nextAction: 'retry_later',
          }),
      },
    });
    render(<AccountRecoveryScreen />, { wrapper: app.wrapper });
    expect(await screen.findByText(/Error code: INTEGRATION_UNAVAILABLE/)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeOnTheScreen();
  });

  it('says when the account is not linked to a participant record yet', async () => {
    const app = createTestApp({ routes: { 'GET /me': ok(me({ person: null })) } });
    render(<AccountRecoveryScreen />, { wrapper: app.wrapper });
    expect(
      await screen.findByLabelText(
        'Your participant record, Not linked to this account yet, Not linked yet',
      ),
    ).toBeOnTheScreen();
  });
});
