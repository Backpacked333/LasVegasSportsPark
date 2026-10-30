/**
 * SCR-S-46 audited privileged actions (§4.14, K-08): `GET /v1/audit-records` newest first with
 * the API's cursor, filters applied on request and kept out of the address, ids validated before
 * sending, the API's VALIDATION_FAILED and ACCESS_DENIED shown with their codes and messages, the
 * actor named through `GET /v1/person-names`, empty and offline states.
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  MEMBERSHIP_1,
  PERSON_1,
  auditRecord,
  ok,
  page,
  uuid,
} from '../../../features/insight-admin/__tests__/fixtures';
import { formatInstant } from '../../../features/insight-admin/format';
import { createTestApp } from '../../../testing/test-app';

const ACTOR = uuid(902);

function app(routes: Record<string, FakeHandler> = {}, online = true) {
  return createTestApp({
    online,
    routes: {
      'GET /audit-records': page([auditRecord(1)]),
      'GET /person-names': ok({
        items: [
          {
            personId: ACTOR,
            canonicalPersonId: ACTOR,
            givenName: 'Sam',
            familyName: 'Admin',
            displayName: 'Sam Admin',
            kind: 'adult',
          },
        ],
      }),
      ...routes,
    },
  });
}

describe('SCR-S-46 AuditRecordsScreen', () => {
  it('§4.14: lists audited actions newest first with actor, target, revisions and reason', async () => {
    const user = userEvent.setup();
    const test = app();
    render(test.at('/admin/audit'));
    const list = await screen.findByRole('list', { name: 'Audit records' });
    const item = within(list).getByRole('listitem', {
      name: `identity.manage_staff_membership · staff_membership ${MEMBERSHIP_1.slice(0, 8)}`,
    });
    expect(
      await within(item).findByText(
        `${formatInstant('2026-10-24T12:00:00.000Z')} · by Sam Admin (System administrator) · revision 1 → 2`,
      ),
    ).toBeInTheDocument();
    expect(within(item).getByText('Reason: Role change approved')).toBeInTheDocument();
    expect(within(item).getByText('Correlation corr-1')).toBeInTheDocument();
    await user.click(within(item).getByText('Recorded details'));
    expect(within(item).getByText('operation')).toBeInTheDocument();
    expect(within(item).getByText('update')).toBeInTheDocument();
    expect(screen.getByText(/Reading the audit is itself an audited action/)).toBeInTheDocument();
    expect(test.fake.requests.find((r) => r.route === '/audit-records')?.query).toEqual({
      limit: '25',
    });
  });

  it('applies filters only on request and pages with the cursor', async () => {
    const user = userEvent.setup();
    const test = app({
      'GET /audit-records': (request) =>
        request.query.cursor
          ? fakeResponse(200, { items: [auditRecord(2)], nextCursor: null })
          : fakeResponse(200, { items: [auditRecord(1)], nextCursor: 'cursor-2' }),
    });
    render(test.at('/admin/audit'));
    await screen.findByRole('list', { name: 'Audit records' });
    await user.click(screen.getByRole('button', { name: 'Load more audit records' }));
    await waitFor(() =>
      expect(
        within(screen.getByRole('list', { name: 'Audit records' })).getAllByRole('listitem', {
          name: /identity/,
        }),
      ).toHaveLength(2),
    );
    expect(test.fake.requests.some((r) => r.query.cursor === 'cursor-2')).toBe(true);
    const form = screen.getByRole('form', { name: 'Filter audit records' });
    await user.type(within(form).getByLabelText('Target type'), 'capability');
    await user.type(within(form).getByLabelText('Target id'), 'rentals');
    await user.type(within(form).getByLabelText('Actor person id'), PERSON_1);
    expect(test.fake.requests.some((r) => r.route === '/audit-records' && r.query.targetType)).toBe(
      false,
    );
    await user.click(within(form).getByRole('button', { name: 'Show records' }));
    await waitFor(() =>
      expect(
        test.fake.requests.some(
          (r) =>
            r.route === '/audit-records' &&
            r.query.targetType === 'capability' &&
            r.query.targetId === 'rentals' &&
            r.query.actorPersonId === PERSON_1,
        ),
      ).toBe(true),
    );
  });

  it('validates ids and the period before sending', async () => {
    const user = userEvent.setup();
    const test = app();
    render(test.at('/admin/audit'));
    const form = await screen.findByRole('form', { name: 'Filter audit records' });
    await user.type(within(form).getByLabelText('Operation id'), 'abc');
    await user.type(within(form).getByLabelText('Occurred from'), '2026-10-24T10:00');
    await user.type(within(form).getByLabelText('Occurred before'), '2026-10-24T09:00');
    await user.click(within(form).getByRole('button', { name: 'Show records' }));
    expect(within(form).getByText('Enter a full id.')).toBeInTheDocument();
    expect(within(form).getByText('The end must be after the start.')).toBeInTheDocument();
    expect(
      test.fake.requests.some((r) => r.route === '/audit-records' && r.query.operationId),
    ).toBe(false);
  });

  it('shows the API validation failure with its code', async () => {
    render(
      app({
        'GET /audit-records': () =>
          fakeResponse(
            400,
            apiErrorBody('VALIDATION_FAILED', { message: 'The cursor is not valid.' }),
          ),
      }).at('/admin/audit'),
    );
    expect(
      await screen.findByText('Error code: VALIDATION_FAILED. Reference: test-correlation-id'),
    ).toBeInTheDocument();
  });

  it('shows the audit the API refuses as not available to the viewer, with its message', async () => {
    render(
      app({
        'GET /audit-records': () =>
          fakeResponse(
            403,
            apiErrorBody('ACCESS_DENIED', { message: 'You may not read the audit.' }),
          ),
      }).at('/admin/audit'),
    );
    expect(await screen.findByText('Not available to you')).toBeInTheDocument();
    expect(
      screen.getByText(/needs its own permission\. You may not read the audit\./),
    ).toBeInTheDocument();
  });

  it('says so when no audited action matches', async () => {
    render(app({ 'GET /audit-records': page([]) }).at('/admin/audit'));
    expect(await screen.findByRole('heading', { name: 'No audit records' })).toBeInTheDocument();
  });

  it('names a system actor by its label, without a person read', async () => {
    const test = app({
      'GET /audit-records': page([
        auditRecord(3, {
          actor: {
            kind: 'system',
            accountId: null,
            personId: null,
            staffRoles: [],
            sessionId: null,
            actorLabel: 'system:jobs',
          },
        }),
      ]),
    });
    render(test.at('/admin/audit'));
    expect(await screen.findByText(/by system:jobs \(system\)/)).toBeInTheDocument();
    expect(test.fake.requests.some((r) => r.route === '/person-names')).toBe(false);
  });

  it('offline with nothing loaded: says so instead of an empty list', async () => {
    render(app({}, false).at('/admin/audit'));
    expect((await screen.findAllByText('You are offline')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('heading', { name: 'No audit records' })).toBeNull();
  });
});
