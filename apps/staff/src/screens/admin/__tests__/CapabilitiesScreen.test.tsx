/**
 * SCR-S-47 capability switches (§1.6, §6.5 Package G; K-12, DEC-016, DEC-072 to DEC-082): every
 * switch from `GET /v1/admin/capabilities` with its state as text, enforcement, DEC-016 and its own
 * decision; turning one on or off only for `core.manage_capabilities` (system administrators),
 * naming one of its applicability decisions with a reason, the revision as `expectedRevision` once
 * it has one and one Idempotency-Key per intent (reused on retry); NOT_AN_APPLICABILITY_DECISION,
 * STALE_REVISION (Reload) and ACCESS_DENIED shown with their codes; `GET /v1/me/permissions`
 * re-read after a change; the audit history read on request; offline read-only.
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  NOW_ISO,
  PERSON_1,
  auditRecord,
  capability,
  ok,
  page,
} from '../../../features/insight-admin/__tests__/fixtures';
import { formatInstant } from '../../../features/insight-admin/format';
import { createTestApp, mePermissions } from '../../../testing/test-app';

const ADMIN = mePermissions({
  staffRoles: ['system_administrator'],
  actions: ['core.view_capabilities', 'core.manage_capabilities'],
});

function capabilities(...items: ReturnType<typeof capability>[]) {
  return ok({ items });
}

function app(routes: Record<string, FakeHandler> = {}, online = true) {
  return createTestApp({
    online,
    routes: {
      'GET /me/permissions': ADMIN,
      'GET /admin/capabilities': capabilities(
        capability('rentals'),
        capability('installments', {
          enforcement: 'recorded_only',
          applicabilityReferences: ['DEC-016', 'DEC-073'],
          relatedDecisions: ['DEC-008'],
          owningModules: ['finance'],
        }),
      ),
      'GET /person-names': ok({ items: [] }),
      ...routes,
    },
  });
}

async function row(name: string) {
  const list = await screen.findByRole('list', { name: 'Capability switches' });
  return within(list).getByRole('listitem', { name }) as HTMLElement;
}

describe('SCR-S-47 CapabilitiesScreen', () => {
  it('DEC-016: lists every switch off as text with its decisions, owner and enforcement', async () => {
    render(app().at('/admin/capabilities'));
    const rentals = await row('Rentals');
    expect(within(rentals).getByText('Rentals turned off')).toBeInTheDocument();
    expect(
      within(rentals).getByText(
        /Decided by DEC-016 and its own decision DEC-076 \(owner: Product owner\)/,
      ),
    ).toBeInTheDocument();
    expect(within(rentals).getByText(/New commitments check this switch/)).toBeInTheDocument();
    expect(
      within(rentals).getByText('Never changed: off since the start, as every switch is.'),
    ).toBeInTheDocument();
    const installments = await row('Installment plans');
    expect(
      within(installments).getByText(/Recorded only: nothing checks this switch/),
    ).toBeInTheDocument();
    expect(
      within(installments).getByText(/Shaped by DEC-008, which never turn it on/),
    ).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('0 of 2 switches turned on.');
    const note = screen.getByTestId('pending-note');
    expect(note).toHaveTextContent('DEC-016');
    expect(note).toHaveTextContent('Product owner');
    const nav = screen.getByRole('navigation', { name: 'Administration pages' });
    expect(within(nav).getByRole('link', { name: 'Capability switches' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('turns a switch on naming its own decision, with a reason and an idempotency key, and re-reads permissions', async () => {
    const user = userEvent.setup();
    let enabled = false;
    const test = app({
      'GET /admin/capabilities': () =>
        fakeResponse(200, {
          items: [
            enabled
              ? capability('rentals', {
                  enabled: true,
                  decisionReference: 'DEC-076',
                  reason: 'Rentals approved for spring',
                  changedByPersonId: PERSON_1,
                  changedAt: NOW_ISO,
                  revision: 1,
                })
              : capability('rentals'),
          ],
        }),
      'POST /admin/capabilities/{capability}/enable': () => {
        enabled = true;
        return fakeResponse(
          200,
          capability('rentals', {
            enabled: true,
            decisionReference: 'DEC-076',
            revision: 1,
            changedAt: NOW_ISO,
          }),
        );
      },
      'GET /person-names': ok({
        items: [
          {
            personId: PERSON_1,
            canonicalPersonId: PERSON_1,
            givenName: 'Sam',
            familyName: 'Admin',
            displayName: 'Sam Admin',
            kind: 'adult',
          },
        ],
      }),
    });
    render(test.at('/admin/capabilities'));
    const rentals = await row('Rentals');
    await user.click(within(rentals).getByRole('button', { name: 'Turn on Rentals' }));
    const form = within(rentals).getByRole('form', { name: 'Turn on Rentals' });
    // No decision is preselected.
    expect(within(form).getByRole('radio', { name: /DEC-016/ })).not.toBeChecked();
    expect(within(form).getByRole('radio', { name: /DEC-076/ })).not.toBeChecked();
    await user.click(within(form).getByRole('radio', { name: /DEC-076/ }));
    await user.type(
      within(form).getByLabelText('Reason (required)'),
      'Rentals approved for spring',
    );
    const permissionReads = test.fake.requests.filter((r) => r.route === '/me/permissions').length;
    await user.click(within(form).getByRole('button', { name: 'Turn on Rentals' }));
    expect(await screen.findByText('Rentals turned on (DEC-076)')).toBeInTheDocument();
    const post = test.fake.requests.find(
      (r) => r.route === '/admin/capabilities/{capability}/enable',
    );
    expect(post?.params).toEqual({ capability: 'rentals' });
    expect(post?.body).toEqual({
      decisionReference: 'DEC-076',
      reason: 'Rentals approved for spring',
    });
    expect(post?.headers['idempotency-key']).toMatch(/^key-\d{8}$/);
    await waitFor(() =>
      expect(
        test.fake.requests.filter((r) => r.route === '/me/permissions').length,
      ).toBeGreaterThan(permissionReads),
    );
    const updated = await row('Rentals');
    expect(await within(updated).findByText('Rentals turned on')).toBeInTheDocument();
    expect(
      await within(updated).findByText(
        `Last change ${formatInstant(NOW_ISO)} naming DEC-076 by Sam Admin: Rentals approved for spring · revision 1`,
      ),
    ).toBeInTheDocument();
  });

  it('turns a switch off with its current revision as the expected revision', async () => {
    const user = userEvent.setup();
    const test = app({
      'GET /admin/capabilities': capabilities(
        capability('rentals', {
          enabled: true,
          decisionReference: 'DEC-016',
          revision: 3,
          changedAt: NOW_ISO,
        }),
      ),
      'POST /admin/capabilities/{capability}/disable': ok(
        capability('rentals', { enabled: false, decisionReference: 'DEC-016', revision: 4 }),
      ),
    });
    render(test.at('/admin/capabilities'));
    const rentals = await row('Rentals');
    await user.click(within(rentals).getByRole('button', { name: 'Turn off Rentals' }));
    const form = within(rentals).getByRole('form', { name: 'Turn off Rentals' });
    await user.click(within(form).getByRole('radio', { name: /DEC-016/ }));
    await user.type(within(form).getByLabelText('Reason (required)'), 'Season ended');
    await user.click(within(form).getByRole('button', { name: 'Turn off Rentals' }));
    await waitFor(() =>
      expect(
        test.fake.requests.find((r) => r.route === '/admin/capabilities/{capability}/disable')
          ?.body,
      ).toEqual({ decisionReference: 'DEC-016', reason: 'Season ended', expectedRevision: 3 }),
    );
    expect(await screen.findByText('Rentals turned off (DEC-016)')).toBeInTheDocument();
  });

  it('validates the decision and the reason before sending anything', async () => {
    const user = userEvent.setup();
    const test = app();
    render(test.at('/admin/capabilities'));
    const rentals = await row('Rentals');
    await user.click(within(rentals).getByRole('button', { name: 'Turn on Rentals' }));
    const form = within(rentals).getByRole('form', { name: 'Turn on Rentals' });
    await user.click(within(form).getByRole('button', { name: 'Turn on Rentals' }));
    expect(within(form).getByText('Choose the decision that settles this.')).toBeInTheDocument();
    expect(within(form).getByText('Enter the reason for this change.')).toBeInTheDocument();
    expect(test.fake.requests.some((r) => r.method === 'POST')).toBe(false);
  });

  it('shows NOT_AN_APPLICABILITY_DECISION with its code and the decisions that apply', async () => {
    const user = userEvent.setup();
    render(
      app({
        'POST /admin/capabilities/{capability}/enable': () =>
          fakeResponse(
            400,
            apiErrorBody('VALIDATION_FAILED', {
              message: 'DEC-057 does not decide whether point_of_sale applies.',
              details: { code: 'NOT_AN_APPLICABILITY_DECISION', capability: 'rentals' },
            }),
          ),
      }).at('/admin/capabilities'),
    );
    const rentals = await row('Rentals');
    await user.click(within(rentals).getByRole('button', { name: 'Turn on Rentals' }));
    const form = within(rentals).getByRole('form', { name: 'Turn on Rentals' });
    await user.click(within(form).getByRole('radio', { name: /DEC-076/ }));
    await user.type(within(form).getByLabelText('Reason (required)'), 'Approved');
    await user.click(within(form).getByRole('button', { name: 'Turn on Rentals' }));
    expect(
      await within(form).findByText(
        'Error code: VALIDATION_FAILED. Reference: test-correlation-id',
      ),
    ).toBeInTheDocument();
    expect(
      within(form).getByText('Only DEC-016 or DEC-076 can turn rentals on or off.'),
    ).toBeInTheDocument();
  });

  it('STALE_REVISION offers Reload, which re-reads the switch and keeps what was typed; the next attempt sends the new revision', async () => {
    const user = userEvent.setup();
    let reloaded = false;
    let posts = 0;
    const test = app({
      'GET /admin/capabilities': () =>
        fakeResponse(200, {
          items: [
            capability('rentals', {
              enabled: true,
              decisionReference: 'DEC-016',
              changedByPersonId: PERSON_1,
              changedAt: NOW_ISO,
              revision: reloaded ? 4 : 3,
            }),
          ],
        }),
      'POST /admin/capabilities/{capability}/disable': () => {
        posts += 1;
        if (posts === 1) {
          reloaded = true;
          return fakeResponse(
            409,
            apiErrorBody('STALE_REVISION', {
              nextAction: 'reload_and_retry',
              message: 'The capability changed.',
              details: { expectedRevision: 3, currentRevision: 4 },
            }),
          );
        }
        return fakeResponse(
          200,
          capability('rentals', { enabled: false, decisionReference: 'DEC-076', revision: 5 }),
        );
      },
    });
    render(test.at('/admin/capabilities'));
    const rentals = await row('Rentals');
    await user.click(within(rentals).getByRole('button', { name: 'Turn off Rentals' }));
    const form = within(rentals).getByRole('form', { name: 'Turn off Rentals' });
    await user.click(within(form).getByRole('radio', { name: /DEC-076/ }));
    await user.type(within(form).getByLabelText('Reason (required)'), 'Season ended');
    await user.click(within(form).getByRole('button', { name: 'Turn off Rentals' }));
    expect(await within(form).findByText(/Error code: STALE_REVISION/)).toBeInTheDocument();
    await user.click(within(form).getByRole('button', { name: 'Reload' }));
    expect(
      await within(rentals).findByText(/Reloaded: Rentals is still turned on .*revision 4\)/),
    ).toBeInTheDocument();
    // The same form, with what was typed.
    const kept = within(rentals).getByRole('form', { name: 'Turn off Rentals' });
    expect(within(kept).getByLabelText('Reason (required)')).toHaveValue('Season ended');
    expect(within(kept).getByRole('radio', { name: /DEC-076/ })).toBeChecked();
    await user.click(within(kept).getByRole('button', { name: 'Turn off Rentals' }));
    await waitFor(() => expect(posts).toBe(2));
    const sent = test.fake.requests.filter(
      (r) => r.route === '/admin/capabilities/{capability}/disable',
    );
    expect(sent[0]?.body).toEqual({
      decisionReference: 'DEC-076',
      reason: 'Season ended',
      expectedRevision: 3,
    });
    expect(sent[1]?.body).toEqual({
      decisionReference: 'DEC-076',
      reason: 'Season ended',
      expectedRevision: 4,
    });
    // A refused attempt ended its intent: the second one is a new intent with a new key.
    expect(sent[1]?.headers['idempotency-key']).not.toBe(sent[0]?.headers['idempotency-key']);
    expect(await screen.findByText('Rentals turned off (DEC-076)')).toBeInTheDocument();
  });

  it('INVALID_TRANSITION: after Reload the form says the switch was changed meanwhile and keeps the reason', async () => {
    const user = userEvent.setup();
    let changedElsewhere = false;
    const test = app({
      'GET /admin/capabilities': () =>
        fakeResponse(200, {
          items: [
            changedElsewhere
              ? capability('rentals', {
                  enabled: true,
                  decisionReference: 'DEC-076',
                  reason: 'Approved',
                  changedByPersonId: PERSON_1,
                  changedAt: NOW_ISO,
                  revision: 1,
                })
              : capability('rentals'),
          ],
        }),
      'POST /admin/capabilities/{capability}/enable': () => {
        changedElsewhere = true;
        return fakeResponse(
          409,
          apiErrorBody('INVALID_TRANSITION', {
            nextAction: 'reload_and_retry',
            message: 'The capability is already enabled.',
          }),
        );
      },
    });
    render(test.at('/admin/capabilities'));
    const rentals = await row('Rentals');
    await user.click(within(rentals).getByRole('button', { name: 'Turn on Rentals' }));
    const form = within(rentals).getByRole('form', { name: 'Turn on Rentals' });
    await user.click(within(form).getByRole('radio', { name: /DEC-076/ }));
    await user.type(within(form).getByLabelText('Reason (required)'), 'Approved for spring');
    await user.click(within(form).getByRole('button', { name: 'Turn on Rentals' }));
    expect(await within(form).findByText(/Error code: INVALID_TRANSITION/)).toBeInTheDocument();
    // Never changed: no revision was sent.
    expect(
      test.fake.requests.find((r) => r.route === '/admin/capabilities/{capability}/enable')?.body,
    ).toEqual({ decisionReference: 'DEC-076', reason: 'Approved for spring' });
    await user.click(within(form).getByRole('button', { name: 'Reload' }));
    const note = await within(rentals).findByTestId('capability-changed');
    expect(note).toHaveTextContent(
      'Changed since you opened this form: Rentals is now turned on (last change',
    );
    expect(note).toHaveTextContent('revision 1');
    expect(note).toHaveTextContent('sending this form now turns it off');
    const flipped = within(rentals).getByRole('form', { name: 'Turn off Rentals' });
    expect(within(flipped).getByLabelText('Reason (required)')).toHaveValue('Approved for spring');
    expect(within(flipped).getByRole('button', { name: 'Turn off Rentals' })).toBeInTheDocument();
    // Nothing more was sent without the administrator.
    expect(test.fake.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
  });

  it('§4.9: a change that got no answer is retried with the same idempotency key', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const test = app({
      'POST /admin/capabilities/{capability}/enable': () => {
        calls += 1;
        if (calls === 1) throw new TypeError('connection dropped');
        return fakeResponse(200, capability('rentals', { enabled: true, revision: 1 }));
      },
    });
    render(test.at('/admin/capabilities'));
    const rentals = await row('Rentals');
    await user.click(within(rentals).getByRole('button', { name: 'Turn on Rentals' }));
    const form = within(rentals).getByRole('form', { name: 'Turn on Rentals' });
    await user.click(within(form).getByRole('radio', { name: /DEC-076/ }));
    await user.type(within(form).getByLabelText('Reason (required)'), 'Approved');
    await user.click(within(form).getByRole('button', { name: 'Turn on Rentals' }));
    await user.click(await within(form).findByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(calls).toBe(2));
    const [first, second] = test.fake.requests.filter(
      (r) => r.route === '/admin/capabilities/{capability}/enable',
    );
    expect(second?.headers['idempotency-key']).toBe(first?.headers['idempotency-key']);
  });

  it('offers no change without core.manage_capabilities, and the API refusal is shown with its message', async () => {
    render(
      app({ 'GET /me/permissions': mePermissions({ actions: ['core.view_capabilities'] }) }).at(
        '/admin/capabilities',
      ),
    );
    const rentals = await row('Rentals');
    expect(
      await within(rentals).findByText(
        'Not available to you: only a system administrator turns a switch on or off.',
      ),
    ).toBeInTheDocument();
    expect(within(rentals).queryByRole('button', { name: 'Turn on Rentals' })).toBeNull();
  });

  it('shows the switches the API refuses as not available to the viewer', async () => {
    render(
      app({
        'GET /admin/capabilities': () =>
          fakeResponse(
            403,
            apiErrorBody('ACCESS_DENIED', {
              message: 'You are not permitted to perform this action.',
            }),
          ),
      }).at('/admin/capabilities'),
    );
    expect(await screen.findByText('Not available to you')).toBeInTheDocument();
    expect(screen.getByText(/You are not permitted to perform this action\./)).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Capability switches' })).toBeNull();
  });

  it('a refused change (ACCESS_DENIED) keeps the form and says it is not available to you', async () => {
    const user = userEvent.setup();
    render(
      app({
        'POST /admin/capabilities/{capability}/enable': () =>
          fakeResponse(
            403,
            apiErrorBody('ACCESS_DENIED', { message: 'Only system administrators may do this.' }),
          ),
      }).at('/admin/capabilities'),
    );
    const rentals = await row('Rentals');
    await user.click(within(rentals).getByRole('button', { name: 'Turn on Rentals' }));
    const form = within(rentals).getByRole('form', { name: 'Turn on Rentals' });
    await user.click(within(form).getByRole('radio', { name: /DEC-076/ }));
    await user.type(within(form).getByLabelText('Reason (required)'), 'Approved');
    await user.click(within(form).getByRole('button', { name: 'Turn on Rentals' }));
    expect(await within(form).findByText('Not available to you')).toBeInTheDocument();
    expect(within(form).getByLabelText('Reason (required)')).toHaveValue('Approved');
  });

  it('§4.14: reads a switch audit history only when asked', async () => {
    const user = userEvent.setup();
    const test = app({
      'GET /audit-records': page([
        auditRecord(1, {
          action: 'core.manage_capabilities.enable',
          targetType: 'capability',
          targetId: 'rentals',
          beforeRevision: null,
          afterRevision: 1,
          details: { capability: 'rentals', enabled: true, decisionReference: 'DEC-076' },
        }),
      ]),
    });
    render(test.at('/admin/capabilities'));
    const rentals = await row('Rentals');
    expect(test.fake.requests.some((r) => r.route === '/audit-records')).toBe(false);
    await user.click(
      within(rentals).getByRole('button', { name: 'Show audit history of Rentals' }),
    );
    const history = await within(rentals).findByRole('list', { name: 'Audit history of Rentals' });
    expect(within(history).getByText(/core\.manage_capabilities\.enable/)).toBeInTheDocument();
    expect(within(history).getByText(/revision 1/)).toBeInTheDocument();
    expect(test.fake.requests.find((r) => r.route === '/audit-records')?.query).toMatchObject({
      targetType: 'capability',
      targetId: 'rentals',
    });
  });

  it('offline with nothing loaded: says so and that changes need a connection', async () => {
    render(app({}, false).at('/admin/capabilities'));
    expect(
      await screen.findByText(/Needs a connection: turning a capability on or off/),
    ).toBeInTheDocument();
    expect(screen.getAllByText('You are offline').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Turn on Rentals' })).toBeNull();
  });
});
