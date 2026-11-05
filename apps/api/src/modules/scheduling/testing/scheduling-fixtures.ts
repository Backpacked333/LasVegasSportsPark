import {
  newId,
  systemPrincipal,
  type Closure,
  type Event,
  type EventKind,
  type PartyCommitment,
  type Principal,
} from '@sportspark/contracts';
import { json, type Db } from '@sportspark/db';
import type { ClosuresService } from '../services/closures.service';
import type { EventsService } from '../services/events.service';
import { resolveLocal } from '../time/local-time';

/**
 * Fixtures for downstream modules (competition, workforce, facilities, enrollment, entry,
 * reporting). Inventory is written directly through Kysely; events and closures go through the
 * services so reservations, audit and outbox follow-ups are real.
 */

export interface PitchFixture {
  facilityId: string;
  pitchId: string;
  northHalfId: string;
  southHalfId: string;
  units: { north: string; south: string };
  fullPitchConfigurationId: string;
  twoHalvesConfigurationId: string;
}

export interface SeedPitchOptions {
  organizationId: string;
  facilityId: string;
  name?: string;
  defaultSetupMinutes?: number;
  defaultCleanupMinutes?: number;
  compatibleFormats?: string[];
}

/**
 * A whole pitch with two halves (SPK-SCHED-002): the pitch maps to both halves' conflict units,
 * each half to its own; "Full pitch" and "Two halves" are the permitted arrangements.
 */
export async function seedPitchWithHalves(
  db: Db,
  options: SeedPitchOptions,
): Promise<PitchFixture> {
  const { organizationId, facilityId } = options;
  const name = options.name ?? `Pitch ${newId().slice(0, 4)}`;
  const north = newId();
  const south = newId();
  await db
    .insertInto('conflict_units')
    .values([
      {
        id: north,
        organization_id: organizationId,
        facility_id: facilityId,
        name: `${name} north`,
      },
      {
        id: south,
        organization_id: organizationId,
        facility_id: facilityId,
        name: `${name} south`,
      },
    ])
    .execute();
  const pitchId = newId();
  const northHalfId = newId();
  const southHalfId = newId();
  const base = {
    organization_id: organizationId,
    facility_id: facilityId,
    default_setup_minutes: options.defaultSetupMinutes ?? 0,
    default_cleanup_minutes: options.defaultCleanupMinutes ?? 10,
    compatible_formats: options.compatibleFormats ?? ['11v11', '7v7', '5v5'],
  };
  await db
    .insertInto('resources')
    .values([{ ...base, id: pitchId, kind: 'pitch', name, parent_resource_id: null }])
    .execute();
  await db
    .insertInto('resources')
    .values([
      {
        ...base,
        id: northHalfId,
        kind: 'subdivision',
        name: `${name} north half`,
        parent_resource_id: pitchId,
        compatible_formats: ['7v7', '5v5'],
      },
      {
        ...base,
        id: southHalfId,
        kind: 'subdivision',
        name: `${name} south half`,
        parent_resource_id: pitchId,
        compatible_formats: ['7v7', '5v5'],
      },
    ])
    .execute();
  await db
    .insertInto('resource_conflict_units')
    .values([
      { organization_id: organizationId, resource_id: pitchId, conflict_unit_id: north },
      { organization_id: organizationId, resource_id: pitchId, conflict_unit_id: south },
      { organization_id: organizationId, resource_id: northHalfId, conflict_unit_id: north },
      { organization_id: organizationId, resource_id: southHalfId, conflict_unit_id: south },
    ])
    .execute();
  const fullPitchConfigurationId = newId();
  const twoHalvesConfigurationId = newId();
  await db
    .insertInto('resource_configurations')
    .values([
      {
        id: fullPitchConfigurationId,
        organization_id: organizationId,
        facility_id: facilityId,
        name: `${name}: full pitch`,
        description: null,
      },
      {
        id: twoHalvesConfigurationId,
        organization_id: organizationId,
        facility_id: facilityId,
        name: `${name}: two halves`,
        description: null,
      },
    ])
    .execute();
  await db
    .insertInto('resource_configuration_members')
    .values([
      {
        organization_id: organizationId,
        configuration_id: fullPitchConfigurationId,
        resource_id: pitchId,
      },
      {
        organization_id: organizationId,
        configuration_id: twoHalvesConfigurationId,
        resource_id: northHalfId,
      },
      {
        organization_id: organizationId,
        configuration_id: twoHalvesConfigurationId,
        resource_id: southHalfId,
      },
    ])
    .execute();
  return {
    facilityId,
    pitchId,
    northHalfId,
    southHalfId,
    units: { north, south },
    fullPitchConfigurationId,
    twoHalvesConfigurationId,
  };
}

/** A standalone space (room or pitch without subdivisions) with one dedicated conflict unit. */
export async function seedResource(
  db: Db,
  options: SeedPitchOptions & { kind?: 'pitch' | 'room' | 'other' },
): Promise<{ resourceId: string; unitId: string }> {
  const resourceId = newId();
  const unitId = newId();
  const name = options.name ?? `Space ${resourceId.slice(0, 4)}`;
  await db
    .insertInto('conflict_units')
    .values({
      id: unitId,
      organization_id: options.organizationId,
      facility_id: options.facilityId,
      name,
    })
    .execute();
  await db
    .insertInto('resources')
    .values({
      id: resourceId,
      organization_id: options.organizationId,
      facility_id: options.facilityId,
      kind: options.kind ?? 'pitch',
      name,
      parent_resource_id: null,
      default_setup_minutes: options.defaultSetupMinutes ?? 0,
      default_cleanup_minutes: options.defaultCleanupMinutes ?? 0,
      compatible_formats: options.compatibleFormats ?? [],
    })
    .execute();
  await db
    .insertInto('resource_conflict_units')
    .values({
      organization_id: options.organizationId,
      resource_id: resourceId,
      conflict_unit_id: unitId,
    })
    .execute();
  return { resourceId, unitId };
}

export async function seedOperatingHours(
  db: Db,
  options: {
    organizationId: string;
    facilityId: string;
    resourceId?: string | null;
    weekdays?: number[];
    opensAt?: string;
    closesAt?: string;
  },
): Promise<string[]> {
  const ids: string[] = [];
  for (const weekday of options.weekdays ?? [0, 1, 2, 3, 4, 5, 6]) {
    const id = newId();
    ids.push(id);
    await db
      .insertInto('operating_hours')
      .values({
        id,
        organization_id: options.organizationId,
        facility_id: options.facilityId,
        resource_id: options.resourceId ?? null,
        weekday,
        opens_at: options.opensAt ?? '08:00',
        closes_at: options.closesAt ?? '22:00',
      })
      .execute();
  }
  return ids;
}

/** Facility-local wall-clock time to an ISO instant (default zone: the test facility's). */
export function at(localDate: string, localTime: string, timezone = 'America/Los_Angeles'): string {
  const resolved = resolveLocal(localDate, localTime, timezone);
  if (!resolved) throw new Error(`${localDate} ${localTime} does not exist in ${timezone}`);
  return resolved.instant.toISOString();
}

export interface PublishedEventOptions {
  organizationId: string;
  facilityId: string;
  resourceIds: string[];
  start: string;
  end: string;
  kind?: EventKind;
  title?: string;
  format?: string | null;
  setupMinutes?: number;
  cleanupMinutes?: number;
  commitments?: PartyCommitment[];
  sourceType?: string;
  sourceId?: string;
  status?: 'draft' | 'published';
  principal?: Principal;
}

/** Creates an event through the scheduling port (reservations, audit and notices included). */
export async function createScheduledEvent(
  events: EventsService,
  options: PublishedEventOptions,
): Promise<Event> {
  return events.createEvent(
    options.principal ?? systemPrincipal(options.organizationId, 'fixtures'),
    {
      facilityId: options.facilityId,
      kind: options.kind ?? 'game',
      title: options.title ?? 'Fixture game',
      format: options.format ?? null,
      scheduledStart: options.start,
      scheduledEnd: options.end,
      setupMinutes: options.setupMinutes,
      cleanupMinutes: options.cleanupMinutes,
      resourceIds: options.resourceIds,
      commitments: options.commitments ?? [],
      sourceType: options.sourceType ?? 'fixture',
      sourceId: options.sourceId ?? newId(),
      status: options.status ?? 'published',
    },
  );
}

export async function createAppliedClosure(
  closures: ClosuresService,
  options: {
    organizationId: string;
    facilityId: string;
    resourceId?: string | null;
    start: string;
    end: string;
    reason?: string;
    source?: 'manual' | 'maintenance' | 'holiday';
    mode?: 'cancel_affected' | 'leave_for_resolution';
    principal?: Principal;
  },
): Promise<Closure> {
  const principal = options.principal ?? systemPrincipal(options.organizationId, 'fixtures');
  const created = await closures.createClosure(principal, {
    facilityId: options.facilityId,
    resourceId: options.resourceId ?? null,
    interval: { start: options.start, end: options.end },
    reason: options.reason ?? 'Turf maintenance',
    source: options.source ?? 'maintenance',
  });
  return closures.applyClosure(principal, created.id, {
    mode: options.mode ?? 'leave_for_resolution',
    expectedRevision: created.revision,
  });
}

export const teamCommitment = (teamId: string, role = 'home_team'): PartyCommitment => ({
  partyType: 'team',
  partyId: teamId,
  role,
});
export const personCommitment = (personId: string, role = 'official'): PartyCommitment => ({
  partyType: 'person',
  partyId: personId,
  role,
});

/** Builds the jsonb value for an event commitments column when inserting rows directly. */
export const commitmentsJson = (commitments: PartyCommitment[]) => json(commitments);
