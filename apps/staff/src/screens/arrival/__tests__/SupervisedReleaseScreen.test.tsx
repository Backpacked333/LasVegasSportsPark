/**
 * SCR-S-30 Supervised release: SPK-AT-016 (an adult who may pay but may not collect is denied,
 * with the API's reason and the permissions held as evidence), SPK-ENTRY-007 (authority checked
 * online at release, record fields shown), §4.15 (offline release unavailable; the outage
 * procedure is pending DEC-005/DEC-034, cached authority never asserted).
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ADULT,
  CHILD_1,
  PASS,
  VISIT_1,
  actor,
  oneFacilityMe,
  person,
  scanPerson,
  visit,
} from '../../../features/operations/testing';
import { FACILITY_A, createTestApp } from '../../../testing/test-app';

const RELEASE_ID = '0192f1a0-0000-7000-8000-0000000000ab';

function release(outcome: 'verified' | 'denied', extra: Record<string, unknown> = {}) {
  const released = outcome === 'verified';
  return {
    release: {
      id: RELEASE_ID,
      facilityId: FACILITY_A,
      childPersonId: CHILD_1,
      collectorPersonId: ADULT,
      collectorDescription: null,
      activity: null,
      visitId: VISIT_1,
      verificationMethod: 'online_relationship_check',
      verificationOutcome: outcome,
      authorityBasis: released ? 'relationship_permission:collect' : null,
      authorityCheckedAt: '2026-10-24T12:00:00.000Z',
      collectorPermissions: released ? ['view', 'pay', 'collect'] : ['view', 'pay'],
      denialReason: released
        ? null
        : 'The collecting person does not hold current pickup (collect) permission for this child. They hold view, pay; schedule visibility and payment permission do not establish pickup authority.',
      restrictionNotes: null,
      escalationNotes: null,
      escalationExceptionId: released ? null : '0192f1a0-0000-7000-8000-0000000000ef',
      manualProcedureReference: null,
      postSyncAuthority: null,
      outcome: released ? 'released' : 'not_released',
      decidedAt: '2026-10-24T12:00:00.000Z',
      releasedAt: released ? '2026-10-24T12:00:00.000Z' : null,
      staffActor: actor(),
      source: 'online',
      receivedAt: '2026-10-24T12:00:00.000Z',
      ...extra,
    },
    departure: null,
  };
}

function routes(extra: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    'GET /me': oneFacilityMe(),
    'GET /visits': { status: 200, body: { items: [visit(VISIT_1, CHILD_1)], nextCursor: null } },
    'GET /people/{id}': (req) =>
      fakeResponse(
        200,
        req.params.id === CHILD_1
          ? person(CHILD_1, 'Alex', 'Rivera').body
          : person(req.params.id ?? '', 'Sam', 'Rivera', 'adult').body,
      ),
    'POST /passes/scan': {
      status: 200,
      body: {
        pass: { id: PASS, holderKind: 'person' },
        facilityId: FACILITY_A,
        scannedAt: '2026-10-24T12:00:00.000Z',
        window: { start: '2026-10-24T07:00:00.000Z', end: '2026-10-25T07:00:00.000Z' },
        // holderMayCollect is informational and is never shown as authority.
        people: [{ ...scanPerson(ADULT, 'Sam', 'adult', 'holder'), holderMayCollect: true }],
        recorded: 'nothing',
        nextAction: 'select_people_and_sessions',
      },
    },
    ...extra,
  };
}

async function identifyAndChoose(user: ReturnType<typeof userEvent.setup>) {
  await user.type(
    await screen.findByLabelText("Collecting person's pass reference"),
    'spp_0123456789abcdef',
  );
  await user.click(screen.getByRole('button', { name: 'Identify by pass' }));
  expect(await screen.findByTestId('collector')).toHaveTextContent('Collecting: Sam Rivera');
  await user.click(await screen.findByRole('radio', { name: 'Alex Rivera' }));
}

describe('SCR-S-30 SupervisedReleaseScreen', () => {
  beforeEach(() => window.localStorage.clear());

  it('SPK-AT-016: an adult who may pay but may not collect is denied, with the reason and evidence', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({ 'POST /releases': { status: 201, body: release('denied') } }),
    });
    render(app.at('/arrival/release'));
    await identifyAndChoose(user);
    // Cached authority from the scan is never asserted.
    expect(screen.queryByText(/may collect/i)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Check authority and release' }));

    const record = await screen.findByRole('listitem', { name: 'Release record for Alex Rivera' });
    expect(
      within(record).getByText('Release denied: not authorised to collect'),
    ).toBeInTheDocument();
    expect(within(record).getByText('Not released to Sam Rivera')).toBeInTheDocument();
    expect(
      within(record).getByText(/payment permission do not establish pickup authority/),
    ).toBeInTheDocument();
    expect(
      within(record).getByText(/Permissions the collector holds now: view, pay/),
    ).toBeInTheDocument();
    expect(
      within(record).getByText('Raised for follow-up in the Today workspace.'),
    ).toBeInTheDocument();

    const post = app.fake.requests.find((r) => r.route === '/releases');
    expect(post?.body).toEqual({
      facilityId: FACILITY_A,
      childPersonId: CHILD_1,
      collector: { personId: ADULT },
      decision: 'release',
      escalate: false,
      recordDeparture: true,
    });
    expect(post?.headers['idempotency-key']).toBeTruthy();
    // The child is still awaiting release.
    expect(screen.getByRole('radio', { name: 'Alex Rivera' })).toBeInTheDocument();
  });

  it('SPK-ENTRY-007: a verified release names the collector and leaves the waiting list', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({ 'POST /releases': { status: 201, body: release('verified') } }),
    });
    render(app.at('/arrival/release'));
    await identifyAndChoose(user);
    await user.click(screen.getByRole('checkbox', { name: /escalate under the pickup procedure/ }));
    await user.type(screen.getByLabelText('Escalation notes'), 'Call the guardian on file');
    await user.click(screen.getByRole('button', { name: 'Check authority and release' }));
    expect(await screen.findByText('Released to Sam Rivera')).toBeInTheDocument();
    expect(screen.getByText('Pickup authority verified')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('radio', { name: 'Alex Rivera' })).toBeNull());
    const post = app.fake.requests.find((r) => r.route === '/releases');
    expect(post?.body).toMatchObject({
      escalate: true,
      escalationNotes: 'Call the guardian on file',
    });
  });

  it('asks for the collecting person before checking authority, and restriction notes to withhold', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: routes() });
    render(app.at('/arrival/release'));
    await user.click(await screen.findByRole('radio', { name: 'Alex Rivera' }));
    await user.click(
      screen.getByRole('checkbox', { name: 'Withhold the release (a restriction or concern)' }),
    );
    await user.click(screen.getByRole('button', { name: 'Check authority and release' }));
    expect(
      screen.getByText('Identify the collecting person: scan their pass or describe them.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Say why the release is withheld.')).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.route === '/releases')).toBe(false);
  });

  it('shows the API’s permission restriction as not available', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /releases': {
          status: 403,
          body: apiErrorBody('ACCESS_DENIED', {
            message: 'You need entry.record_release in this facility.',
            nextAction: 'contact_support_or_request_access',
          }),
        },
      }),
    });
    render(app.at('/arrival/release'));
    await identifyAndChoose(user);
    await user.click(screen.getByRole('button', { name: 'Check authority and release' }));
    const unavailable = await screen.findByTestId('command-unavailable');
    expect(within(unavailable).getByText(/entry\.record_release/)).toBeInTheDocument();
    expect(within(unavailable).getByText('Error code: ACCESS_DENIED')).toBeInTheDocument();
  });

  it('§4.15: release is unavailable offline and the outage procedure is a pending decision', async () => {
    const app = createTestApp({ routes: routes() });
    render(app.at('/arrival/release'));
    await screen.findByRole('radio', { name: 'Alex Rivera' });
    act(() => app.connectivity.set(false));
    const offline = await screen.findByTestId('release-offline');
    expect(within(offline).getByText('Release needs a connection')).toBeInTheDocument();
    expect(within(offline).getByText(/DEC-005, DEC-034/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check authority and release' })).toBeNull();
  });

  it('says so when no child is awaiting release', async () => {
    const app = createTestApp({
      routes: routes({ 'GET /visits': { status: 200, body: { items: [], nextCursor: null } } }),
    });
    render(app.at('/arrival/release'));
    expect(await screen.findByText('No children awaiting release')).toBeInTheDocument();
  });
});
