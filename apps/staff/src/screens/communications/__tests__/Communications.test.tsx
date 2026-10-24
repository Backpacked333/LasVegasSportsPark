/**
 * SCR-S-39 Message composer and audience preview, SCR-S-40 Delivery status: SPK-COMMS-006
 * (compose against an audience, preview names and a count with no contact details, confirm the
 * send), SPK-COMMS-007 (essential versus promotional chosen explicitly), SPK-COMMS-003 / SPK-AT-017
 * (recipients excluded at the recheck reported by count), SPK-COMMS-004 (exact delivery states),
 * STALE_REVISION re-preview, ACCESS_DENIED as not available, offline draft kept.
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { ADULT, CHILD_1, oneFacilityMe, person } from '../../../features/operations/testing';
import { FACILITY_A, createTestApp } from '../../../testing/test-app';

const NOTICE = '0192f1a0-0000-7000-8000-0000000003a1';
const RECIPIENT_A = '0192f1a0-0000-7000-8000-0000000003b1';
const RECIPIENT_B = '0192f1a0-0000-7000-8000-0000000003b2';

function notification(status = 'composed', revision = 1) {
  return {
    id: NOTICE,
    kind: 'staff_broadcast',
    category: 'operational',
    status,
    suppressionReason: null,
    facilityId: FACILITY_A,
    subject: null,
    audience: {
      subjectPersonIds: [],
      staffRoles: ['front_desk'],
      facilityId: FACILITY_A,
      teamEntryIds: [],
      personIds: [],
    },
    title: 'Car park closed',
    body: 'Use the north entrance today.',
    detailsBefore: null,
    detailsAfter: null,
    protected: false,
    scheduledFor: null,
    supersedesNotificationId: null,
    supersededByNotificationId: null,
    createdByPersonId: null,
    sourceEventId: null,
    operationId: null,
    queuedAt: status === 'composed' ? null : '2026-10-24T12:00:00.000Z',
    dispatchedAt: null,
    suppressedAt: null,
    correlationId: null,
    revision,
    createdAt: '2026-10-24T12:00:00.000Z',
    updatedAt: '2026-10-24T12:00:00.000Z',
  };
}

const PREVIEW = {
  status: 200,
  body: {
    notificationId: NOTICE,
    resolvedAt: '2026-10-24T12:00:00.000Z',
    count: 2,
    recipients: [
      {
        personId: ADULT,
        displayName: 'Sam Rivera',
        basis: 'staff_role',
        basisDetail: 'front_desk',
        subjectPersonIds: [],
      },
      {
        personId: CHILD_1,
        displayName: 'Robin Park',
        basis: 'staff_role',
        basisDetail: 'front_desk',
        subjectPersonIds: [],
      },
    ],
  },
};

function attempt(
  id: string,
  recipientId: string,
  channel: string,
  status: string,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    notificationId: NOTICE,
    recipientId,
    channel,
    provider: 'fake',
    providerMessageId: null,
    status,
    queuedAt: '2026-10-24T12:00:00.000Z',
    attemptedAt: null,
    acceptedAt: null,
    deliveredAt: status === 'delivered' ? '2026-10-24T12:01:00.000Z' : null,
    failedAt: status === 'failed' ? '2026-10-24T12:01:00.000Z' : null,
    readAt: null,
    acknowledgedAt: null,
    failureCode: status === 'failed' ? 'PROVIDER_REJECTED' : null,
    error: null,
    revision: 1,
    ...extra,
  };
}

function recipient(id: string, personId: string, status: string) {
  return {
    id,
    notificationId: NOTICE,
    personId,
    basis: 'staff_role',
    basisDetail: 'front_desk',
    subjectPersonIds: [],
    status,
    resolvedAt: '2026-10-24T12:00:00.000Z',
    authorizedAt: status === 'authorized' ? '2026-10-24T12:00:00.000Z' : null,
    revokedAt: status === 'revoked' ? '2026-10-24T12:00:00.000Z' : null,
    revocationReason: status === 'revoked' ? 'No longer holds the role at this facility' : null,
    revision: 1,
  };
}

const DELIVERIES = {
  status: 200,
  body: {
    notification: notification('dispatched'),
    recipients: [
      recipient(RECIPIENT_A, ADULT, 'authorized'),
      recipient(RECIPIENT_B, CHILD_1, 'revoked'),
    ],
    attempts: [
      attempt('0192f1a0-0000-7000-8000-0000000003c1', RECIPIENT_A, 'in_app', 'delivered'),
      attempt('0192f1a0-0000-7000-8000-0000000003c2', RECIPIENT_A, 'push', 'unknown'),
      attempt('0192f1a0-0000-7000-8000-0000000003c3', RECIPIENT_A, 'email', 'failed'),
    ],
  },
};

function routes(extra: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    'GET /me': oneFacilityMe(),
    'GET /people/{id}': (req) =>
      fakeResponse(
        200,
        person(
          req.params.id ?? '',
          req.params.id === ADULT ? 'Sam' : 'Robin',
          req.params.id === ADULT ? 'Rivera' : 'Park',
          'adult',
        ).body,
      ),
    ...extra,
  };
}

describe('SCR-S-39 MessageComposerScreen', () => {
  beforeEach(() => window.localStorage.clear());

  it('SPK-COMMS-006: composes against an audience, previews names and a count without contact details, and confirms the send', async () => {
    const user = userEvent.setup();
    let sent = false;
    const app = createTestApp({
      routes: routes({
        'POST /notifications': { status: 201, body: notification() },
        'GET /notifications/{id}': () =>
          fakeResponse(200, notification(sent ? 'queued' : 'composed', sent ? 2 : 1)),
        'GET /notifications/{id}/recipients': PREVIEW,
        'POST /notifications/{id}/send': () => {
          sent = true;
          return fakeResponse(200, notification('queued', 2));
        },
        'GET /notifications/{id}/deliveries': {
          status: 200,
          body: {
            notification: notification('queued', 2),
            recipients: [
              recipient(RECIPIENT_A, ADULT, 'authorized'),
              recipient(RECIPIENT_B, CHILD_1, 'authorized'),
            ],
            attempts: [
              attempt('0192f1a0-0000-7000-8000-0000000003c1', RECIPIENT_A, 'in_app', 'queued'),
              attempt('0192f1a0-0000-7000-8000-0000000003c4', RECIPIENT_B, 'in_app', 'queued'),
            ],
          },
        },
      }),
    });
    render(app.at('/communications/compose'));
    const form = await screen.findByRole('form', { name: 'Compose a message' });
    expect(within(form).getByText(/DEC-012, DEC-062/)).toBeInTheDocument();

    await user.click(within(form).getByRole('button', { name: 'Preview recipients' }));
    expect(within(form).getByText('Choose essential or promotional.')).toBeInTheDocument();
    expect(
      within(form).getByText('Choose at least one staff role, team entry or person.'),
    ).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.route === '/notifications' && r.method === 'POST')).toBe(
      false,
    );

    await user.click(within(form).getByRole('radio', { name: 'Essential operational notice' }));
    await user.click(within(form).getByRole('checkbox', { name: 'Front desk' }));
    await user.type(within(form).getByLabelText('Title'), 'Car park closed');
    await user.type(within(form).getByLabelText('Message'), 'Use the north entrance today.');
    await user.click(within(form).getByRole('button', { name: 'Preview recipients' }));

    expect(await screen.findByTestId('recipient-count')).toHaveTextContent(
      '2 recipients, resolved from current permissions',
    );
    const recipients = screen.getByRole('list', { name: 'Recipients' });
    expect(within(recipients).getByText('Sam Rivera')).toBeInTheDocument();
    expect(within(recipients).queryByText(/@/)).toBeNull();
    const compose = app.fake.requests.find(
      (r) => r.route === '/notifications' && r.method === 'POST',
    );
    expect(compose?.body).toEqual({
      kind: 'staff_broadcast',
      category: 'operational',
      facilityId: FACILITY_A,
      audience: {
        staffRoles: ['front_desk'],
        teamEntryIds: [],
        subjectPersonIds: [],
        personIds: [],
        facilityId: FACILITY_A,
      },
      title: 'Car park closed',
      body: 'Use the north entrance today.',
      protected: false,
    });

    await user.click(screen.getByRole('button', { name: 'Confirm and send to 2' }));
    expect(await screen.findByTestId('command-success')).toHaveTextContent('Queued');
    const send = app.fake.requests.find((r) => r.route === '/notifications/{id}/send');
    expect(send?.body).toEqual({ expectedRevision: 1 });
    expect(send?.headers['idempotency-key']).toBeTruthy();
    expect(await screen.findByRole('list', { name: 'Deliveries by state' })).toHaveTextContent(
      'Queued: 2',
    );
  });

  it('explains an audience that resolves to nobody', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /notifications/{id}': { status: 200, body: notification() },
        'GET /notifications/{id}/recipients': {
          status: 200,
          body: {
            notificationId: NOTICE,
            resolvedAt: '2026-10-24T12:00:00.000Z',
            count: 0,
            recipients: [],
          },
        },
      }),
    });
    render(app.at(`/communications/notifications/${NOTICE}`));
    expect(await screen.findByText('This audience resolves to nobody')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Confirm and send/ })).toBeNull();
  });

  it('re-previews when the audience changed since the preview (STALE_REVISION)', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /notifications/{id}': { status: 200, body: notification() },
        'GET /notifications/{id}/recipients': PREVIEW,
        'POST /notifications/{id}/send': {
          status: 409,
          body: apiErrorBody('STALE_REVISION', { nextAction: 'reload_and_retry' }),
        },
      }),
    });
    render(app.at(`/communications/notifications/${NOTICE}`));
    await user.click(await screen.findByRole('button', { name: 'Confirm and send to 2' }));
    await user.click(await screen.findByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(
        app.fake.requests.filter((r) => r.route === '/notifications/{id}/recipients'),
      ).toHaveLength(2),
    );
  });

  it('shows an audience outside the composer’s authority as not available', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /notifications': {
          status: 403,
          body: apiErrorBody('ACCESS_DENIED', {
            message: 'You may not address staff outside your facility.',
            nextAction: 'contact_support_or_request_access',
          }),
        },
      }),
    });
    render(app.at('/communications/compose'));
    const form = await screen.findByRole('form', { name: 'Compose a message' });
    await user.click(within(form).getByRole('radio', { name: 'Promotional message' }));
    await user.type(within(form).getByLabelText('Named people (record ids, one per line)'), ADULT);
    await user.type(within(form).getByLabelText('Title'), 'Autumn camp');
    await user.type(within(form).getByLabelText('Message'), 'Places are open.');
    await user.click(within(form).getByRole('button', { name: 'Preview recipients' }));
    expect(await screen.findByTestId('command-unavailable')).toHaveTextContent(
      'outside your facility',
    );
  });

  it('keeps the draft offline and disables composing', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: routes() });
    render(app.at('/communications/compose'));
    const form = await screen.findByRole('form', { name: 'Compose a message' });
    await user.type(within(form).getByLabelText('Title'), 'Draft title');
    act(() => app.connectivity.set(false));
    expect(within(form).getByRole('button', { name: 'Preview recipients' })).toBeDisabled();
    expect(
      within(form).getByText('Needs a connection. Your draft is kept on this screen.'),
    ).toBeInTheDocument();
    expect(within(form).getByLabelText('Title')).toHaveValue('Draft title');
  });
});

describe('SCR-S-40 Delivery status', () => {
  beforeEach(() => window.localStorage.clear());

  it('SPK-COMMS-004: shows exact states per recipient and channel, counts, and recheck exclusions by count', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /notifications/{id}': { status: 200, body: notification('dispatched') },
        'GET /notifications/{id}/deliveries': DELIVERIES,
      }),
    });
    render(app.at(`/communications/notifications/${NOTICE}`));
    const counts = await screen.findByRole('list', { name: 'Deliveries by state' });
    expect(within(counts).getByText('Delivered (confirmed): 1')).toBeInTheDocument();
    expect(within(counts).getByText('Unknown: 1')).toBeInTheDocument();
    expect(within(counts).getByText('Failed: 1')).toBeInTheDocument();
    expect(screen.getByTestId('recheck-excluded')).toHaveTextContent(
      '1 recipient was excluded at the recheck',
    );
    expect(screen.getByText(/DEC-041/)).toBeInTheDocument();
    expect(screen.getByText('Retrying a failed delivery is not available yet')).toBeInTheDocument();
    const sam = await screen.findByRole('listitem', { name: 'Sam Rivera' });
    const deliveries = within(sam).getByRole('list', { name: 'Deliveries to Sam Rivera' });
    expect(within(deliveries).getByText(/Push/)).toBeInTheDocument();
    expect(within(deliveries).getByText(/Provider rejected/)).toBeInTheDocument();
    expect(
      screen.getByText(
        'A push notification is not proof of delivery: only confirmed deliveries say so.',
      ),
    ).toBeInTheDocument();
  });

  it('lists messages for the selected facility with their status', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /notifications': {
          status: 200,
          body: {
            items: [
              notification('queued'),
              {
                ...notification('suppressed'),
                id: '0192f1a0-0000-7000-8000-0000000003a2',
                title: 'Old reminder',
                suppressionReason: 'obsolete',
              },
            ],
            nextCursor: null,
          },
        },
      }),
    });
    render(app.at('/communications'));
    const list = await screen.findByRole('list', { name: 'Messages' });
    expect(within(list).getByRole('link', { name: 'Car park closed' })).toHaveAttribute(
      'href',
      `/communications/notifications/${NOTICE}`,
    );
    expect(within(list).getByText('Suppressed')).toBeInTheDocument();
    expect(app.fake.requests.find((r) => r.route === '/notifications')?.query.facilityId).toBe(
      FACILITY_A,
    );
  });

  it('shows a notice the viewer may not read as not available', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /notifications/{id}': { status: 404, body: apiErrorBody('NOT_FOUND') },
      }),
    });
    render(app.at(`/communications/notifications/${NOTICE}`));
    expect(await screen.findByTestId('state-unavailable')).toBeInTheDocument();
  });
});
