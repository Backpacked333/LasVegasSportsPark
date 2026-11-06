/**
 * SCR-C-31 care notes (§1.7 not a medical assessment system, SPK-DISC-005, §4.14, §4.10,
 * SPK-IAM-003): operational notes only, read only when opened (each read is audited), recorded by
 * the person or a holder of `complete_forms`, retired with a reason and the note's revision, and
 * "not available" for a person whose notes the account may not read.
 */
import { fakeResponse, type FakeRequest } from '@sportspark/api-client/testing';
import { fireEvent, render, screen, within } from '@testing-library/react-native';
import { createTestApp } from '../../../testing/test-app';
import {
  apiError,
  CHILD,
  me,
  namesRoute,
  ok,
  page,
  person,
  SELF,
} from '../../account/__tests__/fixtures';
import { NOT_MEDICAL, rolesText } from '../CareNotes';
import { FamilyScreen } from '../FamilyScreen';

const SAM = person(CHILD, 'Sam', 'Morgan', 'child');
const NOTE = '0192f1a0-0000-7000-8000-00000000e001';

function note(overrides: Record<string, unknown> = {}) {
  return {
    id: NOTE,
    personId: CHILD,
    kind: 'allergy',
    body: 'Peanuts: EpiPen in the kit bag',
    status: 'active',
    recordedAt: '2026-10-01T12:00:00.000Z',
    retiredAt: null,
    revision: 3,
    ...overrides,
  };
}

/** The notes API: a list per person, with each record and retirement applied. */
function careNotesApi(initial: Record<string, ReturnType<typeof note>[]>) {
  const notes = { ...initial };
  const list = (personId: string) => ({
    personId,
    notes: notes[personId] ?? [],
    visibleToRoles: ['front_desk', 'program_manager', 'general_manager'],
    readAudited: true,
  });
  return {
    'GET /people/{id}/care-notes': (req: FakeRequest) => fakeResponse(200, list(req.params.id!)),
    'POST /people/{id}/care-notes': (req: FakeRequest) => {
      const body = req.body as { kind: string; body: string };
      const created = note({
        id: '0192f1a0-0000-7000-8000-00000000e002',
        ...body,
        personId: req.params.id,
        revision: 1,
      });
      notes[req.params.id!] = [...(notes[req.params.id!] ?? []), created];
      return fakeResponse(201, created);
    },
    'POST /care-notes/{id}/retire': (req: FakeRequest) => {
      for (const id of Object.keys(notes))
        notes[id] = notes[id]!.filter((n) => n.id !== req.params.id);
      return fakeResponse(200, note({ status: 'retired', revision: 4 }));
    },
  };
}

function familyApp(permissions: string[], routes: Record<string, unknown> = {}) {
  return createTestApp({
    routes: {
      'GET /me': ok(me({ authorities: [{ subjectPersonId: CHILD, permissions }] })),
      'GET /person-names': namesRoute([SAM]),
      'GET /me/access-grants': ok({ items: [], nextCursor: null }),
      'GET /me/households': ok({ items: [] }),
      'GET /me/invitations': page([]),
      ...careNotesApi({ [CHILD]: [note()] }),
      ...(routes as Record<string, never>),
    },
  });
}

describe('SCR-C-31 care notes', () => {
  it('§4.14: notes are read only when opened, say they are not medical advice and who sees them', async () => {
    const app = familyApp(['view', 'complete_forms']);
    render(<FamilyScreen />, { wrapper: app.wrapper });
    const open = await screen.findByRole('button', { name: 'Care notes for Sam Morgan' });
    expect(app.fake.requests.some((r) => r.route === '/people/{id}/care-notes')).toBe(false);

    fireEvent.press(open);
    const box = await screen.findByTestId(`care-notes-${CHILD}`);
    expect(within(box).getByText(NOT_MEDICAL)).toBeOnTheScreen();
    expect(
      await within(box).findByLabelText('Allergy, Peanuts: EpiPen in the kit bag'),
    ).toBeOnTheScreen();
    expect(
      within(box).getByText(
        'Seen by you, other adults allowed to view Sam Morgan, and the front desk, program managers and general managers. Every time the notes are read, it is recorded.',
      ),
    ).toBeOnTheScreen();
  });

  it('SPK-DISC-005: a guardian holding complete_forms records a care instruction; the list shows it', async () => {
    const app = familyApp(['view', 'complete_forms']);
    render(<FamilyScreen />, { wrapper: app.wrapper });
    fireEvent.press(await screen.findByRole('button', { name: 'Care notes for Sam Morgan' }));
    fireEvent.press(await screen.findByRole('button', { name: 'Add a care note' }));
    fireEvent.press(screen.getByRole('button', { name: 'Save care note' }));
    expect(screen.getByText('✕ Choose what kind of note this is.')).toBeOnTheScreen();
    expect(app.fake.requests.some((r) => r.method === 'POST')).toBe(false);

    fireEvent.press(screen.getByRole('radio', { name: 'Care instruction' }));
    fireEvent.changeText(
      screen.getByLabelText('What staff need to know'),
      '  Inhaler before games ',
    );
    fireEvent.press(screen.getByRole('button', { name: 'Save care note' }));
    expect(
      await screen.findByLabelText('Care instruction, Inhaler before games'),
    ).toBeOnTheScreen();
    const post = app.fake.requests.find(
      (r) => r.route === '/people/{id}/care-notes' && r.method === 'POST',
    );
    expect(post?.params.id).toBe(CHILD);
    expect(post?.body).toEqual({ kind: 'care_instruction', body: 'Inhaler before games' });
    expect(post?.headers['idempotency-key']).toBeTruthy();
  });

  it('§4.9: retiring asks for a reason and sends the note’s revision', async () => {
    const app = familyApp(['view', 'complete_forms']);
    render(<FamilyScreen />, { wrapper: app.wrapper });
    fireEvent.press(await screen.findByRole('button', { name: 'Care notes for Sam Morgan' }));
    fireEvent.press(await screen.findByRole('button', { name: 'Retire: Allergy' }));
    fireEvent.press(screen.getByRole('button', { name: 'Retire note' }));
    expect(screen.getByText(/Say why this note no longer applies\./)).toBeOnTheScreen();

    fireEvent.changeText(screen.getByLabelText('Why it no longer applies'), 'Outgrown');
    fireEvent.press(screen.getByRole('button', { name: 'Retire note' }));
    expect(await screen.findByText('No care notes.')).toBeOnTheScreen();
    const retire = app.fake.requests.find((r) => r.route === '/care-notes/{id}/retire');
    expect(retire?.params.id).toBe(NOTE);
    expect(retire?.body).toEqual({ reason: 'Outgrown', expectedRevision: 3 });
  });

  it('SPK-IAM-003: view without complete_forms reads the notes but cannot change them', async () => {
    const app = familyApp(['view']);
    render(<FamilyScreen />, { wrapper: app.wrapper });
    fireEvent.press(await screen.findByRole('button', { name: 'Care notes for Sam Morgan' }));
    expect(
      await screen.findByLabelText('Allergy, Peanuts: EpiPen in the kit bag'),
    ).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Add a care note' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retire: Allergy' })).toBeNull();
  });

  it('§4.10: protected NOT_FOUND is "not available" without saying whether notes exist', async () => {
    const app = familyApp(['view'], {
      'GET /people/{id}/care-notes': () =>
        apiError(404, 'NOT_FOUND', { nextAction: 'verify_reference' }),
    });
    render(<FamilyScreen />, { wrapper: app.wrapper });
    fireEvent.press(await screen.findByRole('button', { name: 'Care notes for Sam Morgan' }));
    const box = await screen.findByTestId(`care-notes-${CHILD}`);
    expect(await within(box).findByText('Not available')).toBeOnTheScreen();
    expect(within(box).queryByText(/Peanuts/)).toBeNull();
  });

  it('one’s own notes are behind "Show your care notes" and can be recorded', async () => {
    const app = familyApp(['view']);
    render(<FamilyScreen />, { wrapper: app.wrapper });
    fireEvent.press(await screen.findByRole('button', { name: 'Show your care notes' }));
    const box = await screen.findByTestId(`care-notes-${SELF}`);
    expect(await within(box).findByText('No care notes.')).toBeOnTheScreen();
    expect(within(box).getByRole('button', { name: 'Add a care note' })).toBeOnTheScreen();
    expect(rolesText(['front_desk'])).toBe('the front desk');
  });
});
