/**
 * SCR-S-11 review tasks (SPK-RESULT-004, SPK-AT-014, SPK-FIX-002, SPK-UX-006, SPK-UX-008): the
 * management review tasks the API opened in the league manager queue for corrections that touch a
 * published bracket or a game already played, and the seasons a publication left with unscheduled
 * fixtures (remaining obligations with owner and deadline). Each task links to the record it is
 * about; acknowledging or closing a task never changes that record (handled on the Today
 * workspace). The API has no list of submitted results across fixtures yet, so results awaiting
 * publication are reached from a season's fixtures.
 */
import { formatAge, type Schema } from '@sportspark/api-client';
import { Link } from 'react-router';
import { useApiQuery } from '../../api/useApiQuery';
import { useNow } from '../../providers/AppProviders';
import { formatInstant } from '../../features/competition/format';
import { LeaguesNav } from '../../features/competition/nav';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge, type StatusTone } from '../../ui/StatusBadge';
import { RESULT_REVIEW_CATEGORY } from './ResultsReviewScreen';

type OperationalException = Schema<'OperationalException'>;

export const INCOMPLETE_SEASON_CATEGORY = 'competition.incomplete_season';

const SEVERITY_TONE: Record<OperationalException['severity'], StatusTone> = {
  info: 'info',
  warning: 'warning',
  high: 'danger',
  critical: 'danger',
};

function detail(task: OperationalException, key: string): string | null {
  const value = task.details[key];
  return typeof value === 'string' ? value : null;
}

function countOf(task: OperationalException, key: string): number {
  const value = task.details[key];
  return Array.isArray(value) ? value.length : 0;
}

function TaskRow({ task, now }: { task: OperationalException; now: Date }) {
  const fixtureId = detail(task, 'fixtureId');
  const seasonId = task.affected?.type === 'season' ? task.affected.id : detail(task, 'seasonId');
  const unscheduled = task.details.unscheduledFixtures;
  const opened = formatAge(new Date(task.openedAt), now);
  return (
    <li aria-labelledby={`task-${task.id}`}>
      <div className="row-text">
        <span className="row-title" id={`task-${task.id}`}>
          {task.title}
        </span>
        <span>
          <StatusBadge tone={SEVERITY_TONE[task.severity]} label={`Severity ${task.severity}`} />{' '}
          <StatusBadge tone="info" label={`Exception ${task.status}`} />
          {task.overdue ? <StatusBadge tone="danger" label="Overdue" /> : null}
        </span>
        <span className="caption">
          Opened {opened} · Owner queue: {task.ownerQueue} · Deadline:{' '}
          {task.deadlineAt ? formatInstant(task.deadlineAt) : 'none'}
        </span>
        {task.category === RESULT_REVIEW_CATEGORY ? (
          <span className="caption">
            Affects {countOf(task, 'affectedBracketNodeIds')} bracket node(s) and{' '}
            {countOf(task, 'affectedFixtureIds')} later fixture(s).
          </span>
        ) : null}
        {typeof unscheduled === 'number' ? (
          <span className="caption">{unscheduled} fixture(s) still unscheduled.</span>
        ) : null}
      </div>
      {fixtureId ? (
        <Link to={`/leagues/fixtures/${fixtureId}/results`}>Review the correction</Link>
      ) : seasonId ? (
        <Link to={`/leagues/seasons/${seasonId}/fixtures`}>Open the season&apos;s fixtures</Link>
      ) : null}
    </li>
  );
}

export function ResultsReviewQueueScreen() {
  const now = useNow();
  const tasks = useApiQuery({
    path: '/exceptions',
    request: { query: { queue: 'league_manager', limit: 100 } },
  });
  return (
    <section aria-labelledby="review-queue-title">
      <h2 id="review-queue-title">Result review tasks</h2>
      <LeaguesNav />
      <StateView
        variant="unavailable"
        title="Submitted results across fixtures: not available yet"
        description="The API lists result revisions per fixture only. Open a season's fixtures to review and publish submitted results."
      />
      <QueryBoundary
        query={tasks}
        label="review tasks"
        isEmpty={(data) =>
          data.items.filter(
            (t) =>
              (t.category === RESULT_REVIEW_CATEGORY ||
                t.category === INCOMPLETE_SEASON_CATEGORY) &&
              (t.status === 'open' || t.status === 'acknowledged'),
          ).length === 0
        }
        empty={{
          title: 'No open review tasks',
          description:
            'Corrections that touch a published bracket or a played game, and seasons left with unscheduled fixtures, appear here.',
        }}
      >
        {(data) => {
          const open = data.items.filter((t) => t.status === 'open' || t.status === 'acknowledged');
          const corrections = open.filter((t) => t.category === RESULT_REVIEW_CATEGORY);
          const seasons = open.filter((t) => t.category === INCOMPLETE_SEASON_CATEGORY);
          return (
            <>
              <section aria-labelledby="corrections-title" className="panel">
                <h3 id="corrections-title">Corrections awaiting management review</h3>
                {corrections.length === 0 ? (
                  <p>None open.</p>
                ) : (
                  <ul className="list" aria-label="Corrections awaiting review">
                    {corrections.map((task) => (
                      <TaskRow key={task.id} task={task} now={now} />
                    ))}
                  </ul>
                )}
              </section>
              <section aria-labelledby="incomplete-title" className="panel">
                <h3 id="incomplete-title">Seasons with unscheduled fixtures</h3>
                {seasons.length === 0 ? (
                  <p>None open.</p>
                ) : (
                  <ul className="list" aria-label="Seasons with remaining obligations">
                    {seasons.map((task) => (
                      <TaskRow key={task.id} task={task} now={now} />
                    ))}
                  </ul>
                )}
              </section>
              {data.nextCursor ? (
                <p className="caption">
                  More tasks exist in the league manager queue; open the Today workspace for the
                  whole queue.
                </p>
              ) : null}
            </>
          );
        }}
      </QueryBoundary>
    </section>
  );
}
