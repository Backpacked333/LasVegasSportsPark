/**
 * The facility of a record outside the default facility directory (SPK-SCHED-008, K-04): a record
 * whose facility `GET /v1/facilities` does not list (archived) is shown in that facility's own zone,
 * read with `GET /v1/facilities/{id}`; when that read fails, times are in UTC and the screen says the
 * zone is not available (SPK-UX-008), never the zone of another facility. Exercised on SCR-S-42.
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { INVENTORY, facilitySummary, oneFacilityRoutes, restriction } from '../test-fixtures';
import { createTestApp } from '../../../testing/test-app';

/** A facility of the organization that the default directory listing leaves out (archived). */
const ARCHIVED = '0192f1a0-0000-7000-8000-00000000fa03';

function routes(overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...oneFacilityRoutes(),
    'GET /resources': { status: 200, body: INVENTORY },
    'GET /assets': { status: 200, body: [] },
    'GET /maintenance-restrictions/{id}': {
      status: 200,
      body: restriction({
        id: 'r-9',
        facilityId: ARCHIVED,
        status: 'released',
        releasedAt: '2026-10-20T18:00:00.000Z',
        releasedBy: {
          kind: 'staff',
          accountId: null,
          personId: null,
          actorLabel: 'Facilities lead',
        },
        releaseReason: 'Repaired',
      }),
    },
    ...overrides,
  };
}

const facilityReads = (app: ReturnType<typeof createTestApp>) =>
  app.fake.requests.filter((r) => r.route === '/facilities/{id}');

describe('a record whose facility the default directory does not list', () => {
  it('reads the one facility with GET /v1/facilities/{id} and shows times in its zone', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /facilities/{id}': {
          status: 200,
          body: facilitySummary({
            id: ARCHIVED,
            slug: 'old-park',
            name: 'Old Park',
            timezone: 'America/Denver',
            status: 'archived',
            inStaffScope: false,
          }),
        },
      }),
    });
    render(app.at('/facilities/restrictions/r-9'));
    expect(
      await screen.findByText('Times are facility local time (America/Denver).'),
    ).toBeInTheDocument();
    expect(facilityReads(app).map((r) => r.params.id)).toContain(ARCHIVED);
    // 2026-10-20T18:00Z is 12:00 in Denver (MDT), not 11:00 in Los Angeles.
    expect(screen.getByText(/by Facilities lead: Repaired$/)).toHaveTextContent('12:00');
  });

  it('a facility that cannot be read is shown in UTC and says the zone is not available', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /facilities/{id}': () => fakeResponse(404, apiErrorBody('NOT_FOUND')),
      }),
    });
    render(app.at('/facilities/restrictions/r-9'));
    expect(
      await screen.findByText('Times are facility local time (UTC, zone not available).'),
    ).toBeInTheDocument();
    await waitFor(() => expect(facilityReads(app).length).toBeGreaterThan(0));
    expect(screen.queryByText(/America\/Los_Angeles/)).toBeNull();
  });

  it('a facility the directory lists is not read again', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /maintenance-restrictions/{id}': {
          status: 200,
          body: restriction({ id: 'r-9', status: 'released' }),
        },
      }),
    });
    render(app.at('/facilities/restrictions/r-9'));
    expect(
      await screen.findByText('Times are facility local time (America/Los_Angeles).'),
    ).toBeInTheDocument();
    expect(facilityReads(app)).toHaveLength(0);
  });
});
