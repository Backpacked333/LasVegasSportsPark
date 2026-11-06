/**
 * "Needs your call" (SCR-S-11 summary on the league home and the season home; SPK-RESULT-001,
 * SPK-RESULT-004, SPK-AT-014, SPK-FIX-002, SPK-UX-006, SPK-UX-008): what waits for a league
 * manager's decision, from the same reads the result review queue uses:
 *
 * - open or acknowledged review tasks of the league manager queue (`GET /v1/exceptions`) for
 *   corrections that touch a published bracket or a played game, and seasons left with
 *   unscheduled fixtures; with `seasonId` only the tasks about that season;
 * - with `seasonId`, the season's results submitted and awaiting publication
 *   (`GET /v1/seasons/{id}/result-revisions?status=submitted`).
 *
 * - with `seasonId`, fixtures played without any result (`GET /v1/seasons/{id}/results-awaiting`):
 *   players marked present per side and, when the API suggests one from the rule set and the
 *   attendance, the forfeit to record.
 *
 * Inline decisions use the ordinary commands, each with its own idempotency key: "Accept the
 * report" publishes a submitted result (`POST /v1/results/{id}/publish` with its revision; a
 * correction that needs management review says so and publishes nothing); "Record the forfeit"
 * submits the suggested forfeit (`POST /v1/fixtures/{id}/results`) and then publishes it; "Nudge
 * captains" records a reminder to both captains (`POST /v1/fixtures/{id}/result-reminders`;
 * delivery belongs to communications). Every item also links to the screen with the full
 * decision. A read the viewer may not make says so in words and never implies there is nothing
 * to do.
 */
import {
  formatAge,
  presentationForError,
  type ApiError,
  type Schema,
} from '@sportspark/api-client';
import { useState } from 'react';
import { Link } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandButton } from '../../features/competition/CommandButton';
import { CommandError } from '../../features/competition/CommandError';
import { keys } from '../../features/competition/feedback';
import { CardHead } from '../../ui/Page';
import { useNow } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { StatusBadge, type StatusTone } from '../../ui/StatusBadge';
import { RESULT_CLASSIFICATION } from '../../features/competition/labels';
import { RESULT_REVIEW_CATEGORY } from './ResultsReviewScreen';
import { INCOMPLETE_SEASON_CATEGORY } from './ResultsReviewQueueScreen';

type OperationalException = Schema<'OperationalException'>;
type Revision = Schema<'ResultRevision'>;
type Awaiting = Schema<'ResultAwaiting'>;

const CALL_KEYS = keys(
  '/seasons/{id}/result-revisions',
  '/seasons/{id}/results-awaiting',
  '/seasons/{id}/standings',
  '/fixtures/{id}/results',
  '/exceptions',
);

const CALL_LIMIT = 5;

function detail(task: OperationalException, key: string): string | null {
  const value = task.details[key];
  return typeof value === 'string' ? value : null;
}

function seasonOf(task: OperationalException): string | null {
  return task.affected?.type === 'season' ? task.affected.id : detail(task, 'seasonId');
}

/** Open review tasks of the league manager queue, optionally about one season. */
export function openReviewTasks(
  items: readonly OperationalException[],
  seasonId?: string,
): OperationalException[] {
  return items.filter(
    (t) =>
      (t.category === RESULT_REVIEW_CATEGORY || t.category === INCOMPLETE_SEASON_CATEGORY) &&
      (t.status === 'open' || t.status === 'acknowledged') &&
      (!seasonId || seasonOf(t) === seasonId),
  );
}

const TASK_TAG: Record<string, { tone: StatusTone; label: string }> = {
  [RESULT_REVIEW_CATEGORY]: { tone: 'danger', label: 'Correction review' },
  [INCOMPLETE_SEASON_CATEGORY]: { tone: 'warning', label: 'Unscheduled fixtures' },
};

function TaskCall({ task, now }: { task: OperationalException; now: Date }) {
  const tag = TASK_TAG[task.category] ?? { tone: 'info' as const, label: 'Review task' };
  const fixtureId = detail(task, 'fixtureId');
  const seasonId = seasonOf(task);
  return (
    <li>
      <span className="actions-row">
        <StatusBadge tone={tag.tone} label={tag.label} />
        {task.overdue ? <StatusBadge tone="danger" label="Overdue" /> : null}
      </span>
      <span className="call-title">{task.title}</span>
      <span className="caption">
        Opened {formatAge(new Date(task.openedAt), now)} · Owner: {task.ownerQueue}
      </span>
      {fixtureId ? (
        <Link
          className="button button-primary button-sm"
          to={`/leagues/fixtures/${fixtureId}/results`}
        >
          Review the correction
        </Link>
      ) : seasonId ? (
        <Link
          className="button button-secondary button-sm"
          to={`/leagues/seasons/${seasonId}/fixtures`}
        >
          Open the season&apos;s fixtures
        </Link>
      ) : null}
    </li>
  );
}

function SubmittedCall({ revision }: { revision: Revision }) {
  // The same fixture read as the season's revision rows (team names, CMP-01).
  const fixture = useApiQuery({
    path: '/fixtures/{id}',
    request: { path: { id: revision.fixtureId } },
    staleTime: 5 * 60_000,
  });
  const home = fixture.data?.home.teamName;
  const away = fixture.data ? (fixture.data.away?.teamName ?? 'bye') : undefined;
  const scored = revision.homeScore !== null && revision.awayScore !== null;
  const match =
    home && away
      ? scored
        ? `${home} ${revision.homeScore} – ${revision.awayScore} ${away}`
        : `${home} v ${away}`
      : scored
        ? `${revision.homeScore} – ${revision.awayScore}`
        : 'Fixture result';
  return (
    <li>
      <StatusBadge tone="info" label="Result submitted" />
      <span className="call-title">{match}</span>
      <span className="caption">{RESULT_CLASSIFICATION[revision.classification]}</span>
      <span className="caption">
        Submitted by {revision.submittedBy.actorLabel}, revision {revision.revisionNo}. Publish it
        or return it.
      </span>
      <span className="actions-row">
        <AcceptReport revision={revision} match={match} />
        <Link
          className="button button-secondary button-sm"
          to={`/leagues/fixtures/${revision.fixtureId}/results`}
        >
          Review the result
        </Link>
      </span>
    </li>
  );
}

/** Publishes the submitted result as it stands (SPK-RESULT-001: the only path to official). */
function AcceptReport({ revision, match }: { revision: Revision; match: string }) {
  const publish = useApiCommand('post', '/results/{id}/publish', { invalidate: CALL_KEYS });
  const send = () =>
    void publish
      .submit({ path: { id: revision.id }, body: { expectedRevision: revision.revision } })
      .catch(() => undefined);
  if (publish.status === 'success' && publish.data) {
    return publish.data.published ? (
      <StatusBadge tone="success" label="Published" />
    ) : (
      <StatusBadge tone="warning" label="Needs management review: nothing was published" />
    );
  }
  return (
    <>
      <CommandButton
        className="button-sm"
        busy={publish.isProcessing}
        aria-label={`Accept the report: ${match}`}
        onClick={send}
      >
        Accept the report
      </CommandButton>
      <CommandError error={publish.error} onRetry={send} onReload={() => publish.reset()} />
    </>
  );
}

/** A fixture played without a result: the suggested forfeit, a reminder, or the result screen. */
function AwaitingCall({ item }: { item: Awaiting }) {
  const now = useNow();
  const [home, away] = item.sides;
  const match = `${home?.teamName ?? 'Home'} v ${away?.teamName ?? 'Away'}`;
  const submit = useApiCommand('post', '/fixtures/{id}/results', { invalidate: CALL_KEYS });
  const publish = useApiCommand('post', '/results/{id}/publish', { invalidate: CALL_KEYS });
  const remind = useApiCommand('post', '/fixtures/{id}/result-reminders', {
    invalidate: CALL_KEYS,
  });
  const [step, setStep] = useState<'idle' | 'submitted' | 'published'>('idle');
  const forfeit = item.suggestedForfeit;
  const forfeiting = item.sides.find((s) => s.teamEntryId === forfeit?.forfeitingEntryId);
  const recordForfeit = async () => {
    if (!forfeit) return;
    try {
      const revision = await submit.submit({
        path: { id: item.fixtureId },
        body: {
          classification: 'forfeit',
          homeScore: forfeit.homeScore,
          awayScore: forfeit.awayScore,
          forfeitingEntryId: forfeit.forfeitingEntryId,
        },
      });
      setStep('submitted');
      await publish.submit({
        path: { id: revision.id },
        body: { expectedRevision: revision.revision },
      });
      setStep('published');
    } catch {
      // Shown by CommandError below; a submitted forfeit then waits under "Result submitted".
    }
  };
  const nudge = () =>
    void remind.submit({ path: { id: item.fixtureId }, body: {} }).catch(() => undefined);
  const present = item.sides
    .map((s) => `${s.teamName} ${s.present === null ? 'not checked in' : `${s.present} present`}`)
    .join(' · ');
  return (
    <li>
      <span className="actions-row">
        <StatusBadge
          tone={forfeit ? 'neutral' : 'info'}
          label={forfeit ? 'Forfeit' : 'Missing result'}
        />
        {item.reminderCount > 0 && item.lastReminderAt ? (
          <StatusBadge
            tone="pending"
            label={`Captains nudged ${formatAge(new Date(item.lastReminderAt), now)}`}
          />
        ) : null}
      </span>
      <span className="call-title">{match}</span>
      <span className="caption">
        {forfeit
          ? forfeit.reason
          : `No result from either team or the referee since the game ended ${formatAge(new Date(item.scheduledEnd), now)}.`}
      </span>
      <span className="caption">
        {present} (minimum {item.minimumPlayersToStart})
      </span>
      <span className="actions-row">
        {forfeit && step !== 'published' ? (
          <CommandButton
            className="button-sm"
            busy={submit.isProcessing || publish.isProcessing}
            aria-label={`Record the ${forfeit.homeScore}–${forfeit.awayScore} forfeit: ${forfeiting?.teamName ?? 'the short side'} forfeits ${match}`}
            onClick={() => void recordForfeit()}
          >
            Record {forfeit.homeScore}–{forfeit.awayScore} forfeit
          </CommandButton>
        ) : null}
        {step === 'published' ? <StatusBadge tone="success" label="Forfeit published" /> : null}
        {step === 'submitted' && publish.error ? (
          <StatusBadge tone="warning" label="Forfeit submitted, not yet published" />
        ) : null}
        {remind.status === 'success' && remind.data ? (
          <StatusBadge
            tone="success"
            label={`Reminder recorded for ${remind.data.recipientCount} ${remind.data.recipientCount === 1 ? 'captain' : 'captains'}`}
          />
        ) : (
          <CommandButton
            variant="secondary"
            className="button-sm"
            busy={remind.isProcessing}
            aria-label={`Nudge captains: ${match}`}
            onClick={nudge}
          >
            Nudge captains
          </CommandButton>
        )}
        <Link
          className="button button-secondary button-sm"
          to={`/leagues/fixtures/${item.fixtureId}/results`}
        >
          Enter result
        </Link>
      </span>
      <CommandError
        error={submit.error ?? publish.error ?? remind.error}
        onRetry={() => (remind.error ? nudge() : void recordForfeit())}
        onReload={() => {
          submit.reset();
          publish.reset();
          remind.reset();
        }}
      />
    </li>
  );
}

function ReadNote({
  what,
  error,
  onRetry,
}: {
  what: string;
  error: ApiError;
  onRetry: () => void;
}) {
  if (presentationForError(error) === 'unavailable') {
    return <li className="caption">{what} are not available to you.</li>;
  }
  return (
    <li className="caption">
      {what} could not load ({error.code}).{' '}
      <Button
        variant="secondary"
        className="button-sm"
        onClick={onRetry}
        aria-label={`Load ${what.toLowerCase()} again`}
      >
        Load again
      </Button>
    </li>
  );
}

export function NeedsYourCall({ seasonId }: { seasonId?: string }) {
  const now = useNow();
  const tasks = useApiQuery({
    path: '/exceptions',
    request: { query: { queue: 'league_manager', limit: 100 } },
  });
  const submitted = useApiQuery({
    path: '/seasons/{id}/result-revisions',
    request: { path: { id: seasonId ?? '' }, query: { status: 'submitted', limit: CALL_LIMIT } },
    enabled: !!seasonId,
  });
  const awaiting = useApiQuery({
    path: '/seasons/{id}/results-awaiting',
    request: { path: { id: seasonId ?? '' } },
    enabled: !!seasonId,
  });
  const open = tasks.data ? openReviewTasks(tasks.data.items, seasonId) : [];
  const results = submitted.data?.items ?? [];
  const waiting = (awaiting.data?.items ?? []).slice(0, CALL_LIMIT);
  const loading =
    (!tasks.data && !tasks.error) ||
    (!!seasonId && !submitted.data && !submitted.error) ||
    (!!seasonId && !awaiting.data && !awaiting.error);
  const total = open.length + results.length + waiting.length;
  return (
    <section className="card card-flush" aria-labelledby="calls-title">
      <CardHead aside={<span className="caption">Results review</span>}>
        <h3 id="calls-title">Needs your call</h3>
      </CardHead>
      <ul className="call-list" aria-label="Decisions waiting">
        {tasks.error && !tasks.data ? (
          <ReadNote what="Review tasks" error={tasks.error} onRetry={() => void tasks.refetch()} />
        ) : null}
        {seasonId && submitted.error && !submitted.data ? (
          <ReadNote
            what="Submitted results"
            error={submitted.error}
            onRetry={() => void submitted.refetch()}
          />
        ) : null}
        {seasonId && awaiting.error && !awaiting.data ? (
          <ReadNote
            what="Games without a result"
            error={awaiting.error}
            onRetry={() => void awaiting.refetch()}
          />
        ) : null}
        {results.map((revision) => (
          <SubmittedCall key={revision.id} revision={revision} />
        ))}
        {waiting.map((item) => (
          <AwaitingCall key={item.fixtureId} item={item} />
        ))}
        {open.slice(0, CALL_LIMIT).map((task) => (
          <TaskCall key={task.id} task={task} now={now} />
        ))}
        {loading ? (
          <li className="caption" aria-busy="true">
            Checking for decisions…
          </li>
        ) : total === 0 && !tasks.error && !submitted.error && !awaiting.error ? (
          <li>
            <StatusBadge tone="success" label="Nothing waiting" />
            <span className="caption">
              No submitted results or open review tasks
              {seasonId ? ' for this season' : ''} right now.
            </span>
          </li>
        ) : null}
      </ul>
      <p className="card-note">
        <Link to="/leagues/results-review">
          All result review tasks{open.length > CALL_LIMIT ? ` (${open.length} open)` : ''}
        </Link>
        {submitted.data?.nextCursor
          ? ' · more submitted results are on the season’s revisions'
          : ''}
      </p>
    </section>
  );
}
