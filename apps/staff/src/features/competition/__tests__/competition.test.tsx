/**
 * Shared pieces of the competition, placement and youth screens: route registration in the
 * "Leagues and tournaments" and "Teams and placement" areas (SPK-UX-005), the error helpers
 * (§4.10), status vocabulary as text (SPK-UX-009, SPK-UX-010), and an accessible name on every
 * control of the form-heavy screens (SPK-UX-009).
 */
import { ApiError } from '@sportspark/api-client';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FACILITY_A, createTestApp, mePermissions } from '../../../testing/test-app';
import { fieldErrorsOf, reasonsOf } from '../CommandError';
import {
  FIXTURE_STATUS,
  READINESS_STATUS,
  RESULT_STATUS,
  SOLVER_OUTCOME,
  TEAM_ENTRY_STATUS,
  humanizeCode,
} from '../labels';
import {
  ID,
  TEAM_ROUTES,
  bracketNode,
  competition,
  division,
  ok,
  page,
  pool,
  poolStandings,
  ruleSet,
  season,
  teamEntry,
} from './fixtures';

function apiError(code: string, details?: unknown) {
  return new ApiError({
    kind: 'api',
    status: 400,
    code,
    message: 'x',
    nextAction: 'correct_input',
    correlationId: null,
    details,
  });
}

describe('competition error helpers (§4.10)', () => {
  it('reads field messages only from VALIDATION_FAILED', () => {
    expect(
      fieldErrorsOf(
        apiError('VALIDATION_FAILED', [{ path: 'name', message: 'Required' }, { bad: 1 }]),
      ),
    ).toEqual({ name: 'Required' });
    expect(fieldErrorsOf(apiError('STALE_REVISION', [{ path: 'name', message: 'x' }]))).toEqual({});
  });

  it('reads explainable reasons and drops malformed ones', () => {
    expect(
      reasonsOf(
        apiError('ELIGIBILITY_FAILED', {
          reasons: [
            { code: 'a', severity: 'blocking', message: 'A' },
            { code: 'b', severity: 'bogus', message: 'B' },
            'nope',
          ],
        }),
      ),
    ).toEqual([{ code: 'a', severity: 'blocking', message: 'A' }]);
  });
});

describe('status vocabulary (SPK-UX-010, SPK-UX-009)', () => {
  it('uses machine state names for staff and words for readiness and solver outcomes', () => {
    expect(Object.values(FIXTURE_STATUS).map((b) => b.label)).toEqual([
      'unscheduled',
      'scheduled',
      'postponed',
      'played',
      'forfeit',
      'canceled',
      'abandoned',
    ]);
    expect(Object.values(RESULT_STATUS).map((b) => b.label)).toEqual([
      'draft',
      'submitted',
      'official',
      'superseded',
    ]);
    expect(Object.keys(TEAM_ENTRY_STATUS)).toEqual([
      'applied',
      'approved',
      'rejected',
      'withdrawn',
    ]);
    expect(READINESS_STATUS.unknown.label).toBe('Unknown or stale evidence');
    // No outcome other than proven_optimal mentions optimality; none but proven_infeasible says infeasible.
    for (const [outcome, label] of Object.entries(SOLVER_OUTCOME)) {
      if (outcome !== 'proven_optimal') expect(label.label).not.toMatch(/optimal/i);
      if (outcome !== 'proven_infeasible')
        expect(label.label).not.toMatch(/infeasible|impossible/i);
    }
  });

  it('turns codes into words', () => {
    expect(humanizeCode('league_manager')).toBe('League manager');
    expect(humanizeCode('roster.minimum')).toBe('Roster minimum');
  });
});

describe('area routes (SPK-UX-005)', () => {
  it('replaces the Leagues and Teams placeholders with their screens', async () => {
    const app = createTestApp({ routes: { 'GET /competitions': ok([]) } });
    render(app.at('/leagues'));
    expect(
      await screen.findByRole('heading', { name: 'Leagues and tournaments' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Not built yet/)).toBeNull();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    // The areas come from GET /v1/me/permissions: wait for the link before checking it.
    expect(
      await within(nav).findByRole('link', { name: 'Leagues and tournaments' }),
    ).toHaveAttribute('aria-current', 'page');
  });

  it('opens the Teams area home without a placeholder', async () => {
    const app = createTestApp({ routes: { 'GET /competitions': ok([competition()]) } });
    render(app.at('/teams'));
    expect(await screen.findByRole('heading', { name: 'Teams and placement' })).toBeInTheDocument();
    expect(screen.queryByText(/Not built yet/)).toBeNull();
  });

  it('keeps no placeholder on Administration: SCR-S-56 is linked to its own page (Package G)', async () => {
    const app = createTestApp();
    render(app.at('/admin'));
    const nav = await screen.findByRole('navigation', { name: 'Administration screens' });
    expect(
      within(nav).getByRole('link', { name: 'Access hardware (conditional)' }),
    ).toHaveAttribute('href', '/admin/access-hardware');
    expect(screen.queryByText(/Not built yet/)).toBeNull();
  });
});

function expectEveryControlNamed(container: HTMLElement) {
  const controls = container.querySelectorAll('input, select, textarea, button');
  expect(controls.length).toBeGreaterThan(0);
  for (const control of controls) {
    const role =
      control.tagName === 'BUTTON'
        ? 'button'
        : control.tagName === 'SELECT'
          ? 'combobox'
          : control.getAttribute('type') === 'checkbox'
            ? 'checkbox'
            : 'textbox';
    if (
      control.getAttribute('type') === 'date' ||
      control.getAttribute('type') === 'datetime-local' ||
      control.getAttribute('type') === 'time'
    ) {
      // Date and time inputs have no implicit textbox role; check the label association instead.
      const id = control.getAttribute('id');
      expect(id && container.querySelector(`label[for="${id}"]`)).toBeTruthy();
      continue;
    }
    const named = within(container)
      .getAllByRole(role)
      .includes(control as HTMLElement);
    expect(named).toBe(true);
    const name =
      control.getAttribute('aria-label') ??
      (control.id ? container.querySelector(`label[for="${control.id}"]`)?.textContent : null) ??
      control.textContent;
    expect(name?.trim().length ?? 0).toBeGreaterThan(0);
  }
}

describe('accessible names on every control (SPK-UX-009)', () => {
  it('names every control of the rule-set form', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: { 'GET /rule-sets': ok([ruleSet()]) } });
    render(app.at('/leagues/rule-sets'));
    await user.click(await screen.findByRole('button', { name: 'New version of Indoor 6v6' }));
    expectEveryControlNamed(screen.getByRole('form', { name: 'New version of Indoor 6v6' }));
  });

  it('names every control of the fixture specification form', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...TEAM_ROUTES,
        'GET /divisions/{id}': ok(division({ facilityId: FACILITY_A })),
        'GET /seasons/{id}': ok(season()),
        'GET /team-entries': ok([teamEntry({ status: 'approved' })]),
        'GET /resources': ok([
          {
            id: ID.resource,
            facilityId: FACILITY_A,
            kind: 'field',
            name: 'Field 1',
            status: 'active',
          },
        ]),
      },
    });
    render(app.at(`/leagues/divisions/${ID.division}/fixture-generation`));
    const form = await screen.findByRole('form', { name: 'Fixture specification' });
    await user.click(within(form).getByRole('button', { name: 'Add a start time' }));
    await user.click(within(form).getByRole('button', { name: 'Add a blackout' }));
    await user.click(within(form).getByRole('button', { name: 'Add a preference' }));
    await within(form).findByLabelText('Field 1');
    expectEveryControlNamed(form);
  });

  it('names every control of the seeding, pool and suspension-subject forms', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        'GET /me/permissions': mePermissions({
          enabled: ['tournaments'],
          actions: ['identity.lookup_person'],
        }),
        'GET /pools/{id}': ok(pool()),
        'GET /pools/{id}/standings': ok(poolStandings()),
        'GET /divisions/{id}': ok(division()),
        'GET /team-entries': ok([teamEntry({ status: 'approved', divisionId: ID.division })]),
        'GET /seasons/{id}/bracket-nodes': ok([bracketNode({ published: false })]),
      },
    });
    render(app.at(`/leagues/pools/${ID.pool}`));
    expectEveryControlNamed(
      await screen.findByRole('form', { name: 'Place an entry in the pool' }),
    );
    await user.click(await screen.findByRole('button', { name: 'Seed Final from standings' }));
    expectEveryControlNamed(screen.getByRole('form', { name: 'Seed Final from standings' }));
  });

  it('names every control of the suspension proposal with person search', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        'GET /me/permissions': mePermissions({ actions: ['identity.lookup_person'] }),
        'GET /incidents': ok([]),
        'GET /suspensions': ok([]),
        'GET /competitions': ok([competition()]),
        'GET /disciplinary-decisions': ok(page([])),
        'GET /appeals': ok(page([])),
      },
    });
    render(app.at('/leagues/discipline'));
    await user.click(await screen.findByRole('button', { name: 'Propose a suspension' }));
    const form = screen.getByRole('form', { name: 'Propose a suspension' });
    await within(form).findByLabelText(/^Suspended person: find by name/);
    expectEveryControlNamed(form);
  });
});
