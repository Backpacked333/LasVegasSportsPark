import { Injectable } from '@nestjs/common';
import type { ConflictDetail, EventKind, PartyCommitment } from '@sportspark/contracts';
import { tstzrange, type ResourceStatus } from '@sportspark/db';
import { sql } from 'kysely';
import type { Trx } from '../../../kernel';
import type { SchedulingPolicy } from '../scheduling.policy';
import { minutesOf, minutesSinceMidnight, toLocal } from '../time/local-time';

/** One event as it would exist after a command: new or moved events use the proposed values. */
export interface ProposedEvent {
  /** Stable key for reporting (draft change sequence or event id). */
  key: string;
  changeSequence?: number;
  /** Existing event id when the proposal modifies an event (its own rows are ignored). */
  eventId: string | null;
  kind: EventKind;
  format: string | null;
  scheduledStart: Date;
  scheduledEnd: Date;
  setupMinutes: number;
  cleanupMinutes: number;
  resourceIds: string[];
  commitments: PartyCommitment[];
}

export interface DetectedConflict {
  key: string;
  severity: 'error' | 'warning';
  detail: ConflictDetail;
}

export interface FacilityContext {
  id: string;
  timezone: string;
}

export interface DetectOptions {
  policy: SchedulingPolicy;
  /** Events whose active rows are released by the same command (moves, cancels in the same group). */
  ignoreEventIds?: string[];
}

interface ResourceRow {
  id: string;
  facility_id: string;
  name: string;
  status: ResourceStatus;
  parent_resource_id: string | null;
  compatible_formats: string[];
}

/**
 * Application-level conflict detection (SPK-SCHED-002/003/004). It gives early, explanatory
 * feedback naming the conflicting event ids; the exclusion constraints in migration 0300 remain
 * the final guarantee (§4.7).
 */
@Injectable()
export class ConflictDetector {
  async detect(
    trx: Trx,
    organizationId: string,
    facility: FacilityContext,
    proposals: ProposedEvent[],
    options: DetectOptions,
  ): Promise<DetectedConflict[]> {
    const conflicts: DetectedConflict[] = [];
    if (proposals.length === 0) return conflicts;
    const ignore = new Set(options.ignoreEventIds ?? []);
    for (const p of proposals) if (p.eventId) ignore.add(p.eventId);
    const ignoreIds = [...ignore];

    const resourceIds = [...new Set(proposals.flatMap((p) => p.resourceIds))];
    const resources = new Map<string, ResourceRow>();
    const unitsByResource = new Map<string, string[]>();
    if (resourceIds.length > 0) {
      const rows = await trx
        .selectFrom('resources')
        .select(['id', 'facility_id', 'name', 'status', 'parent_resource_id', 'compatible_formats'])
        .where('organization_id', '=', organizationId)
        .where('id', 'in', resourceIds)
        .execute();
      for (const row of rows) resources.set(row.id, row);
      const units = await trx
        .selectFrom('resource_conflict_units')
        .select(['resource_id', 'conflict_unit_id'])
        .where('organization_id', '=', organizationId)
        .where('resource_id', 'in', resourceIds)
        .execute();
      for (const u of units) {
        unitsByResource.set(u.resource_id, [
          ...(unitsByResource.get(u.resource_id) ?? []),
          u.conflict_unit_id,
        ]);
      }
    }

    const hours = await trx
      .selectFrom('operating_hours')
      .select(['resource_id', 'weekday', 'opens_at', 'closes_at'])
      .where('organization_id', '=', organizationId)
      .where('facility_id', '=', facility.id)
      .execute();

    const configurations = await trx
      .selectFrom('resource_configurations as c')
      .innerJoin('resource_configuration_members as m', (join) =>
        join
          .onRef('m.configuration_id', '=', 'c.id')
          .onRef('m.organization_id', '=', 'c.organization_id'),
      )
      .select(['c.id as configuration_id', 'm.resource_id'])
      .where('c.organization_id', '=', organizationId)
      .where('c.facility_id', '=', facility.id)
      .where('c.active', '=', true)
      .execute();
    const membersByConfiguration = new Map<string, Set<string>>();
    for (const row of configurations) {
      const set = membersByConfiguration.get(row.configuration_id) ?? new Set<string>();
      set.add(row.resource_id);
      membersByConfiguration.set(row.configuration_id, set);
    }
    const permittedTogether = (a: string, b: string): boolean => {
      if (membersByConfiguration.size === 0) return true;
      for (const members of membersByConfiguration.values()) {
        if (members.has(a) && members.has(b)) return true;
      }
      return false;
    };

    const occupiedOf = (p: ProposedEvent) => ({
      start: new Date(p.scheduledStart.getTime() - p.setupMinutes * 60_000),
      end: new Date(p.scheduledEnd.getTime() + p.cleanupMinutes * 60_000),
    });
    const unitsOf = (p: ProposedEvent) => [
      ...new Set(p.resourceIds.flatMap((r) => unitsByResource.get(r) ?? [])),
    ];

    for (const p of proposals) {
      const occupied = occupiedOf(p);
      const push = (severity: 'error' | 'warning', detail: ConflictDetail) =>
        conflicts.push({ key: p.key, severity, detail });

      // resources: existence, facility, status, format
      for (const resourceId of p.resourceIds) {
        const resource = resources.get(resourceId);
        if (!resource || resource.facility_id !== facility.id) {
          push('error', {
            code: 'resource_unavailable',
            message: 'The resource does not exist in this facility.',
            resourceId,
            conflictingEventIds: [],
          });
          continue;
        }
        if (resource.status === 'closed') {
          push('error', {
            code: 'resource_unavailable',
            message: `${resource.name} is closed.`,
            resourceId,
            conflictingEventIds: [],
          });
        } else if (resource.status === 'restricted') {
          push('warning', {
            code: 'resource_unavailable',
            message: `${resource.name} is under an operating restriction.`,
            resourceId,
            conflictingEventIds: [],
          });
        }
        if (
          p.format &&
          resource.compatible_formats.length > 0 &&
          !resource.compatible_formats.includes(p.format)
        ) {
          push('error', {
            code: 'incompatible_format',
            message: `${resource.name} does not support the ${p.format} format.`,
            resourceId,
            conflictingEventIds: [],
          });
        }
      }

      const units = unitsOf(p);
      if (units.length > 0) {
        // physical overlap on shared conflict units, buffers included (SPK-SCHED-002/003)
        const overlapping = await trx
          .selectFrom('reservation_units')
          .select(['event_id', 'conflict_unit_id'])
          .where('organization_id', '=', organizationId)
          .where('status', '=', 'active')
          .where('conflict_unit_id', 'in', units)
          .where(sql<boolean>`occupied && ${tstzrange(occupied.start, occupied.end)}`)
          .$if(ignoreIds.length > 0, (qb) => qb.where('event_id', 'not in', ignoreIds))
          .execute();
        const byUnit = new Map<string, Set<string>>();
        for (const row of overlapping) {
          const set = byUnit.get(row.conflict_unit_id) ?? new Set<string>();
          set.add(row.event_id);
          byUnit.set(row.conflict_unit_id, set);
        }
        for (const [conflictUnitId, eventIds] of byUnit) {
          push('error', {
            code: 'physical_overlap',
            message:
              'The space is already reserved for an overlapping interval (buffers included).',
            conflictUnitId,
            conflictingEventIds: [...eventIds].sort(),
          });
        }

        // closures of the facility or of any resource sharing a unit (SPK-SCHED-009, SPK-FAC-003)
        const closures = await trx
          .selectFrom('closures')
          .select(['id', 'resource_id'])
          .where('organization_id', '=', organizationId)
          .where('facility_id', '=', facility.id)
          .where('status', '=', 'active')
          .where(sql<boolean>`during && ${tstzrange(occupied.start, occupied.end)}`)
          .where((eb) =>
            eb.or([
              eb('resource_id', 'is', null),
              eb(
                'resource_id',
                'in',
                eb
                  .selectFrom('resource_conflict_units')
                  .select('resource_id')
                  .where('organization_id', '=', organizationId)
                  .where('conflict_unit_id', 'in', units),
              ),
            ]),
          )
          .execute();
        for (const closure of closures) {
          push('error', {
            code: 'closure',
            message: closure.resource_id
              ? 'The space is closed during the interval.'
              : 'The facility is closed during the interval.',
            closureId: closure.id,
            resourceId: closure.resource_id ?? undefined,
            conflictingEventIds: [],
          });
        }
      }

      // operating hours (SPK-SCHED-001): resource windows, falling back to facility windows
      const local = toLocal(facility.timezone, p.scheduledStart);
      const startMinute = minutesSinceMidnight(facility.timezone, p.scheduledStart);
      const endMinute =
        startMinute + Math.round((p.scheduledEnd.getTime() - p.scheduledStart.getTime()) / 60_000);
      for (const resourceId of p.resourceIds) {
        if (!resources.has(resourceId)) continue;
        let windows = hours.filter((h) => h.resource_id === resourceId);
        if (windows.length === 0) windows = hours.filter((h) => h.resource_id === null);
        if (windows.length === 0) continue;
        const fits = windows.some(
          (w) =>
            w.weekday === local.weekday &&
            minutesOf(w.opens_at) <= startMinute &&
            endMinute <= minutesOf(w.closes_at),
        );
        if (!fits) {
          push('error', {
            code: 'outside_operating_hours',
            message: `${resources.get(resourceId)?.name ?? 'The resource'} is not open for the whole event.`,
            resourceId,
            conflictingEventIds: [],
          });
        }
      }

      // party overlaps and required rest (SPK-SCHED-004)
      for (const c of p.commitments) {
        const rest = options.policy.requiredRestMinutes[c.partyType] ?? 0;
        const rows = await trx
          .selectFrom('event_commitments')
          .select([
            'event_id',
            sql<string>`lower(occupied)`.as('start'),
            sql<string>`upper(occupied)`.as('end'),
          ])
          .where('organization_id', '=', organizationId)
          .where('status', '=', 'active')
          .where('party_type', '=', c.partyType)
          .where('party_id', '=', c.partyId)
          .where(
            sql<boolean>`occupied && ${tstzrange(
              new Date(p.scheduledStart.getTime() - rest * 60_000),
              new Date(p.scheduledEnd.getTime() + rest * 60_000),
            )}`,
          )
          .$if(ignoreIds.length > 0, (qb) => qb.where('event_id', 'not in', ignoreIds))
          .execute();
        const overlapping = rows.filter(
          (r) =>
            new Date(r.start).getTime() < p.scheduledEnd.getTime() &&
            p.scheduledStart.getTime() < new Date(r.end).getTime(),
        );
        const tooClose = rows.filter((r) => !overlapping.includes(r));
        if (overlapping.length > 0) {
          push('error', {
            code: 'party_overlap',
            message: `The ${c.partyType} is already committed to an overlapping event.`,
            party: { partyType: c.partyType, partyId: c.partyId },
            conflictingEventIds: [...new Set(overlapping.map((r) => r.event_id))].sort(),
          });
        }
        if (tooClose.length > 0) {
          push('error', {
            code: 'insufficient_rest',
            message: `The ${c.partyType} needs ${rest} minutes of rest between commitments.`,
            party: { partyType: c.partyType, partyId: c.partyId },
            conflictingEventIds: [...new Set(tooClose.map((r) => r.event_id))].sort(),
          });
        }
      }

      // configured physical arrangements (SPK-SCHED-002): sibling subdivisions in use at the same time
      if (membersByConfiguration.size > 0) {
        for (const resourceId of p.resourceIds) {
          const resource = resources.get(resourceId);
          if (!resource?.parent_resource_id) continue;
          const siblings = await trx
            .selectFrom('reservations as r')
            .innerJoin('resources as s', (join) =>
              join
                .onRef('s.id', '=', 'r.resource_id')
                .onRef('s.organization_id', '=', 'r.organization_id'),
            )
            .select(['r.event_id', 'r.resource_id'])
            .where('r.organization_id', '=', organizationId)
            .where('r.status', '=', 'active')
            .where('s.parent_resource_id', '=', resource.parent_resource_id)
            .where('r.resource_id', '<>', resourceId)
            .where(sql<boolean>`r.occupied && ${tstzrange(occupied.start, occupied.end)}`)
            .$if(ignoreIds.length > 0, (qb) => qb.where('r.event_id', 'not in', ignoreIds))
            .execute();
          const bySibling = new Map<string, Set<string>>();
          for (const row of siblings) {
            if (permittedTogether(resourceId, row.resource_id)) continue;
            const set = bySibling.get(row.resource_id) ?? new Set<string>();
            set.add(row.event_id);
            bySibling.set(row.resource_id, set);
          }
          for (const [siblingId, eventIds] of bySibling) {
            push('error', {
              code: 'configuration_not_permitted',
              message:
                'No active configuration allows these subdivisions to operate at the same time.',
              resourceId: siblingId,
              conflictingEventIds: [...eventIds].sort(),
            });
          }
        }
      }
    }

    // conflicts between proposals of the same group (a draft must be consistent with itself)
    for (let i = 0; i < proposals.length; i += 1) {
      for (let j = i + 1; j < proposals.length; j += 1) {
        const a = proposals[i] as ProposedEvent;
        const b = proposals[j] as ProposedEvent;
        const oa = occupiedOf(a);
        const ob = occupiedOf(b);
        const overlapOccupied = oa.start < ob.end && ob.start < oa.end;
        const overlapScheduled =
          a.scheduledStart < b.scheduledEnd && b.scheduledStart < a.scheduledEnd;
        const sequences = [a.changeSequence, b.changeSequence].filter(
          (s): s is number => s !== undefined,
        );
        if (overlapOccupied) {
          const ua = new Set(unitsOf(a));
          const shared = unitsOf(b).filter((u) => ua.has(u));
          if (shared.length > 0) {
            conflicts.push({
              key: a.key,
              severity: 'error',
              detail: {
                code: 'intra_draft_overlap',
                message: 'Two changes in this group reserve the same space at the same time.',
                conflictUnitId: shared[0],
                conflictingEventIds: [a.eventId, b.eventId].filter((id): id is string => !!id),
                changeSequences: sequences,
              },
            });
          }
          for (const ra of a.resourceIds) {
            const pa = resources.get(ra)?.parent_resource_id;
            if (!pa) continue;
            for (const rb of b.resourceIds) {
              if (ra === rb || resources.get(rb)?.parent_resource_id !== pa) continue;
              if (!permittedTogether(ra, rb)) {
                conflicts.push({
                  key: a.key,
                  severity: 'error',
                  detail: {
                    code: 'configuration_not_permitted',
                    message:
                      'No active configuration allows these subdivisions to operate at the same time.',
                    resourceId: rb,
                    conflictingEventIds: [b.eventId].filter((id): id is string => !!id),
                    changeSequences: sequences,
                  },
                });
              }
            }
          }
        }
        if (overlapScheduled) {
          for (const ca of a.commitments) {
            if (
              b.commitments.some((cb) => cb.partyType === ca.partyType && cb.partyId === ca.partyId)
            ) {
              conflicts.push({
                key: a.key,
                severity: 'error',
                detail: {
                  code: 'party_overlap',
                  message: `The ${ca.partyType} is committed to two overlapping changes in this group.`,
                  party: { partyType: ca.partyType, partyId: ca.partyId },
                  conflictingEventIds: [b.eventId].filter((id): id is string => !!id),
                  changeSequences: sequences,
                },
              });
            }
          }
        }
      }
    }
    return conflicts;
  }
}
