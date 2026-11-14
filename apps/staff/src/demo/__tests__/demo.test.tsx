/**
 * Demo mode (src/demo): role picker sign-in, guided tours, the demo banner, and that real builds
 * carry none of it. Components are tested directly; the gated entry points are null outside demo
 * builds, which is what a real build ships.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import {
  MemoryRouter,
  Route,
  Routes,
  createRoutesFromChildren,
  matchRoutes,
  useLocation,
} from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { AppRoutes } from '../../App';
import { createTestApp, TEST_SESSION } from '../../testing/test-app';
import { parseDemoAccounts } from '../accounts';
import { DemoBar } from '../DemoBar';
import { DemoRolePicker } from '../DemoRolePicker';
import {
  DemoRolePicker as GatedPicker,
  DemoBar as GatedBar,
  TourPanel as GatedTour,
  IS_DEMO,
} from '..';
import { DEMO_ROLES } from '../roles';
import { getDemoState, resetDemoState, setDemoState } from '../store';
import { TourPanel } from '../TourPanel';

const DESK = '0192f1a0-0000-7000-8000-00000000de01';
const LEAGUE = '0192f1a0-0000-7000-8000-00000000de02';

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function inRouter(element: ReactElement, path: string) {
  return (
    <MemoryRouter initialEntries={[path]}>
      {element}
      <Routes>
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>
  );
}

afterEach(() => resetDemoState());

describe('demo accounts', () => {
  it('keeps only subjects that map to account UUIDs', () => {
    expect(
      parseDemoAccounts(JSON.stringify({ 'dev-desk': DESK, 'dev-x': 'nope', 'dev-y': 3 })),
    ).toEqual({ 'dev-desk': DESK });
    expect(parseDemoAccounts('not json')).toEqual({});
    expect(parseDemoAccounts(undefined)).toEqual({});
  });
});

describe('real mode', () => {
  it('ships no demo entry points outside demo builds', () => {
    expect(IS_DEMO).toBe(false);
    expect(GatedPicker).toBeNull();
    expect(GatedBar).toBeNull();
    expect(GatedTour).toBeNull();
  });
});

describe('demo role picker', () => {
  it('signs in as the seeded account for the role and opens the first tour screen', async () => {
    const app = createTestApp({
      session: null,
      routes: {
        'POST /dev/tokens': {
          status: 201,
          body: { token: 'demo-token', expiresAt: null, accountId: DESK },
        },
      },
    });
    render(
      <app.wrapper>
        {inRouter(
          <DemoRolePicker accounts={{ 'dev-desk': DESK, 'dev-league': LEAGUE }} />,
          '/sign-in',
        )}
      </app.wrapper>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Sign in as front desk' }));

    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/today'));
    const call = app.fake.requests.find((r) => r.route === '/dev/tokens');
    expect(call?.body).toEqual({ accountId: DESK });
    expect(await app.sessionStore.load()).toMatchObject({ token: 'demo-token', accountId: DESK });
    expect(getDemoState()).toMatchObject({ roleId: 'front-desk', step: 0, open: true });
  });

  it('says how to set up the demo when no accounts were seeded', () => {
    const app = createTestApp({ session: null });
    render(<app.wrapper>{inRouter(<DemoRolePicker accounts={{}} />, '/sign-in')}</app.wrapper>);

    expect(screen.getByText('Demo accounts not set up')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in as front desk' })).toBeDisabled();
  });

  it('points families to the mobile app instead of a staff sign-in', () => {
    const app = createTestApp({ session: null });
    render(
      <app.wrapper>
        {inRouter(<DemoRolePicker accounts={{ 'dev-desk': DESK }} />, '/sign-in')}
      </app.wrapper>,
    );

    expect(screen.getByText(/Families use the mobile app/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /parent/i })).not.toBeInTheDocument();
  });
});

describe('guided tour', () => {
  it('moves between steps and opens each step screen', async () => {
    setDemoState({ roleId: 'league-manager', step: 0, open: true });
    render(inRouter(<TourPanel />, '/leagues'));

    expect(screen.getByText('League manager tour · step 1 of 6')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('League manager tour · step 2 of 6')).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/leagues/rule-sets');

    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/leagues');
  });

  it('finishes on the last step and offers to reopen a step screen after wandering off', async () => {
    setDemoState({ roleId: 'referee', step: 1, open: true });
    render(inRouter(<TourPanel />, '/today'));

    await userEvent.click(screen.getByRole('button', { name: 'Open this screen' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/workspace/fees');

    await userEvent.click(screen.getByRole('button', { name: 'Finish tour' }));
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    expect(getDemoState()).toMatchObject({ open: false, step: 0 });
  });

  it('has every tour step on a screen the dashboard routes to', () => {
    const routes = createRoutesFromChildren(
      (AppRoutes() as ReactElement<{ children: ReactElement }>).props.children,
    );
    for (const role of DEMO_ROLES) {
      for (const step of role.tour) {
        const matches = matchRoutes(routes, step.path) ?? [];
        const leaf = matches[matches.length - 1]?.route.path;
        expect({ role: role.id, path: step.path, leaf }).not.toMatchObject({ leaf: '*' });
        expect(matches.length, `${role.id} ${step.path}`).toBeGreaterThan(0);
      }
    }
  });
});

describe('demo banner', () => {
  it('says the data is sample data and switches role by signing out', async () => {
    setDemoState({ roleId: 'coach', step: 2, open: true });
    const app = createTestApp();
    render(<app.wrapper>{inRouter(<DemoBar />, '/workspace')}</app.wrapper>);

    expect(screen.getByRole('region', { name: 'Demo mode' })).toHaveTextContent(
      'sample data, nothing here is real',
    );
    expect(screen.getByText(/viewing as coach/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Hide tour' }));
    expect(getDemoState().open).toBe(false);

    expect(await app.sessionStore.load()).toEqual(TEST_SESSION);
    await userEvent.click(screen.getByRole('button', { name: 'Switch role' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/sign-in'));
    expect(await app.sessionStore.load()).toBeNull();
    expect(getDemoState().roleId).toBeNull();
  });
});
