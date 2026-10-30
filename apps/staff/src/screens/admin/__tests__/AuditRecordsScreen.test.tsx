/**
 * SCR-S-46 audited privileged actions (§4.14, K-08): `GET /v1/audit-records` newest first with
 * the API's cursor, read only when "Show records" is pressed (every read is itself audited) and
 * never again on window focus, filters applied on request and kept out of the address, ids
 * validated before sending, the actor found by name (`GET /v1/people`), the API's
 * VALIDATION_FAILED and ACCESS_DENIED shown with their codes and messages, the actor named through
 * `GET /v1/person-names` (in reads of at most 100 ids), empty and offline states.
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { focusManager } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MEMBERSHIP_1,
  PERSON_1,
  auditRecord,
  ok,
  page,
  personSearchResult,
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

const auditReads = (test: ReturnType<typeof app>) =>
  test.fake.requests.filter((r) => r.route === '/audit-records').length;

async function showRecords(user: ReturnType<typeof userEvent.setup>) {
  const form = await screen.findByRole('form', { name: 'Filter audit records' });
  await user.click(within(form).getByRole('button', { name: 'Show records' }));
}

afterEach(() => {
  focusManager.setFocused(undefined);
});

describe('SCR-S-46 AuditRecordsScreen', () => {
  it('§4.14: reads nothing until "Show records" is pressed', async () => {
    const user = userEvent.setup();
    const test = app();
    render(test.at('/admin/audit'));
    expect(await screen.findByTestId('audit-not-read')).toHaveTextContent('No records are shown');
    expect(auditReads(test)).toBe(0);
    await showRecords(user);
    await screen.findByRole('list', { name: 'Audit records' });
    expect(auditReads(test)).toBe(1);
  });

  it('§4.14: a loaded audit is not re-read when the window regains focus', async () => {
    const user = userEvent.setup();
    const test = app();
    render(test.at('/admin/audit'));
    await showRecords(user);
    await screen.findByRole('list', { name: 'Audit records' });
    await screen.findByText(/by Sam Admin/);
    const permissionReads = () =>
      test.fake.requests.filter((r) => r.route === '/me/permissions').length;
    const before = permissionReads();
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    // The focus was handled: the permissions read re-reads on every return to the window.
    await waitFor(() => expect(permissionReads()).toBeGreaterThan(before));
    expect(auditReads(test)).toBe(1);
  });

  it('pressing "Show records" again is a new deliberate read of the first page', async () => {
    const user = userEvent.setup();
    const test = app();
    render(test.at('/admin/audit'));
    await showRecords(user);
    await screen.findByRole('list', { name: 'Audit records' });
    expect(auditReads(test)).toBe(1);
    await showRecords(user);
    await waitFor(() => expect(auditReads(test)).toBe(2));
    expect(await screen.findByRole('list', { name: 'Audit records' })).toBeInTheDocument();
  });

  it('finds the actor by name (names only) and filters by that person', async () => {
    const user = userEvent.setup();
    const test = app({ 'GET /people': page([personSearchResult()]) });
    render(test.at('/admin/audit'));
    const form = await screen.findByRole('form', { name: 'Filter audit records' });
    const search = within(form).getByRole('group', { name: 'Find the actor' });
    await user.type(within(search).getByLabelText('Find the actor by name'), 'Al{Enter}');
    // Enter searched; it did not apply the filters.
    expect(auditReads(test)).toBe(0);
    await user.click(
      await within(search).findByRole('button', { name: 'Use Alex Rivera as the actor' }),
    );
    expect(within(form).getByLabelText('Actor person id')).toHaveValue(PERSON_1);
    expect(within(form).getByText('Chosen: Alex Rivera')).toBeInTheDocument();
    expect(test.fake.requests.find((r) => r.route === '/people')?.query).toMatchObject({
      query: 'Al',
      kind: 'adult',
    });
    await user.click(within(form).getByRole('button', { name: 'Show records' }));
    await waitFor(() =>
      expect(
        test.fake.requests.some(
          (r) => r.route === '/audit-records' && r.query.actorPersonId === PERSON_1,
        ),
      ).toBe(true),
    );
  });

  it('a person search the API refuses is not available, and the id can still be entered', async () => {
    const user = userEvent.setup();
    render(
      app({
        'GET /people': () =>
          fakeResponse(
            403,
            apiErrorBody('ACCESS_DENIED', { message: 'You may not search people.' }),
          ),
      }).at('/admin/audit'),
    );
    const form = await screen.findByRole('form', { name: 'Filter audit records' });
    const search = within(form).getByRole('group', { name: 'Find the actor' });
    await user.type(within(search).getByLabelText('Find the actor by name'), 'Al');
    await user.click(within(search).getByRole('button', { name: 'Search for the actor' }));
    expect(await within(search).findByText('Not available to you')).toBeInTheDocument();
    expect(within(search).getByText('You can still enter the person id.')).toBeInTheDocument();
    expect(within(form).getByLabelText('Actor person id')).toBeEnabled();
  });

  it('§4.14: lists audited actions newest first with actor, target, revisions and reason', async () => {
    const user = userEvent.setup();
    const test = app();
    render(test.at('/admin/audit'));
    await showRecords(user);
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
    await showRecords(user);
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
    const user = userEvent.setup();
    render(
      app({
        'GET /audit-records': () =>
          fakeResponse(
            400,
            apiErrorBody('VALIDATION_FAILED', { message: 'The cursor is not valid.' }),
          ),
      }).at('/admin/audit'),
    );
    await showRecords(user);
    expect(
      await screen.findByText('Error code: VALIDATION_FAILED. Reference: test-correlation-id'),
    ).toBeInTheDocument();
  });

  it('shows the audit the API refuses as not available to the viewer, with its message', async () => {
    const user = userEvent.setup();
    render(
      app({
        'GET /audit-records': () =>
          fakeResponse(
            403,
            apiErrorBody('ACCESS_DENIED', { message: 'You may not read the audit.' }),
          ),
      }).at('/admin/audit'),
    );
    await showRecords(user);
    expect(await screen.findByText('Not available to you')).toBeInTheDocument();
    expect(
      screen.getByText(/needs its own permission\. You may not read the audit\./),
    ).toBeInTheDocument();
  });

  it('says so when no audited action matches', async () => {
    const user = userEvent.setup();
    render(app({ 'GET /audit-records': page([]) }).at('/admin/audit'));
    await showRecords(user);
    expect(await screen.findByRole('heading', { name: 'No audit records' })).toBeInTheDocument();
  });

  it('names a system actor by its label, without a person read', async () => {
    const user = userEvent.setup();
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
    await showRecords(user);
    expect(await screen.findByText(/by system:jobs \(system\)/)).toBeInTheDocument();
    expect(test.fake.requests.some((r) => r.route === '/person-names')).toBe(false);
  });

  it('offline with nothing loaded: says so instead of an empty list', async () => {
    const user = userEvent.setup();
    render(app({}, false).at('/admin/audit'));
    await showRecords(user);
    expect((await screen.findAllByText('You are offline')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('heading', { name: 'No audit records' })).toBeNull();
  });

  it('ID-02: names more than 100 actors in reads of at most 100 ids, never as "not available" without asking', async () => {
    const user = userEvent.setup();
    const actors = Array.from({ length: 101 }, (_, i) => uuid(20000 + i));
    const test = app({
      'GET /audit-records': page(
        actors.map((personId, i) =>
          auditRecord(i + 10, {
            id: uuid(30000 + i),
            actor: {
              kind: 'staff',
              accountId: null,
              personId,
              staffRoles: ['system_administrator'],
              sessionId: null,
              actorLabel: 'staff:system_administrator',
            },
          }),
        ),
      ),
      'GET /person-names': ok({
        items: actors.map((personId, i) => ({
          personId,
          canonicalPersonId: personId,
          givenName: 'Staff',
          familyName: `Member ${i}`,
          displayName: `Staff Member ${i}`,
          kind: 'adult',
        })),
      }),
    });
    render(test.at('/admin/audit'));
    await showRecords(user);
    expect(await screen.findByText(/by Staff Member 100 \(/)).toBeInTheDocument();
    expect(screen.getByText(/by Staff Member 0 \(/)).toBeInTheDocument();
    expect(screen.queryByText(/a person not available to you/)).toBeNull();
    expect(test.fake.requests.filter((r) => r.route === '/person-names')).toHaveLength(2);
  });
});
