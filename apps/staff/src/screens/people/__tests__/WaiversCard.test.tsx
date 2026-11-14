/**
 * Waivers on the person record (SPK-REG-011, proposed amendment PA-01; SPK-REG-009; capability
 * `liability_waivers`, DEC-095 pending).
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createTestApp, mePermissions } from '../../../testing/test-app';
import { PERSON_ID, person, timeline } from './fixtures';

const V3 = '0192f1a0-0000-7000-8000-0000000005a3';
const V4 = '0192f1a0-0000-7000-8000-0000000005a4';
const STAFF = '0192f1a0-0000-7000-8000-0000000005b1';
const GUARDIAN = '0192f1a0-0000-7000-8000-0000000005b2';
const SESSION = '0192f1a0-0000-7000-8000-0000000005c1';

const rule = { reacceptOnNewVersion: false, renewEveryMonths: 12, enforcement: 'block' };
const version = (id: string, n: number) => ({
  policyVersionId: id,
  version: n,
  title: 'Liability waiver',
  effectiveFrom: '2026-01-01T00:00:00.000Z',
});
const acceptance = (over: Record<string, unknown>) => ({
  acknowledgmentId: '0192f1a0-0000-7000-8000-0000000005d1',
  policyVersionId: V4,
  version: 4,
  subjectPersonId: PERSON_ID,
  signedByPersonId: PERSON_ID,
  basis: 'self',
  method: 'digital',
  signedAt: '2026-10-01T16:00:00.000Z',
  paperDatedOn: null,
  recordedByKind: 'customer',
  recordedByPersonId: null,
  acceptedAt: '2026-10-01T16:00:00.000Z',
  status: 'active',
  withdrawnAt: null,
  withdrawnReason: null,
  ...over,
});
const waiver = (over: Record<string, unknown>) => ({
  policyKey: 'liability',
  title: 'Liability waiver',
  status: 'current',
  reason: null,
  currentVersion: version(V4, 4),
  acceptance: null,
  validUntil: null,
  lapsedAt: null,
  rule,
  evaluatedAt: '2026-10-24T12:00:00.000Z',
  history: [],
  overrides: [],
  ...over,
});

function app(waivers: unknown[], enabled = true, actions: string[] = []) {
  return createTestApp({
    routes: {
      'GET /me/permissions': mePermissions({
        actions,
        enabled: enabled ? ['liability_waivers'] : [],
      }),
      'GET /people/{id}': { status: 200, body: person() },
      'GET /customers/{personId}/timeline': { status: 200, body: timeline() },
      'GET /people/{id}/waivers': {
        status: 200,
        body: { personId: PERSON_ID, evaluated: true, waivers },
      },
    },
  });
}

describe('SCR-S-20 waivers card', () => {
  it('SPK-REG-011: shows each waiver as current, lapsed or missing with the facts, the history and the overrides', async () => {
    const paper = acceptance({
      acknowledgmentId: '0192f1a0-0000-7000-8000-0000000005d2',
      policyVersionId: V3,
      version: 3,
      signedByPersonId: GUARDIAN,
      basis: 'guardian',
      method: 'paper',
      paperDatedOn: '2025-09-01',
      recordedByKind: 'staff',
      recordedByPersonId: STAFF,
      signedAt: '2025-09-03T17:00:00.000Z',
      acceptedAt: '2025-09-01T00:00:00.000Z',
    });
    const t = app([
      waiver({
        policyKey: 'liability',
        status: 'lapsed',
        reason: 'renewal_due',
        lapsedAt: '2026-09-01T00:00:00.000Z',
        acceptance: paper,
        history: [paper],
        overrides: [
          {
            id: '0192f1a0-0000-7000-8000-0000000005e1',
            personId: PERSON_ID,
            policyKey: 'liability',
            policyVersionId: V4,
            waiverStatus: 'lapsed',
            activity: { type: 'offering_session', id: SESSION },
            reason: 'Renewal form is in the post',
            actorPersonId: STAFF,
            occurredAt: '2026-10-20T16:00:00.000Z',
          },
        ],
      }),
      waiver({
        policyKey: 'rental-waiver',
        title: 'Rental waiver',
        status: 'missing',
        reason: 'never_accepted',
        rule: { reacceptOnNewVersion: false, renewEveryMonths: null, enforcement: 'warn' },
      }),
      waiver({
        policyKey: 'camp-waiver',
        title: 'Camp waiver',
        status: 'current',
        acceptance: acceptance({}),
        history: [acceptance({})],
        validUntil: '2027-10-01T16:00:00.000Z',
      }),
    ]);
    render(t.at(`/people/${PERSON_ID}`));
    const card = await screen.findByRole('region', { name: 'Waivers' });
    const list = await within(card).findByRole('list', { name: 'Waivers' });
    expect(within(list).getByText('Waiver lapsed')).toBeInTheDocument();
    expect(within(list).getByText('Waiver missing')).toBeInTheDocument();
    expect(within(list).getByText('Waiver current')).toBeInTheDocument();
    expect(within(list).getByText('Renewal was due on 1 Sep 2026.')).toBeInTheDocument();
    expect(within(list).getByText('Never accepted.')).toBeInTheDocument();
    expect(within(list).getByText('Counts until 1 Oct 2027.')).toBeInTheDocument();
    // the approved rule is shown as what the waiver says, not as a system setting
    expect(
      within(list).getByText(/a missing or lapsed waiver warns and does not block/),
    ).toBeInTheDocument();
    expect(within(list).getAllByText(/renewed every 12 months/).length).toBeGreaterThan(0);
    const overrides = within(list).getByRole('list', { name: 'Overrides of Liability waiver' });
    expect(
      within(overrides).getByText('Override: Renewal form is in the post'),
    ).toBeInTheDocument();
    expect(within(card).getByText('Proposed rule, DEC-095 pending')).toBeInTheDocument();
  });

  it('SPK-REG-009: a paper acceptance reads as recorded from paper by staff with the paper date, never as a digital signature', async () => {
    const paper = acceptance({
      signedByPersonId: GUARDIAN,
      basis: 'guardian',
      method: 'paper',
      paperDatedOn: '2026-10-10',
      recordedByKind: 'staff',
      recordedByPersonId: STAFF,
      signedAt: '2026-10-12T17:00:00.000Z',
      acceptedAt: '2026-10-10T00:00:00.000Z',
    });
    const t = app([waiver({ acceptance: paper, history: [paper] })]);
    render(t.at(`/people/${PERSON_ID}`));
    const card = await screen.findByRole('region', { name: 'Waivers' });
    const list = await within(card).findByRole('list', { name: 'Waivers' });
    expect(
      within(list).getByText(
        'Version 4: Recorded from paper by staff; paper dated 10 Oct 2026, by a guardian',
      ),
    ).toBeInTheDocument();
    expect(within(list).getByText(/staff entry by/)).toBeInTheDocument();
    expect(within(list).getByText(STAFF)).toBeInTheDocument();
    expect(within(list).queryByText(/Accepted digitally/)).toBeNull();
    // the time shown is when staff entered it, labelled as such
    expect(within(list).getByText(/^Entered /)).toBeInTheDocument();
  });

  it('offers recording only to roles that may accept a waiver, and only for a waiver that is not current', async () => {
    const missing = waiver({ status: 'missing', reason: 'never_accepted' });
    const reader = app([missing]);
    const first = render(reader.at(`/people/${PERSON_ID}`));
    const card = await screen.findByRole('region', { name: 'Waivers' });
    await within(card).findByText('Waiver missing');
    expect(within(card).queryByRole('button', { name: 'Record paper waiver' })).toBeNull();
    first.unmount();

    const desk = app(
      [
        missing,
        waiver({ policyKey: 'camp-waiver', title: 'Camp waiver', acceptance: acceptance({}) }),
      ],
      true,
      ['catalog.accept_waiver'],
    );
    render(desk.at(`/people/${PERSON_ID}`));
    const deskCard = await screen.findByRole('region', { name: 'Waivers' });
    await waitFor(() =>
      expect(within(deskCard).getAllByRole('button', { name: 'Record paper waiver' })).toHaveLength(
        1,
      ),
    );
    expect(within(deskCard).getAllByRole('button', { name: 'Sign on this tablet' })).toHaveLength(
      1,
    );
  });

  it('SPK-REG-011 with liability waivers turned off: the card is absent and the API is not asked', async () => {
    const t = app([waiver({})], false);
    render(t.at(`/people/${PERSON_ID}`));
    await screen.findByRole('region', { name: 'Care notes' });
    expect(screen.queryByRole('region', { name: 'Waivers' })).toBeNull();
    expect(t.fake.requests.some((r) => r.route === '/people/{id}/waivers')).toBe(false);
  });
});
