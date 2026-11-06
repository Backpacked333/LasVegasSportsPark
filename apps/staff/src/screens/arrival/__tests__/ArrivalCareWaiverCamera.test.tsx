/**
 * SCR-S-28 additions: care notes on the scan (SPK-ENTRY-004, §1.7, §4.14), the desk's actions on a
 * missing required form (SPK-REG-009: the guardian signs on this tablet, staff record the named
 * signer; send-link and override stay unavailable with their reasons), and camera scanning with
 * the browser's BarcodeDetector (no library; the reader and typed reference stay; DEC-023 pending).
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHECKIN_1,
  CHILD_1,
  SESSION_1,
  checkin,
  householdScan,
  oneFacilityMe,
} from '../../../features/operations/testing';
import { FACILITY_A, createTestApp, mePermissions } from '../../../testing/test-app';

const REFERENCE = 'spp_0123456789abcdef0123';
const POLICY = '0192f1a0-0000-7000-8000-0000000003a1';
const GUARDIAN = '0192f1a0-0000-7000-8000-0000000003b1';

function scanWithNotes(notes: unknown[] | null) {
  const body = householdScan();
  return {
    ...body,
    people: body.people.map((p) => ({
      ...p,
      careNotes: p.personId === CHILD_1 ? notes : notes === null ? null : [],
    })),
  };
}

const occupancy = {
  status: 200,
  body: {
    facilityId: FACILITY_A,
    window: { start: '2026-10-24T07:00:00.000Z', end: '2026-10-25T07:00:00.000Z' },
    evaluatedAt: '2026-10-24T12:00:00.000Z',
    arrivals: { people: 0, visits: 0 },
    departures: { people: 0, visits: 0 },
    recordedOnSite: 0,
    openFromEarlierDays: 0,
    occupancy: {
      status: 'unverified',
      verifiedOccupancy: null,
      reconciledAt: null,
      statement: 'Not verified.',
    },
    lastSnapshot: null,
  },
};

async function typeAndScan(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText('Pass reference'), REFERENCE);
  await user.click(screen.getByRole('button', { name: 'Open selection' }));
  return screen.findByRole('list', { name: 'People on this pass' });
}

describe('SCR-S-28 care notes on the scan', () => {
  beforeEach(() => window.localStorage.clear());

  it('SPK-ENTRY-004: shows the protected care note on the child it belongs to', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        'GET /me': oneFacilityMe(),
        'GET /facilities/{id}/occupancy': occupancy,
        'POST /passes/scan': {
          status: 200,
          body: scanWithNotes([
            { id: POLICY, kind: 'allergy', body: 'Peanuts: EpiPen in the kit bag' },
          ]),
        },
      },
    });
    render(app.at('/arrival'));
    const people = await typeAndScan(user);
    const alex = within(people).getByRole('listitem', { name: 'Alex Rivera' });
    const notes = within(alex).getByRole('list', { name: 'Care notes for Alex Rivera' });
    expect(within(notes).getByText(/Peanuts: EpiPen in the kit bag/)).toBeInTheDocument();
    expect(within(notes).getByText(/recorded in the audit log/)).toBeInTheDocument();
    const blake = within(people).getByRole('listitem', { name: 'Blake Rivera' });
    expect(within(blake).queryByRole('list', { name: /Care notes/ })).toBeNull();
  });

  it('§4.14: says care notes are not shown to a role the API gives none', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        'GET /me': oneFacilityMe(),
        'GET /facilities/{id}/occupancy': occupancy,
        'POST /passes/scan': { status: 200, body: scanWithNotes(null) },
      },
    });
    render(app.at('/arrival'));
    const people = await typeAndScan(user);
    const alex = within(people).getByRole('listitem', { name: 'Alex Rivera' });
    expect(within(alex).getByText('Care notes are not shown to your role.')).toBeInTheDocument();
  });
});

describe('SCR-S-28 missing form at the desk', () => {
  beforeEach(() => window.localStorage.clear());

  it('SPK-REG-009: the guardian signs on this tablet; staff record the named signer, then the check-in is checked again', async () => {
    const user = userEvent.setup();
    const held = checkin(CHECKIN_1, CHILD_1, SESSION_1, 'held', [
      {
        code: 'missing_acknowledgment',
        severity: 'blocking',
        message: 'A required form has not been acknowledged for this participant.',
        nextAction: 'complete_acknowledgment',
        reference: { type: 'policy_version', id: POLICY },
      },
    ]);
    const app = createTestApp({
      routes: {
        'GET /me': oneFacilityMe(),
        'GET /me/permissions': mePermissions({ actions: ['catalog.record_acknowledgment'] }),
        'GET /facilities/{id}/occupancy': occupancy,
        'POST /passes/scan': { status: 200, body: householdScan() },
        'POST /session-checkins': { status: 201, body: held },
        'POST /session-checkins/{id}/recheck': {
          status: 200,
          body: checkin(CHECKIN_1, CHILD_1, SESSION_1, 'admitted', [], 2),
        },
        'GET /policy-versions/{id}': {
          status: 200,
          body: {
            id: POLICY,
            kind: 'waiver',
            key: 'season-waiver',
            version: 1,
            title: '2026 season waiver',
            content: { text: 'I accept the risks of playing soccer.' },
            effectiveFrom: '2026-01-01T00:00:00.000Z',
            effectiveTo: null,
            approvalStatus: 'approved',
            approvedAt: '2026-01-01T00:00:00.000Z',
            retiredAt: null,
            retiredReason: null,
            revision: 1,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        },
        'GET /people/{id}': {
          status: 200,
          body: { id: CHILD_1, kind: 'child', givenName: 'Alex', familyName: 'Rivera' },
        },
        'GET /people/{id}/authority': {
          status: 200,
          body: {
            personId: CHILD_1,
            relationships: [],
            grants: [
              {
                grantId: '0192f1a0-0000-7000-8000-0000000003c1',
                relationshipId: '0192f1a0-0000-7000-8000-0000000003d1',
                relationshipKind: 'guardian',
                actorPersonId: GUARDIAN,
                actorDisplayName: 'Sam Rivera',
                subjectPersonId: CHILD_1,
                subjectDisplayName: 'Alex',
                permission: 'complete_forms',
                source: 'staff',
                effectiveFrom: '2026-01-01T00:00:00.000Z',
                effectiveTo: null,
                revokedAt: null,
                status: 'effective',
                underReview: false,
                revision: 1,
              },
            ],
            households: [],
            pendingInvitations: [],
            accountLinked: false,
            claims: [],
          },
        },
        'POST /acknowledgments': {
          status: 201,
          body: { id: '0192f1a0-0000-7000-8000-0000000003e1' },
        },
      },
    });
    render(app.at('/arrival'));
    await typeAndScan(user);
    await user.click(
      screen.getByRole('checkbox', { name: 'Check Alex Rivera in to Junior skills' }),
    );
    await user.click(screen.getByRole('button', { name: 'Record selected' }));
    const missing = await screen.findByRole('group', { name: 'Missing form' });
    expect(within(missing).getByText(/DEC-012, DEC-062/)).toBeInTheDocument();
    expect(within(missing).getByText(/No override is offered/)).toBeInTheDocument();
    await user.click(within(missing).getByRole('button', { name: 'Sign on this tablet' }));
    const tablet = await screen.findByRole('group', {
      name: 'Sign 2026 season waiver on this tablet',
    });
    expect(
      await within(tablet).findByText('I accept the risks of playing soccer.'),
    ).toBeInTheDocument();
    const signButton = within(tablet).getByRole('button', { name: 'Record signature' });
    expect(signButton).toBeDisabled();
    await user.selectOptions(await within(tablet).findByLabelText(/Who is signing/), GUARDIAN);
    await user.click(
      within(tablet).getByRole('checkbox', {
        name: 'Sam Rivera (guardian) read this form on this tablet and accepts it',
      }),
    );
    await user.click(signButton);
    await waitFor(() =>
      expect(app.fake.requests.some((r) => r.route === '/session-checkins/{id}/recheck')).toBe(
        true,
      ),
    );
    const ack = app.fake.requests.find((r) => r.route === '/acknowledgments');
    expect(ack?.body).toEqual({
      subjectPersonId: CHILD_1,
      policyVersionId: POLICY,
      signedByPersonId: GUARDIAN,
      evidence: { method: 'desk_tablet', signerPresent: true },
    });
    expect(ack?.headers['idempotency-key']).toMatch(/^key-/);
    expect(await screen.findByText('Checked in to Junior skills')).toBeInTheDocument();
  });
});

describe('SCR-S-28 camera scanning', () => {
  const stop = vi.fn();
  afterEach(() => {
    delete (window as unknown as { BarcodeDetector?: unknown }).BarcodeDetector;
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
    stop.mockReset();
  });

  it('falls back to the reader and the typed reference without a BarcodeDetector', async () => {
    const app = createTestApp({
      routes: { 'GET /me': oneFacilityMe(), 'GET /facilities/{id}/occupancy': occupancy },
    });
    render(app.at('/arrival'));
    expect(await screen.findByTestId('camera-unsupported')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Scan with camera/ })).toBeNull();
    expect(screen.getByLabelText('Pass reference')).toBeInTheDocument();
  });

  it('SPK-ENTRY-002: a code read by the camera opens the selection with the same scan command, and the camera stops', async () => {
    const user = userEvent.setup();
    class FakeDetector {
      detect() {
        return Promise.resolve([{ rawValue: REFERENCE }]);
      }
    }
    (window as unknown as { BarcodeDetector: unknown }).BarcodeDetector = FakeDetector;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: () => Promise.resolve({ getTracks: () => [{ stop }] }),
      },
    });
    const app = createTestApp({
      routes: {
        'GET /me': oneFacilityMe(),
        'GET /facilities/{id}/occupancy': occupancy,
        'POST /passes/scan': { status: 200, body: householdScan() },
      },
    });
    render(app.at('/arrival'));
    await user.click(await screen.findByRole('button', { name: /Scan with camera/ }));
    expect(
      await screen.findByRole('list', { name: 'People on this pass' }, { timeout: 3000 }),
    ).toBeInTheDocument();
    const scans = app.fake.requests.filter((r) => r.route === '/passes/scan');
    expect(scans).toHaveLength(1);
    expect(scans[0]?.body).toEqual({ reference: REFERENCE, facilityId: FACILITY_A });
    expect(stop).toHaveBeenCalled();
    expect(screen.queryByLabelText(/Camera view/)).toBeNull();
  });
});
