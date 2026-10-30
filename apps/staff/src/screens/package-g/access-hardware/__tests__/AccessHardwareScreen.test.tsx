/**
 * SCR-S-56 Access hardware (Package G; §3.16 Access hardware, SPK-COND-004, SPK-ENTRY-002,
 * DEC-016, DEC-080, DEC-023): turned off by default with devices readable, devices registered
 * deny-all with no heartbeat timeout assumed, outages shown with their age, renaming and retiring
 * with revisions (a stale retirement reloads and sends the revision just read), policies drafted
 * by one person and approved by another with each window problem on its own control, the command
 * queue with delivery outcomes, the hardware exceptions of every category with the owner queue the
 * API recorded, event ingestion from the inbox, and the audit history read only when asked.
 */
import { CAPABILITY_PRESENTATION } from '@sportspark/api-client';
import {
  capabilityDisabledBody,
  fakeResponse,
  type FakeHandler,
} from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  COMMAND_ID,
  DEVICE_B_ID,
  DEVICE_ID,
  EXCEPTION_ID,
  ME_PERSON,
  POLICY_B_ID,
  POLICY_ID,
  apiError,
  auditRecord,
  baseRoutes,
  device,
  deviceCommand,
  hardwareException,
  ok,
  page,
  permissions,
  policy,
  providerEvent,
} from '../../../../features/pos-access-accounting/__tests__/fixtures';
import { FACILITY_A, createTestApp } from '../../../../testing/test-app';

const BASE = '/admin/access-hardware';
const DEVICE_PATH = `${BASE}/facilities/${FACILITY_A}/devices/${DEVICE_ID}`;
const HARDWARE = [
  'entry.register_access_device',
  'entry.update_access_device',
  'entry.retire_access_device',
  'entry.draft_access_policy',
  'entry.approve_access_policy',
  'entry.retire_access_policy',
];
const VIEW_EVENTS = 'core.view_provider_events';
const VIEW_AUDIT = 'core.view_audit';

function routes(extra: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...baseRoutes(),
    'GET /me/permissions': permissions(['access_hardware'], HARDWARE),
    'GET /access-devices': page([
      device(),
      device({
        id: DEVICE_B_ID,
        name: 'Back door',
        kind: 'door',
        providerDeviceRef: 'DR-0002',
        health: 'offline',
        lastHeartbeatAt: '2026-10-24T09:00:00.000Z',
        activePolicyId: null,
      }),
    ]),
    'GET /access-devices/{id}/policies': ok([policy()]),
    'GET /access-devices/{id}/commands': page([deviceCommand()]),
    'GET /exceptions': page([]),
    ...extra,
  };
}

async function chooseFacility(user: ReturnType<typeof userEvent.setup>) {
  const devices = await screen.findByRole('region', { name: 'Devices' });
  await within(devices).findByRole('option', { name: 'North Park' });
  await user.selectOptions(within(devices).getByLabelText(/^Devices at/), FACILITY_A);
}

describe('SCR-S-56 AccessHardwareScreen', () => {
  it('DEC-016: opens from Administration turned off; devices stay readable and nothing new is registered', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: { ...routes(), 'GET /me/permissions': permissions([], HARDWARE) },
    });
    render(app.at('/admin'));
    await user.click(await screen.findByRole('link', { name: /Access hardware \(conditional\)/ }));
    const pageEl = await screen.findByTestId('package-g-access-hardware');
    expect(pageEl).toHaveAccessibleName('Access hardware');
    const notice = await within(pageEl).findByTestId('state-turned-off');
    expect(notice).toHaveTextContent('Access hardware turned off');
    expect(notice).toHaveTextContent(
      `(${CAPABILITY_PRESENTATION.access_hardware.decisions.join(', ')})`,
    );
    await chooseFacility(user);
    expect(await screen.findByRole('list', { name: 'Access devices' })).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Register a device' })).toBeNull();
    expect(pageEl).toHaveTextContent('never attendance, a check-in or pickup authority');
  });

  it('SPK-COND-004: lists health with the outage age and deny-all devices', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: routes() });
    render(app.at(BASE));
    await chooseFacility(user);
    const list = await screen.findByRole('list', { name: 'Access devices' });
    const [first, second] = within(list).getAllByRole('listitem');
    expect(first).toHaveTextContent('online');
    expect(first).toHaveTextContent('Last heartbeat 2 minutes ago.');
    expect(first).toHaveTextContent('An approved policy is in force.');
    expect(second).toHaveTextContent('offline: outage');
    expect(second).toHaveTextContent('Last heartbeat 3 hours ago.');
    expect(second).toHaveTextContent('Deny-all: no approved policy.');
    const call = app.fake.requests.find((r) => r.route === '/access-devices');
    expect(call?.query).toMatchObject({ facilityId: FACILITY_A, status: 'active' });
  });

  it('registers a device sent deny-all, with no heartbeat timeout assumed', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /access-devices': ok(
          device({ id: DEVICE_B_ID, name: 'Gym door', activePolicyId: null }),
          201,
        ),
      }),
    });
    render(app.at(BASE));
    await chooseFacility(user);
    const form = await screen.findByRole('form', { name: 'Register a device' });
    expect(form).toHaveTextContent('A new device is sent deny-all');
    await user.selectOptions(within(form).getByLabelText(/^Kind/), 'door');
    await user.type(within(form).getByLabelText(/^Device name/), 'Gym door');
    await user.type(within(form).getByLabelText(/^Provider device reference/), 'DR-0009');
    await user.click(within(form).getByRole('button', { name: 'Register the device' }));
    expect(await within(form).findByRole('status')).toHaveTextContent(
      'Gym door registered and sent deny-all.',
    );
    const call = app.fake.requests.find(
      (r) => r.method === 'POST' && r.route === '/access-devices',
    );
    expect(call?.body).toEqual({
      facilityId: FACILITY_A,
      kind: 'door',
      name: 'Gym door',
      providerDeviceRef: 'DR-0009',
    });
    expect(call?.headers['idempotency-key']).toMatch(/^key-/);
  });

  it('a provider reference already registered is refused with what to check', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /access-devices': apiError(409, 'RESOURCE_CONFLICT', {
          message: 'A device with this provider reference is already registered.',
          nextAction: 'resolve_conflict',
          details: { code: 'device_ref_in_use', providerDeviceRef: 'TS-0001' },
        }),
      }),
    });
    render(app.at(BASE));
    await chooseFacility(user);
    const form = await screen.findByRole('form', { name: 'Register a device' });
    await user.selectOptions(within(form).getByLabelText(/^Kind/), 'turnstile');
    await user.type(within(form).getByLabelText(/^Device name/), 'Copy');
    await user.type(within(form).getByLabelText(/^Provider device reference/), 'TS-0001');
    await user.type(within(form).getByLabelText(/^Heartbeat timeout in seconds/), '0');
    await user.click(within(form).getByRole('button', { name: 'Register the device' }));
    expect(within(form).getByText('Enter whole seconds from 1 to 86400.')).toBeInTheDocument();
    const timeout = within(form).getByLabelText(/^Heartbeat timeout in seconds/);
    await user.clear(timeout);
    await user.type(timeout, '120');
    await user.click(within(form).getByRole('button', { name: 'Register the device' }));
    expect(await within(form).findByTestId('state-validation')).toHaveTextContent(
      'This provider device reference is already registered',
    );
  });

  it('recovery required: lists every hardware exception category with the owner queue the API recorded', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /exceptions': page([
          hardwareException({
            id: EXCEPTION_ID,
            category: 'entry.device_command_undelivered',
            title: 'A device command was not delivered after repeated attempts',
            affected: { type: 'device_command', id: COMMAND_ID },
          }),
          hardwareException({
            id: '0192f1a0-0000-7000-8000-00000000b302',
            category: 'entry.device_offline',
            title: 'An access device stopped sending heartbeats',
            affected: { type: 'access_device', id: DEVICE_B_ID },
            status: 'acknowledged',
          }),
          hardwareException({
            id: '0192f1a0-0000-7000-8000-00000000b303',
            category: 'entry.unregistered_access_device',
            title: 'Access events arrive from a device that is not registered (or is retired) here',
            affected: { type: 'access_device_ref', id: 'TS-0099' },
          }),
          hardwareException({
            id: '0192f1a0-0000-7000-8000-00000000b304',
            category: 'entry.access_outcome_unknown',
            title: 'An access device reported an unknown outcome; arrivals may be missing',
            affected: { type: 'access_device', id: 'TS-0001' },
            ownerQueue: 'front_desk',
          }),
          hardwareException({
            id: '0192f1a0-0000-7000-8000-00000000b305',
            category: 'finance.payment_outcome_unknown',
            title: 'A payment outcome is unknown',
            ownerQueue: 'finance_operator',
          }),
        ]),
      }),
    });
    render(app.at(BASE));
    await chooseFacility(user);
    const list = await screen.findByRole('list', { name: 'Unresolved hardware exceptions' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(4);
    expect(within(list).queryByText('A payment outcome is unknown')).toBeNull();
    const [undelivered, offline, unregistered, unknown] = rows;
    expect(undelivered).toHaveTextContent('Recovery required: high');
    expect(undelivered).toHaveTextContent('Command not delivered');
    expect(undelivered).toHaveTextContent('Owner: Facilities operator queue.');
    expect(
      within(undelivered!).getByRole('link', {
        name: 'A device command was not delivered after repeated attempts',
      }),
    ).toHaveAttribute('href', `/today/exceptions/${EXCEPTION_ID}`);
    expect(offline).toHaveTextContent('Device offline');
    expect(offline).toHaveTextContent('acknowledged');
    // The inventory's "events not ingested with owner".
    expect(unregistered).toHaveTextContent(
      'Events not ingested: the device is not registered here',
    );
    expect(unregistered).toHaveTextContent('Owner: Facilities operator queue.');
    // The API files an unknown access outcome to the facility operations queue, not a client default.
    expect(unknown).toHaveTextContent('Access outcome unknown: arrivals may be missing');
    expect(unknown).toHaveTextContent('Owner: Front desk queue.');
    const call = app.fake.requests.find((r) => r.route === '/exceptions');
    expect(call?.query).toMatchObject({ facilityId: FACILITY_A });
    expect(call?.query).not.toHaveProperty('queue');
    expect(call?.query).not.toHaveProperty('status');
  });

  it('with no hardware exception on the loaded pages, says so instead of implying none exist', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /exceptions': page(
          [hardwareException({ category: 'finance.payment_outcome_unknown' })],
          'cursor-2',
        ),
      }),
    });
    render(app.at(BASE));
    await chooseFacility(user);
    expect(
      await screen.findByText('No unresolved hardware exception on the loaded pages.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Load more/ })).toBeInTheDocument();
  });

  it('event ingestion: lists the access events the inbox received; failed and dead ones were not ingested', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /me/permissions': permissions(['access_hardware'], [...HARDWARE, VIEW_EVENTS]),
        'GET /provider-events': page([
          providerEvent({ eventType: 'access.granted', status: 'processed' }),
          providerEvent({
            id: '0192f1a0-0000-7000-8000-00000000b502',
            providerEventId: 'evt-2',
            eventType: 'access.unknown',
            status: 'dead',
            attempts: 5,
            lastError: 'handler entry.access_control failed',
          }),
          providerEvent({
            id: '0192f1a0-0000-7000-8000-00000000b503',
            provider: 'fake-payments',
            providerEventId: 'pay-1',
            eventType: 'payment.succeeded',
          }),
        ]),
      }),
    });
    render(app.at(BASE));
    await chooseFacility(user);
    const list = await screen.findByRole('list', { name: 'Access events received' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Access granted (access.granted)');
    expect(rows[0]).toHaveTextContent('processed');
    expect(rows[1]).toHaveTextContent('dead: retries exhausted');
    expect(rows[1]).toHaveTextContent('Not ingested: retries are exhausted');
    expect(rows[1]).toHaveTextContent('Last error: handler entry.access_control failed');
    expect(within(list).queryByText(/payment\.succeeded/)).toBeNull();
    await user.selectOptions(screen.getByLabelText('Event type'), 'access.unknown');
    await user.selectOptions(screen.getByLabelText('Event status'), 'dead');
    await waitFor(() =>
      expect(
        app.fake.requests.some(
          (r) =>
            r.route === '/provider-events' &&
            r.query.eventType === 'access.unknown' &&
            r.query.status === 'dead',
        ),
      ).toBe(true),
    );
  });

  it('event ingestion is not read without core.view_provider_events and names the permission', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: routes() });
    render(app.at(BASE));
    await chooseFacility(user);
    expect(
      await screen.findByText(
        'Reading the events devices send needs the permission core.view_provider_events.',
      ),
    ).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.route === '/provider-events')).toBe(false);
  });

  it('a refused event read is "not available"; another read error shows its code', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const app = createTestApp({
      routes: routes({
        'GET /me/permissions': permissions(['access_hardware'], [...HARDWARE, VIEW_EVENTS]),
        'GET /provider-events': () => {
          calls += 1;
          return calls === 1
            ? fakeResponse(503, {
                code: 'INTEGRATION_UNAVAILABLE',
                message: 'Unavailable.',
                correlationId: 'c-evt',
                nextAction: 'retry_later',
              })
            : fakeResponse(403, {
                code: 'ACCESS_DENIED',
                message: 'Not permitted.',
                correlationId: 'c-evt2',
                nextAction: 'contact_support_or_request_access',
              });
        },
      }),
    });
    render(app.at(BASE));
    await chooseFacility(user);
    const panel = await screen.findByRole('region', { name: 'Event ingestion' });
    expect(
      await within(panel).findByText('Error code: INTEGRATION_UNAVAILABLE. Reference: c-evt'),
    ).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Try again' }));
    expect(await within(panel).findByTestId('state-unavailable')).toHaveTextContent(
      'Not available',
    );
    expect(within(panel).queryByRole('list', { name: 'Access events received' })).toBeNull();
  });

  it('a device shows its outage with age; renaming sends the revision it was read at', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'PATCH /access-devices/{id}': ok(device({ name: 'Back door east', revision: 3 })),
      }),
    });
    render(app.at(`${BASE}/facilities/${FACILITY_A}/devices/${DEVICE_B_ID}`));
    const outage = await screen.findByTestId('state-device-outage');
    expect(outage).toHaveTextContent('the last one was 3 hours ago');
    // SPK-SCHED-008: once the facility directory answers, the time is the facility's, named.
    await waitFor(() => expect(outage).toHaveTextContent('02:00 AM PDT'));
    const facts = screen.getByLabelText('Access device');
    expect(within(facts).getByText('Deny-all: no approved policy')).toBeInTheDocument();
    const form = screen.getByRole('form', { name: 'Change the device' });
    const name = within(form).getByLabelText(/^Device name/);
    await user.clear(name);
    await user.type(name, 'Back door east');
    const timeout = within(form).getByLabelText(/^Heartbeat timeout in seconds/);
    await user.clear(timeout);
    await user.click(within(form).getByRole('button', { name: 'Save the device' }));
    expect(await within(form).findByRole('status')).toHaveTextContent('Device saved.');
    const call = app.fake.requests.find((r) => r.route === '/access-devices/{id}');
    // Clearing the timeout sends null: outages are then not detected.
    expect(call?.body).toEqual({
      name: 'Back door east',
      heartbeatTimeoutSeconds: null,
      expectedRevision: 2,
    });
  });

  it('retires a device with a reason and its revision, even while the switch is off', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /me/permissions': permissions([], HARDWARE),
        'POST /access-devices/{id}/retire': ok(device({ status: 'retired' })),
      }),
    });
    render(app.at(DEVICE_PATH));
    expect(await screen.findByTestId('state-turned-off')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Retire the device' }));
    expect(screen.queryByRole('form', { name: 'Change the device' })).toBeNull();
    const form = screen.getByRole('form', { name: 'Retire the device' });
    await user.type(within(form).getByLabelText(/^Reason for retiring/), 'Replaced');
    await user.click(within(form).getByRole('button', { name: 'Retire the device' }));
    await waitFor(() =>
      expect(app.fake.requests.some((r) => r.route === '/access-devices/{id}/retire')).toBe(true),
    );
    const call = app.fake.requests.find((r) => r.route === '/access-devices/{id}/retire');
    expect(call?.body).toEqual({ reason: 'Replaced', expectedRevision: 2 });
  });

  it('§4.9: a stale device retirement offers Reload; the next attempt sends the revision just read', async () => {
    const user = userEvent.setup();
    let changedElsewhere = false;
    let attempts = 0;
    const app = createTestApp({
      routes: routes({
        'GET /access-devices': () =>
          fakeResponse(200, {
            items: [device(changedElsewhere ? { revision: 3, name: 'Main gate east' } : {})],
            nextCursor: null,
          }),
        'POST /access-devices/{id}/retire': () => {
          attempts += 1;
          if (attempts === 1) {
            changedElsewhere = true;
            return fakeResponse(409, {
              code: 'STALE_REVISION',
              message: 'The device changed since it was read.',
              correlationId: 'c-stale',
              nextAction: 'reload_current_state',
            });
          }
          return fakeResponse(200, device({ status: 'retired', revision: 4 }));
        },
      }),
    });
    render(app.at(DEVICE_PATH));
    await user.click(await screen.findByRole('button', { name: 'Retire the device' }));
    const form = screen.getByRole('form', { name: 'Retire the device' });
    await user.type(within(form).getByLabelText(/^Reason for retiring/), 'Replaced');
    await user.click(within(form).getByRole('button', { name: 'Retire the device' }));
    const stale = await screen.findByTestId('state-stale');
    expect(stale).toHaveTextContent('Error code: STALE_REVISION. Reference: c-stale');
    const reads = app.fake.requests.filter((r) => r.route === '/access-devices').length;
    await user.click(within(stale).getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(screen.queryByTestId('state-stale')).toBeNull());
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.route === '/access-devices').length).toBeGreaterThan(
        reads,
      ),
    );
    // The device was read again (renamed meanwhile, revision 3); the reason form keeps its text.
    expect(await screen.findByRole('heading', { name: 'Main gate east' })).toBeVisible();
    const again = screen.getByRole('form', { name: 'Retire the device' });
    expect(within(again).getByLabelText(/^Reason for retiring/)).toHaveValue('Replaced');
    await user.click(within(again).getByRole('button', { name: 'Retire the device' }));
    await waitFor(() => expect(attempts).toBe(2));
    const [first, second] = app.fake.requests.filter(
      (r) => r.route === '/access-devices/{id}/retire',
    );
    expect(first?.body).toEqual({ reason: 'Replaced', expectedRevision: 2 });
    expect(second?.body).toEqual({ reason: 'Replaced', expectedRevision: 3 });
  });

  it('§4.14: the device’s audit history is read only when asked, once, by target', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /me/permissions': permissions(['access_hardware'], [...HARDWARE, VIEW_AUDIT]),
        'GET /audit-records': page([
          auditRecord(),
          auditRecord({
            id: '0192f1a0-0000-7000-8000-00000000b602',
            action: 'entry.access_device_health',
            actor: {
              kind: 'system',
              accountId: null,
              personId: null,
              staffRoles: [],
              sessionId: null,
              actorLabel: 'entry.detect_device_outages',
            },
            beforeRevision: null,
            afterRevision: null,
            correlationId: null,
            details: { health: 'offline' },
          }),
        ]),
      }),
    });
    render(app.at(DEVICE_PATH));
    const show = await screen.findByRole('button', {
      name: 'Show audit history of Main gate turnstile',
    });
    expect(show).toHaveAttribute('aria-expanded', 'false');
    expect(app.fake.requests.some((r) => r.route === '/audit-records')).toBe(false);
    await user.click(show);
    const list = await screen.findByRole('list', {
      name: 'Audit history of Main gate turnstile',
    });
    const [change, health] = within(list).getAllByRole('listitem');
    expect(change).toHaveTextContent('entry.update_access_device');
    expect(change).toHaveTextContent('by Dana Cole · revision 1 to 2');
    // SPK-SCHED-008: the facility's zone, once the facility directory answers.
    await waitFor(() => expect(change).toHaveTextContent('03:00 AM PDT'));
    expect(health).toHaveTextContent('entry.access_device_health');
    expect(health).toHaveTextContent('by entry.detect_device_outages');
    expect(screen.getByText(/Reading the audit is itself audited/)).toBeInTheDocument();
    const calls = app.fake.requests.filter((r) => r.route === '/audit-records');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.query).toMatchObject({ targetType: 'access_device', targetId: DEVICE_ID });
    expect(
      screen.getByRole('button', { name: 'Hide audit history of Main gate turnstile' }),
    ).toHaveAttribute('aria-expanded', 'true');
  });

  it('the audit history is not offered without core.view_audit; a refused read is "not available"', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: routes() });
    const view = render(app.at(DEVICE_PATH));
    await screen.findByRole('form', { name: 'Change the device' });
    expect(screen.queryByRole('button', { name: /audit history/ })).toBeNull();
    view.unmount();
    const allowed = createTestApp({
      routes: routes({
        'GET /me/permissions': permissions(['access_hardware'], [...HARDWARE, VIEW_AUDIT]),
        'GET /audit-records': apiError(403, 'ACCESS_DENIED', {
          nextAction: 'contact_support_or_request_access',
        }),
      }),
    });
    render(allowed.at(DEVICE_PATH));
    await user.click(
      await screen.findByRole('button', { name: 'Show audit history of Main gate turnstile' }),
    );
    expect(await screen.findByTestId('state-unavailable')).toHaveTextContent('Not available');
  });

  it('four eyes: drafts a policy in facility time; its author is told another person approves it', async () => {
    const user = userEvent.setup();
    let drafted = false;
    const draft = policy({
      id: POLICY_B_ID,
      status: 'draft',
      authoredByPersonId: ME_PERSON,
      approvedByPersonId: null,
      approvedAt: null,
      allowedHolderKinds: ['person', 'household'],
      schedule: [{ days: ['sat', 'sun'], from: '08:00', to: '20:00' }],
      revision: 1,
    });
    const app = createTestApp({
      routes: routes({
        'GET /access-devices/{id}/policies': () =>
          fakeResponse(200, drafted ? [policy(), draft] : [policy()]),
        'POST /access-devices/{id}/policies': () => {
          drafted = true;
          return fakeResponse(201, draft);
        },
      }),
    });
    render(app.at(DEVICE_PATH));
    const form = await screen.findByRole('form', { name: 'Draft an access policy' });
    await waitFor(() => expect(form).toHaveTextContent('Times are Pacific Daylight Time.'));
    await user.click(within(form).getByLabelText('Personal passes'));
    await user.click(within(form).getByLabelText('Household passes'));
    const window1 = within(form).getByRole('group', { name: 'Window 1' });
    await user.click(within(window1).getByLabelText('Saturday'));
    await user.click(within(window1).getByLabelText('Sunday'));
    await user.type(within(window1).getByLabelText(/^Window 1 from/), '20:00');
    await user.type(within(window1).getByLabelText(/^Window 1 to/), '08:00');
    await user.click(within(form).getByRole('button', { name: 'Save the draft' }));
    expect(within(form).getByText('The window ends after it starts.')).toBeInTheDocument();
    await user.clear(within(window1).getByLabelText(/^Window 1 from/));
    await user.type(within(window1).getByLabelText(/^Window 1 from/), '08:00');
    await user.clear(within(window1).getByLabelText(/^Window 1 to/));
    await user.type(within(window1).getByLabelText(/^Window 1 to/), '20:00');
    await user.click(within(form).getByRole('button', { name: 'Save the draft' }));
    expect(await within(form).findByRole('status')).toHaveTextContent('Draft');
    const call = app.fake.requests.find(
      (r) => r.method === 'POST' && r.route === '/access-devices/{id}/policies',
    );
    expect(call?.body).toEqual({
      allowedHolderKinds: ['person', 'household'],
      schedule: [{ days: ['sat', 'sun'], from: '08:00', to: '20:00' }],
    });
    const policies = await screen.findByRole('list', { name: 'Access policies' });
    await within(policies).findByText('draft: awaiting approval');
    expect(
      within(policies).getByText(
        'You drafted this policy: another person approves it (four eyes).',
      ),
    ).toBeInTheDocument();
    expect(within(policies).queryByRole('button', { name: /^Approve policy/ })).toBeNull();
  });

  it('SPK-UX-009: each window problem is reported on the control that has it', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: routes() });
    render(app.at(DEVICE_PATH));
    const form = await screen.findByRole('form', { name: 'Draft an access policy' });
    await user.click(within(form).getByLabelText('Personal passes'));
    const window1 = within(form).getByRole('group', { name: 'Window 1' });
    await user.type(within(window1).getByLabelText(/^Window 1 from/), '6am');
    await user.type(within(window1).getByLabelText(/^Window 1 to/), '22:00');
    await user.click(within(form).getByRole('button', { name: 'Save the draft' }));
    const days = within(window1).getByRole('group', { name: 'Days of window 1' });
    expect(days).toHaveAttribute('aria-invalid', 'true');
    expect(days).toHaveAccessibleDescription('Choose at least one day.');
    const from = within(window1).getByLabelText(/^Window 1 from/);
    expect(from).toHaveAttribute('aria-invalid', 'true');
    expect(from).toHaveAccessibleDescription(/Enter the start as HH:MM\./);
    expect(within(window1).getByLabelText(/^Window 1 to/)).not.toHaveAttribute('aria-invalid');
    expect(
      app.fake.requests.some(
        (r) => r.method === 'POST' && r.route === '/access-devices/{id}/policies',
      ),
    ).toBe(false);
  });

  it('approves another person’s draft with its revision; the API’s four-eyes refusal is explained', async () => {
    const user = userEvent.setup();
    const draft = policy({
      id: POLICY_B_ID,
      status: 'draft',
      authoredByPersonId: '0192f1a0-0000-7000-8000-000000000303',
      approvedByPersonId: null,
      approvedAt: null,
      revision: 1,
    });
    const app = createTestApp({
      routes: routes({
        'GET /access-devices/{id}/policies': ok([policy(), draft]),
        'POST /access-policies/{id}/approve': apiError(403, 'ACCESS_DENIED', {
          message: 'The author of an access policy cannot approve it (four eyes).',
          nextAction: 'contact_support_or_request_access',
          details: { code: 'author_cannot_approve' },
        }),
      }),
    });
    render(app.at(DEVICE_PATH));
    const policies = await screen.findByRole('list', { name: 'Access policies' });
    expect(within(policies).getAllByText(/Drafted by/)).toHaveLength(2);
    await user.click(
      within(policies).getByRole('button', { name: `Approve policy ${POLICY_B_ID.slice(0, 8)}` }),
    );
    expect(await within(policies).findByTestId('state-validation')).toHaveTextContent(
      'Another person approves this policy',
    );
    const call = app.fake.requests.find((r) => r.route === '/access-policies/{id}/approve');
    expect(call?.params.id).toBe(POLICY_B_ID);
    expect(call?.body).toEqual({ expectedRevision: 1 });
  });

  it('retiring the active policy says the device is sent deny-all without a replacement', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /access-policies/{id}/retire': ok(policy({ status: 'retired' })),
      }),
    });
    render(app.at(DEVICE_PATH));
    const policies = await screen.findByRole('list', { name: 'Access policies' });
    await user.click(
      within(policies).getByRole('button', { name: `Retire policy ${POLICY_ID.slice(0, 8)}` }),
    );
    const form = within(policies).getByRole('form', {
      name: `Retire policy ${POLICY_ID.slice(0, 8)}`,
    });
    expect(form).toHaveTextContent('the device is sent deny-all');
    await user.type(within(form).getByLabelText(/^Reason/), 'Season over');
    await user.click(within(form).getByRole('button', { name: 'Retire the policy' }));
    await waitFor(() =>
      expect(app.fake.requests.some((r) => r.route === '/access-policies/{id}/retire')).toBe(true),
    );
    const call = app.fake.requests.find((r) => r.route === '/access-policies/{id}/retire');
    expect(call?.body).toEqual({ reason: 'Season over', expectedRevision: 2 });
  });

  it('lists the command queue with delivery outcomes; unknown ones are asked again by the API', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /access-devices/{id}/commands': page([
          deviceCommand(),
          deviceCommand({
            id: '0192f1a0-0000-7000-8000-00000000b202',
            kind: 'revoke_credential',
            policyId: null,
            passId: '0192f1a0-0000-7000-8000-00000000b401',
            status: 'unknown',
            attempts: 2,
            lastError: 'no answer from the device',
            deliveredAt: null,
          }),
        ]),
      }),
    });
    render(app.at(DEVICE_PATH));
    const table = await screen.findByRole('table', { name: 'Device commands' });
    expect(within(table).getByText('delivered')).toBeInTheDocument();
    expect(within(table).getByText('outcome unknown: asked again')).toBeInTheDocument();
    expect(within(table).getByText(/no answer from the device/)).toBeInTheDocument();
    expect(within(table).queryByRole('button')).toBeNull();
    await user.selectOptions(screen.getByLabelText('Show commands'), 'unknown');
    await waitFor(() =>
      expect(
        app.fake.requests.some(
          (r) => r.route === '/access-devices/{id}/commands' && r.query.status === 'unknown',
        ),
      ).toBe(true),
    );
  });

  it('a device change refused because the switch was turned off meanwhile shows "turned off"', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'PATCH /access-devices/{id}': () =>
          fakeResponse(403, capabilityDisabledBody('access_hardware', ['DEC-016', 'DEC-080'])),
      }),
    });
    render(app.at(DEVICE_PATH));
    const form = await screen.findByRole('form', { name: 'Change the device' });
    await user.type(within(form).getByLabelText(/^Device name/), ' 2');
    await user.click(within(form).getByRole('button', { name: 'Save the device' }));
    expect(await within(form).findByTestId('state-turned-off')).toHaveTextContent(
      'Access hardware turned off',
    );
  });

  it('§4.10: a device not in the facility’s list is "not available"; a malformed link names no record', async () => {
    const app = createTestApp({ routes: routes({ 'GET /access-devices': page([]) }) });
    const view = render(app.at(DEVICE_PATH));
    expect(await screen.findByTestId('state-unavailable')).toHaveTextContent('Not available');
    view.unmount();
    render(app.at(`${BASE}/facilities/${FACILITY_A}/devices/nope`));
    expect(await screen.findByText('Link not available')).toBeInTheDocument();
  });

  it('a refused device list is "not available" and lists nothing', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /access-devices': apiError(403, 'ACCESS_DENIED', {
          nextAction: 'contact_support_or_request_access',
        }),
      }),
    });
    render(app.at(BASE));
    await chooseFacility(user);
    expect(await screen.findByTestId('state-unavailable')).toHaveTextContent('Not available');
    expect(screen.queryByRole('list', { name: 'Access devices' })).toBeNull();
  });

  it('a failed device list read shows its code and "Try again", then the devices', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const app = createTestApp({
      routes: routes({
        'GET /access-devices': () => {
          calls += 1;
          return calls === 1
            ? fakeResponse(503, {
                code: 'INTEGRATION_UNAVAILABLE',
                message: 'Unavailable.',
                correlationId: 'c-dev',
                nextAction: 'retry_later',
              })
            : fakeResponse(200, { items: [device()], nextCursor: null });
        },
      }),
    });
    render(app.at(BASE));
    await chooseFacility(user);
    const devices = screen.getByRole('region', { name: 'Devices' });
    const code = await within(devices).findByText(
      'Error code: INTEGRATION_UNAVAILABLE. Reference: c-dev',
    );
    const state = code.closest('section');
    await user.click(within(state!).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('list', { name: 'Access devices' })).toBeInTheDocument();
  });
});
