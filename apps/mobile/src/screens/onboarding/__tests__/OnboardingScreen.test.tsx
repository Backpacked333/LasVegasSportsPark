/**
 * SCR-C-01 Onboarding and account verification (SPK-UX-001, SPK-IAM-001, SPK-IAM-002, §4.13,
 * §6.2 "Fresh installation", "Account verification", "Interrupted onboarding", DEC-018, DEC-061).
 */
import { fakeResponse } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { clearLinkSecrets, holdLinkSecret, readLinkSecret } from '../../../links/link-secrets';
import { createTestApp } from '../../../testing/test-app';
import {
  apiError,
  contactPoint,
  me,
  ok,
  person,
  personDetail,
  SELF,
  TOKEN,
} from '../../account/__tests__/fixtures';
import { OnboardingRoute, OnboardingScreen } from '../OnboardingScreen';

const SELF_PERSON = person(SELF, 'Alex', 'Morgan');

function claimAccepted() {
  return {
    claim: {
      id: '0192f1a0-0000-7000-8000-00000000e001',
      subjectPersonId: SELF,
      kind: 'self',
      requestedPermissions: [],
      status: 'accepted',
      expiresAt: '2026-10-30T10:00:00.000Z',
      acceptedAt: '2026-10-24T12:00:00.000Z',
      acceptedByPersonId: SELF,
      revokedAt: null,
      revision: 2,
      createdAt: '2026-10-20T10:00:00.000Z',
    },
    accountId: '0192f1a0-0000-7000-8000-0000000000aa',
    personId: SELF,
    relationship: null,
    grants: [],
  };
}

afterEach(clearLinkSecrets);

describe('SCR-C-01 OnboardingScreen', () => {
  it('signed out: shows every step as not started and offers sign-in and recovery (fresh installation)', async () => {
    const app = createTestApp({ session: null });
    render(<OnboardingScreen />, { wrapper: app.wrapper });
    expect(await screen.findByLabelText('Step 1 of 4, Sign in, Not started')).toBeOnTheScreen();
    expect(
      screen.getByLabelText('Step 4 of 4, Notifications and camera, Waiting on a decision'),
    ).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Recover an existing account' })).toBeOnTheScreen();
    expect(app.fake.requests).toHaveLength(0);
  });

  it('SPK-IAM-002: claims the desk-created record with the code from the link, then resumes at the next step', async () => {
    let linked = false;
    const app = createTestApp({
      routes: {
        'GET /me': () => fakeResponse(200, me({ person: linked ? SELF_PERSON : null })),
        'GET /people/{id}': ok(personDetail(SELF_PERSON)),
        'POST /claims/{token}/accept': () => {
          linked = true;
          return fakeResponse(200, claimAccepted());
        },
      },
    });
    holdLinkSecret('claim', TOKEN); // as the link landing does
    render(<OnboardingScreen claimToken={TOKEN} />, { wrapper: app.wrapper });

    expect(
      await screen.findByLabelText('Step 2 of 4, Participant record, Not linked yet'),
    ).toBeOnTheScreen();
    expect(screen.getByLabelText('Claim code')).toHaveProp('value', TOKEN);
    fireEvent.press(screen.getByRole('button', { name: 'Claim record' }));

    expect(
      await screen.findByLabelText('Step 2 of 4, Participant record, Linked'),
    ).toBeOnTheScreen();
    const claim = app.fake.requests.find((r) => r.method === 'POST');
    expect(claim?.route).toBe('/claims/{token}/accept');
    expect(claim?.params.token).toBe(TOKEN);
    expect(claim?.headers['idempotency-key']).toBe('key-00000001');
    expect(await screen.findByRole('header', { name: 'Email or phone' })).toBeOnTheScreen();
    // The code that linked the account is used up: it is not offered again as a guardian claim.
    expect(screen.queryByRole('header', { name: 'Claim a record from the front desk' })).toBeNull();
    expect(readLinkSecret('claim')).toBeNull();
  });

  it('validation failure: an empty or malformed claim code is rejected before sending, and the input is kept', async () => {
    const app = createTestApp({ routes: { 'GET /me': ok(me({ person: null })) } });
    render(<OnboardingScreen />, { wrapper: app.wrapper });
    const field = await screen.findByLabelText('Claim code');
    fireEvent.press(screen.getByRole('button', { name: 'Claim record' }));
    expect(screen.getByText(/Enter the claim code\./)).toBeOnTheScreen();
    fireEvent.changeText(field, 'not a code!');
    fireEvent.press(screen.getByRole('button', { name: 'Claim record' }));
    expect(screen.getByText(/at least 16 letters/)).toBeOnTheScreen();
    expect(screen.getByLabelText('Claim code')).toHaveProp('value', 'not a code!');
    expect(app.fake.requests.filter((r) => r.method === 'POST')).toHaveLength(0);
  });

  it('shows an unknown claim code (NOT_FOUND) as not recognised, without the code (§4.10)', async () => {
    const app = createTestApp({
      routes: {
        'GET /me': ok(me({ person: null })),
        'POST /claims/{token}/accept': () =>
          apiError(404, 'NOT_FOUND', { nextAction: 'verify_reference' }),
      },
    });
    render(<OnboardingScreen claimToken={TOKEN} />, { wrapper: app.wrapper });
    fireEvent.press(await screen.findByRole('button', { name: 'Claim record' }));
    expect(await screen.findByLabelText('Claim code not recognised')).toBeOnTheScreen();
    expect(screen.queryByText(/NOT_FOUND/)).toBeNull();
    expect(screen.getByLabelText('Claim code')).toHaveProp('value', TOKEN);
  });

  it('stale version: a claim code already used says so (INVALID_TRANSITION)', async () => {
    const app = createTestApp({
      routes: {
        'GET /me': ok(me({ person: null })),
        'POST /claims/{token}/accept': () =>
          apiError(409, 'INVALID_TRANSITION', {
            nextAction: 'reload_current_state',
            details: { machine: 'Claim', from: 'accepted', event: 'accept' },
          }),
      },
    });
    render(<OnboardingScreen claimToken={TOKEN} />, { wrapper: app.wrapper });
    fireEvent.press(await screen.findByRole('button', { name: 'Claim record' }));
    expect(await screen.findByLabelText('Claim code no longer open')).toBeOnTheScreen();
    expect(screen.getByText('This claim code has already been used.')).toBeOnTheScreen();
  });

  it('§4.9: "Try again" after INTEGRATION_UNAVAILABLE resends the same idempotency key', async () => {
    let calls = 0;
    const app = createTestApp({
      routes: {
        'GET /me': ok(me({ person: null })),
        'POST /claims/{token}/accept': () => {
          calls += 1;
          return apiError(503, 'INTEGRATION_UNAVAILABLE', { nextAction: 'retry_later' });
        },
      },
    });
    render(<OnboardingScreen claimToken={TOKEN} />, { wrapper: app.wrapper });
    fireEvent.press(await screen.findByRole('button', { name: 'Claim record' }));
    expect(await screen.findByText(/Error code: INTEGRATION_UNAVAILABLE/)).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(calls).toBe(2));
    const keys = app.fake.requests
      .filter((r) => r.method === 'POST')
      .map((r) => r.headers['idempotency-key']);
    expect(keys).toEqual(['key-00000001', 'key-00000001']);
  });

  it('account verification: lists contact points as "Verification pending" or "Verified", with DEC-018 pending', async () => {
    const app = createTestApp({
      routes: {
        'GET /me': ok(me({ person: SELF_PERSON })),
        'GET /people/{id}': ok(
          personDetail(SELF_PERSON, [
            contactPoint(
              '0192f1a0-0000-7000-8000-00000000c101',
              SELF,
              'email',
              'alex@example.test',
              false,
            ),
            contactPoint(
              '0192f1a0-0000-7000-8000-00000000c102',
              SELF,
              'phone',
              '+1 555 0100',
              true,
            ),
          ]),
        ),
      },
    });
    render(<OnboardingScreen />, { wrapper: app.wrapper });
    expect(
      await screen.findByLabelText('alex@example.test, Email, primary, Verification pending'),
    ).toBeOnTheScreen();
    expect(screen.getByLabelText('+1 555 0100, Phone, primary, Verified')).toBeOnTheScreen();
    expect(screen.getByLabelText('Step 3 of 4, Email or phone, Verified')).toBeOnTheScreen();
    expect(
      screen.getByText(
        /Verifying an email or phone in the app is not available yet: it depends on DEC-018/,
      ),
    ).toBeOnTheScreen();
    expect(screen.getByText('Your account is set up.')).toBeOnTheScreen();
  });

  it('adds an email unverified, as primary only when there is none of that kind; format errors stop it first', async () => {
    const app = createTestApp({
      routes: {
        'GET /me': ok(me({ person: SELF_PERSON })),
        'GET /people/{id}': ok(personDetail(SELF_PERSON)),
        'POST /people/{id}/contact-points': {
          status: 201,
          body: contactPoint(
            '0192f1a0-0000-7000-8000-00000000c103',
            SELF,
            'email',
            'alex@example.test',
            false,
          ),
        },
      },
    });
    render(<OnboardingScreen />, { wrapper: app.wrapper });
    const field = await screen.findByLabelText('Email address');
    fireEvent.changeText(field, 'alex-at-example');
    fireEvent.press(screen.getByRole('button', { name: 'Add email' }));
    expect(screen.getByText(/in the form name@example.com/)).toBeOnTheScreen();
    expect(app.fake.requests.filter((r) => r.method === 'POST')).toHaveLength(0);

    fireEvent.changeText(screen.getByLabelText('Email address'), ' alex@example.test ');
    fireEvent.press(screen.getByRole('button', { name: 'Add email' }));
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.method === 'POST')).toHaveLength(1),
    );
    const post = app.fake.requests.find((r) => r.method === 'POST');
    expect(post?.params.id).toBe(SELF);
    expect(post?.body).toEqual({
      kind: 'email',
      value: 'alex@example.test',
      isPrimary: true,
      verified: false,
    });
  });

  it('§4.9: Try again after no answer resends the same body and key, even after a refetch shows the new point', async () => {
    let posts = 0;
    let added = false;
    const point = contactPoint(
      '0192f1a0-0000-7000-8000-00000000c104',
      SELF,
      'email',
      'alex@example.test',
      false,
    );
    const app = createTestApp({
      routes: {
        'GET /me': ok(me({ person: SELF_PERSON })),
        'GET /people/{id}': () =>
          fakeResponse(
            200,
            personDetail(SELF_PERSON, added ? [{ ...point, isPrimary: true }] : []),
          ),
        'POST /people/{id}/contact-points': () => {
          posts += 1;
          added = true; // the first attempt reached the API; its answer is lost
          if (posts === 1) throw new TypeError('Network request failed');
          return fakeResponse(201, point);
        },
      },
    });
    render(<OnboardingScreen />, { wrapper: app.wrapper });
    fireEvent.changeText(await screen.findByLabelText('Email address'), 'alex@example.test');
    fireEvent.press(screen.getByRole('button', { name: 'Add email' }));
    const retry = await screen.findByRole('button', { name: 'Try again' });
    // A reconnect or focus refetch now lists the new point, so a rebuilt body would say isPrimary false.
    await act(async () => {
      await app.queryClient.invalidateQueries({ queryKey: ['api', '/people/{id}'] });
    });
    fireEvent.press(retry);
    await waitFor(() => expect(posts).toBe(2));
    const sent = app.fake.requests.filter((r) => r.method === 'POST');
    expect(sent[1]?.headers['idempotency-key']).toBe(sent[0]?.headers['idempotency-key']);
    expect(sent[1]?.body).toEqual(sent[0]?.body);
    expect(sent[0]?.body).toMatchObject({ isPrimary: true });
  });

  it('shows the API VALIDATION_FAILED message at the field and keeps the input', async () => {
    const app = createTestApp({
      routes: {
        'GET /me': ok(me({ person: SELF_PERSON })),
        'GET /people/{id}': ok(personDetail(SELF_PERSON)),
        'POST /people/{id}/contact-points': () =>
          apiError(400, 'VALIDATION_FAILED', {
            message: 'The email address is not valid.',
            nextAction: 'correct_input',
          }),
      },
    });
    render(<OnboardingScreen />, { wrapper: app.wrapper });
    fireEvent.changeText(await screen.findByLabelText('Email address'), 'alex@example.test');
    fireEvent.press(screen.getByRole('button', { name: 'Add email' }));
    expect(await screen.findByText(/The email address is not valid\./)).toBeOnTheScreen();
    expect(screen.getByLabelText('Email address')).toHaveProp('value', 'alex@example.test');
  });

  it('a used or expired claim code from a link is forgotten, so the next visit does not prefill it', async () => {
    const app = createTestApp({
      routes: {
        'GET /me': ok(me({ person: null })),
        'POST /claims/{token}/accept': () =>
          apiError(409, 'INVALID_TRANSITION', {
            nextAction: 'reload_current_state',
            details: { machine: 'claim', from: 'expired', event: 'accept' },
          }),
      },
    });
    holdLinkSecret('claim', TOKEN);
    const view = render(<OnboardingRoute />, { wrapper: app.wrapper });
    fireEvent.press(await screen.findByRole('button', { name: 'Claim record' }));
    expect(await screen.findByText(/This claim code has expired/)).toBeOnTheScreen();
    expect(readLinkSecret('claim')).toBeNull();
    view.unmount();
    render(<OnboardingRoute />, { wrapper: app.wrapper });
    expect(await screen.findByLabelText('Claim code')).toHaveProp('value', '');
  });

  it('offline: claiming is disabled, the code is kept and nothing is sent', async () => {
    const app = createTestApp({ routes: { 'GET /me': ok(me({ person: null })) } });
    render(<OnboardingScreen claimToken={TOKEN} />, { wrapper: app.wrapper });
    expect(await screen.findByLabelText('Claim code')).toBeOnTheScreen();
    act(() => app.sources.setReachable(false));
    const button = screen.getByRole('button', { name: 'Claim record' });
    expect(button).toBeDisabled();
    expect(screen.getByText('Claiming needs a connection. Your code is kept.')).toBeOnTheScreen();
    expect(screen.getByLabelText('Claim code')).toHaveProp('value', TOKEN);
  });

  it('explains notification and camera permissions as pending DEC-061 and lets the person continue', async () => {
    const app = createTestApp({
      routes: {
        'GET /me': ok(me({ person: SELF_PERSON })),
        'GET /people/{id}': ok(personDetail(SELF_PERSON)),
      },
    });
    render(<OnboardingScreen />, { wrapper: app.wrapper });
    expect(
      await screen.findByText(
        /asking for notification and camera permission is not available yet: it depends on DEC-061/,
      ),
    ).toBeOnTheScreen();
    expect(screen.getByText(/You can continue without them/)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Go to Home' })).toBeOnTheScreen();
  });

  it('shows the participant record step as linked once the API links the account (interrupted onboarding resumes)', async () => {
    const app = createTestApp({
      routes: {
        'GET /me': ok(me({ person: SELF_PERSON })),
        'GET /people/{id}': ok(personDetail(SELF_PERSON)),
      },
    });
    render(<OnboardingScreen />, { wrapper: app.wrapper });
    expect(
      await screen.findByLabelText('Step 3 of 4, Email or phone, Not added'),
    ).toBeOnTheScreen();
    expect(screen.getByLabelText('Step 2 of 4, Participant record, Linked')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Claim code')).toBeNull();
  });

  it('a claim link opened by a linked account offers the guardian claim; a code used to link the account is not offered again', async () => {
    holdLinkSecret('claim', TOKEN);
    const app = createTestApp({
      routes: {
        'GET /me': ok(me({ person: SELF_PERSON })),
        'GET /people/{id}': ok(personDetail(SELF_PERSON)),
      },
    });
    render(<OnboardingScreen />, { wrapper: app.wrapper });
    expect(
      await screen.findByRole('header', { name: 'Claim a record from the front desk' }),
    ).toBeOnTheScreen();
    expect(screen.getByLabelText('Claim code')).toHaveProp('value', TOKEN);
  });
});
