/**
 * Team waiting list at the staff screens (SPK-COMP-006, proposed amendment PA-10; capability
 * `team_waitlist`): SCR-S-16 team entry review (wait, offer, see and withdraw offers) and the
 * waiting list panel of the Teams area home.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  ID,
  TEAM_ROUTES,
  competition,
  division,
  ok,
  season,
  teamEntry,
} from '../../../features/competition/__tests__/fixtures';
import { createTestApp, mePermissions } from '../../../testing/test-app';

const WAITING_ID = '00000000-0000-4000-8000-0000000000c1';
const SECOND_ID = '00000000-0000-4000-8000-0000000000c2';
const OFFER_ID = '00000000-0000-4000-8000-0000000000d1';

const offer = (overrides: Record<string, unknown> = {}) => ({
  id: OFFER_ID,
  teamEntryId: SECOND_ID,
  seasonId: ID.season,
  divisionId: ID.division,
  divisionName: 'Division A',
  status: 'offered',
  positionAtOffer: 2,
  offeredAt: '2026-11-10T18:00:00.000Z',
  expiresAt: '2026-11-12T18:00:00.000Z',
  note: null,
  resolvedAt: null,
  resolutionReason: null,
  revision: 1,
  ...overrides,
});

const waitingLists = (
  overrides: Record<string, unknown> = {},
  second: Record<string, unknown> = {},
) => ({
  seasonId: ID.season,
  offerHours: 48,
  lists: [
    {
      division: { id: ID.division, name: 'Division A' },
      capacity: 8,
      placed: 7,
      openOffers: 0,
      freePlaces: 1,
      entries: [
        {
          position: 1,
          teamEntryId: WAITING_ID,
          teamId: ID.teamRed,
          teamName: 'Red',
          waitingSince: '2026-11-01T18:00:00.000Z',
          revision: 4,
          openOffer: null,
        },
        {
          position: 2,
          teamEntryId: SECOND_ID,
          teamId: ID.teamBlue,
          teamName: 'Blue',
          waitingSince: '2026-11-02T18:00:00.000Z',
          revision: 6,
          openOffer: null,
          ...second,
        },
      ],
      ...overrides,
    },
  ],
});

const workspace = () => ({
  entry: teamEntry(),
  readiness: {
    approval: 'applied',
    financialStatusRef: null,
    rosterCount: 5,
    rosterMin: 8,
    rosterMax: 14,
    rosterComplete: false,
    eligiblePlayers: 5,
    pendingInvitations: 0,
    pendingJoinRequests: 0,
    issues: [],
  },
});

const routes = {
  ...TEAM_ROUTES,
  'GET /me/permissions': mePermissions({ enabled: ['team_waitlist'] }),
  'GET /divisions': ok([division()]),
  'GET /team-entries': ok([teamEntry()]),
  'GET /team-entries/{id}': ok(workspace()),
  'GET /seasons/{id}/waiting-list': ok(waitingLists()),
};

describe('SPK-COMP-006 team waiting list (staff screens)', () => {
  it('SPK-COMP-006: the waiting list shows the order, the places and the pending rule; staff offer the free place to the team they choose', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...routes,
        'POST /team-entries/{id}/place-offers': ok({
          offer: offer(),
          entry: teamEntry({ id: SECOND_ID, status: 'waiting' }),
        }),
      },
    });
    render(app.at(`/teams/seasons/${ID.season}/entries`));
    const panel = await screen.findByRole('region', { name: 'Waiting list' });
    const list = await within(panel).findByRole('list', { name: 'Teams waiting for Division A' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('1. Red')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('2. Blue')).toBeInTheDocument();
    expect(within(panel).getByText('7 of 8 places used, 1 free.')).toBeInTheDocument();
    // The undecided rule is named with its decision record, never invented.
    expect(
      within(panel).getByText(
        /an offer stands for 48 hours\. Proposed rule, pending decision DEC-104\./,
      ),
    ).toBeInTheDocument();
    // Staff choose the second team; the command names the entry's revision and the division.
    await user.click(within(rows[1]!).getByRole('button', { name: 'Offer a place to Blue' }));
    expect(await within(panel).findByText(/^Place offered until /)).toBeInTheDocument();
    const post = app.fake.requests.find((r) => r.method === 'POST');
    expect(post?.route).toBe('/team-entries/{id}/place-offers');
    expect(post?.params).toMatchObject({ id: SECOND_ID });
    expect(post?.body).toEqual({ expectedRevision: 6, divisionId: ID.division });
    expect(post?.headers['idempotency-key']).toMatch(/^key-/);
  });

  it('SPK-COMP-006: an open offer is shown with its expiry and holds the place; withdrawing it needs a reason', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...routes,
        'GET /seasons/{id}/waiting-list': ok(
          waitingLists({ openOffers: 1, freePlaces: 0 }, { openOffer: offer() }),
        ),
        'POST /team-entry-place-offers/{id}/withdraw': ok({
          offer: offer({ status: 'withdrawn', revision: 2 }),
          entry: teamEntry({ id: SECOND_ID, status: 'waiting' }),
        }),
      },
    });
    render(app.at(`/teams/seasons/${ID.season}/entries`));
    const panel = await screen.findByRole('region', { name: 'Waiting list' });
    expect(
      await within(panel).findByText('7 of 8 places used, 1 offered to waiting teams, 0 free.'),
    ).toBeInTheDocument();
    expect(within(panel).getByText('Place offered in Division A')).toBeInTheDocument();
    expect(within(panel).getByText(/Offer expires .*The place is held/)).toBeInTheDocument();
    // No place is free: the first team cannot be offered one.
    expect(within(panel).queryByRole('button', { name: 'Offer a place to Red' })).toBeNull();
    expect(within(panel).getByText('No free place to offer yet.')).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Withdraw the offer to Blue' }));
    const form = within(panel).getByRole('form', { name: 'Withdraw the offer to Blue' });
    await user.click(within(form).getByRole('button', { name: 'Withdraw the offer' }));
    expect(within(form).getByText('Give a reason for withdrawing the offer.')).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.method === 'POST')).toBe(false);
    await user.type(within(form).getByLabelText(/^Reason/), 'Offered by mistake');
    await user.click(within(form).getByRole('button', { name: 'Withdraw the offer' }));
    expect(
      await within(panel).findByText('Offer withdrawn; the team keeps its place'),
    ).toBeInTheDocument();
    const post = app.fake.requests.find((r) => r.method === 'POST');
    expect(post?.params).toMatchObject({ id: OFFER_ID });
    expect(post?.body).toEqual({ expectedRevision: 1, reason: 'Offered by mistake' });
  });

  it('SPK-COMP-006: an applied entry is added to the waiting list of a division, and a placement into a full division says the team now waits', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...routes,
        'POST /team-entries/{id}/wait': ok(
          teamEntry({ status: 'waiting', waitingDivisionId: ID.division }),
        ),
        'POST /team-entries/{id}/approve': ok(
          teamEntry({ status: 'waiting', waitingDivisionId: ID.division }),
        ),
      },
    });
    render(app.at(`/teams/seasons/${ID.season}/entries`));
    const entries = await screen.findByRole('list', { name: 'Team entries' });
    await user.click(
      await within(entries).findByRole('button', { name: 'Add to the waiting list' }),
    );
    const form = screen.getByRole('form', { name: 'Add the entry to the waiting list' });
    await user.selectOptions(within(form).getByLabelText('Wait for division'), ID.division);
    await user.click(within(form).getByRole('button', { name: 'Add to the waiting list' }));
    expect(await screen.findByText('Entry waiting')).toBeInTheDocument();
    const wait = app.fake.requests.find((r) => r.route === '/team-entries/{id}/wait');
    expect(wait?.body).toEqual({ expectedRevision: 3, divisionId: ID.division });

    await user.click(within(entries).getByRole('button', { name: 'Approve' }));
    const approve = screen.getByRole('form', { name: 'Approve the entry' });
    await user.selectOptions(within(approve).getByLabelText('Place in division'), ID.division);
    await user.click(within(approve).getByRole('button', { name: 'Approve the entry' }));
    expect(
      await screen.findByText('The division is full: the team is now waiting'),
    ).toBeInTheDocument();
  });

  it('SPK-COMP-006: a waiting entry reads as waiting, with since when and for which division, and cannot be approved directly', async () => {
    const app = createTestApp({
      routes: {
        ...routes,
        'GET /team-entries': ok([
          teamEntry({
            status: 'waiting',
            waitingSince: '2026-11-01T18:00:00.000Z',
            waitingDivisionId: ID.division,
          }),
        ]),
      },
    });
    render(app.at(`/teams/seasons/${ID.season}/entries`));
    const entries = await screen.findByRole('list', { name: 'Team entries' });
    expect(await within(entries).findByText('Entry waiting')).toBeInTheDocument();
    expect(
      within(entries).getByText(
        /Waiting since .* for division Division A\. The team holds no place and owes nothing/,
      ),
    ).toBeInTheDocument();
    expect(within(entries).queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(within(entries).getByRole('button', { name: 'Decline' })).toBeInTheDocument();
    expect(within(entries).getByRole('button', { name: 'Withdraw' })).toBeInTheDocument();
  });

  it('SPK-COMP-006 capability off: no waiting list is read or shown and no entry can be made to wait', async () => {
    const app = createTestApp({
      routes: {
        ...TEAM_ROUTES,
        'GET /divisions': ok([division()]),
        'GET /team-entries': ok([teamEntry()]),
        'GET /team-entries/{id}': ok(workspace()),
      },
    });
    render(app.at(`/teams/seasons/${ID.season}/entries`));
    const entries = await screen.findByRole('list', { name: 'Team entries' });
    expect(await within(entries).findByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(within(entries).queryByRole('button', { name: 'Add to the waiting list' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Waiting list' })).toBeNull();
    expect(app.fake.requests.some((r) => r.route === '/seasons/{id}/waiting-list')).toBe(false);
  });

  it("SPK-COMP-006: the Teams home lists each season's waiting list in order, read-only", async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...routes,
        'GET /competitions': ok([competition()]),
        'GET /seasons': ok([season()]),
      },
    });
    render(app.at('/teams'));
    await user.selectOptions(await screen.findByLabelText('Competition'), ID.competition);
    const name = season().name as string;
    const panel = await screen.findByRole('region', { name: `Waiting list of ${name}` });
    const list = await within(panel).findByRole('list', { name: 'Teams waiting for Division A' });
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(2));
    expect(within(list).getByText('1. Red')).toBeInTheDocument();
    expect(within(panel).queryByRole('button')).toBeNull();
  });
});
