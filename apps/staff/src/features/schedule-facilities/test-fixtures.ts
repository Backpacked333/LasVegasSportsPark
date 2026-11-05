/**
 * Records shaped like the API's scheduling and facilities contracts (packages/contracts/src/api
 * scheduling.ts, facilities.ts) for the schedule and facilities screen tests. One facility in
 * Los Angeles; 2026-10-24 local is the test day (TEST_NOW is 05:00 local).
 */
import type { Schema } from '@sportspark/api-client';
import {
  FACILITY_A,
  FACILITY_B,
  TEST_NOW,
  mePermissions,
  staffMe,
  todayFeed,
} from '../../testing/test-app';

export const PITCH = '0192f1a0-0000-7000-8000-0000000000a1';
export const HALF_A = '0192f1a0-0000-7000-8000-0000000000a2';
export const HALF_B = '0192f1a0-0000-7000-8000-0000000000a3';
export const ROOM = '0192f1a0-0000-7000-8000-0000000000a4';
export const UNIT_A = '0192f1a0-0000-7000-8000-0000000000b1';
export const UNIT_B = '0192f1a0-0000-7000-8000-0000000000b2';
export const UNIT_ROOM = '0192f1a0-0000-7000-8000-0000000000b3';
export const ME_PERSON = '0192f1a0-0000-7000-8000-0000000000dd';

const T = TEST_NOW.toISOString();

/** A facility directory entry (`GET /v1/facilities`, K-04): Los Angeles, in the viewer's scope. */
export function facilitySummary(
  over: Partial<Schema<'FacilitySummary'>> & { id: string },
): Schema<'FacilitySummary'> {
  return {
    slug: 'north-park',
    name: 'North Park 1',
    timezone: 'America/Los_Angeles',
    status: 'active',
    address: null,
    inStaffScope: true,
    ...over,
  };
}

/** `GET /v1/facilities`: A (North Park 1) in scope and B (North Park 2) outside it, by default. */
export function facilityDirectory(items?: Schema<'FacilitySummary'>[]) {
  return {
    status: 200,
    body: {
      items: items ?? [
        facilitySummary({ id: FACILITY_A }),
        facilitySummary({
          id: FACILITY_B,
          slug: 'north-park-2',
          name: 'North Park 2',
          inStaffScope: false,
        }),
      ],
    },
  };
}

/** Every schedule and facilities command these screens offer (scheduling and facilities actions). */
export const SCHEDULE_FACILITY_ACTIONS = [
  'scheduling.read_inventory',
  'scheduling.manage_inventory',
  'scheduling.manage_closures',
  'scheduling.read_schedule',
  'scheduling.manage_events',
  'scheduling.manage_drafts',
  'scheduling.publish_schedule',
  'facilities.manage_asset',
  'facilities.report_issue',
  'facilities.manage_maintenance_task',
  'facilities.apply_restriction',
  'facilities.record_inspection',
  'facilities.release_to_service',
  'facilities.schedule_preventive_maintenance',
  'facilities.view_maintenance',
] as const;

/** `GET /me/permissions` allowing the listed actions at facility A (default: all of them). */
export function scopedPermissions(actions: readonly string[] = SCHEDULE_FACILITY_ACTIONS) {
  return mePermissions({ actions: actions.map((id) => ({ id, facilityIds: [FACILITY_A] })) });
}

/**
 * `GET /me`, `GET /me/permissions` (every schedule and facilities action at A), `GET /facilities`
 * and `GET /today` for a viewer scoped to facility A only.
 */
export function oneFacilityRoutes() {
  return {
    'GET /me': staffMe([FACILITY_A]),
    'GET /me/permissions': scopedPermissions(),
    'GET /facilities': facilityDirectory(),
    'GET /today': todayFeed([], [FACILITY_A]),
  };
}

export function resource(
  over: Partial<Schema<'Resource'>> & { id: string; name: string },
): Schema<'Resource'> {
  return {
    facilityId: FACILITY_A,
    kind: 'pitch',
    parentResourceId: null,
    dimensions: {},
    compatibleFormats: [],
    defaultSetupMinutes: 0,
    defaultCleanupMinutes: 0,
    requiredEquipment: [],
    staffingConstraints: {},
    status: 'active',
    conflictUnitIds: [],
    revision: 1,
    createdAt: T,
    updatedAt: T,
    ...over,
  };
}

/** A pitch occupying both halves' units, its two halves, and a room. */
export const INVENTORY: Schema<'Resource'>[] = [
  resource({
    id: PITCH,
    name: 'Pitch 1',
    conflictUnitIds: [UNIT_A, UNIT_B],
    compatibleFormats: ['11v11'],
    defaultSetupMinutes: 15,
    defaultCleanupMinutes: 10,
    dimensions: { length: 100, width: 64 },
  }),
  resource({
    id: HALF_A,
    name: 'Pitch 1 North',
    kind: 'subdivision',
    parentResourceId: PITCH,
    conflictUnitIds: [UNIT_A],
    compatibleFormats: ['7v7'],
  }),
  resource({
    id: HALF_B,
    name: 'Pitch 1 South',
    kind: 'subdivision',
    parentResourceId: PITCH,
    conflictUnitIds: [UNIT_B],
    compatibleFormats: ['7v7'],
  }),
  resource({ id: ROOM, name: 'Party room', kind: 'room', conflictUnitIds: [UNIT_ROOM] }),
];

export function event(
  over: Partial<Schema<'Event'>> & { id: string; title: string },
): Schema<'Event'> {
  return {
    facilityId: FACILITY_A,
    kind: 'game',
    format: null,
    seriesId: null,
    occurrenceIndex: null,
    // 18:00 to 19:30 in Los Angeles (PDT).
    scheduledStart: '2026-10-25T01:00:00.000Z',
    scheduledEnd: '2026-10-25T02:30:00.000Z',
    timezone: 'America/Los_Angeles',
    setupMinutes: 0,
    cleanupMinutes: 0,
    dstResolution: 'exact',
    status: 'published',
    publishedRevision: 1,
    revision: 1,
    sourceType: null,
    sourceId: null,
    resourceIds: [PITCH],
    commitments: [],
    canceledAt: null,
    cancelReason: null,
    createdAt: T,
    updatedAt: T,
    ...over,
  };
}

export function page<T>(items: T[], nextCursor: string | null = null) {
  return { status: 200, body: { items, nextCursor } };
}

export function draft(
  over: Partial<Schema<'ScheduleDraft'>> & { id: string },
): Schema<'ScheduleDraft'> {
  return {
    facilityId: FACILITY_A,
    name: 'Week 9 changes',
    status: 'editing',
    author: { kind: 'staff', accountId: null, actorLabel: 'Sam Scheduler' },
    baseRevision: { capturedAt: T, eventRevisions: {} },
    changes: [],
    validationResults: null,
    lastSavedAt: T,
    validatedAt: null,
    publishedAt: null,
    publicationGroupId: null,
    revision: 3,
    createdAt: T,
    updatedAt: T,
    ...over,
  };
}

export function closure(over: Partial<Schema<'Closure'>> & { id: string }): Schema<'Closure'> {
  return {
    facilityId: FACILITY_A,
    resourceId: PITCH,
    interval: { start: '2026-10-25T00:00:00.000Z', end: '2026-10-25T06:00:00.000Z' },
    reason: 'Flooded turf',
    source: 'manual',
    status: 'pending',
    impact: null,
    resolution: null,
    appliedAt: null,
    liftedAt: null,
    withdrawnAt: null,
    withdrawalReason: null,
    revision: 1,
    createdAt: T,
    updatedAt: T,
    ...over,
  };
}

export function task(
  over: Partial<NonNullable<Schema<'MaintenanceTask'>>> & { id: string },
): Schema<'MaintenanceTask'> {
  return {
    facilityId: FACILITY_A,
    assetId: null,
    resourceId: HALF_A,
    issue: 'Torn net on north goal',
    severity: 'high',
    reporter: { kind: 'staff', accountId: null, personId: null, actorLabel: 'Front desk' },
    reportedAt: T,
    evidence: [],
    assignedOwnerPersonId: null,
    dueAt: null,
    status: 'open',
    requiresInspection: false,
    resolution: null,
    resolvedAt: null,
    closedAt: null,
    preventiveScheduleId: null,
    occurrenceIndex: null,
    latestInspection: null,
    openRestrictionIds: [],
    revision: 2,
    createdAt: T,
    updatedAt: T,
    ...over,
  };
}

export function restriction(
  over: Partial<Schema<'Restriction'>> & { id: string },
): Schema<'Restriction'> {
  return {
    facilityId: FACILITY_A,
    resourceId: HALF_A,
    assetId: null,
    taskId: null,
    preventiveScheduleId: null,
    occurrenceIndex: null,
    kind: 'closed',
    interval: { start: '2026-10-24T12:00:00.000Z', end: '2026-10-26T12:00:00.000Z' },
    reason: 'Turf repair',
    affectedConflictUnitIds: [UNIT_A],
    status: 'active',
    approvedBy: {
      kind: 'staff',
      accountId: null,
      personId: null,
      actorLabel: 'Facilities lead',
    },
    approvedAt: T,
    schedulingClosureId: null,
    releasedBy: null,
    releasedAt: null,
    releaseReason: null,
    withdrawnBy: null,
    withdrawnAt: null,
    withdrawalReason: null,
    operationId: null,
    revision: 4,
    createdAt: T,
    updatedAt: T,
    ...over,
  };
}

export function asset(
  over: Partial<Schema<'Asset'>> & { id: string; name: string },
): Schema<'Asset'> {
  return {
    facilityId: FACILITY_A,
    resourceId: HALF_A,
    kind: 'goal',
    identifier: 'G-01',
    attributes: {},
    status: 'in_service',
    revision: 1,
    createdAt: T,
    updatedAt: T,
    ...over,
  };
}
