/**
 * Field readiness from the field crew's daily pitch preparation (staff redesign Phase 8 "Field
 * crew · Fields"; facilities migration 0975, SPK-READY-001 field readiness, SPK-UX-006
 * escalation). Shared by the crew's Fields screen, Today's "Field" readiness check (S 1a / S 3a)
 * and Today's "Needs action": a pitch not marked ready 15 minutes before its first use is the
 * manager's red issue.
 *
 * A subdivision (a half pitch) shares its whole pitch's preparation. Only pitches are prepared;
 * rooms and courts carry no field check. Times are the facility's (SPK-SCHED-008).
 */
import type { Schema } from '@sportspark/api-client';
import type { ResourceStatus, ScheduledEvent } from './today-model';

export type FieldPreparationDay = Schema<'FieldPreparationDay'>;
export type FieldPreparation = Schema<'FieldPreparation'>;
export type FieldPreparationItem = Schema<'FieldPreparationItem'>;

/** The checklist in walking order, with the words the crew reads. */
export const FIELD_CHECKLIST: readonly { key: FieldPreparationItem; label: string }[] = [
  { key: 'lines', label: 'Lines marked' },
  { key: 'goals_anchored', label: 'Goals anchored' },
  { key: 'nets', label: 'Nets up' },
  { key: 'corner_flags', label: 'Corner flags out' },
];

/** A pitch not ready this close to its first use is the manager's red issue. */
export const NOT_READY_ALERT_MS = 15 * 60_000;

/** Kinds that use a pitch (maintenance and blocks do not need it prepared). */
const USE_KINDS = new Set<ScheduledEvent['kind']>([
  'game',
  'practice',
  'session',
  'rental',
  'party',
  'pickup',
]);

/** The whole pitch a space belongs to (itself for a pitch, its parent for a half). */
export function pitchOf(
  resourceId: string,
  resources: readonly ResourceStatus[],
): ResourceStatus | undefined {
  const r = resources.find((x) => x.resourceId === resourceId);
  if (!r) return undefined;
  if (r.kind === 'pitch') return r;
  if (r.kind === 'subdivision' && r.parentResourceId) {
    const parent = resources.find((x) => x.resourceId === r.parentResourceId);
    return parent?.kind === 'pitch' ? parent : undefined;
  }
  return undefined;
}

export interface PreparationProgress {
  ready: boolean;
  done: number;
  total: number;
}

export function progressOf(preparation: FieldPreparation | null | undefined): PreparationProgress {
  const total = FIELD_CHECKLIST.length;
  if (!preparation) return { ready: false, done: 0, total };
  return {
    ready: preparation.status === 'ready',
    done: FIELD_CHECKLIST.filter((i) => preparation.checkedItems.includes(i.key)).length,
    total,
  };
}

export interface FieldDay {
  pitch: ResourceStatus;
  /** The pitch's uses today (its own and its halves'), by start. */
  uses: ScheduledEvent[];
  /** The first use of the day, or null when the pitch is not used today. */
  firstUse: ScheduledEvent | null;
  /** The next use that has not ended yet, or null. */
  nextUse: ScheduledEvent | null;
  preparation: FieldPreparation | null;
  /** A closing restriction on the pitch now (the crew does not prepare a closed pitch). */
  closed: ResourceStatus['restrictions'][number] | null;
}

/** Every pitch of the facility, the ones used today first by their first use, then the rest. */
export function fieldDays(
  resources: readonly ResourceStatus[],
  events: readonly ScheduledEvent[],
  preparations: readonly FieldPreparation[],
  now: Date,
): FieldDay[] {
  const t = now.getTime();
  const days = resources
    .filter((r) => r.kind === 'pitch')
    .map((pitch): FieldDay => {
      const uses = events
        .filter(
          (e) =>
            e.status !== 'canceled' &&
            USE_KINDS.has(e.kind) &&
            e.resourceIds.some((id) => pitchOf(id, resources)?.resourceId === pitch.resourceId),
        )
        .sort((a, b) => a.scheduledStart.localeCompare(b.scheduledStart));
      const halves = resources.filter((r) => r.parentResourceId === pitch.resourceId);
      const closed =
        [pitch, ...halves].flatMap((r) => r.restrictions).find((x) => x.kind === 'closed') ?? null;
      return {
        pitch,
        uses,
        firstUse: uses[0] ?? null,
        nextUse: uses.find((e) => new Date(e.scheduledEnd).getTime() > t) ?? null,
        preparation: preparations.find((p) => p.resourceId === pitch.resourceId) ?? null,
        closed,
      };
    });
  return days.sort((a, b) => {
    if (a.firstUse && b.firstUse) {
      return a.firstUse.scheduledStart.localeCompare(b.firstUse.scheduledStart);
    }
    if (a.firstUse) return -1;
    if (b.firstUse) return 1;
    return a.pitch.name.localeCompare(b.pitch.name, undefined, { numeric: true });
  });
}

export interface FieldIssue {
  id: string;
  pitch: ResourceStatus;
  use: ScheduledEvent;
  progress: PreparationProgress;
}

/**
 * Pitches whose next use starts within 15 minutes (or is under way) while the pitch is not marked
 * ready: the manager's red issues (Phase 8 item 7). A closed pitch is the restriction's business.
 */
export function fieldIssues(days: readonly FieldDay[], now: Date): FieldIssue[] {
  const t = now.getTime();
  return days
    .filter((d) => d.nextUse && !d.closed && !progressOf(d.preparation).ready)
    .filter((d) => new Date(d.nextUse!.scheduledStart).getTime() - t <= NOT_READY_ALERT_MS)
    .map((d) => ({
      id: `field-not-ready:${d.pitch.resourceId}:${d.nextUse!.id}`,
      pitch: d.pitch,
      use: d.nextUse!,
      progress: progressOf(d.preparation),
    }));
}

export interface FieldPreparationState {
  /** The event uses a pitch and the day's preparations were read. */
  known: boolean;
  pitchName: string | null;
  progress: PreparationProgress;
  /** The start is within 15 minutes (or under way) and the pitch is not ready. */
  urgent: boolean;
}

/** The preparation of the pitch an event uses, for the "Field" readiness check. */
export function preparationForEvent(
  event: Pick<ScheduledEvent, 'resourceIds' | 'scheduledStart'>,
  resources: readonly ResourceStatus[] | undefined,
  day: FieldPreparationDay | undefined,
  now: Date,
): FieldPreparationState | null {
  if (!resources || !day) return null;
  const pitch = event.resourceIds
    .map((id) => pitchOf(id, resources))
    .find((p): p is ResourceStatus => p !== undefined);
  if (!pitch) return null;
  const progress = progressOf(day.items.find((p) => p.resourceId === pitch.resourceId));
  const urgent =
    !progress.ready &&
    new Date(event.scheduledStart).getTime() - now.getTime() <= NOT_READY_ALERT_MS;
  return { known: true, pitchName: pitch.name, progress, urgent };
}
