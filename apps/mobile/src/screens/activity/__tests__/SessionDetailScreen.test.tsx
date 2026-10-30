/**
 * SCR-C-20 activity detail for a program session or a booked session (SPK-UX-004, SPK-COMMS-005,
 * SPK-SCHED-008, SPK-UX-008, SPK-UX-009, §4.10, §4.14).
 */
import { fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { render, screen, within } from '@testing-library/react-native';
import {
  BOOKING,
  CHILD,
  ENROLLMENT,
  enrollment,
  fail,
  GUARDIAN_OF_CHILD,
  inboxPage,
  me,
  OFFERING_TWO,
  offering,
  ok,
  names,
  facility,
  DENVER,
  scheduleChange,
  SELF,
  SESSION,
  SESSION_TWO,
  session,
  BASKET,
  checkoutBasket,
} from '../../../features/today/__tests__/fixtures';
import { createTestApp } from '../../../testing/test-app';
import { SessionDetailScreen } from '../SessionDetailScreen';

jest.mock('../../../features/today/device-time-zone', () => ({
  deviceTimeZone: () => 'America/Los_Angeles',
}));

const booking = {
  id: BOOKING,
  offeringId: OFFERING_TWO,
  sessionId: SESSION_TWO,
  participantPersonId: SELF,
  kind: 'pickup',
  status: 'pending',
  poolId: null,
  holdId: null,
  makeupEntitlementId: null,
  scheduledStart: '2026-10-25T01:00:00.000Z',
  scheduledEnd: '2026-10-25T02:30:00.000Z',
  expiresAt: null,
  confirmedAt: null,
  canceledAt: null,
  cancelReason: null,
  expiredAt: null,
  revision: 1,
};

function routes(overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    'GET /me': ok(me(GUARDIAN_OF_CHILD)),
    'GET /me/inbox': inboxPage([]),
    'GET /enrollments/{id}': ok(enrollment()),
    'GET /session-bookings/{id}': ok(booking),
    'GET /person-names': names({ [CHILD]: 'Sam' }),
    'GET /facilities/{id}': ok(facility()),
    'GET /offerings/{id}': (req) =>
      fakeResponse(
        200,
        req.params.id === OFFERING_TWO
          ? offering(OFFERING_TWO, 'Adult Pickup Night', null)
          : offering(),
      ),
    'GET /offerings/{id}/sessions': (req) =>
      fakeResponse(
        200,
        req.params.id === OFFERING_TWO
          ? [
              session({
                id: SESSION_TWO,
                offeringId: OFFERING_TWO,
                scheduledStart: booking.scheduledStart,
                scheduledEnd: booking.scheduledEnd,
                schedulingEventId: null,
              }),
            ]
          : [session()],
      ),
    ...overrides,
  };
}

function renderSession(
  props: { sessionId?: string; enrollmentId?: string; bookingId?: string },
  overrides: Record<string, FakeHandler> = {},
) {
  const app = createTestApp({ routes: routes(overrides) });
  render(
    <SessionDetailScreen
      sessionId={props.sessionId}
      enrollmentId={props.enrollmentId}
      bookingId={props.bookingId}
    />,
    {
      wrapper: app.wrapper,
    },
  );
  return app;
}

describe('SCR-C-20 SessionDetailScreen', () => {
  it('SPK-UX-004: a child’s program session with participant, place, time, status and arrival guidance pending', async () => {
    renderSession({ sessionId: SESSION, enrollmentId: ENROLLMENT });
    const card = await screen.findByTestId('session-card');
    expect(
      await within(card).findByLabelText(
        'For: Sam. When: Sat, Oct 24, 10:00 AM to 11:00 AM PDT. Where: Main Park, North field',
      ),
    ).toBeOnTheScreen();
    expect(within(card).getByRole('header', { name: 'Junior Skills' })).toBeOnTheScreen();
    expect(within(card).getByLabelText('Confirmed')).toBeOnTheScreen();
    expect(screen.getByText('Ball skills for younger players.')).toBeOnTheScreen();
    expect(
      screen.getByText(
        /Arrival guidance for this activity is not available yet: it depends on POL-046/,
      ),
    ).toBeOnTheScreen();
    // Only the given name of the child is shown (§4.14).
    expect(screen.queryByText(/Morgan|2016/)).toBeNull();
  });

  it('SPK-COMMS-005: shows the latest change with old and new details in the facility zone', async () => {
    renderSession(
      { sessionId: SESSION, enrollmentId: ENROLLMENT },
      { 'GET /me/inbox': inboxPage([scheduleChange()]) },
    );
    expect(await screen.findByTestId('session-card-change')).toHaveProp(
      'accessibilityLabel',
      'Changed. Was: Sat, Oct 24, 10:00 AM to 11:00 AM PDT at Pitch 1. Now: Sat, Oct 24, 11:00 AM to 12:00 PM PDT at Pitch 2',
    );
  });

  it('a booked session reads its booking: "Booking pending" for the signed-in person', async () => {
    const app = renderSession({ sessionId: SESSION_TWO, bookingId: BOOKING });
    const card = await screen.findByTestId('session-card');
    expect(await within(card).findByLabelText('Booking pending')).toBeOnTheScreen();
    expect(
      within(card).getByLabelText(
        'For: You. When: Sat, Oct 24, 6:00 PM to 7:30 PM PDT. Where: Main Park',
      ),
    ).toBeOnTheScreen();
    expect(app.fake.requests.some((r) => r.route === '/enrollments/{id}')).toBe(false);
  });

  it('a canceled session says so with the reason; a pending payment reads "Payment processing"', async () => {
    renderSession(
      { sessionId: SESSION, enrollmentId: ENROLLMENT },
      {
        'GET /offerings/{id}/sessions': ok([
          session({ status: 'canceled', cancelReason: 'Field closed for maintenance' }),
        ]),
      },
    );
    expect(
      await screen.findByText('This session was canceled: Field closed for maintenance'),
    ).toBeOnTheScreen();
    expect(screen.getByTestId('session-card-status')).toHaveProp('accessibilityLabel', 'Canceled');

    screen.unmount();
    renderSession(
      { sessionId: SESSION, enrollmentId: ENROLLMENT },
      {
        // The real shape: lastOperationId stays null while the checkout runs.
        'GET /enrollments/{id}': ok(
          enrollment({ status: 'pending', lastOperationId: null, basketId: BASKET }),
        ),
        'GET /baskets/{id}': ok(checkoutBasket('checking_out', null)),
      },
    );
    expect(await screen.findByLabelText('Payment processing')).toBeOnTheScreen();
  });

  it('§4.10: an activity the person may not see is "not available" with no code or hint', async () => {
    renderSession(
      { sessionId: SESSION, enrollmentId: ENROLLMENT },
      { 'GET /enrollments/{id}': fail(404, 'NOT_FOUND') },
    );
    expect(await screen.findByText(/This activity is not available\./)).toBeOnTheScreen();
    expect(screen.queryByText(/NOT_FOUND/)).toBeNull();

    screen.unmount();
    renderSession({ sessionId: SESSION });
    expect(await screen.findByLabelText('Not available')).toBeOnTheScreen();

    screen.unmount();
    renderSession({ sessionId: 'not-in-offering', enrollmentId: ENROLLMENT });
    expect(await screen.findByLabelText('Not available')).toBeOnTheScreen();
  });

  it('shows a failed read with its code and a retry', async () => {
    renderSession(
      { sessionId: SESSION, enrollmentId: ENROLLMENT },
      {
        'GET /enrollments/{id}': fail(
          503,
          'INTEGRATION_UNAVAILABLE',
          'Registrations are unavailable.',
        ),
      },
    );
    expect(await screen.findByText('Registrations are unavailable.')).toBeOnTheScreen();
    expect(screen.getByText(/Error code: INTEGRATION_UNAVAILABLE/)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeOnTheScreen();
  });

  it('SPK-SCHED-008: times are on the facility clock the enrollment names, without a schedule notice', async () => {
    renderSession(
      { sessionId: SESSION, enrollmentId: ENROLLMENT },
      {
        'GET /enrollments/{id}': ok(
          enrollment({
            offering: { ...enrollment().offering, timezone: DENVER },
          }),
        ),
      },
    );
    const card = await screen.findByTestId('session-card');
    expect(
      await within(card).findByLabelText(
        'For: Sam. When: Sat, Oct 24, 11:00 AM to 12:00 PM MDT. Where: Main Park, North field',
      ),
    ).toBeOnTheScreen();
    expect(screen.queryByText(/device's time zone/)).toBeNull();
  });

  it('SPK-SCHED-008: a booked session takes its zone and place from GET /v1/facilities/{id}', async () => {
    const app = renderSession(
      { sessionId: SESSION_TWO, bookingId: BOOKING },
      {
        'GET /offerings/{id}': ok({
          ...offering(OFFERING_TWO, 'Adult Pickup Night', null),
          facility: undefined,
        }),
        'GET /facilities/{id}': ok(facility({ name: 'North Complex', timezone: DENVER })),
      },
    );
    const card = await screen.findByTestId('session-card');
    expect(
      await within(card).findByLabelText(
        'For: You. When: Sat, Oct 24, 7:00 PM to 8:30 PM MDT. Where: North Complex',
      ),
    ).toBeOnTheScreen();
    expect(app.fake.requests.some((r) => r.route === '/facilities/{id}')).toBe(true);
  });
});
