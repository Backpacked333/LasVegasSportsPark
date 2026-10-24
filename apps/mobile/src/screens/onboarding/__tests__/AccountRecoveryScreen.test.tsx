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
  ok,
  peopleRoute,
  person,
  SELF,
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
        // CHILD_TWO is collect-only: the API does not let this account read the record.
        'GET /people/{id}': peopleRoute([person(CHILD, 'Sam', 'Morgan', 'child')]),
      },
    });
    render(<AccountRecoveryScreen />, { wrapper: app.wrapper });
    expect(await screen.findByLabelText('Sam Morgan: View, Register and Pay')).toBeOnTheScreen();
    expect(screen.getByLabelText('Name not available to you: Collect')).toBeOnTheScreen();
    expect(screen.getByLabelText('Alex Morgan, Your own record, Linked')).toBeOnTheScreen();
    expect(screen.getByText(/Account recovery never adds permissions/)).toBeOnTheScreen();
    expect(screen.queryByText(/NOT_FOUND/)).toBeNull();
    // Only the people the API listed were looked up: no other household is read.
    const looked = app.fake.requests
      .filter((r) => r.route === '/people/{id}')
      .map((r) => r.params.id);
    expect(new Set(looked)).toEqual(new Set([CHILD, CHILD_TWO]));
    expect(looked).not.toContain(SELF);
  });

  it('shows "No family access on this account" when the API lists none (success: nothing new)', async () => {
    const app = createTestApp({ routes: { 'GET /me': ok(me({})) } });
    render(<AccountRecoveryScreen />, { wrapper: app.wrapper });
    expect(
      await screen.findByRole('header', { name: 'No family access on this account' }),
    ).toBeOnTheScreen();
  });

  it('permission restriction: a rate-limited recovery shows RATE_LIMITED and its next action', async () => {
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

  it('recovery required: the identity provider being unavailable shows INTEGRATION_UNAVAILABLE with "Try again"', async () => {
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
