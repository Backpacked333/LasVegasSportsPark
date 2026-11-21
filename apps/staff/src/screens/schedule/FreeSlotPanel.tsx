/**
 * "Find a free slot" (handoff S 2b panel; INTERACTIONS 2b rows 2 to 5, key flow "Book a free slot
 * for a caller"; SPK-SCHED-002, SPK-SCHED-003, SPK-SCHED-008, SPK-COND-003). Space type, length,
 * days and hours: the results and the outlines on the week grid update at once.
 *
 * - Free time comes from `GET /v1/resource-availability` (free start times per space over the next
 *   14 days, with conflict units, buffers, closures and operating hours applied by scheduling).
 *   `schedule-model.slotMatches` keeps the days and hours asked for and the earliest start per
 *   space and day. Free is not a hold: the booking command checks again.
 * - Hold opens New booking prefilled (S 5a). **Proposed (pending decision 5, slot holds and staff
 *   prices):** the API has no slot hold, so the 15 minutes are kept on this screen only, and
 *   nothing is reserved on the server until the booking is made; no price is shown here.
 * - No match: "No free 90-min 7v7 slot. Try 60 min or weekdays."
 * - ✕ closes the panel and clears the outlines.
 */
import type { Schema } from '@sportspark/api-client';
import { useEffect, useMemo, useState } from 'react';
import { useApiQuery } from '../../api/useApiQuery';
import type { FacilityContext } from '../../features/schedule-facilities/facility-scope';
import {
  addDaysToLocalDate,
  formatLocalDate,
  localDateOf,
  startOfLocalDay,
} from '../../features/schedule-facilities/time';
import { useNow } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { Skeleton, SkeletonGroup } from '../../ui/Skeleton';
import { plainWords } from '../../ui/StatusBadge';
import {
  DAYS_LABEL,
  noMatchMessage,
  shortClock,
  slotMatches,
  type DaysChoice,
  type SlotMatch,
  type SlotQuery,
} from './schedule-model';

type Resource = Schema<'Resource'>;

/** The search window: two weeks, the most one availability read covers. */
const SEARCH_DAYS = 14;

const LENGTHS = [60, 90, 120] as const;
const BETWEEN: readonly { value: string; label: string; hours: [number, number] }[] = [
  { value: '8-14', label: '8 AM – 2 PM', hours: [8, 14] },
  { value: '14-18', label: '2 PM – 6 PM', hours: [14, 18] },
  { value: '17-22', label: '5 PM – 10 PM', hours: [17, 22] },
  { value: '8-22', label: 'Any time', hours: [8, 22] },
];

export interface SpaceType {
  value: string;
  label: string;
}

/** The space types of the facility: each format a space plays, then rooms and other spaces. */
export function spaceTypes(resources: readonly Resource[]): SpaceType[] {
  const active = resources.filter((r) => r.status === 'active');
  // Larger games first ("7v7" before "5v5"), then the other formats by name.
  const players = (f: string) => Number(/^(\d+)v\d+$/.exec(f)?.[1] ?? 0);
  const formats = [...new Set(active.flatMap((r) => r.compatibleFormats))].sort(
    (a, b) => players(b) - players(a) || a.localeCompare(b),
  );
  const types: SpaceType[] = formats.map((f) => ({
    value: f,
    label: /^\d+v\d+$/.test(f) ? `${f} field` : plainWords(f),
  }));
  if (active.some((r) => r.kind === 'room')) types.push({ value: 'kind:room', label: 'Room' });
  if (active.some((r) => r.kind === 'other')) {
    types.push({ value: 'kind:other', label: 'Court or indoor space' });
  }
  return types;
}

function slotLine(m: SlotMatch, tz: string): string {
  return `${formatLocalDate(m.date).replace(/,.*$/, '')} ${Number(m.date.slice(8))} · ${shortClock(m.start, tz)}–${shortClock(m.end, tz)}`;
}

export function FreeSlotPanel({
  facility,
  resources,
  fromDate,
  onClose,
  onHold,
  onMatches,
}: {
  facility: FacilityContext;
  resources: readonly Resource[];
  fromDate: string;
  onClose: () => void;
  onHold: (slot: { resourceId: string; start: number; end: number }) => void;
  onMatches: (matches: readonly SlotMatch[]) => void;
}) {
  const now = useNow();
  const tz = facility.timezone;
  const types = useMemo(() => spaceTypes(resources), [resources]);
  const [spaceType, setSpaceType] = useState(() => types[0]?.value ?? '');
  const [length, setLength] = useState<number>(90);
  const [days, setDays] = useState<DaysChoice>('weekend');
  const [between, setBetween] = useState('8-14');
  const today = localDateOf(now, tz);
  const first = fromDate < today ? today : fromDate;
  const window = useMemo(
    () => ({
      start: startOfLocalDay(first, tz),
      end: startOfLocalDay(addDaysToLocalDate(first, SEARCH_DAYS), tz),
    }),
    [first, tz],
  );
  const kind = spaceType.startsWith('kind:') ? spaceType.slice(5) : undefined;
  const availability = useApiQuery({
    path: '/resource-availability',
    request: {
      query: {
        facilityId: facility.id,
        start: window.start,
        end: window.end,
        durationMinutes: length,
        stepMinutes: 30,
        ...(kind ? { resourceKind: kind as Resource['kind'] } : {}),
      },
    },
  });
  const query: SlotQuery = {
    spaceType,
    lengthMinutes: length,
    days,
    between: BETWEEN.find((b) => b.value === between)?.hours ?? [8, 22],
  };
  const matches = availability.data
    ? slotMatches(availability.data.resources, resources, query, tz, now.getTime())
    : [];
  const signature = matches.map((m) => `${m.resourceId}|${m.start}`).join(',');
  useEffect(() => {
    onMatches(matches);
    // Only when the results change, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  const shown = matches.slice(0, 6);
  const typeLabel = types.find((t) => t.value === spaceType)?.label ?? 'space';

  return (
    <aside
      className="card slot-panel"
      aria-labelledby="slot-panel-title"
      data-testid="free-slot-panel"
    >
      <div className="slot-head">
        <h3 id="slot-panel-title">Find a free slot</h3>
        <button
          type="button"
          className="ui-drawer-close"
          aria-label="Close Find a free slot"
          onClick={onClose}
        >
          <Icon name="close" size={18} />
        </button>
      </div>
      <div className="slot-filters">
        <label>
          Space type
          <select value={spaceType} onChange={(e) => setSpaceType(e.target.value)}>
            <option value="">Any space</option>
            {types.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Length
          <select value={length} onChange={(e) => setLength(Number(e.target.value))}>
            {LENGTHS.map((l) => (
              <option key={l} value={l}>
                {l} min
              </option>
            ))}
          </select>
        </label>
        <label>
          Days
          <select value={days} onChange={(e) => setDays(e.target.value as DaysChoice)}>
            {(['weekend', 'weekdays', 'any'] as const).map((d) => (
              <option key={d} value={d}>
                {DAYS_LABEL[d]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Between
          <select value={between} onChange={(e) => setBetween(e.target.value)}>
            {BETWEEN.map((b) => (
              <option key={b.value} value={b.value}>
                {b.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {availability.isPending ? (
        <SkeletonGroup label="free slots">
          <Skeleton height={56} radius={14} />
          <Skeleton height={56} radius={14} />
        </SkeletonGroup>
      ) : availability.error ? (
        <p className="caption" role="alert">
          Free slots could not be read ({availability.error.code}).{' '}
          <button type="button" className="link-button" onClick={() => void availability.refetch()}>
            Try again
          </button>
        </p>
      ) : shown.length === 0 ? (
        <p className="slot-none" role="status">
          {noMatchMessage(query, typeLabel)}
        </p>
      ) : (
        <>
          <p className="caption" role="status">
            {matches.length} {matches.length === 1 ? 'match' : 'matches'}, earliest first
          </p>
          <ul className="slot-list" aria-label="Free slots">
            {shown.map((m, i) => (
              <li key={`${m.resourceId}-${m.start}`} data-first={i === 0 || undefined}>
                <span className="slot-text">
                  <b>{slotLine(m, tz)}</b>
                  <span className="caption">{m.resourceName}</span>
                </span>
                <Button
                  variant={i === 0 ? 'primary' : 'secondary'}
                  className="button-sm"
                  aria-label={`Hold ${m.resourceName}, ${slotLine(m, tz)}`}
                  onClick={() => onHold({ resourceId: m.resourceId, start: m.start, end: m.end })}
                >
                  Hold
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
      <span className="proposed-tag">◷ Prices and holds proposed · not in the API yet</span>
      <p className="caption slot-foot">
        A hold keeps the slot for 15 minutes on this screen while you take the customer’s details;
        nothing is reserved until the booking is made.
      </p>
    </aside>
  );
}
