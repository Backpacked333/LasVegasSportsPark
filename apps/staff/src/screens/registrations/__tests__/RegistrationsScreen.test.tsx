/**
 * Registrations area home (SPK-UX-005, SPK-REG-008): the decision queue preview and the
 * organization-wide waitlist (`GET /v1/waitlist-queue`) with live counts, the offering of each
 * entry and the time left on an open offer; a waitlist the viewer may not read is said so.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../../../testing/test-app';
import {
  ENTRY_ID,
  OFFERING_ID,
  apiError,
  nameRoutes,
  ok,
  waitlistEntry,
} from '../../../features/registration-finance/__tests__/fixtures';

const OFFERED_ID = `${ENTRY_ID.slice(0, -1)}3`;

const QUEUE = ok({
  items: [
    {
      ...waitlistEntry({ id: OFFERED_ID, status: 'offered', position: null, offerCount: 1 }),
      offering: {
        id: OFFERING_ID,
        name: 'Winter camp week 1',
        kind: 'camp',
        facilityId: '0192f1a0-0000-7000-8000-000000000101',
        startsOn: '2026-12-21',
      },
      openOffer: {
        id: '0192f1a0-0000-7000-8000-000000000804',
        status: 'offered',
        expiresAt: '2026-10-24T16:48:00.000Z',
      },
    },
    {
      ...waitlistEntry(),
      offering: {
        id: OFFERING_ID,
        name: 'Winter camp week 1',
        kind: 'camp',
        facilityId: '0192f1a0-0000-7000-8000-000000000101',
        startsOn: '2026-12-21',
      },
      openOffer: null,
    },
  ],
  nextCursor: null,
  counts: { waiting: 7, offered: 1 },
});

describe('RegistrationsScreen', () => {
  it('SPK-REG-008: lists waitlists across offerings with live counts and the time left on an open offer', async () => {
    const app = createTestApp({
      routes: { ...nameRoutes(), 'GET /waitlist-queue': QUEUE },
    });
    render(app.at('/registrations'));
    const card = (await screen.findByRole('heading', { name: 'Waitlists' })).closest('section')!;
    expect(
      await within(card as HTMLElement).findByText('7 waiting · 1 offer open'),
    ).toBeInTheDocument();
    const list = within(card as HTMLElement).getByRole('list', { name: 'Waitlist entries' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('Offer open · 4h 48m left')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('offered')).toBeInTheDocument();
    expect(within(rows[0]!).getByRole('link', { name: 'Winter camp week 1' })).toHaveAttribute(
      'href',
      `/registrations/waitlists/${OFFERING_ID}`,
    );
    expect(within(rows[1]!).getByText(/Position 1 · joined/)).toBeInTheDocument();
    expect(app.fake.requests.find((r) => r.route === '/waitlist-queue')?.query.limit).toBe('5');
  });

  it('says waitlists are not available when the API refuses them, keeping the rest of the page', async () => {
    const app = createTestApp({
      routes: { 'GET /waitlist-queue': apiError(403, 'ACCESS_DENIED') },
    });
    render(app.at('/registrations'));
    expect(await screen.findByText('Waitlists are not available to you.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Needs a decision' })).toBeInTheDocument();
  });

  it('shows an empty waitlist as designed', async () => {
    const app = createTestApp({
      routes: {
        'GET /waitlist-queue': ok({
          items: [],
          nextCursor: null,
          counts: { waiting: 0, offered: 0 },
        }),
      },
    });
    render(app.at('/registrations'));
    expect(await screen.findByText('Nobody waiting')).toBeInTheDocument();
  });
});
