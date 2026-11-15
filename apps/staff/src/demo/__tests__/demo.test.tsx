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
import { DEMO_LINK_NAMES, parseDemoLinks, stepPath, type DemoLinkName } from '../links';
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
const RECORD = '0192f1a0-0000-7000-8000-0000000000aa';
const CODE = '0a1b2c3d4e5f60718293a4b5';

/**
 * The shape of every link the seed's summary gives the demo build (`demo.tourLinks` and
 * `demo.publicLinks` of apps/api/src/dev/seed-demo.ts), with a sample id or public code.
 */
const SAMPLE_LINKS: Record<DemoLinkName, string> = {
  season: `/leagues/seasons/${RECORD}`,
  seasonResults: `/leagues/seasons/${RECORD}/results`,
  standings: `/leagues/seasons/${RECORD}/standings`,
  competition: `/leagues/competitions/${RECORD}`,
  teamEntries: `/teams/seasons/${RECORD}/entries`,
  messageSchedule: `/communications/schedules/season/${RECORD}`,
  perSessionClass: `/programs/offerings/${RECORD}`,
  memberClass: `/programs/offerings/${RECORD}`,
  camp: `/programs/offerings/${RECORD}`,
  campUniforms: `/programs/offerings/${RECORD}/uniforms`,
  waitlist: `/registrations/waitlists/${RECORD}`,
  registerSession: `/finance/point-of-sale/sessions/${RECORD}`,
  openAmountSale: `/finance/point-of-sale/sales/${RECORD}`,
  rentalRoster: `/schedule/rentals/${RECORD}`,
  paperWaiverPerson: `/people/${RECORD}`,
  missingWaiverPerson: `/people/${RECORD}`,
  lobby: `/lobby/dev/${CODE}?seasons=${CODE}`,
  publicSchedule: `/public/dev/schedule/${CODE}`,
  publicStandings: `/public/dev/seasons/${CODE}/standings`,
  publicFixtures: `/public/dev/seasons/${CODE}/fixtures`,
};

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

describe('demo links', () => {
  it('keeps only known names that map to a path of this application', () => {
    expect(
      parseDemoLinks(
        JSON.stringify({
          season: `/leagues/seasons/${RECORD}`,
          lobby: `/lobby/dev/${CODE}`,
          competition: 'https://elsewhere.example.test/leagues',
          camp: '//elsewhere.example.test',
          unknown: '/today',
          standings: 7,
        }),
      ),
    ).toEqual({ season: `/leagues/seasons/${RECORD}`, lobby: `/lobby/dev/${CODE}` });
    expect(parseDemoLinks('not json')).toEqual({});
    expect(parseDemoLinks(undefined)).toEqual({});
  });

  it('opens the seeded record of a step when the demo has it, otherwise the fallback screen', () => {
    const step = { path: '/leagues', link: 'season' as const };
    expect(stepPath(step, { season: SAMPLE_LINKS.season })).toBe(SAMPLE_LINKS.season);
    expect(stepPath(step, {})).toBe('/leagues');
    expect(stepPath({ path: '/today' }, SAMPLE_LINKS)).toBe('/today');
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
    render(inRouter(<TourPanel links={SAMPLE_LINKS} />, '/leagues'));

    expect(screen.getByText('League manager tour · step 1 of 9')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('League manager tour · step 2 of 9')).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent(SAMPLE_LINKS.season);

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
    const routed = (role: string, path: string) => {
      const matches = matchRoutes(routes, path.split('?')[0] as string) ?? [];
      const leaf = matches[matches.length - 1]?.route.path;
      expect({ role, path, leaf }).not.toMatchObject({ leaf: '*' });
      expect(matches.length, `${role} ${path}`).toBeGreaterThan(0);
    };
    for (const role of DEMO_ROLES) {
      for (const step of role.tour) {
        // The fallback screen, and the seeded record the step opens when the demo has it.
        routed(role.id, step.path);
        if (step.link) routed(role.id, SAMPLE_LINKS[step.link]);
        for (const open of step.openLinks ?? []) routed(role.id, SAMPLE_LINKS[open.link]);
      }
    }
    // Every link the seed hands over is a screen of this application.
    for (const name of DEMO_LINK_NAMES) routed('link', SAMPLE_LINKS[name]);
  });

  it('routes the sections below a splat route the tours rely on', () => {
    // `/schedule/*` and `/finance/point-of-sale/*` own their sub-routes: the route table above
    // matches the splat for any path, so the sections the tours open are named here too.
    const steps = DEMO_ROLES.flatMap((role) => role.tour);
    const paths = steps.flatMap((step) => [
      step.path,
      ...(step.link ? [SAMPLE_LINKS[step.link]] : []),
    ]);
    const sections = new Set(
      paths
        .filter((p) => p.startsWith('/schedule/') || p.startsWith('/finance/point-of-sale'))
        .map((p) => p.replace(RECORD, ':id')),
    );
    expect([...sections].sort()).toEqual([
      '/finance/point-of-sale',
      '/finance/point-of-sale/sessions/:id',
      '/schedule/drafts',
      '/schedule/rentals',
      '/schedule/rentals/:id',
    ]);
  });

  it('gives every step a title, a description and things to try in plain words', () => {
    for (const role of DEMO_ROLES) {
      for (const step of role.tour) {
        expect(step.title.length, step.title).toBeGreaterThan(3);
        expect(step.title.length, step.title).toBeLessThanOrEqual(48);
        // Sentence case: no word after the first starts with a capital unless it is a name.
        expect(step.title).not.toMatch(/ (And|The|Of|For|On|A|To|In|With) /);
        expect(step.body.split(/[.!?] /).length, step.title).toBeLessThanOrEqual(2);
        expect((step.tryThis ?? []).length, step.title).toBeLessThanOrEqual(3);
        for (const text of [step.title, step.body, ...(step.tryThis ?? [])]) {
          // No internal identifiers or requirement codes in what a presenter reads aloud.
          expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}|SPK-|DEC-|PA-\d|_/);
        }
      }
    }
  });

  it('covers the ten new features in the tours of the roles they belong to', () => {
    const text = (roleId: string) =>
      (DEMO_ROLES.find((r) => r.id === roleId)?.tour ?? [])
        .map((s) => `${s.title} ${s.body} ${(s.tryThis ?? []).join(' ')}`)
        .join(' ')
        .toLowerCase();
    const desk = text('front-desk');
    for (const topic of [
      'waiver',
      'roster',
      'open-amount',
      'single day',
      'add-ons',
      'jersey',
      'per class',
      'member price',
    ]) {
      expect(desk, topic).toContain(topic);
    }
    const league = text('league-manager');
    for (const topic of [
      'waiting list',
      'offer',
      'public standings',
      'lobby display',
      'sequence',
    ]) {
      expect(league, topic).toContain(topic);
    }
    const admin = text('administrator');
    for (const topic of ['switches', 'template', 'reports', 'open-amount', 'tiers', 'uniform']) {
      expect(admin, topic).toContain(topic);
    }
  });

  it('opens a step on its seeded record and offers the public pages in a new tab', async () => {
    setDemoState({ roleId: 'league-manager', step: 5, open: true });
    render(inRouter(<TourPanel links={SAMPLE_LINKS} />, '/today'));

    // Step 6 (results) names the season's results; step 7 the competition and its public pages.
    await userEvent.click(screen.getByRole('button', { name: 'Open this screen' }));
    expect(screen.getByTestId('where')).toHaveTextContent(SAMPLE_LINKS.seasonResults);
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByTestId('where')).toHaveTextContent(SAMPLE_LINKS.competition);
    const standings = screen.getByRole('link', { name: /Public standings/ });
    expect(standings).toHaveAttribute('href', SAMPLE_LINKS.publicStandings);
    expect(standings).toHaveAttribute('target', '_blank');
    expect(screen.getByRole('link', { name: /Lobby display/ })).toHaveAttribute(
      'href',
      SAMPLE_LINKS.lobby,
    );
  });

  it('falls back to the area screen when the demo was started without the dataset', async () => {
    setDemoState({ roleId: 'league-manager', step: 6, open: true });
    render(inRouter(<TourPanel links={{}} />, '/today'));

    await userEvent.click(screen.getByRole('button', { name: 'Open this screen' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/leagues');
    expect(screen.queryByRole('link', { name: /Public standings/ })).not.toBeInTheDocument();
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
