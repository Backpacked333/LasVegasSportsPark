/**
 * SCR-S-33 coverage rail (SPK-AT-012, SPK-STAFF-003): "Find a replacement" on an assignment lists
 * the service's candidates ranked eligible first, with availability, qualification and conflicts
 * in one line, and sends the offer to the assignment's own page (reason and expected revision).
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  ASSIGNMENT_1,
  FIXTURE_1,
  OFFICIAL,
  assignmentRecord,
  nameEntry,
  oneFacilityMe,
  personNames,
} from '../../../features/operations/testing';
import { createTestApp } from '../../../testing/test-app';
import { rankCandidates } from '../AssignmentsScreen';

const reason = (severity: string, message: string) => ({
  code: message,
  message,
  severity,
  sourceIds: [],
  sourceType: null,
});

const candidates = [
  {
    personId: 'a',
    displayName: 'Tom Baker',
    eligible: false,
    reasons: [reason('blocking', 'Unavailable until 18:30')],
  },
  {
    personId: 'b',
    displayName: 'Priya Nair',
    eligible: true,
    reasons: [reason('warning', 'Three games back to back')],
  },
  {
    personId: 'c',
    displayName: 'Marco Ruiz',
    eligible: true,
    reasons: [reason('positive', 'Available 17:00 to 22:00')],
  },
];

describe('SCR-S-33 replacement candidates rail (SPK-AT-012)', () => {
  it('ranks eligible candidates first, then by the service’s positive and warning reasons', () => {
    expect(rankCandidates(candidates as never).map((c) => c.displayName)).toEqual([
      'Marco Ruiz',
      'Priya Nair',
      'Tom Baker',
    ]);
  });

  it('opens the ranked candidates of a declined assignment and links the offer to its page', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        'GET /me': oneFacilityMe(),
        'GET /reports/uncovered-assignments': {
          status: 200,
          body: { rows: [], scope: { timezone: null } },
        },
        'GET /assignments': {
          status: 200,
          body: {
            items: [{ ...assignmentRecord({ status: 'declined' }), availableActions: [] }],
            nextCursor: null,
          },
        },
        'GET /person-names': personNames([nameEntry(OFFICIAL, 'Jordan', 'Lee', 'adult')]),
        'GET /assignments/{id}/replacements': {
          status: 200,
          body: {
            assignmentId: ASSIGNMENT_1,
            targetType: 'fixture',
            targetId: FIXTURE_1,
            role: 'referee',
            slot: 1,
            scheduledStart: '2026-10-24T18:00:00.000Z',
            scheduledEnd: '2026-10-24T19:00:00.000Z',
            requiredQualifications: [],
            evaluatedAt: '2026-10-24T12:00:00.000Z',
            candidates,
          },
        },
      },
    });
    render(app.at('/staff'));
    await user.click(
      await screen.findByRole('button', { name: 'Find a replacement for U12 Red v Blue, Referee' }),
    );
    const ranked = await screen.findByRole('list', { name: 'Ranked replacement candidates' });
    const rows = within(ranked).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Marco Ruiz');
    expect(rows[2]).toHaveTextContent('Not eligible · Unavailable until 18:30');
    expect(
      screen.getByRole('link', { name: 'Offer the slot on the assignment page' }),
    ).toHaveAttribute('href', `/staff/assignments/${ASSIGNMENT_1}`);
    // Nothing is offered from the rail: no command was sent.
    expect(app.fake.requests.some((r) => r.method === 'POST')).toBe(false);
  });
});

describe('SCR-S-33 open-slot candidates (SPK-STAFF-001, SPK-STAFF-003)', () => {
  const REQUIREMENT = '0192f1a0-0000-7000-8000-0000000001c1';
  const openSlot = {
    requirementId: REQUIREMENT,
    kind: 'official',
    targetType: 'fixture',
    targetId: FIXTURE_1,
    offeringId: null,
    role: 'referee',
    requiredCount: 2,
    covered: 1,
    scheduledStart: '2026-10-24T18:00:00.000Z',
    scheduledEnd: '2026-10-24T19:00:00.000Z',
    requiredQualifications: [],
    evaluatedAt: '2026-10-24T12:00:00.000Z',
    candidates: [
      {
        personId: OFFICIAL,
        displayName: 'Marco Ruiz',
        eligible: true,
        grade: '8',
        safeguarding: { kind: 'safeguarding', status: 'held', validTo: '2027-06-30T00:00:00.000Z' },
        reasons: [
          reason('positive', 'Available 17:00 to 22:00'),
          { ...reason('info', 'Grade 8.'), code: 'official_grade' },
        ],
      },
      {
        personId: 'p2',
        displayName: 'Tom Baker',
        eligible: true,
        grade: null,
        safeguarding: {
          kind: 'safeguarding',
          status: 'expired',
          validTo: '2026-09-30T00:00:00.000Z',
        },
        reasons: [],
      },
    ],
  };
  const routes = {
    'GET /me': oneFacilityMe(),
    'GET /reports/uncovered-assignments': {
      status: 200,
      body: {
        rows: [
          {
            targetType: 'fixture',
            targetId: FIXTURE_1,
            title: 'U12 Red v Blue',
            start: '2026-10-24T18:00:00.000Z',
            requirementId: REQUIREMENT,
            kind: 'official',
            role: 'referee',
            required: 2,
            accepted: 1,
            offered: 0,
            proposed: 0,
            uncovered: 1,
          },
        ],
        scope: { timezone: 'America/Los_Angeles' },
      },
    },
    'GET /assignments': { status: 200, body: { items: [], nextCursor: null } },
    'GET /person-names': personNames([nameEntry(OFFICIAL, 'Marco', 'Ruiz', 'adult')]),
    'GET /assignment-requirements/{id}/candidates': { status: 200, body: openSlot },
    'POST /assignments': {
      status: 201,
      body: { assignment: assignmentRecord({ status: 'offered' }), uncovered: null },
    },
  };

  it('ranks candidates for an uncovered slot with grade and safeguarding, and offers the slot', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes });
    render(app.at('/staff'));
    await user.click(
      await screen.findByRole('button', { name: 'Find candidates for U12 Red v Blue, Referee' }),
    );
    const ranked = await screen.findByRole('list', { name: 'Ranked candidates for the open slot' });
    const rows = within(ranked).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Grade 8 · ✓ Safeguarding until 2027-06-30');
    expect(rows[1]).toHaveTextContent('▲ Safeguarding expired');
    expect(screen.getByText('1 of 2 covered')).toBeInTheDocument();
    await user.click(within(ranked).getByRole('button', { name: 'Offer the slot to Marco Ruiz' }));
    expect(await within(ranked).findByText('Offered')).toBeInTheDocument();
    expect(app.fake.requests.find((r) => r.method === 'POST')?.body).toEqual({
      personId: OFFICIAL,
      kind: 'official',
      targetType: 'fixture',
      targetId: FIXTURE_1,
      role: 'referee',
      offer: true,
    });
  });
});
