/**
 * Message templates, sequences and the message schedule of a season or an offering
 * (SPK-COMMS-009, proposed amendment PA-05; capability `message_sequences`, DEC-099 pending):
 * templates (list, create, edit), sequences (list, create, steps), and the schedule with preview,
 * edit, skip, confirm and what was sent.
 */
import { type FakeHandler } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { formatInstant } from '../../../../features/operations/format';
import { oneFacilityMe } from '../../../../features/operations/testing';
import { FACILITY_A, createTestApp, mePermissions } from '../../../../testing/test-app';
import { MessageScheduleLink } from '../MessageScheduleLink';

const TEMPLATE = '0192f1a0-0000-7000-8000-000000000a01';
const TEMPLATE_2 = '0192f1a0-0000-7000-8000-000000000a02';
const SEQUENCE = '0192f1a0-0000-7000-8000-000000000b01';
const STEP_1 = '0192f1a0-0000-7000-8000-000000000c01';
const STEP_2 = '0192f1a0-0000-7000-8000-000000000c02';
const SEASON = '0192f1a0-0000-7000-8000-000000000d01';
const COMPETITION = '0192f1a0-0000-7000-8000-000000000d02';
const MESSAGE_1 = '0192f1a0-0000-7000-8000-000000000e01';
const MESSAGE_2 = '0192f1a0-0000-7000-8000-000000000e02';
const MESSAGE_3 = '0192f1a0-0000-7000-8000-000000000e03';
const MESSAGE_4 = '0192f1a0-0000-7000-8000-000000000e04';
const MESSAGE_5 = '0192f1a0-0000-7000-8000-000000000e05';
const NOTICE = '0192f1a0-0000-7000-8000-000000000f01';
const PERSON_1 = '0192f1a0-0000-7000-8000-000000000f11';
const PERSON_2 = '0192f1a0-0000-7000-8000-000000000f12';
const PERSON_3 = '0192f1a0-0000-7000-8000-000000000f13';
const NOW = '2026-10-24T12:00:00.000Z';
const ZONE = 'America/Los_Angeles';

const ACTIONS = [
  'communications.read_message_schedule',
  'communications.manage_message_templates',
  'communications.manage_message_sequences',
  'communications.preview_scheduled_message',
  'communications.confirm_scheduled_message',
  'communications.skip_scheduled_message',
];

function template(over: Record<string, unknown> = {}) {
  return {
    id: TEMPLATE,
    name: 'Season welcome',
    category: 'operational',
    title: 'Welcome to {{season_name}}',
    body: 'Games start on {{start_date}}.',
    placeholders: ['season_name', 'start_date'],
    status: 'active',
    revision: 3,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

const PLACEHOLDERS = {
  items: [
    { name: 'season_name', label: 'Season name', subjects: ['season'] },
    { name: 'offering_name', label: 'Offering name', subjects: ['offering'] },
    { name: 'start_date', label: 'Start date', subjects: ['season', 'offering'] },
  ],
};

function step(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    sequenceId: SEQUENCE,
    position: 1,
    templateId: TEMPLATE,
    templateName: 'Season welcome',
    anchor: 'starts',
    offsetDays: -7,
    sendTimeLocal: null,
    effectiveSendTimeLocal: '09:00',
    retiredAt: null,
    revision: 2,
    ...over,
  };
}

function sequence(over: Record<string, unknown> = {}) {
  return {
    id: SEQUENCE,
    name: 'Adult league season',
    facilityId: FACILITY_A,
    subjectType: 'season',
    scopeId: COMPETITION,
    active: false,
    steps: [
      step(STEP_1),
      step(STEP_2, {
        position: 2,
        templateId: TEMPLATE_2,
        templateName: 'Thank you',
        anchor: 'ends',
        offsetDays: 1,
        sendTimeLocal: '10:30',
        effectiveSendTimeLocal: '10:30',
      }),
    ],
    revision: 4,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function message(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    facilityId: FACILITY_A,
    subject: { type: 'season', id: SEASON },
    sequenceId: SEQUENCE,
    sequenceName: 'Adult league season',
    stepId: STEP_1,
    templateId: TEMPLATE,
    templateName: 'Season welcome',
    category: 'operational',
    anchor: 'starts',
    offsetDays: -7,
    sendTimeLocal: '09:00',
    anchorAt: '2027-01-10T08:00:00.000Z',
    dueAt: '2027-01-03T17:00:00.000Z',
    status: 'needs_confirmation',
    attention: null,
    edited: false,
    title: 'Welcome to Winter 2027',
    body: 'Games start on Sunday, January 10, 2027.',
    sourceTitle: 'Welcome to {{season_name}}',
    sourceBody: 'Games start on {{start_date}}.',
    missingPlaceholders: [],
    confirmedAt: null,
    skippedAt: null,
    skipReason: null,
    canceledAt: null,
    cancelReason: null,
    sentAt: null,
    delivery: null,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function schedule(messages: unknown[]) {
  return {
    subject: { type: 'season', id: SEASON },
    subjectName: 'Winter 2027',
    facilityId: FACILITY_A,
    timezone: ZONE,
    sequences: [{ id: SEQUENCE, name: 'Adult league season' }],
    messages,
  };
}

const MESSAGES = () => [
  message(MESSAGE_2, {
    title: 'Registration is open for Winter 2027',
    body: 'Register from Tuesday, December 1, 2026.',
    anchor: 'registration_opens',
    offsetDays: 1,
    dueAt: '2026-12-02T16:00:00.000Z',
    status: 'sent',
    confirmedAt: NOW,
    sentAt: '2026-12-02T16:00:00.000Z',
    delivery: {
      notificationId: NOTICE,
      notificationStatus: 'dispatched',
      suppressionReason: null,
      recipientCount: 14,
    },
    revision: 3,
  }),
  message(MESSAGE_1),
  message(MESSAGE_4, {
    title: 'One day to go',
    offsetDays: -1,
    dueAt: '2027-01-09T17:00:00.000Z',
    attention: 'anchor_moved',
    revision: 5,
  }),
  message(MESSAGE_5, {
    title: 'First game of Winter 2027',
    body: 'We play on {{first_game_date}}.',
    anchor: 'first_game',
    offsetDays: -1,
    anchorAt: null,
    dueAt: null,
    missingPlaceholders: ['first_game_date'],
  }),
  message(MESSAGE_3, {
    title: 'Thank you for playing in Winter 2027',
    anchor: 'ends',
    offsetDays: 1,
    dueAt: '2027-04-11T16:00:00.000Z',
    status: 'skipped',
    skippedAt: NOW,
    skipReason: 'A printed letter goes out instead',
    revision: 2,
  }),
];

const PREVIEW = {
  scheduledMessageId: MESSAGE_1,
  status: 'needs_confirmation',
  category: 'operational',
  title: 'Welcome to Winter 2027',
  body: 'Games start on Sunday, January 10, 2027.',
  missingPlaceholders: [],
  dueAt: '2027-01-03T17:00:00.000Z',
  blockers: [],
  recipients: {
    resolvedAt: NOW,
    count: 3,
    reachableCount: 2,
    tooLarge: false,
    entries: [
      { personId: PERSON_1, displayName: 'Ana Ortiz', basis: 'team_member', reachable: true },
      { personId: PERSON_2, displayName: 'Ben Cole', basis: 'team_member', reachable: false },
      { personId: PERSON_3, displayName: 'Cy Dunn', basis: 'receive_messages', reachable: true },
    ],
  },
};

function routes(
  extra: Record<string, FakeHandler> = {},
  options: { enabled?: boolean; actions?: string[] } = {},
): Record<string, FakeHandler> {
  return {
    'GET /me': oneFacilityMe(),
    'GET /me/permissions': mePermissions({
      enabled: options.enabled === false ? [] : ['message_sequences'],
      actions: options.actions ?? ACTIONS,
    }),
    'GET /message-placeholders': { status: 200, body: PLACEHOLDERS },
    'GET /message-templates': {
      status: 200,
      body: {
        items: [
          template(),
          template({
            id: TEMPLATE_2,
            name: 'Thank you',
            category: 'promotional',
            title: 'Thank you for playing',
            status: 'archived',
          }),
        ],
      },
    },
    'GET /message-templates/{id}': { status: 200, body: template() },
    'GET /message-sequences': { status: 200, body: { items: [sequence()] } },
    'GET /message-sequences/{id}': { status: 200, body: sequence() },
    'GET /competitions': {
      status: 200,
      body: [{ id: COMPETITION, name: 'Adult coed league' }],
    },
    'GET /message-schedules/{subjectType}/{subjectId}': {
      status: 200,
      body: schedule(MESSAGES()),
    },
    'GET /scheduled-messages/{id}/preview': { status: 200, body: PREVIEW },
    ...extra,
  };
}

const SCHEDULE_PATH = `/communications/schedules/season/${SEASON}`;

/** The first request to a route template with the method, once it has been made. */
async function requestTo(app: ReturnType<typeof createTestApp>, method: string, route: string) {
  await waitFor(() =>
    expect(app.fake.requests.some((r) => r.method === method && r.route === route)).toBe(true),
  );
  return app.fake.requests.find((r) => r.method === method && r.route === route)!;
}

describe('message templates (SPK-COMMS-009)', () => {
  it('SPK-COMMS-009: lists the templates with their category and writes a new one with placeholders', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /message-templates': {
          status: 201,
          body: template({ id: TEMPLATE_2, name: 'Camp reminder', category: 'promotional' }),
        },
      }),
    });
    render(app.at('/communications/templates'));
    expect(await screen.findByRole('heading', { name: 'Message templates' })).toBeInTheDocument();
    expect(screen.getByText('Proposed, DEC-099 pending')).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Message templates' });
    expect(within(list).getByRole('link', { name: 'Season welcome' })).toHaveAttribute(
      'href',
      `/communications/templates/${TEMPLATE}`,
    );
    expect(within(list).getByText('Essential')).toBeInTheDocument();
    expect(within(list).getByText('Promotional')).toBeInTheDocument();
    expect(within(list).getByText('Archived')).toBeInTheDocument();

    const form = await screen.findByRole('form', { name: 'New template' });
    const placeholders = await within(form).findByRole('list', { name: 'Placeholders' });
    expect(within(placeholders).getByText('{{season_name}}')).toBeInTheDocument();
    expect(within(form).getByText(/never sent as written/)).toBeInTheDocument();
    // nothing is sent to the API until the form is complete
    await user.click(within(form).getByRole('button', { name: 'Save template' }));
    expect(within(form).getByText('Give the template a name.')).toBeInTheDocument();
    expect(within(form).getByText('Choose essential or promotional.')).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.method === 'POST')).toBe(false);

    await user.type(within(form).getByLabelText(/^Name/), 'Camp reminder');
    await user.selectOptions(within(form).getByLabelText(/^Category/), 'promotional');
    await user.type(within(form).getByLabelText(/^Title/), 'Camp starts soon');
    await user.click(within(form).getByLabelText(/^Text/));
    await user.paste('{{offering_name}} starts on {{start_date}}.');
    await user.click(within(form).getByRole('button', { name: 'Save template' }));
    expect(await within(form).findByText('Template "Camp reminder" saved.')).toBeInTheDocument();
    const created = await requestTo(app, 'POST', '/message-templates');
    expect(created.body).toEqual({
      name: 'Camp reminder',
      category: 'promotional',
      title: 'Camp starts soon',
      body: '{{offering_name}} starts on {{start_date}}.',
    });
    expect(created.headers['idempotency-key']).toMatch(/^key-/);
  });

  it('SPK-COMMS-009, SPK-COMMS-007: changes a template with its revision; the category is fixed; archiving is one command', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'PATCH /message-templates/{id}': { status: 200, body: template({ revision: 4 }) },
      }),
    });
    render(app.at(`/communications/templates/${TEMPLATE}`));
    const form = await screen.findByRole('form', { name: 'Change template' });
    expect(within(form).getByLabelText(/^Title/)).toHaveValue('Welcome to {{season_name}}');
    expect(screen.getByText(/The category is chosen once/)).toBeInTheDocument();
    expect(within(form).queryByLabelText(/^Category/)).not.toBeInTheDocument();
    expect(within(form).getByText(/will ask to be confirmed again/)).toBeInTheDocument();

    const text = within(form).getByLabelText(/^Text/);
    await user.clear(text);
    await user.click(text);
    await user.paste('Games start on {{start_date}}. Bring shin guards.');
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    const saved = await requestTo(app, 'PATCH', '/message-templates/{id}');
    expect(saved.params).toEqual({ id: TEMPLATE });
    expect(saved.body).toEqual({
      name: 'Season welcome',
      title: 'Welcome to {{season_name}}',
      body: 'Games start on {{start_date}}. Bring shin guards.',
      expectedRevision: 3,
    });
    expect(await screen.findByText('Template saved.')).toBeInTheDocument();
  });
});

describe('message sequences (SPK-COMMS-009)', () => {
  it('SPK-COMMS-009: lists the sequences and creates one for the seasons of a competition at the facility in use', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /message-sequences': {
          status: 201,
          body: sequence({ id: STEP_2, name: 'Youth league season', steps: [] }),
        },
      }),
    });
    render(app.at('/communications/sequences'));
    const list = await screen.findByRole('list', { name: 'Message sequences' });
    const row = within(list).getByRole('listitem');
    expect(within(row).getByRole('link', { name: 'Adult league season' })).toHaveAttribute(
      'href',
      `/communications/sequences/${SEQUENCE}`,
    );
    expect(within(row).getByText('Switched off')).toBeInTheDocument();
    expect(
      await within(row).findByText('Seasons of Adult coed league · 2 steps'),
    ).toBeInTheDocument();

    const form = await screen.findByRole('form', { name: 'New sequence' });
    await user.type(within(form).getByLabelText(/^Name/), 'Youth league season');
    await user.selectOptions(within(form).getByLabelText(/^Messages for/), 'season');
    const competition = await within(form).findByLabelText(/^Competition/);
    await within(competition).findByRole('option', { name: 'Adult coed league' });
    await user.selectOptions(competition, COMPETITION);
    await user.click(within(form).getByRole('button', { name: 'Create sequence' }));
    const created = await requestTo(app, 'POST', '/message-sequences');
    expect(created.body).toEqual({
      name: 'Youth league season',
      facilityId: FACILITY_A,
      subjectType: 'season',
      scopeId: COMPETITION,
    });
    expect(await within(form).findByText('Sequence created, switched off')).toBeInTheDocument();
    expect(within(form).getByRole('link', { name: 'Add its steps' })).toBeInTheDocument();
  });

  it('SPK-COMMS-009: shows each step as a time relative to a date, adds, changes and removes steps, and switches the sequence on', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'PATCH /message-sequences/{id}': { status: 200, body: sequence({ active: true }) },
        'POST /message-sequences/{id}/steps': { status: 201, body: sequence() },
        'PATCH /message-sequences/{id}/steps/{stepId}': { status: 200, body: sequence() },
        'POST /message-sequences/{id}/steps/{stepId}/remove': { status: 200, body: sequence() },
      }),
    });
    render(app.at(`/communications/sequences/${SEQUENCE}`));
    expect(await screen.findByRole('heading', { name: 'Adult league season' })).toBeInTheDocument();
    expect(screen.getByText(/It produces nothing while it is switched off/)).toBeInTheDocument();
    // the open values are named with their decision record, never invented
    expect(screen.getByText(/Who sends and on which days/)).toBeInTheDocument();
    const steps = await screen.findByRole('list', { name: 'Steps' });
    const first = within(steps).getByRole('listitem', {
      name: 'Season welcome: 7 days before the season starts, at 09:00',
    });
    expect(within(first).getByText(/the time of the message policy/)).toBeInTheDocument();
    expect(
      within(steps).getByRole('listitem', {
        name: 'Thank you: 1 day after the season ends, at 10:30',
      }),
    ).toBeInTheDocument();

    // switch on
    await user.click(await screen.findByRole('button', { name: 'Switch on' }));
    const switched = await requestTo(app, 'PATCH', '/message-sequences/{id}');
    expect(switched.body).toEqual({ active: true, expectedRevision: 4 });

    // add a step
    const add = await screen.findByRole('form', { name: 'Add a step' });
    const templateField = within(add).getByLabelText(/^Template/);
    await within(templateField).findByRole('option', { name: 'Season welcome' });
    await user.selectOptions(templateField, TEMPLATE);
    await user.selectOptions(within(add).getByLabelText(/^Counted from/), 'registration_opens');
    const days = within(add).getByLabelText(/^Days/);
    await user.clear(days);
    await user.type(days, '1');
    await user.selectOptions(within(add).getByLabelText(/^Before or after/), 'after');
    await user.type(within(add).getByLabelText(/^Time of day/), '08:00');
    await user.click(within(add).getByRole('button', { name: 'Add step' }));
    const added = await requestTo(app, 'POST', '/message-sequences/{id}/steps');
    expect(added.body).toEqual({
      templateId: TEMPLATE,
      anchor: 'registration_opens',
      offsetDays: 1,
      sendTimeLocal: '08:00',
    });
    // a first game anchors a season's step
    expect(
      within(within(add).getByLabelText(/^Counted from/)).getByRole('option', {
        name: 'The first game',
      }),
    ).toBeInTheDocument();

    // change a step
    await user.click(
      within(first).getByRole('button', {
        name: 'Change Season welcome: 7 days before the season starts, at 09:00',
      }),
    );
    const change = within(first).getByRole('group', {
      name: 'Change Season welcome: 7 days before the season starts, at 09:00',
    });
    await within(within(change).getByLabelText(/^Template/)).findByRole('option', {
      name: 'Season welcome',
    });
    const changeDays = within(change).getByLabelText(/^Days/);
    await user.clear(changeDays);
    await user.type(changeDays, '3');
    expect(
      within(change).getByText(/a confirmed one asks to be confirmed again/),
    ).toBeInTheDocument();
    await user.click(within(change).getByRole('button', { name: 'Save step' }));
    const changed = await requestTo(app, 'PATCH', '/message-sequences/{id}/steps/{stepId}');
    expect(changed.params).toEqual({ id: SEQUENCE, stepId: STEP_1 });
    expect(changed.body).toEqual({
      templateId: TEMPLATE,
      anchor: 'starts',
      offsetDays: -3,
      sendTimeLocal: null,
      expectedRevision: 2,
    });

    // remove a step
    const second = within(steps).getByRole('listitem', {
      name: 'Thank you: 1 day after the season ends, at 10:30',
    });
    await user.click(
      within(second).getByRole('button', {
        name: 'Remove Thank you: 1 day after the season ends, at 10:30',
      }),
    );
    const remove = within(second).getByRole('group', {
      name: 'Remove Thank you: 1 day after the season ends, at 10:30',
    });
    expect(within(remove).getByText(/What was sent is kept/)).toBeInTheDocument();
    await user.click(within(remove).getByRole('button', { name: 'Remove step' }));
    const removed = await requestTo(app, 'POST', '/message-sequences/{id}/steps/{stepId}/remove');
    expect(removed.params).toEqual({ id: SEQUENCE, stepId: STEP_2 });
    expect(removed.body).toEqual({ expectedRevision: 2 });
  });
});

describe('message schedule of a season (SPK-COMMS-009)', () => {
  it('SPK-COMMS-009: shows what is waiting, what was sent and what was skipped, in facility time, and why a message needs attention', async () => {
    const app = createTestApp({ routes: routes() });
    render(app.at(SCHEDULE_PATH));
    expect(
      await screen.findByRole('heading', { name: 'Message schedule: Winter 2027' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the season' })).toHaveAttribute(
      'href',
      `/leagues/seasons/${SEASON}`,
    );
    const list = await screen.findByRole('list', { name: 'Scheduled messages' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((item) => item.getAttribute('aria-label'))).toEqual([
      'Registration is open for Winter 2027',
      'Welcome to Winter 2027',
      'One day to go',
      'First game of Winter 2027',
      'Thank you for playing in Winter 2027',
    ]);

    // waiting: the text with real details and its time in the facility zone
    const waiting = within(list).getByRole('listitem', { name: 'Welcome to Winter 2027' });
    expect(within(waiting).getByText('Needs confirmation')).toBeInTheDocument();
    expect(
      within(waiting).getByText('Games start on Sunday, January 10, 2027.'),
    ).toBeInTheDocument();
    expect(
      within(waiting).getByText(
        `Due ${formatInstant('2027-01-03T17:00:00.000Z', ZONE)} · 7 days before the season starts, at 09:00 · Adult league season · Season welcome`,
      ),
    ).toBeInTheDocument();
    expect(await within(waiting).findByRole('button', { name: 'Confirm' })).toBeEnabled();

    // sent: what the notice it produced reports, and a link to its delivery status
    const sent = within(list).getByRole('listitem', {
      name: 'Registration is open for Winter 2027',
    });
    expect(within(sent).getByText('Sent')).toBeInTheDocument();
    expect(within(sent).getByText('Sent to 14 people.')).toBeInTheDocument();
    expect(
      within(sent).getByRole('link', {
        name: 'Delivery status of Registration is open for Winter 2027',
      }),
    ).toHaveAttribute('href', `/communications/notifications/${NOTICE}`);
    expect(within(sent).queryByRole('button')).not.toBeInTheDocument();

    // skipped: with its reason, and it can be brought back
    const skipped = within(list).getByRole('listitem', {
      name: 'Thank you for playing in Winter 2027',
    });
    expect(within(skipped).getByText(/A printed letter goes out instead/)).toBeInTheDocument();
    expect(await within(skipped).findByRole('button', { name: 'Bring back' })).toBeEnabled();
    expect(within(skipped).queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument();

    // a moved date asks for a new confirmation
    const moved = within(list).getByRole('listitem', { name: 'One day to go' });
    expect(within(moved).getByText(/Its date moved after it was confirmed/)).toBeInTheDocument();

    // a detail the season cannot fill blocks the confirmation
    const blocked = within(list).getByRole('listitem', { name: 'First game of Winter 2027' });
    expect(within(blocked).getByText('Details missing')).toBeInTheDocument();
    expect(within(blocked).getByText('No date yet')).toBeInTheDocument();
    expect(await within(blocked).findByRole('button', { name: 'Confirm' })).toBeDisabled();
  });

  it('SPK-COMMS-009, SPK-COMMS-006: previews the text and who would receive it now, by name and count only', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: routes() });
    render(app.at(SCHEDULE_PATH));
    const list = await screen.findByRole('list', { name: 'Scheduled messages' });
    const waiting = within(list).getByRole('listitem', { name: 'Welcome to Winter 2027' });
    await user.click(await within(waiting).findByRole('button', { name: 'Preview' }));
    const preview = await within(waiting).findByRole('group', {
      name: 'Preview of Welcome to Winter 2027',
    });
    expect(
      await within(preview).findByText(
        '3 people, 1 with every channel switched off for this kind of message.',
      ),
    ).toBeInTheDocument();
    const recipients = within(preview).getByRole('list', { name: 'Recipients now' });
    expect(within(recipients).getByText('Ana Ortiz')).toBeInTheDocument();
    expect(within(recipients).getByText('Cy Dunn')).toBeInTheDocument();
    const optedOut = within(recipients).getByText('Ben Cole').closest('li')!;
    expect(within(optedOut).getByText('Switched this kind of message off')).toBeInTheDocument();
    expect(
      within(preview).getByText(/worked out again from current permissions/),
    ).toBeInTheDocument();
    expect(preview.textContent).not.toMatch(/@|\+1|\d{3}-\d{4}/);
    expect((await requestTo(app, 'GET', '/scheduled-messages/{id}/preview')).params).toEqual({
      id: MESSAGE_1,
    });
  });

  it('SPK-COMMS-009: a missing detail is named by the preview', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /scheduled-messages/{id}/preview': {
          status: 200,
          body: {
            ...PREVIEW,
            scheduledMessageId: MESSAGE_5,
            title: 'First game of Winter 2027',
            body: 'We play on {{first_game_date}}.',
            missingPlaceholders: [{ name: 'first_game_date', label: 'First game date' }],
            dueAt: null,
            blockers: ['missing_placeholder', 'no_due_time'],
          },
        },
      }),
    });
    render(app.at(SCHEDULE_PATH));
    const list = await screen.findByRole('list', { name: 'Scheduled messages' });
    const blocked = within(list).getByRole('listitem', { name: 'First game of Winter 2027' });
    await user.click(await within(blocked).findByRole('button', { name: 'Preview' }));
    const preview = await within(blocked).findByRole('group', {
      name: 'Preview of First game of Winter 2027',
    });
    expect(
      await within(preview).findByText(/This season cannot fill: First game date\./),
    ).toBeInTheDocument();
    expect(
      within(preview).getAllByText(/It has no date to be sent on yet\./).length,
    ).toBeGreaterThan(0);
  });

  it('SPK-COMMS-009: confirms a message with its revision, and says it goes to the recipients of that moment', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /scheduled-messages/{id}/confirm': {
          status: 200,
          body: message(MESSAGE_1, { status: 'confirmed', confirmedAt: NOW, revision: 2 }),
        },
      }),
    });
    render(app.at(SCHEDULE_PATH));
    const list = await screen.findByRole('list', { name: 'Scheduled messages' });
    const waiting = within(list).getByRole('listitem', { name: 'Welcome to Winter 2027' });
    const confirm = await within(waiting).findByRole('button', { name: 'Confirm' });
    await waitFor(() => expect(confirm).toBeEnabled());
    await user.click(confirm);
    const sent = await requestTo(app, 'POST', '/scheduled-messages/{id}/confirm');
    expect(sent.params).toEqual({ id: MESSAGE_1 });
    expect(sent.body).toEqual({ expectedRevision: 1 });
    expect(sent.headers['idempotency-key']).toMatch(/^key-/);
    expect(
      await screen.findByText('Confirmed. It will be sent when it is due, to the recipients then.'),
    ).toBeInTheDocument();
  });

  it('SPK-COMMS-009: edits the text of one message without touching the template, skips with a reason, and produces the schedule', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /scheduled-messages/{id}/edit': {
          status: 200,
          body: message(MESSAGE_1, { edited: true, revision: 2 }),
        },
        'POST /scheduled-messages/{id}/skip': {
          status: 200,
          body: message(MESSAGE_4, { status: 'skipped', skippedAt: NOW, revision: 6 }),
        },
        'POST /message-schedules/{subjectType}/{subjectId}/generate': {
          status: 200,
          body: schedule(MESSAGES()),
        },
      }),
    });
    render(app.at(SCHEDULE_PATH));
    const list = await screen.findByRole('list', { name: 'Scheduled messages' });

    // edit: starts from the text with its placeholders, saved for this message only
    const waiting = within(list).getByRole('listitem', { name: 'Welcome to Winter 2027' });
    await user.click(await within(waiting).findByRole('button', { name: 'Edit text' }));
    const form = within(waiting).getByRole('form', {
      name: 'Edit the text of Welcome to Winter 2027',
    });
    expect(within(form).getByLabelText(/^Title/)).toHaveValue('Welcome to {{season_name}}');
    expect(
      within(form).getByText(/The template Season welcome is not changed\./),
    ).toBeInTheDocument();
    // only the placeholders a season can fill are offered
    const placeholders = await within(form).findByRole('list', { name: 'Placeholders' });
    expect(within(placeholders).getByText('{{season_name}}')).toBeInTheDocument();
    expect(within(placeholders).queryByText('{{offering_name}}')).not.toBeInTheDocument();
    const text = within(form).getByLabelText(/^Text/);
    await user.clear(text);
    await user.click(text);
    await user.paste('Games start on {{start_date}}. Bring shin guards.');
    await user.click(within(form).getByRole('button', { name: 'Save text' }));
    const edited = await requestTo(app, 'POST', '/scheduled-messages/{id}/edit');
    expect(edited.params).toEqual({ id: MESSAGE_1 });
    expect(edited.body).toEqual({
      title: 'Welcome to {{season_name}}',
      body: 'Games start on {{start_date}}. Bring shin guards.',
      expectedRevision: 1,
    });
    expect(await screen.findByText('Text saved for this message.')).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.route === '/message-templates/{id}')).toBe(false);

    // skip, with a reason
    const other = within(list).getByRole('listitem', { name: 'One day to go' });
    await user.click(await within(other).findByRole('button', { name: 'Skip' }));
    const skip = within(other).getByRole('group', { name: 'Skip One day to go' });
    await user.type(within(skip).getByLabelText(/^Why is it skipped/), 'Told in person');
    await user.click(within(skip).getByRole('button', { name: 'Skip this message' }));
    const skipped = await requestTo(app, 'POST', '/scheduled-messages/{id}/skip');
    expect(skipped.params).toEqual({ id: MESSAGE_4 });
    expect(skipped.body).toEqual({ reason: 'Told in person', expectedRevision: 5 });
    expect(await screen.findByText('Message skipped. It will not be sent.')).toBeInTheDocument();

    // produce the schedule from the sequences that apply
    const actions = screen.getByRole('group', { name: 'Schedule actions' });
    expect(within(actions).getByText('Applies: Adult league season.')).toBeInTheDocument();
    await user.click(within(actions).getByRole('button', { name: 'Produce the schedule' }));
    const produced = await requestTo(
      app,
      'POST',
      '/message-schedules/{subjectType}/{subjectId}/generate',
    );
    expect(produced.params).toEqual({ subjectType: 'season', subjectId: SEASON });
  });

  it('SPK-COMMS-009: with the capability off the screens say so, keep what exists readable, and offer no confirmation, editing or creation', async () => {
    const app = createTestApp({ routes: routes({}, { enabled: false }) });
    const { unmount } = render(app.at(SCHEDULE_PATH));
    expect(await screen.findByTestId('state-turned-off')).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Scheduled messages' });
    const waiting = within(list).getByRole('listitem', { name: 'Welcome to Winter 2027' });
    // skipping creates nothing, so it stays; a preview is a read
    expect(await within(waiting).findByRole('button', { name: 'Skip' })).toBeInTheDocument();
    expect(within(waiting).getByRole('button', { name: 'Preview' })).toBeInTheDocument();
    expect(within(waiting).queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument();
    expect(within(waiting).queryByRole('button', { name: 'Edit text' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Produce the schedule' })).not.toBeInTheDocument();
    unmount();

    render(app.at('/communications/templates'));
    expect(await screen.findByTestId('state-turned-off')).toBeInTheDocument();
    expect(await screen.findByRole('list', { name: 'Message templates' })).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'New template' })).not.toBeInTheDocument();
  });

  it('SPK-COMMS-009: a reader without the manager role sees the schedule and no command', async () => {
    const app = createTestApp({
      routes: routes({}, { actions: ['communications.read_message_schedule'] }),
    });
    render(app.at(SCHEDULE_PATH));
    const list = await screen.findByRole('list', { name: 'Scheduled messages' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(5);
    // the permissions have answered (the page is past its capability check)
    expect(screen.queryByTestId('state-turned-off')).not.toBeInTheDocument();
    expect(within(list).queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Produce the schedule' })).not.toBeInTheDocument();
  });
});

describe('link from a season or an offering to its message schedule (SPK-COMMS-009)', () => {
  function renderLink(app: ReturnType<typeof createTestApp>) {
    return render(
      <MemoryRouter>
        <MessageScheduleLink subject="season" id={SEASON} />
        <MessageScheduleLink subject="offering" id={TEMPLATE} />
      </MemoryRouter>,
      { wrapper: app.wrapper },
    );
  }

  it('SPK-COMMS-009: links to the schedule while message sequences are on', async () => {
    renderLink(createTestApp({ routes: routes() }));
    await waitFor(() =>
      expect(screen.getAllByRole('link', { name: 'Message schedule' })).toHaveLength(2),
    );
    const links = screen.getAllByRole('link', { name: 'Message schedule' });
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      `/communications/schedules/season/${SEASON}`,
      `/communications/schedules/offering/${TEMPLATE}`,
    ]);
  });

  it('SPK-COMMS-009: shows nothing while they are off, so the season and offering screens stay as they are', async () => {
    const app = createTestApp({ routes: routes({}, { enabled: false }) });
    renderLink(app);
    await waitFor(() =>
      expect(app.fake.requests.some((r) => r.route === '/me/permissions')).toBe(true),
    );
    expect(screen.queryByRole('link', { name: 'Message schedule' })).not.toBeInTheDocument();
  });
});
