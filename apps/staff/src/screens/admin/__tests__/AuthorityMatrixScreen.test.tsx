/**
 * SCR-S-48 Authority matrix (§5.6, §4.7 invariant 11): one authoritative system per record
 * category and scope; a conflict is shown as such (writes refused), never resolved by the client;
 * the facility scope is sent to the API; DEC-014 pending.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  NOW_ISO,
  facilityList,
  ok,
  page,
  uuid,
} from '../../../features/insight-admin/__tests__/fixtures';
import { FACILITY_A, createTestApp } from '../../../testing/test-app';

const MATRIX = ok({
  at: NOW_ISO,
  facilityId: null,
  programId: null,
  competitionId: null,
  entries: [
    {
      recordCategory: 'person',
      authoritativeSystem: 'legacy',
      basis: 'assignment',
      assignmentId: uuid(1),
      scope: { kind: 'organization' },
      effectiveFrom: '2026-10-01T00:00:00.000Z',
      effectiveTo: null,
    },
    {
      recordCategory: 'future_schedule',
      authoritativeSystem: 'sportspark',
      basis: 'conflict',
      assignmentId: null,
      scope: null,
      effectiveFrom: null,
      effectiveTo: null,
    },
    {
      recordCategory: 'credit',
      authoritativeSystem: 'sportspark',
      basis: 'default',
      assignmentId: null,
      scope: null,
      effectiveFrom: null,
      effectiveTo: null,
    },
  ],
});

describe('SCR-S-48 AuthorityMatrixScreen', () => {
  it('resolves each record category and shows a conflict as writes refused', async () => {
    const user = userEvent.setup();
    const test = createTestApp({
      routes: {
        'GET /authority-matrix': MATRIX,
        'GET /authority-assignments': page([]),
        'GET /facilities': facilityList(),
      },
    });
    render(test.at('/admin/migration/authority'));
    const table = await screen.findByRole('region', { name: 'Authority matrix table' });
    const people = within(table).getByRole('row', { name: /People/ });
    expect(within(people).getByText('legacy')).toBeInTheDocument();
    expect(within(people).getByText('assignment')).toBeInTheDocument();
    const schedules = within(table).getByRole('row', { name: /Future schedules/ });
    expect(within(schedules).getByText('two answers: writes refused')).toBeInTheDocument();
    expect(within(schedules).getByText('conflict')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'No authority assignments' })).toBeInTheDocument();
    expect(screen.getByTestId('pending-note')).toHaveTextContent('DEC-014');
    await within(screen.getByLabelText('Scope')).findByRole('option', { name: 'North Park 1' });
    await user.selectOptions(screen.getByLabelText('Scope'), FACILITY_A);
    await waitFor(() =>
      expect(
        test.fake.requests.some(
          (r) => r.route === '/authority-matrix' && r.query.facilityId === FACILITY_A,
        ),
      ).toBe(true),
    );
  });
});
