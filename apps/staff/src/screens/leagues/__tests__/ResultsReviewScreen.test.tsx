/**
 * SCR-S-11 Results review and publication (SPK-RESULT-001, SPK-RESULT-002, SPK-RESULT-004 reviewed
 * corrections, SPK-AT-014 history retained and downstream review required, §4.7 invariant 8
 * publication authority, DEC-065 pending).
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../../../testing/test-app';
import {
  ID,
  created,
  fail,
  fixtureDetail,
  ok,
  operation,
  page,
  resultRevision,
  reviewTask,
  standings,
} from '../../../features/competition/__tests__/fixtures';

const official = resultRevision({
  id: ID.result1,
  revisionNo: 1,
  status: 'official',
  publishedBy: { kind: 'staff', accountId: null, personId: null, actorLabel: 'L. Manager' },
  publishedAt: '2026-11-08T09:00:00.000Z',
});
const correction = resultRevision({
  id: ID.result2,
  revisionNo: 2,
  status: 'submitted',
  homeScore: 2,
  awayScore: 2,
  supersedesRevisionId: ID.result1,
  revision: 1,
});

function routes(revisions: unknown[], tasks: unknown[] = []) {
  return {
    'GET /fixtures/{id}': ok(fixtureDetail()),
    'GET /fixtures/{id}/results': ok(revisions),
    'GET /exceptions': (req: { query: Record<string, string> }) =>
      new Response(JSON.stringify(page(req.query.status === 'open' ? tasks : [])), { status: 200 }),
    'GET /operations/{id}': ok(operation('succeeded')),
  };
}

describe('SCR-S-11 ResultsReviewScreen (SPK-RESULT-001, SPK-RESULT-004)', () => {
  it('publishes a submitted result as official with the expected revision and shows the outcome', async () => {
    const user = userEvent.setup();
    const submitted = resultRevision();
    const app = createTestApp({
      routes: {
        ...routes([submitted]),
        'POST /results/{id}/publish': ok({
          revision: { ...submitted, status: 'official' },
          published: true,
          supersededRevisionId: null,
          reviewExceptionId: null,
          standings: standings(),
          proposedSuspensionIds: [ID.suspension],
          progressedBracketNodeIds: [],
          operationId: ID.operation,
        }),
      },
    });
    render(app.at(`/leagues/fixtures/${ID.fixture}/results`));
    const list = await screen.findByRole('list', { name: 'Result revisions, newest first' });
    expect(within(list).getByText('Revision 1: Red 3 – 1 Blue')).toBeInTheDocument();
    expect(within(list).getByText('Result submitted')).toBeInTheDocument();
    expect(screen.getByText(/depends on DEC-065/)).toBeInTheDocument();
    await user.click(within(list).getByRole('button', { name: 'Publish as official' }));
    const outcome = await screen.findByTestId('publish-outcome');
    expect(within(outcome).getByText('Result official')).toBeInTheDocument();
    expect(within(outcome).getByText(/Standings recalculated/)).toBeInTheDocument();
    expect(
      within(outcome).getByText(/1 suspension was proposed by the rule set/),
    ).toBeInTheDocument();
    expect(await within(outcome).findByText('succeeded')).toBeInTheDocument();
    const publish = app.fake.requests.find((r) => r.route === '/results/{id}/publish');
    expect(publish?.params).toEqual({ id: ID.result1 });
    expect(publish?.body).toEqual({ expectedRevision: 2 });
    expect(publish?.headers['idempotency-key']).toMatch(/^key-/);
  });

  it('keeps the superseded official result with actor, reason and publication time', async () => {
    const app = createTestApp({
      routes: routes([
        {
          ...official,
          status: 'superseded',
          supersededAt: '2026-11-09T09:00:00.000Z',
          supersededByRevisionId: ID.result2,
        },
        resultRevision({
          id: ID.result2,
          revisionNo: 2,
          status: 'official',
          reason: 'Score sheet showed 2-2.',
          publishedBy: { kind: 'staff', accountId: null, personId: null, actorLabel: 'L. Manager' },
          publishedAt: '2026-11-09T09:00:00.000Z',
        }),
      ]),
    });
    render(app.at(`/leagues/fixtures/${ID.fixture}/results`));
    const list = await screen.findByRole('list', { name: 'Result revisions, newest first' });
    const items = within(list).getAllByRole('listitem');
    expect(within(items[0] as HTMLElement).getByText('Result official')).toBeInTheDocument();
    expect(
      within(items[0] as HTMLElement).getByText('Correction reason: Score sheet showed 2-2.'),
    ).toBeInTheDocument();
    expect(within(items[1] as HTMLElement).getByText('Result superseded')).toBeInTheDocument();
    expect(
      within(items[1] as HTMLElement).getByText(/Published by L. Manager/),
    ).toBeInTheDocument();
    expect(within(items[1] as HTMLElement).getByText(/Superseded/)).toBeInTheDocument();
  });

  it('requires a reason to publish a correction and reports a management review without rewriting', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...routes([correction, official]),
        'POST /results/{id}/publish': ok({
          revision: correction,
          published: false,
          supersededRevisionId: null,
          reviewExceptionId: ID.exception,
          standings: null,
          proposedSuspensionIds: [],
          progressedBracketNodeIds: [],
          operationId: ID.operation,
        }),
      },
    });
    render(app.at(`/leagues/fixtures/${ID.fixture}/results`));
    const list = await screen.findByRole('list', { name: 'Result revisions, newest first' });
    await user.click(within(list).getByRole('button', { name: 'Publish the correction' }));
    expect(
      within(list).getByText('A correction of an official result needs a reason.'),
    ).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.method === 'POST')).toBe(false);
    await user.type(
      within(list).getByLabelText(/^Reason for the correction/),
      'Score sheet showed 2-2.',
    );
    await user.click(within(list).getByRole('button', { name: 'Publish the correction' }));
    const review = await screen.findByTestId('review-required');
    expect(within(review).getByText('Management review required')).toBeInTheDocument();
    expect(within(review).getByText(/nothing was rewritten/)).toBeInTheDocument();
    expect(app.fake.requests.find((r) => r.method === 'POST')?.body).toEqual({
      expectedRevision: 1,
      reason: 'Score sheet showed 2-2.',
    });
  });

  it('publishes a reviewed correction against its open review task (SPK-AT-014)', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...routes([{ ...correction, reason: 'Score sheet showed 2-2.' }, official], [reviewTask()]),
        'POST /results/{id}/publish': ok({
          revision: { ...correction, status: 'official' },
          published: true,
          supersededRevisionId: ID.result1,
          reviewExceptionId: ID.exception,
          standings: null,
          proposedSuspensionIds: [],
          progressedBracketNodeIds: [ID.node1],
          operationId: ID.operation,
        }),
      },
    });
    render(app.at(`/leagues/fixtures/${ID.fixture}/results`));
    await user.click(await screen.findByRole('button', { name: 'Publish after review' }));
    const outcome = await screen.findByTestId('publish-outcome');
    expect(within(outcome).getByText(/now superseded and kept in the history/)).toBeInTheDocument();
    expect(app.fake.requests.find((r) => r.method === 'POST')?.body).toEqual({
      expectedRevision: 1,
      reviewExceptionId: ID.exception,
    });
  });

  it('shows ACCESS_DENIED from publication as not available, naming the missing authority', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...routes([resultRevision()]),
        'POST /results/{id}/publish': fail(
          403,
          'ACCESS_DENIED',
          'contact_support_or_request_access',
          {
            message: 'Publication authority is required.',
          },
        ),
      },
    });
    render(app.at(`/leagues/fixtures/${ID.fixture}/results`));
    await user.click(await screen.findByRole('button', { name: 'Publish as official' }));
    expect(await screen.findByText('Not available to you')).toBeInTheDocument();
    expect(screen.getByText(/Publication authority is required/)).toBeInTheDocument();
  });

  it('shows a recovery-required publication operation as recovery, not success', async () => {
    const user = userEvent.setup();
    const submitted = resultRevision();
    const app = createTestApp({
      routes: {
        ...routes([submitted]),
        'GET /operations/{id}': ok(operation('recovery_required')),
        'POST /results/{id}/publish': ok({
          revision: { ...submitted, status: 'official' },
          published: true,
          supersededRevisionId: null,
          reviewExceptionId: null,
          standings: null,
          proposedSuspensionIds: [],
          progressedBracketNodeIds: [],
          operationId: ID.operation,
        }),
      },
    });
    render(app.at(`/leagues/fixtures/${ID.fixture}/results`));
    await user.click(await screen.findByRole('button', { name: 'Publish as official' }));
    expect(await screen.findByText('recovery_required')).toBeInTheDocument();
    expect(screen.getByText(/A follow-up step was not recorded/)).toBeInTheDocument();
  });

  it('returns a submitted result for correction only with a reason', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...routes([resultRevision()]),
        'POST /results/{id}/return': ok(resultRevision({ status: 'draft' })),
      },
    });
    render(app.at(`/leagues/fixtures/${ID.fixture}/results`));
    await user.click(await screen.findByRole('button', { name: 'Return for correction' }));
    const form = screen.getByRole('form', { name: 'Return for correction' });
    await user.click(within(form).getByRole('button', { name: 'Return to the submitter' }));
    expect(within(form).getByText('Say what needs correcting.')).toBeInTheDocument();
    await user.type(within(form).getByLabelText(/^What needs correcting/), 'Away score missing.');
    await user.click(within(form).getByRole('button', { name: 'Return to the submitter' }));
    expect(
      await within(form).findByText('Result draft: returned for correction'),
    ).toBeInTheDocument();
    expect(app.fake.requests.find((r) => r.method === 'POST')?.body).toEqual({
      expectedRevision: 2,
      reason: 'Away score missing.',
    });
  });

  it('asks for a classification before submitting a correction (validation failure)', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...routes([official]),
        'POST /fixtures/{id}/results': created(correction),
      },
    });
    render(app.at(`/leagues/fixtures/${ID.fixture}/results`));
    await user.click(await screen.findByRole('button', { name: 'Start a correction' }));
    const form = screen.getByRole('form', { name: 'Submit a correction' });
    await user.click(
      within(form).getByRole('button', { name: 'Submit the correction for review' }),
    );
    expect(within(form).getByText('Choose how the match ended.')).toBeInTheDocument();
    expect(within(form).getByText('A correction needs a reason.')).toBeInTheDocument();
    await user.selectOptions(within(form).getByLabelText(/^Classification/), 'completed');
    await user.type(within(form).getByLabelText(/^Red score/), '2');
    await user.type(within(form).getByLabelText(/^Blue score/), '2');
    await user.type(
      within(form).getByLabelText(/^Reason for the correction/),
      'Score sheet showed 2-2.',
    );
    await user.click(
      within(form).getByRole('button', { name: 'Submit the correction for review' }),
    );
    expect(await within(form).findByText('Revision 2 submitted')).toBeInTheDocument();
    expect(app.fake.requests.find((r) => r.method === 'POST')?.body).toEqual({
      classification: 'completed',
      homeScore: 2,
      awayScore: 2,
      reason: 'Score sheet showed 2-2.',
    });
  });

  it('says when nothing was submitted, and when results are not available', async () => {
    const app = createTestApp({ routes: routes([]) });
    render(app.at(`/leagues/fixtures/${ID.fixture}/results`));
    expect(await screen.findByRole('heading', { name: 'Nothing submitted' })).toBeInTheDocument();

    const denied = createTestApp({
      routes: { 'GET /fixtures/{id}/results': fail(404, 'NOT_FOUND', 'verify_reference') },
    });
    render(denied.at(`/leagues/fixtures/${ID.fixture}/results`));
    await waitFor(() => expect(screen.getAllByText('Not available').length).toBeGreaterThan(0));
  });
});

describe('SCR-S-11 ResultsReviewQueueScreen (SPK-AT-014, SPK-FIX-002)', () => {
  it('lists open correction reviews and incomplete seasons with links to their records', async () => {
    const app = createTestApp({
      routes: {
        'GET /exceptions': ok(
          page([
            reviewTask(),
            reviewTask({
              id: ID.operation,
              category: 'competition.incomplete_season',
              title: 'Season published with unscheduled fixtures',
              affected: { type: 'season', id: ID.season },
              severity: 'warning',
              details: { unscheduledFixtures: 2 },
              deadlineAt: '2026-10-31T12:00:00.000Z',
            }),
            reviewTask({ id: ID.dispute, category: 'other.thing', title: 'Unrelated' }),
          ]),
        ),
      },
    });
    render(app.at('/leagues/results-review'));
    const corrections = await screen.findByRole('list', { name: 'Corrections awaiting review' });
    expect(
      within(corrections).getByText('Result correction affects published history'),
    ).toBeInTheDocument();
    expect(within(corrections).getByText(/Affects 1 bracket node/)).toBeInTheDocument();
    expect(
      within(corrections).getByRole('link', { name: 'Review the correction' }),
    ).toHaveAttribute('href', `/leagues/fixtures/${ID.fixture}/results`);
    const seasons = screen.getByRole('list', { name: 'Seasons with remaining obligations' });
    expect(within(seasons).getByText('2 fixture(s) still unscheduled.')).toBeInTheDocument();
    expect(screen.queryByText('Unrelated')).toBeNull();
    expect(
      screen.getByText('Submitted results across fixtures: not available yet'),
    ).toBeInTheDocument();
    expect(app.fake.requests.find((r) => r.route === '/exceptions')?.query).toMatchObject({
      queue: 'league_manager',
    });
  });

  it('shows the queue as not available when the viewer may not read it', async () => {
    const app = createTestApp({
      routes: {
        'GET /exceptions': fail(403, 'ACCESS_DENIED', 'contact_support_or_request_access'),
      },
    });
    render(app.at('/leagues/results-review'));
    expect(await screen.findByText('Not available')).toBeInTheDocument();
  });
});
