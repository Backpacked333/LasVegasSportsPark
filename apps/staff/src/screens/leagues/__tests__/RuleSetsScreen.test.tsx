/**
 * SCR-S-08 rule sets (SPK-COMP-002 every listed rule, irrelevant format fields disabled;
 * SPK-RESULT-003 versioned rule sets; SPK-UX-008 validation failure; SPK-UX-009 keyboard-operable
 * tiebreaker order). Nothing is preset (DEC-002 pending).
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../../../testing/test-app';
import {
  ID,
  created,
  fail,
  ok,
  ruleSet,
  ruleSetContent,
} from '../../../features/competition/__tests__/fixtures';
import { buildContent, contentFieldErrors, draftFromContent, emptyDraft } from '../rule-set-form';

describe('SCR-S-08 rule-set form model (SPK-COMP-002)', () => {
  it('round-trips a stored version into the next version unchanged', () => {
    const content = ruleSetContent();
    const built = buildContent('indoor_boarded', draftFromContent(content as never));
    expect(built.errors).toEqual({});
    expect(built.content).toEqual(content);
  });

  it('presets nothing: an empty draft lists every unanswered rule', () => {
    const built = buildContent('outdoor', emptyDraft());
    expect(built.content).toBeNull();
    expect(built.errors.playersOnField).toBe('Enter a whole number.');
    expect(built.errors['substitutions.unlimited']).toBe('Choose yes or no.');
    expect(built.errors.tiebreakers).toBe('Add at least one tiebreaker.');
    expect(built.errors['resultApproval.approveRoles']).toBe('Choose at least one role.');
    expect(built.errors['outdoor.offside']).toBe('Choose yes or no.');
    // A section that does not apply to the format is never asked for.
    expect(built.errors['futsal.kickIns']).toBeUndefined();
    // Sin bins do not apply to outdoor soccer.
    expect(built.errors['cards.sinBinMinutes']).toBeUndefined();
  });

  it('sends the sections of other formats as null and forces rolling substitutions indoors', () => {
    const draft = draftFromContent(
      ruleSetContent({
        substitutions: { unlimited: true, maxPerMatch: null, rolling: false, reEntryAllowed: true },
      }) as never,
    );
    const built = buildContent('indoor_boarded', draft);
    expect(built.content?.substitutions.rolling).toBe(true);
    expect(built.content?.outdoor).toBeNull();
    expect(built.content?.futsal).toBeNull();
    expect(built.content?.smallSidedOther).toBeNull();
  });

  it('maps API field paths onto form fields', () => {
    expect(contentFieldErrors({ 'content.cards.sinBinMinutes': 'x', name: 'y' })).toEqual({
      'cards.sinBinMinutes': 'x',
      name: 'y',
    });
  });
});

describe('SCR-S-08 RuleSetsScreen (SPK-COMP-002, SPK-RESULT-003)', () => {
  it('lists the latest versions and names the pending DEC-002', async () => {
    const app = createTestApp({ routes: { 'GET /rule-sets': ok([ruleSet()]) } });
    render(app.at('/leagues/rule-sets'));
    const list = await screen.findByRole('list', { name: 'Rule sets' });
    expect(within(list).getByText('Indoor 6v6, version 1')).toBeInTheDocument();
    expect(app.fake.requests.find((r) => r.route === '/rule-sets')?.query).toEqual({
      latestOnly: 'true',
    });
    expect(screen.getByText(/depends on DEC-002/)).toBeInTheDocument();
  });

  it('disables the sections that do not apply to the chosen format', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: { 'GET /rule-sets': ok([]) } });
    render(app.at('/leagues/rule-sets'));
    await user.click(await screen.findByRole('button', { name: 'New rule set' }));
    const form = screen.getByRole('form', { name: 'New rule set' });
    // Before a format is chosen every rule is disabled.
    expect(within(form).getByRole('group', { name: 'Players and match length' })).toBeDisabled();
    await user.selectOptions(within(form).getByLabelText(/^Format \(required\)/), 'futsal');
    expect(within(form).getByRole('group', { name: 'Futsal rules' })).toBeEnabled();
    expect(within(form).getByRole('group', { name: 'Outdoor soccer rules' })).toBeDisabled();
    expect(within(form).getByRole('group', { name: 'Boarded indoor soccer rules' })).toBeDisabled();
    expect(
      within(form).getAllByText(
        'Does not apply to Futsal: these fields stay disabled and are not saved.',
      ),
    ).toHaveLength(3);
  });

  it('refuses to send an incomplete rule set and keeps the input', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: { 'GET /rule-sets': ok([]) } });
    render(app.at('/leagues/rule-sets'));
    await user.click(await screen.findByRole('button', { name: 'New rule set' }));
    const form = screen.getByRole('form', { name: 'New rule set' });
    await user.type(within(form).getByLabelText(/^Rule set name/), 'Futsal open');
    await user.selectOptions(within(form).getByLabelText(/^Format \(required\)/), 'futsal');
    await user.click(within(form).getByRole('button', { name: 'Create rule set' }));
    expect(within(form).getByText(/answers need attention/)).toBeInTheDocument();
    expect(within(form).getByLabelText(/^Rule set name/)).toHaveValue('Futsal open');
    expect(app.fake.requests.some((r) => r.method === 'POST')).toBe(false);
  });

  it('saves the next version prefilled from the version it supersedes', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        'GET /rule-sets': ok([ruleSet()]),
        'POST /rule-sets': created(ruleSet({ version: 2, id: ID.season })),
      },
    });
    render(app.at('/leagues/rule-sets'));
    await user.click(await screen.findByRole('button', { name: 'New version of Indoor 6v6' }));
    const form = screen.getByRole('form', { name: 'New version of Indoor 6v6' });
    const protest = within(form).getByLabelText(/^Protest deadline/);
    expect(protest).toHaveValue('48');
    await user.clear(protest);
    await user.type(protest, '72');
    await user.click(within(form).getByRole('button', { name: 'Save version 2' }));
    expect(await within(form).findByText('Indoor 6v6, version 2 saved')).toBeInTheDocument();
    const post = app.fake.requests.find((r) => r.method === 'POST');
    const body = post?.body as {
      name: string;
      format: string;
      content: { protestDeadlineHours: number };
    };
    expect(body.name).toBe('Indoor 6v6');
    expect(body.format).toBe('indoor_boarded');
    expect(body.content.protestDeadlineHours).toBe(72);
    expect(post?.headers['idempotency-key']).toMatch(/^key-/);
  });

  it('shows the API’s field messages for an invalid rule set', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        'GET /rule-sets': ok([ruleSet()]),
        'POST /rule-sets': fail(400, 'VALIDATION_FAILED', 'correct_input', {
          message: 'Request validation failed.',
          details: [{ path: 'content.rosterMin', message: 'rosterMin exceeds rosterMax' }],
        }),
      },
    });
    render(app.at('/leagues/rule-sets'));
    await user.click(await screen.findByRole('button', { name: 'New version of Indoor 6v6' }));
    const form = screen.getByRole('form', { name: 'New version of Indoor 6v6' });
    await user.click(within(form).getByRole('button', { name: 'Save version 2' }));
    await waitFor(() =>
      expect(within(form).getAllByText('rosterMin exceeds rosterMax').length).toBeGreaterThan(0),
    );
    expect(within(form).getByLabelText(/^Roster minimum/)).toHaveAttribute('aria-invalid', 'true');
    expect(within(form).getByText(/Error code: VALIDATION_FAILED/)).toBeInTheDocument();
  });

  it('orders tiebreakers with keyboard-operable Move buttons', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: { 'GET /rule-sets': ok([ruleSet()]) } });
    render(app.at('/leagues/rule-sets'));
    await user.click(await screen.findByRole('button', { name: 'New version of Indoor 6v6' }));
    const order = screen.getByRole('list', { name: 'Tiebreaker order' });
    expect(within(order).getAllByRole('listitem')[0]).toHaveTextContent('Points');
    await user.click(within(order).getByRole('button', { name: /Move Goal difference up/ }));
    const items = within(order).getAllByRole('listitem');
    expect(items[1]).toHaveTextContent('Goal difference');
  });
});
