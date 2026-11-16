/**
 * Team waiting list in the customer app (SPK-COMP-006, proposed amendment PA-10): the workspace
 * of a waiting team (SCR-C-22) shows the wait, the place in the order and an open offer the
 * captain accepts or declines, and lets the captain withdraw; the entry screen (SCR-C-27) says
 * when a division is full.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { formatInstant } from '../../../features/teams/format';
import {
  CAPTAIN_ACTIONS,
  IDS,
  baseRoutes,
  division,
  playerWorkspace,
  standings,
  teamEntry,
  workspace,
} from '../../../features/teams/testing/fixtures';
import { teamEntryStatus } from '../../../features/teams/status';
import { waitingPlaceText } from '../../../features/teams/TeamWaiting';
import { createTeamsTestApp } from '../../../features/teams/testing/teams-test-app';
import { divisionCriteriaText } from '../TeamEntryScreen';
import { TeamWorkspaceScreen } from '../TeamWorkspaceScreen';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn() };
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => mockRouter,
}));

const OFFER_ID = '00000000-0000-4000-8000-0000000000d1';
const SINCE = '2026-10-20T18:00:00.000Z';
const EXPIRES = '2026-10-26T18:00:00.000Z';

const openOffer = {
  id: OFFER_ID,
  teamEntryId: IDS.entry,
  seasonId: IDS.season,
  divisionId: IDS.division,
  divisionName: 'Coed Division 2',
  status: 'offered' as const,
  positionAtOffer: 2,
  offeredAt: '2026-10-24T18:00:00.000Z',
  expiresAt: EXPIRES,
  note: null,
  resolvedAt: null,
  resolutionReason: null,
  revision: 1,
};

const waitingEntry = () =>
  teamEntry({
    status: 'waiting',
    divisionId: null,
    waitingSince: SINCE,
    waitingDivisionId: IDS.division,
    revision: 4,
  });

function waitingWorkspace(offer: typeof openOffer | null, actions: string[] = []) {
  return workspace({
    entry: waitingEntry(),
    division: null,
    upcomingFixtures: [],
    waiting: {
      since: SINCE,
      division: { id: IDS.division, name: 'Coed Division 2' },
      position: 2,
      listLength: 3,
      openOffer: offer,
    },
    viewer: {
      roles: ['captain'],
      actingAsCaptain: true,
      availableActions: [...CAPTAIN_ACTIONS, ...actions],
    },
  });
}

const ANSWERS = ['competition.accept_team_place_offer', 'competition.decline_team_place_offer'];

function routes(ws: ReturnType<typeof workspace>, overrides = {}) {
  return baseRoutes({
    'GET /team-entries/{id}': { status: 200, body: ws },
    'GET /seasons/{id}/standings': { status: 200, body: standings() },
    ...overrides,
  });
}

describe('SPK-COMP-006 team waiting list (customer app)', () => {
  it('SPK-COMP-006: the captain sees that the team is waiting, for which division, its place in the order and since when', async () => {
    const app = createTeamsTestApp({ routes: routes(waitingWorkspace(null)) });
    render(<TeamWorkspaceScreen entryId={IDS.entry} />, { wrapper: app.wrapper });

    expect(await screen.findByLabelText('Team waiting for a place')).toBeOnTheScreen();
    expect(
      screen.getByText('Your team is waiting for a place in Coed Division 2.'),
    ).toBeOnTheScreen();
    expect(screen.getByLabelText('Place in the order: 2nd of 3 waiting')).toBeOnTheScreen();
    expect(screen.getByLabelText(`Waiting since: ${formatInstant(SINCE)}`)).toBeOnTheScreen();
    expect(screen.getByText(/holds no place and owes nothing/)).toBeOnTheScreen();
    expect(screen.getByText('No place has been offered yet.')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Accept the place' })).toBeNull();
    await app.settle();
  });

  it('SPK-COMP-006: the captain accepts an offered place with the offer revision; the entry goes to the league for approval', async () => {
    const app = createTeamsTestApp({
      routes: routes(waitingWorkspace(openOffer, ANSWERS), {
        'POST /team-entry-place-offers/{id}/accept': {
          status: 200,
          body: {
            offer: { ...openOffer, status: 'accepted', revision: 2 },
            entry: teamEntry({ status: 'applied' }),
          },
        },
      }),
    });
    render(<TeamWorkspaceScreen entryId={IDS.entry} />, { wrapper: app.wrapper });

    expect(await screen.findByLabelText('A place is offered in Coed Division 2')).toBeOnTheScreen();
    expect(screen.getByLabelText(`Answer by: ${formatInstant(EXPIRES)}`)).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Accept the place' }));
    expect(await screen.findByTestId('waiting-offer-accepted')).toBeOnTheScreen();
    expect(
      screen.getByText(
        'You accepted the place. The league reviews the team as usual; payment follows approval.',
      ),
    ).toBeOnTheScreen();
    expect(app.bodiesOf('POST', '/team-entry-place-offers/{id}/accept')).toEqual([
      { expectedRevision: 1 },
    ]);
    expect(app.requestsTo('POST', '/team-entry-place-offers/{id}/accept')[0]?.params).toMatchObject(
      { id: OFFER_ID },
    );
    expect(app.keysOf('POST', '/team-entry-place-offers/{id}/accept')[0]).toBeTruthy();
    await app.settle();
  });

  it('SPK-COMP-006: declining keeps the place in the order', async () => {
    const app = createTeamsTestApp({
      routes: routes(waitingWorkspace(openOffer, ANSWERS), {
        'POST /team-entry-place-offers/{id}/decline': {
          status: 200,
          body: { offer: { ...openOffer, status: 'declined', revision: 2 }, entry: waitingEntry() },
        },
      }),
    });
    render(<TeamWorkspaceScreen entryId={IDS.entry} />, { wrapper: app.wrapper });

    fireEvent.press(await screen.findByRole('button', { name: 'Decline the offer' }));
    expect(await screen.findByTestId('waiting-offer-declined')).toBeOnTheScreen();
    expect(
      screen.getByText('You declined the offer. Your team keeps its place in the order.'),
    ).toBeOnTheScreen();
    expect(app.bodiesOf('POST', '/team-entry-place-offers/{id}/decline')).toEqual([
      { expectedRevision: 1 },
    ]);
    await app.settle();
  });

  it('SPK-COMP-006: the captain withdraws the waiting team with a reason and the entry revision', async () => {
    const app = createTeamsTestApp({
      routes: routes(waitingWorkspace(null), {
        'POST /team-entries/{id}/withdraw': {
          status: 200,
          body: teamEntry({ status: 'withdrawn' }),
        },
      }),
    });
    render(<TeamWorkspaceScreen entryId={IDS.entry} />, { wrapper: app.wrapper });

    fireEvent.press(await screen.findByRole('button', { name: 'Withdraw from the waiting list' }));
    fireEvent.press(screen.getByRole('button', { name: 'Withdraw the team' }));
    expect(await screen.findByLabelText('Reason for withdrawing')).toHaveProp(
      'accessibilityHint',
      'Error: Give the reason for withdrawing.',
    );
    expect(app.requestsTo('POST', '/team-entries/{id}/withdraw')).toHaveLength(0);
    fireEvent.changeText(
      screen.getByLabelText('Reason for withdrawing'),
      'We joined another league',
    );
    fireEvent.press(screen.getByRole('button', { name: 'Withdraw the team' }));
    expect(await screen.findByTestId('waiting-withdrawn')).toBeOnTheScreen();
    expect(app.bodiesOf('POST', '/team-entries/{id}/withdraw')).toEqual([
      { reason: 'We joined another league', expectedRevision: 4 },
    ]);
    await app.settle();
  });

  it('SPK-COMP-006: a refused answer (the offer expired meanwhile) is shown with a way to reload', async () => {
    const app = createTeamsTestApp({
      routes: routes(waitingWorkspace(openOffer, ANSWERS), {
        'POST /team-entry-place-offers/{id}/accept': {
          status: 409,
          body: {
            code: 'INVALID_TRANSITION',
            message: 'The offer has expired.',
            details: { code: 'OFFER_EXPIRED' },
            correlationId: 'c-1',
            nextAction: 'reload',
          },
        },
      }),
    });
    render(<TeamWorkspaceScreen entryId={IDS.entry} />, { wrapper: app.wrapper });

    fireEvent.press(await screen.findByRole('button', { name: 'Accept the place' }));
    expect(await screen.findByTestId('command-failure')).toBeOnTheScreen();
    expect(screen.queryByTestId('waiting-offer-accepted')).toBeNull();
    await app.settle();
  });

  it('SPK-COMP-006: a roster player sees the wait and the offer but is offered no answer and no withdrawal', async () => {
    const player = {
      ...playerWorkspace(),
      entry: waitingEntry(),
      division: null,
      upcomingFixtures: [],
      waiting: {
        since: SINCE,
        division: { id: IDS.division, name: 'Coed Division 2' },
        position: 1,
        listLength: 1,
        openOffer,
      },
    };
    const app = createTeamsTestApp({ routes: routes(player) });
    render(<TeamWorkspaceScreen entryId={IDS.entry} />, { wrapper: app.wrapper });

    expect(await screen.findByLabelText('Place in the order: 1st of 1 waiting')).toBeOnTheScreen();
    expect(screen.getByLabelText('A place is offered in Coed Division 2')).toBeOnTheScreen();
    expect(screen.getByText("The team's captain answers the offer.")).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Accept the place' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Withdraw from the waiting list' })).toBeNull();
    await waitFor(() => expect(app.queryClient.isFetching()).toBe(0));
  });

  it('SPK-COMP-006: an entry that is not waiting shows no waiting section', async () => {
    const app = createTeamsTestApp({ routes: routes(workspace()) });
    render(<TeamWorkspaceScreen entryId={IDS.entry} />, { wrapper: app.wrapper });

    expect(await screen.findByLabelText('Team entry approved')).toBeOnTheScreen();
    expect(screen.queryByTestId('team-waiting')).toBeNull();
    await app.settle();
  });

  it('SPK-COMP-006: the words for a waiting entry, its place and a full division', () => {
    expect(teamEntryStatus({ status: 'waiting', rejectionReason: null })).toEqual({
      tone: 'pending',
      label: 'Team waiting for a place',
    });
    expect(waitingPlaceText({ position: 3, listLength: 5 })).toBe('3rd of 5 waiting');
    expect(divisionCriteriaText(division({ capacityTeamEntries: 8, entryCount: 8 }))).toBe(
      'ages 18 and over, Recreational, Coed, 7v7. 8 of 8 team places taken. Full: the league may put a team that applies on its waiting list',
    );
    expect(divisionCriteriaText(division({ capacityTeamEntries: 8, entryCount: 5 }))).toBe(
      'ages 18 and over, Recreational, Coed, 7v7. 5 of 8 team places taken',
    );
  });
});
