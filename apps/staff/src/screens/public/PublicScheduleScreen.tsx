/**
 * A facility's schedule for a day, by field and time, without sign-in (SPK-SCHED-010, proposed
 * amendment PA-06): `/public/:organization/schedule/:code?date=YYYY-MM-DD`. The API decides every
 * word shown: a private booking reads "Reserved" with no renter, a game of a competition that is
 * not public reads "League game", and a title a person typed never arrives here.
 *
 * The API answers for a window of days around today only (`window` in the answer: a proposed
 * default of yesterday to 14 days ahead, DEC-100 pending; security review L-3). The previous and
 * next day controls stop at the window's first and last day, and the page says which days it
 * shows. A day outside the window, typed into the address, reads "Not available".
 */
import type { Schema } from '@sportspark/api-client';
import { Link, useParams, useSearchParams } from 'react-router';
import { formatPublicDate, formatPublicTime, PublicFrame } from './PublicFrame';
import { usePublicView } from './usePublicView';

export type DaySchedule = Schema<'PublicDaySchedule'>;
type Entry = Schema<'PublicScheduleEntry'>;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The day before or after a calendar date, as YYYY-MM-DD. */
export function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export function entryText(entry: Entry): string {
  return entry.score ? `${entry.title}, ${entry.score.home} to ${entry.score.away}` : entry.title;
}

/** The day's entries as rows of time, field and what occupies it. */
export function ScheduleTable({
  entries,
  timezone,
  caption,
}: {
  entries: readonly Entry[];
  timezone: string;
  caption: string;
}) {
  if (entries.length === 0) {
    return <p className="public-empty">Nothing is scheduled.</p>;
  }
  return (
    <table className="public-table">
      <caption className="public-sr">{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Time</th>
          <th scope="col">Field</th>
          <th scope="col">What</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry, index) => (
          <tr key={`${entry.startsAt}-${entry.fields.join('+')}-${index}`} data-kind={entry.kind}>
            <td className="public-time">
              {formatPublicTime(entry.startsAt, timezone)} to{' '}
              {formatPublicTime(entry.endsAt, timezone)}
            </td>
            <td>{entry.fields.length > 0 ? entry.fields.join(', ') : 'To be announced'}</td>
            <td>
              <span className="public-kind" data-kind={entry.kind}>
                {entry.title}
              </span>
              {entry.score ? (
                <span className="public-score">
                  {' '}
                  {entry.score.home} : {entry.score.away}
                </span>
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * A link to another day, or, at the end of the days this view shows, the same words as text that
 * says no day follows (never a link to a day the API would answer "not available" for).
 */
function DayLink({ label, to }: { label: string; to: string | null }) {
  if (to === null) {
    return (
      <span className="public-nav-end" aria-disabled="true">
        {label}
        <span className="public-sr"> (not shown: outside the days this page shows)</span>
      </span>
    );
  }
  return <Link to={`?date=${to}`}>{label}</Link>;
}

export function PublicScheduleScreen() {
  const { organization = '', code = '' } = useParams();
  const [params] = useSearchParams();
  const asked = params.get('date');
  const date = asked && DATE.test(asked) ? asked : undefined;
  const view = usePublicView(
    {
      path: '/public/{organization}/schedule/{code}',
      request: { path: { organization, code }, query: date ? { date } : {} },
    },
    `schedule:${organization}:${code}:${date ?? 'today'}`,
  );
  return (
    <PublicFrame
      view={view}
      organizationName={(data) => data.organizationName}
      title={(data) => `${data.facilityName} schedule`}
      subtitle={(data) => formatPublicDate(data.date)}
      timezone={(data) => data.timezone}
    >
      {(data) => (
        <>
          <nav className="public-nav" aria-label="Days">
            <DayLink
              label="Previous day"
              to={data.date > data.window.from ? shiftDate(data.date, -1) : null}
            />
            <Link to=".">Today</Link>
            <DayLink
              label="Next day"
              to={data.date < data.window.to ? shiftDate(data.date, 1) : null}
            />
          </nav>
          <p className="public-note" data-testid="public-window">
            This page shows {formatPublicDate(data.window.from)} to{' '}
            {formatPublicDate(data.window.to)}.
          </p>
          <ScheduleTable
            entries={data.entries}
            timezone={data.timezone}
            caption={`Schedule of ${data.facilityName} on ${formatPublicDate(data.date)}`}
          />
          <p className="public-note">Times are shown in the facility&apos;s time zone.</p>
        </>
      )}
    </PublicFrame>
  );
}
