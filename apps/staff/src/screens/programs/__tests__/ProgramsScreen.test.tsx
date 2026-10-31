/**
 * SCR-S-14 programs (SPK-CAT-001, SPK-YOUTH-001, SPK-UX-008): list, create with an idempotency
 * key, keep input on a validation failure, permission restriction shown as not available, keyset
 * paging with "Load more" (§4.5).
 */
import { fakeResponse } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../../../testing/test-app';
import {
  PROGRAM_ID,
  apiError,
  ok,
  program,
} from '../../../features/registration-finance/__tests__/fixtures';

const LIST = ok({
  items: [
    program(),
    program({ id: `${PROGRAM_ID.slice(0, -1)}2`, name: 'Winter camp', status: 'draft' }),
  ],
  nextCursor: null,
});

describe('SCR-S-14 ProgramsScreen', () => {
  it('SPK-CAT-001: lists reusable programs with their status as text and a link to each', async () => {
    const app = createTestApp({ routes: { 'GET /programs': LIST } });
    render(app.at('/programs'));
    const list = await screen.findByRole('list', { name: 'Programs' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByRole('link', { name: 'Spring academy' })).toHaveAttribute(
      'href',
      `/programs/${PROGRAM_ID}`,
    );
    expect(within(items[0]!).getByText('active')).toBeInTheDocument();
    expect(within(items[0]!).getByText(/Ages 8 to 10/)).toBeInTheDocument();
    expect(within(items[1]!).getByText('draft')).toBeInTheDocument();
  });

  it('says so when there are no programs', async () => {
    const app = createTestApp({ routes: { 'GET /programs': ok({ items: [], nextCursor: null }) } });
    render(app.at('/programs'));
    expect(await screen.findByRole('heading', { name: 'No programs' })).toBeInTheDocument();
  });

  it('creates a program with an idempotency key and opens it', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        'GET /programs': LIST,
        'POST /programs': ok(program({ name: 'Futsal clinic', status: 'draft' }), 201),
        'GET /programs/{id}': ok(program({ name: 'Futsal clinic', status: 'draft' })),
        'GET /programs/{id}/offerings': ok({ items: [], nextCursor: null }),
      },
    });
    render(app.at('/programs'));
    await screen.findByRole('list', { name: 'Programs' });
    await user.type(screen.getByLabelText(/^Program name/), 'Futsal clinic');
    await user.type(screen.getByLabelText(/^Activity type/), 'futsal');
    await user.type(screen.getByLabelText('Minimum age (years)'), '9');
    await user.click(screen.getByRole('button', { name: 'Create program' }));
    expect(await screen.findByRole('heading', { name: 'Futsal clinic' })).toBeInTheDocument();
    const post = app.fake.requests.find((r) => r.method === 'POST' && r.route === '/programs');
    expect(post?.body).toEqual({
      name: 'Futsal clinic',
      activityType: 'futsal',
      ageBand: { minAgeYears: 9 },
      status: 'draft',
    });
    expect(post?.headers['idempotency-key']).toMatch(/^key-\d{8}$/);
  });

  it('checks required fields before sending and keeps the input after a VALIDATION_FAILED answer', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        'GET /programs': LIST,
        'POST /programs': apiError(400, 'VALIDATION_FAILED', {
          message: 'Request validation failed.',
          nextAction: 'correct_input',
          details: [{ path: 'activityType', message: 'Too long', code: 'too_big' }],
        }),
      },
    });
    render(app.at('/programs'));
    await screen.findByRole('list', { name: 'Programs' });
    await user.click(screen.getByRole('button', { name: 'Create program' }));
    expect(screen.getByText('Enter a name.')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Program name/)).toHaveAttribute('aria-invalid', 'true');
    expect(app.fake.requests.some((r) => r.method === 'POST')).toBe(false);

    await user.type(screen.getByLabelText(/^Program name/), 'Futsal clinic');
    await user.type(screen.getByLabelText(/^Activity type/), 'futsal');
    await user.click(screen.getByRole('button', { name: 'Create program' }));
    expect(await screen.findByText(/Error code: VALIDATION_FAILED/)).toBeInTheDocument();
    expect(screen.getAllByText(/Too long/).length).toBeGreaterThan(0);
    expect(screen.getByLabelText(/^Program name/)).toHaveValue('Futsal clinic');
  });

  it('shows a permission restriction as not available, naming the missing permission', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        'GET /programs': apiError(403, 'ACCESS_DENIED', {
          details: { action: 'catalog.list_programs' },
        }),
        'POST /programs': apiError(403, 'ACCESS_DENIED', {
          nextAction: 'contact_support_or_request_access',
          details: { action: 'catalog.manage_programs' },
        }),
      },
    });
    render(app.at('/programs'));
    expect(await screen.findByText('Not available')).toBeInTheDocument();
    await user.type(screen.getByLabelText(/^Program name/), 'Futsal clinic');
    await user.type(screen.getByLabelText(/^Activity type/), 'futsal');
    await user.click(screen.getByRole('button', { name: 'Create program' }));
    expect(await screen.findByText('Not available to you')).toBeInTheDocument();
    expect(screen.getByText(/catalog\.manage_programs/)).toBeInTheDocument();
  });

  it('disables creation offline and keeps what was typed', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: { 'GET /programs': LIST }, online: false });
    render(app.at('/programs'));
    await user.type(await screen.findByLabelText(/^Program name/), 'Futsal clinic');
    expect(screen.getByRole('button', { name: 'Create program' })).toBeDisabled();
    expect(screen.getByText(/creating a program needs a connection/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Program name/)).toHaveValue('Futsal clinic');
    await waitFor(() => expect(app.fake.requests.some((r) => r.method === 'POST')).toBe(false));
  });

  it('§4.5: pages programs with the API cursor and never hides that more exist', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        'GET /programs': (request) =>
          fakeResponse(
            200,
            request.query.cursor === 'p2'
              ? {
                  items: [program({ id: `${PROGRAM_ID.slice(0, -1)}3`, name: 'Summer camp' })],
                  nextCursor: null,
                }
              : { items: [program()], nextCursor: 'p2' },
          ),
      },
    });
    render(app.at('/programs'));
    const list = await screen.findByRole('list', { name: 'Programs' });
    await user.click(screen.getByRole('button', { name: 'Load more programs' }));
    expect(await within(list).findByRole('link', { name: 'Summer camp' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more programs' })).toBeNull();
    expect(
      app.fake.requests.filter((r) => r.route === '/programs').map((r) => r.query.cursor ?? null),
    ).toEqual([null, 'p2']);
  });
});
