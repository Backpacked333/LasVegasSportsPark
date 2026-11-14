/**
 * A facility's schedule for a day, by field and time, without sign-in (SPK-SCHED-010, proposed
 * amendment PA-06): `/public/:organization/schedule/:code?date=YYYY-MM-DD`. The API decides every
 * word shown: a private booking reads "Reserved" with no renter, a game of a competition that is
 * not public reads "League game", and a title a person typed never arrives here.
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
            <Link to={`?date=${shiftDate(data.date, -1)}`}>Previous day</Link>
            <Link to=".">Today</Link>
            <Link to={`?date=${shiftDate(data.date, 1)}`}>Next day</Link>
          </nav>
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
