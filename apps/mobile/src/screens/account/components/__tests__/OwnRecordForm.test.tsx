/**
 * SCR-C-01 "create or claim the Person": creating one's own adult record (SPK-IAM-001,
 * SPK-IAM-002, SPK-IAM-007).
 */
import { fakeResponse } from '@sportspark/api-client/testing';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { createTestApp } from '../../../../testing/test-app';
import { OnboardingScreen } from '../../../onboarding/OnboardingScreen';
import { apiError, me, ok, person, personDetail, SELF } from '../../__tests__/fixtures';
import { dateOfBirthProblem, OwnRecordForm } from '../OwnRecordForm';

jest.mock('expo-router', () => ({ useRouter: () => ({ replace: jest.fn(), push: jest.fn() }) }));

const TODAY = new Date('2026-10-24T12:00:00.000Z');

function fill(given: string, family: string, born: string) {
  fireEvent.changeText(screen.getByLabelText('First name'), given);
  fireEvent.changeText(screen.getByLabelText('Last name'), family);
  fireEvent.changeText(screen.getByLabelText('Date of birth'), born);
}

describe('OwnRecordForm', () => {
  it('a date of birth must be a real past date written year-month-day', () => {
    expect(dateOfBirthProblem('1990-04-23', TODAY)).toBeNull();
    expect(dateOfBirthProblem('23/04/1990', TODAY)).toMatch(/year-month-day/);
    expect(dateOfBirthProblem('1990-02-30', TODAY)).toBe('That date does not exist.');
    expect(dateOfBirthProblem('2030-01-01', TODAY)).toBe(
      'A date of birth cannot be in the future.',
    );
  });

  it('validation failure: nothing is sent until every field is valid, and what was typed is kept', async () => {
    const app = createTestApp();
    render(<OwnRecordForm now={() => TODAY} />, { wrapper: app.wrapper });
    fireEvent.press(screen.getByRole('button', { name: 'Create my record' }));
    expect(await screen.findByText(/Enter your first name\./)).toBeOnTheScreen();
    expect(screen.getByText(/Enter your last name\./)).toBeOnTheScreen();
    fill('Nora', 'Newcomer', '1990-13-01');
    fireEvent.press(screen.getByRole('button', { name: 'Create my record' }));
    expect(await screen.findByText(/That date does not exist\./)).toBeOnTheScreen();
    expect(screen.getByLabelText('First name')).toHaveProp('value', 'Nora');
    expect(app.fake.requests).toHaveLength(0);
  });

  it('onboarding: an account with no record creates its own, with one idempotency key, and the step becomes Linked', async () => {
    let linked = false;
    const app = createTestApp({
      routes: {
        'GET /me': () =>
          fakeResponse(200, me({ person: linked ? person(SELF, 'Nora', 'Newcomer') : null })),
        'GET /people/{id}': ok(personDetail(person(SELF, 'Nora', 'Newcomer'), [])),
        'POST /me/person': () => {
          linked = true;
          return fakeResponse(201, personDetail(person(SELF, 'Nora', 'Newcomer'), []));
        },
      },
    });
    render(<OnboardingScreen />, { wrapper: app.wrapper });
    expect(
      await screen.findByLabelText('Step 2 of 4, Participant record, Not linked yet'),
    ).toBeOnTheScreen();
    expect(
      screen.getByRole('header', { name: 'No claim code? Create your record' }),
    ).toBeOnTheScreen();
    fill(' Nora ', 'Newcomer', '1990-04-23');
    fireEvent.press(screen.getByRole('button', { name: 'Create my record' }));
    expect(
      await screen.findByLabelText('Step 2 of 4, Participant record, Linked'),
    ).toBeOnTheScreen();
    const created = app.fake.requests.filter((r) => r.route === '/me/person');
    expect(created).toHaveLength(1);
    expect(created[0]?.body).toEqual({
      givenName: 'Nora',
      familyName: 'Newcomer',
      dateOfBirth: '1990-04-23',
    });
    expect(created[0]?.headers['idempotency-key']).toBe('key-00000001');
  });

  it('SPK-IAM-002: when the desk already holds a record with the verified email, nothing is created and the person is sent to claim it', async () => {
    const app = createTestApp({
      routes: {
        'POST /me/person': () =>
          apiError(409, 'RESOURCE_CONFLICT', {
            message: 'A record already exists.',
            details: { kind: 'email', resolution: 'claim_existing_record' },
          }),
      },
    });
    render(<OwnRecordForm now={() => TODAY} />, { wrapper: app.wrapper });
    fill('Dana', 'Desk', '1985-04-12');
    fireEvent.press(screen.getByRole('button', { name: 'Create my record' }));
    expect(await screen.findByTestId('own-record-claim-instead')).toHaveTextContent(
      /The front desk already has a record with your verified email address\. Nothing new was created\./,
    );
    expect(screen.getByLabelText('First name')).toHaveProp('value', 'Dana');
  });

  it('offline: the button is disabled and the input is kept', async () => {
    const app = createTestApp({ reachable: false });
    render(<OwnRecordForm now={() => TODAY} />, { wrapper: app.wrapper });
    fill('Nora', 'Newcomer', '1990-04-23');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Create my record' })).toBeDisabled(),
    );
    expect(
      screen.getByText('Creating a record needs a connection. What you typed is kept.'),
    ).toBeOnTheScreen();
    expect(app.fake.requests).toHaveLength(0);
  });
});
