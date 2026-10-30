/**
 * SCR-S-30 Supervised release: SPK-AT-016 (an adult who may pay but may not collect is denied,
 * with the API's reason and the permissions held as evidence), SPK-ENTRY-007 (authority checked
 * online at release, record fields shown; from a session, the collector is checked first with
 * the read-only collector check and the record names the grant relied on), §4.15 (offline
 * release unavailable; the outage procedure is pending DEC-005/DEC-034, cached authority never
 * asserted).
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ADULT,
  CHILD_1,
  OFFERING,
  PASS,
  SESSION_1,
  VISIT_1,
  actor,
  nameEntry,
  oneFacilityMe,
  personNames,
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
    'GET /person-names': personNames([
      nameEntry(CHILD_1, 'Alex', 'Rivera'),
      nameEntry(ADULT, 'Sam', 'Rivera', 'adult'),
    ]),
    'GET /sessions': { status: 200, body: { items: [], nextCursor: null } },
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

  it('keeps the release record once the departure closes the visit and the child leaves the on-site list', async () => {
    const user = userEvent.setup();
    let released = false;
    const app = createTestApp({
      routes: routes({
        // The release records the departure: the child is no longer on site afterwards.
        'GET /visits': () =>
          fakeResponse(200, {
            items: released ? [] : [visit(VISIT_1, CHILD_1)],
            nextCursor: null,
          }),
        'POST /releases': () => {
          released = true;
          return fakeResponse(201, release('verified'));
        },
      }),
    });
    render(app.at('/arrival/release'));
    await identifyAndChoose(user);
    await user.click(screen.getByRole('button', { name: 'Check authority and release' }));
    expect(await screen.findByText('Released to Sam Rivera')).toBeInTheDocument();
    // The on-site read is refetched after the release and no longer lists the child.
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.route === '/visits').length).toBeGreaterThan(1),
    );
    expect(await screen.findByText('No children awaiting release')).toBeInTheDocument();
    const record = screen.getByRole('listitem', { name: 'Release record for Alex Rivera' });
    expect(within(record).getByText('Released to Sam Rivera')).toBeInTheDocument();
    expect(within(record).getByText(/Checked .*05:00 (PDT|GMT-7)/)).toBeInTheDocument();
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

  describe('from a session (collector check first, ENT-02)', () => {
    const GRANT = '0192f1a0-0000-7000-8000-0000000000b9';
    const sessionRoutes = (extra: Record<string, FakeHandler> = {}) =>
      routes({
        'GET /sessions': {
          status: 200,
          body: {
            items: [
              {
                sessionId: SESSION_1,
                offeringId: OFFERING,
                offeringName: 'Junior skills',
                sequence: 1,
                title: null,
                scheduledStart: '2026-10-24T16:00:00.000Z',
                scheduledEnd: '2026-10-24T17:00:00.000Z',
                status: 'scheduled',
                facilityId: FACILITY_A,
                timezone: 'America/Los_Angeles',
              },
            ],
            nextCursor: null,
          },
        },
        'GET /attendance': {
          status: 200,
          body: {
            activity: {
              type: 'session',
              id: SESSION_1,
              offeringId: OFFERING,
              sessionId: SESSION_1,
              eventId: null,
            },
            people: [
              {
                personId: CHILD_1,
                givenName: 'Alex',
                familyName: 'Rivera',
                displayName: 'Alex Rivera',
                effectiveState: 'present',
                status: 'recorded',
                currentObservationIds: [],
                history: [],
              },
            ],
          },
        },
        ...extra,
      });

    async function chooseSessionChild(user: ReturnType<typeof userEvent.setup>) {
      const from = await screen.findByLabelText('Release from');
      await waitFor(() =>
        expect(
          within(from).getByRole('option', { name: /Junior skills, session 1/ }),
        ).toBeInTheDocument(),
      );
      await user.selectOptions(from, SESSION_1);
      await user.click(await screen.findByRole('radio', { name: 'Alex Rivera' }));
    }

    it('SPK-ENTRY-007: names the collector the check confirms, then records the release with the grant relied on', async () => {
      const user = userEvent.setup();
      const app = createTestApp({
        routes: sessionRoutes({
          'POST /releases/collector-checks': {
            status: 200,
            body: {
              mayCollect: true,
              collector: { personId: ADULT, displayName: 'Sam Rivera' },
              checkedAt: '2026-10-24T12:00:00.000Z',
              restrictions: [
                {
                  code: 'authority_rechecked_at_release',
                  message: 'Pickup authority is checked again when the release is recorded.',
                },
              ],
            },
          },
          'POST /releases': {
            status: 201,
            body: release('verified', {
              authorityGrantId: GRANT,
              activity: {
                type: 'session',
                id: SESSION_1,
                offeringId: OFFERING,
                sessionId: SESSION_1,
                eventId: null,
              },
            }),
          },
        }),
      });
      render(app.at('/arrival/release'));
      await chooseSessionChild(user);
      const group = screen.getByRole('group', { name: 'Collecting person for Alex Rivera' });
      await user.type(
        within(group).getByLabelText("Collecting person's pass reference"),
        'spp_0123456789abcdef',
      );
      await user.click(within(group).getByRole('button', { name: 'Check the collector' }));
      expect(await screen.findByText('May collect: Sam Rivera')).toBeInTheDocument();
      expect(screen.getByText(/checked again when the release is recorded/)).toBeInTheDocument();
      // SPK-SCHED-008: the check and the confirmation use the facility zone, as the record does.
      expect(screen.getByTestId('collector-check')).toHaveTextContent(
        /Checked .*05:00 (PDT|GMT-7)/,
      );
      expect(screen.getByText(/Collector confirmed at .*05:00 (PDT|GMT-7)/)).toBeInTheDocument();
      // Read-only: the reference travels in the body, nothing is recorded yet.
      const check = app.fake.requests.find((r) => r.route === '/releases/collector-checks');
      expect(check?.body).toEqual({
        activity: { type: 'session', offeringId: OFFERING, sessionId: SESSION_1 },
        participantPersonId: CHILD_1,
        passReference: 'spp_0123456789abcdef',
      });
      expect(check?.path).not.toContain('spp_');
      expect(app.fake.requests.some((r) => r.route === '/releases')).toBe(false);

      await user.click(screen.getByRole('button', { name: 'Check authority and release' }));
      expect(await screen.findByText('Released to Sam Rivera')).toBeInTheDocument();
      expect(screen.getByTestId('authority-grant')).toHaveTextContent(
        'Authority relied on: collect permission, grant ref 0192f1a0.',
      );
      const post = app.fake.requests.find((r) => r.route === '/releases');
      expect(post?.body).toMatchObject({
        childPersonId: CHILD_1,
        collector: { personId: ADULT },
        activity: { type: 'session', offeringId: OFFERING, sessionId: SESSION_1 },
      });
    });

    it('SPK-AT-016: a pass that does not confirm authority names nobody; the release is recorded as denied', async () => {
      const user = userEvent.setup();
      const app = createTestApp({
        routes: sessionRoutes({
          'POST /releases/collector-checks': {
            status: 200,
            body: {
              mayCollect: false,
              collector: null,
              checkedAt: '2026-10-24T12:00:00.000Z',
              restrictions: [],
            },
          },
          'POST /releases': {
            status: 201,
            body: release('denied', {
              collectorPersonId: null,
              collectorDescription: 'Adult with a payer pass',
              collectorPermissions: [],
            }),
          },
        }),
      });
      render(app.at('/arrival/release'));
      await chooseSessionChild(user);
      const group = screen.getByRole('group', { name: 'Collecting person for Alex Rivera' });
      await user.type(
        within(group).getByLabelText("Collecting person's pass reference"),
        'spp_0123456789abcdef',
      );
      await user.click(within(group).getByRole('button', { name: 'Check the collector' }));
      expect(await screen.findByText('Not confirmed to collect Alex Rivera')).toBeInTheDocument();
      // Nothing about the pass or its holder is revealed.
      expect(screen.queryByText(/Sam/)).toBeNull();
      await user.click(screen.getByRole('button', { name: 'Check authority and release' }));
      expect(screen.getByText(/The checked pass does not confirm a collector/)).toBeInTheDocument();
      expect(app.fake.requests.some((r) => r.route === '/releases')).toBe(false);
      await user.type(
        within(group).getByLabelText('Or describe a collector without a pass'),
        'Adult with a payer pass',
      );
      await user.click(within(group).getByRole('button', { name: 'Use this description' }));
      await user.click(screen.getByRole('button', { name: 'Check authority and release' }));
      const record = await screen.findByRole('listitem', {
        name: 'Release record for Alex Rivera',
      });
      expect(
        within(record).getByText('Release denied: not authorised to collect'),
      ).toBeInTheDocument();
      const post = app.fake.requests.find((r) => r.route === '/releases');
      expect(post?.body).toMatchObject({ collector: { description: 'Adult with a payer pass' } });
    });

    it('shows a refused collector check as not available with its code', async () => {
      const user = userEvent.setup();
      const app = createTestApp({
        routes: sessionRoutes({
          'POST /releases/collector-checks': {
            status: 403,
            body: apiErrorBody('ACCESS_DENIED', {
              message: 'You need entry.record_release here.',
              nextAction: 'contact_support_or_request_access',
            }),
          },
        }),
      });
      render(app.at('/arrival/release'));
      await chooseSessionChild(user);
      await user.type(
        screen.getByLabelText("Collecting person's pass reference"),
        'spp_0123456789abcdef',
      );
      await user.click(screen.getByRole('button', { name: 'Check the collector' }));
      const unavailable = await screen.findByTestId('command-unavailable');
      expect(unavailable).toHaveTextContent('Error code: ACCESS_DENIED');
    });
  });
});
