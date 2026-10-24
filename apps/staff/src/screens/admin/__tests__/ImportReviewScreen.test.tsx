/**
 * SCR-S-48 Import review queue: §5.4 ambiguous relationships and balances in review queues with
 * their owner (SPK-UX-008 recovery required), filters sent to the API, an ambiguous relationship
 * accepted only by narrowing the staged permissions, and an empty queue said plainly.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { importException, ok, page } from '../../../features/insight-admin/__tests__/fixtures';
import { createTestApp } from '../../../testing/test-app';

describe('SCR-S-48 ImportReviewScreen', () => {
  it('lists open exceptions with their review owner and filters by owner', async () => {
    const user = userEvent.setup();
    const test = createTestApp({
      routes: {
        'GET /import-exceptions': page([
          importException('ambiguous_balance'),
          importException('ambiguous_relationship', { id: 'e2', externalId: 'R-9' }),
        ]),
      },
    });
    render(test.at('/admin/migration/review'));
    const list = await screen.findByRole('list', { name: 'Import exceptions' });
    expect(within(list).getByText(/Review owner: Finance operator/)).toBeInTheDocument();
    expect(within(list).getByText(/Review owner: Support operator/)).toBeInTheDocument();
    expect(test.fake.requests.find((r) => r.route === '/import-exceptions')?.query).toMatchObject({
      status: 'open',
    });
    await user.selectOptions(screen.getByLabelText('Review owner'), 'finance_operator');
    await waitFor(() =>
      expect(
        test.fake.requests.some(
          (r) => r.route === '/import-exceptions' && r.query.reviewOwnerRole === 'finance_operator',
        ),
      ).toBe(true),
    );
  });

  it('accepts an ambiguous relationship only by narrowing the staged permissions', async () => {
    const user = userEvent.setup();
    const test = createTestApp({
      routes: {
        'GET /import-exceptions': page([importException('ambiguous_relationship')]),
        'POST /import-exceptions/{id}/decide': ok(
          importException('ambiguous_relationship', { status: 'decided', decision: 'accept' }),
        ),
      },
    });
    render(test.at('/admin/migration/review'));
    await user.click(
      await screen.findByRole('button', { name: 'Decide Ambiguous relationship X-3' }),
    );
    const form = screen.getByRole('form', { name: /Decide exception/ });
    await user.click(within(form).getByRole('radio', { name: 'Accept' }));
    await user.click(within(form).getByRole('checkbox', { name: 'View' }));
    await user.type(
      within(form).getByLabelText('Reason (required)'),
      'Documented by the program manager',
    );
    await user.click(within(form).getByRole('button', { name: 'Record decision' }));
    expect(await screen.findByText(/Exception decided: accept/)).toBeInTheDocument();
    const post = test.fake.requests.find((r) => r.route === '/import-exceptions/{id}/decide');
    expect(post?.body).toEqual({
      decision: 'accept',
      reason: 'Documented by the program manager',
      expectedRevision: 4,
      resolution: { permissions: ['view'] },
    });
    expect(post?.headers['idempotency-key']).toMatch(/^key-/);
  });

  it('says so when nothing waits for review', async () => {
    render(
      createTestApp({ routes: { 'GET /import-exceptions': page([]) } }).at(
        '/admin/migration/review',
      ),
    );
    expect(await screen.findByRole('heading', { name: 'Nothing to review' })).toBeInTheDocument();
  });
});
