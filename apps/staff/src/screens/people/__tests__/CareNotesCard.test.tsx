/**
 * Care notes on the person record (migration 0181; §1.7 operational notes only, SPK-DISC-005,
 * §4.14 protected and audited, §4.10 not available without saying whether notes exist).
 */
import { fakeResponse } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createTestApp, mePermissions } from '../../../testing/test-app';
import { PERSON_ID, person, timeline } from './fixtures';

const NOTE_ID = '0192f1a0-0000-7000-8000-0000000001f1';

function careNotes(notes: unknown[] = []) {
  return {
    personId: PERSON_ID,
    notes,
    visibleToRoles: ['front_desk', 'program_manager', 'general_manager'],
    readAudited: true,
  };
}
const allergy = {
  id: NOTE_ID,
  personId: PERSON_ID,
  kind: 'allergy',
  body: 'Peanuts: EpiPen in the kit bag',
  status: 'active',
  recordedAt: '2026-10-20T16:00:00.000Z',
  retiredAt: null,
  revision: 1,
};

describe('SCR-S-20 care notes card', () => {
  it('§4.14: shows the protected notes, who may see them and that every view is audited', async () => {
    const app = createTestApp({
      routes: {
        'GET /me/permissions': mePermissions({ actions: ['identity.read_care_notes'] }),
        'GET /people/{id}': { status: 200, body: person() },
        'GET /customers/{personId}/timeline': { status: 200, body: timeline() },
        'GET /people/{id}/care-notes': { status: 200, body: careNotes([allergy]) },
      },
    });
    render(app.at(`/people/${PERSON_ID}`));
    const card = await screen.findByRole('region', { name: 'Care notes' });
    const list = await within(card).findByRole('list', { name: 'Care notes' });
    expect(within(list).getByText(/Peanuts: EpiPen in the kit bag/)).toBeInTheDocument();
    expect(within(card).getByText('Protected')).toBeInTheDocument();
    expect(within(card).getByText(/Visible to:/).parentElement).toHaveTextContent(
      /front desk.*program manager.*general manager/i,
    );
    expect(within(card).getByText(/recorded in the audit log/)).toBeInTheDocument();
    // Reading only: nothing to record or retire without the manage permission.
    expect(within(card).queryByRole('button', { name: /Retire/ })).toBeNull();
    expect(within(card).queryByRole('form', { name: 'Add a care note' })).toBeNull();
  });

  it('§4.10: without the read permission the card says not available and never asks the API', async () => {
    const app = createTestApp({
      routes: {
        'GET /people/{id}': { status: 200, body: person() },
        'GET /customers/{personId}/timeline': { status: 200, body: timeline() },
      },
    });
    render(app.at(`/people/${PERSON_ID}`));
    const card = await screen.findByRole('region', { name: 'Care notes' });
    expect(
      await within(card).findByText('Care notes are not available to you.'),
    ).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.route === '/people/{id}/care-notes')).toBe(false);
  });

  it('§1.7: records an operational note and retires one with a reason and its revision', async () => {
    const user = userEvent.setup();
    let reads = 0;
    const app = createTestApp({
      routes: {
        'GET /me/permissions': mePermissions({
          actions: ['identity.read_care_notes', 'identity.manage_care_notes'],
        }),
        'GET /people/{id}': { status: 200, body: person() },
        'GET /customers/{personId}/timeline': { status: 200, body: timeline() },
        'GET /people/{id}/care-notes': () => {
          reads += 1;
          return fakeResponse(200, careNotes([allergy]));
        },
        'POST /people/{id}/care-notes': {
          status: 201,
          body: { ...allergy, id: `${NOTE_ID.slice(0, -1)}2`, kind: 'care_instruction' },
        },
        'POST /care-notes/{id}/retire': {
          status: 200,
          body: { ...allergy, status: 'retired', revision: 2 },
        },
      },
    });
    render(app.at(`/people/${PERSON_ID}`));
    const card = await screen.findByRole('region', { name: 'Care notes' });
    const form = await within(card).findByRole('form', { name: 'Add a care note' });
    expect(within(form).getByText(/Not a diagnosis or medical advice/)).toBeInTheDocument();
    await user.selectOptions(within(form).getByLabelText(/Kind of note/), 'care_instruction');
    await user.type(
      within(form).getByLabelText(/What staff need to know and do/),
      'Inhaler before running drills',
    );
    await user.click(within(form).getByRole('button', { name: 'Record care note' }));
    expect(await within(card).findByText('Care note recorded.')).toBeInTheDocument();
    const posted = app.fake.requests.find(
      (r) => r.route === '/people/{id}/care-notes' && r.method === 'POST',
    );
    expect(posted?.body).toEqual({
      kind: 'care_instruction',
      body: 'Inhaler before running drills',
    });
    expect(posted?.headers['idempotency-key']).toMatch(/^key-/);

    await user.click(within(card).getByRole('button', { name: 'Retire allergy note' }));
    await user.type(within(card).getByLabelText(/Why is this note retired/), 'outgrown');
    await user.click(within(card).getByRole('button', { name: 'Retire note' }));
    expect(await within(card).findByText('Allergy note retired.')).toBeInTheDocument();
    const retired = app.fake.requests.find((r) => r.route === '/care-notes/{id}/retire');
    expect(retired?.body).toEqual({ reason: 'outgrown', expectedRevision: 1 });
    await waitFor(() => expect(reads).toBeGreaterThan(1));
  });
});
