/**
 * Week grid of free blocks by space type for the new-booking form (SCR-S-51/52; SPK-SCHED-002/003,
 * SPK-SCHED-008), from `GET /v1/resource-availability`: for seven facility-local days and each
 * hour, how many spaces of the chosen type have a free start of the chosen length (conflict
 * units, buffers, closures and operating hours applied by the API). Free here is not a hold:
 * choosing a cell picks its day, and the offering's own free times below decide the booking, which
 * the API checks again. No price is shown: booking prices are not in the API.
 */
import type { Schema } from '@sportspark/api-client';
import { useMemo, useState } from 'react';
import { useApiQuery } from '../../../api/useApiQuery';
import {
  addDaysToLocalDate,
  formatLocalDate,
  localDaysWindow,
  localTimeOf,
  resolveLocal,
} from '../../../features/schedule-facilities/time';
import { SelectField } from '../../../ui/FormFields';

type ResourceKind = NonNullable<Schema<'FacilityAvailability'>['resources'][number]['kind']>;

const KIND_OPTIONS: { value: ResourceKind | ''; label: string }[] = [
  { value: '', label: 'Any space' },
  { value: 'pitch', label: 'Pitches' },
  { value: 'subdivision', label: 'Pitch subdivisions' },
  { value: 'room', label: 'Rooms and courts' },
  { value: 'other', label: 'Other spaces' },
];

const pad = (n: number) => String(n).padStart(2, '0');

export function WeekAvailability({
  facilityId,
  timeZone,
  fromDate,
  durationMinutes,
  selectedDate,
  onPickDate,
}: {
  facilityId: string;
  timeZone: string;
  /** The first local day of the grid. */
  fromDate: string;
  durationMinutes: number;
  selectedDate: string;
  onPickDate: (date: string) => void;
}) {
  const [kind, setKind] = useState<ResourceKind | ''>('');
  // The grid keeps its week while the chosen day stays inside it (choosing a cell does not move it).
  const [anchor, setAnchor] = useState(fromDate);
  if (anchor !== fromDate && !(fromDate >= anchor && fromDate < addDaysToLocalDate(anchor, 7))) {
    setAnchor(fromDate);
  }
  const window = useMemo(() => {
    try {
      return localDaysWindow(anchor, 7, timeZone);
    } catch {
      return null;
    }
  }, [anchor, timeZone]);
  const availability = useApiQuery({
    path: '/resource-availability',
    request: {
      query: {
        facilityId,
        start: window?.start ?? '',
        end: window?.end ?? '',
        durationMinutes,
        stepMinutes: 60,
        ...(kind ? { resourceKind: kind } : {}),
      },
    },
    enabled: window !== null,
  });
  const days = Array.from({ length: 7 }, (_, i) => addDaysToLocalDate(anchor, i));
  const data = availability.data;
  // free spaces per start instant
  const freeAt = new Map<string, number>();
  for (const r of data?.resources ?? []) {
    for (const s of r.slots) freeAt.set(s.start, (freeAt.get(s.start) ?? 0) + 1);
  }
  const hours = [
    ...new Set([...freeAt.keys()].map((s) => Number(localTimeOf(s, timeZone).slice(0, 2)))),
  ].sort((a, b) => a - b);
  const cellOf = (day: string, hour: number) => {
    const r = resolveLocal(day, `${pad(hour)}:00`, timeZone);
    const instant = r.kind === 'exact' ? r.instant : r.kind === 'ambiguous' ? r.earlier : null;
    return instant ? (freeAt.get(new Date(instant).toISOString()) ?? 0) : 0;
  };
  return (
    <section className="pg-panel week-grid" aria-labelledby="week-grid-title">
      <div className="week-grid-head">
        <h5 id="week-grid-title">Free blocks this week</h5>
        <SelectField
          label="Space type"
          value={kind}
          onChange={(v) => setKind(v as ResourceKind | '')}
          options={KIND_OPTIONS}
        />
      </div>
      <p className="caption">
        Spaces with a free {durationMinutes}-minute start each hour ({timeZone}). Choose a day to
        see the offering's free times; nothing is held until the booking is sent.
      </p>
      {!data ? (
        <p className="caption">
          {availability.error
            ? `Free blocks could not be loaded (${availability.error.code}).`
            : 'Loading free blocks…'}
        </p>
      ) : data.resources.length === 0 ? (
        <p className="caption">No space of this type at the facility.</p>
      ) : hours.length === 0 ? (
        <p className="caption">No free block of this length in these seven days.</p>
      ) : (
        <div className="week-grid-scroll">
          <table className="week-grid-table">
            <caption className="visually-hidden">
              Free spaces by day and hour, {data.resources.length} spaces of this type
            </caption>
            <thead>
              <tr>
                <th scope="col">Time</th>
                {days.map((d) => (
                  <th scope="col" key={d}>
                    {formatLocalDate(d)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {hours.map((h) => (
                <tr key={h}>
                  <th scope="row">{`${pad(h)}:00`}</th>
                  {days.map((d) => {
                    const n = cellOf(d, h);
                    return (
                      <td key={d}>
                        {n > 0 ? (
                          <button
                            type="button"
                            className="week-cell"
                            data-free="true"
                            aria-pressed={selectedDate === d}
                            aria-label={`${formatLocalDate(d)} ${pad(h)}:00: ${n} free`}
                            onClick={() => onPickDate(d)}
                          >
                            {n} free
                          </button>
                        ) : (
                          <span className="week-cell" data-free="false">
                            Booked
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
