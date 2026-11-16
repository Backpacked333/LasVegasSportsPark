import { AssetsService, MaintenanceTasksService } from '../../modules/facilities';
import { ClosuresService, ResourcesService } from '../../modules/scheduling';
import { calendarOf, optional, service, type DemoContext } from './context';
import type { DemoStaff } from './people';

/**
 * The park's spaces (SPK-SCHED-001/002): three fields, the first rentable whole or by half, a
 * court and a party room, with opening hours; and, so the Facilities area is not empty, one
 * maintenance task and one planned closure. All through scheduling's and facilities' services.
 */
export interface DemoSpaces {
  field1: string;
  field1North: string;
  field1South: string;
  field2: string;
  field3: string;
  court: string;
  partyRoom: string;
}

const FORMATS = ['7v7', '5v5', 'indoor_boarded'];

export async function seedSpaces(ctx: DemoContext, staff: DemoStaff): Promise<DemoSpaces> {
  const resources = service(ctx, ResourcesService);
  const manager = staff.manager.principal;
  const facilityId = ctx.facilityId;
  const existing = await resources.listResources(manager, facilityId);
  const byName = new Map(existing.map((r) => [r.name, r.id]));

  const ensure = async (
    name: string,
    body: {
      kind: 'pitch' | 'subdivision' | 'room' | 'other';
      parentResourceId?: string;
      conflictUnitIds?: string[];
    },
  ): Promise<string> => {
    const known = byName.get(name);
    if (known) return known;
    const created = await resources.createResource(manager, {
      facilityId,
      name,
      kind: body.kind,
      parentResourceId: body.parentResourceId,
      conflictUnitIds: body.conflictUnitIds,
      compatibleFormats: body.kind === 'room' ? undefined : FORMATS,
      defaultSetupMinutes: 0,
      defaultCleanupMinutes: 0,
      policyReferences: [],
    });
    byName.set(name, created.id);
    return created.id;
  };

  // Field 1 is two halves: the whole field occupies both, each half its own (SPK-SCHED-002).
  let field1 = byName.get('Field 1');
  let field1North = byName.get('Field 1 north half');
  let field1South = byName.get('Field 1 south half');
  if (!field1 || !field1North || !field1South) {
    const units = await resources.listConflictUnits(manager, facilityId);
    const unit = async (name: string): Promise<string> =>
      units.find((u) => u.name === name)?.id ??
      (await resources.createConflictUnit(manager, { facilityId, name, policyReferences: [] })).id;
    const north = await unit('Field 1 north');
    const south = await unit('Field 1 south');
    field1 = await ensure('Field 1', { kind: 'pitch', conflictUnitIds: [north, south] });
    field1North = await ensure('Field 1 north half', {
      kind: 'subdivision',
      parentResourceId: field1,
      conflictUnitIds: [north],
    });
    field1South = await ensure('Field 1 south half', {
      kind: 'subdivision',
      parentResourceId: field1,
      conflictUnitIds: [south],
    });
  }
  const spaces: DemoSpaces = {
    field1,
    field1North,
    field1South,
    field2: await ensure('Field 2', { kind: 'pitch' }),
    field3: await ensure('Field 3', { kind: 'pitch' }),
    court: await ensure('Court', { kind: 'other' }),
    partyRoom: await ensure('Party room', { kind: 'room' }),
  };

  const hours = await resources.listOperatingHours(manager, facilityId);
  if (hours.length === 0) {
    for (let weekday = 0; weekday < 7; weekday += 1) {
      await resources.createOperatingHours(manager, {
        facilityId,
        weekday,
        opensAt: '07:00',
        closesAt: '23:00',
        policyReferences: [],
      });
    }
  }

  await optional(ctx, 'the maintenance task on Field 3', async () => {
    const tasks = service(ctx, MaintenanceTasksService);
    const assets = service(ctx, AssetsService);
    const known = await assets.list(manager, { facilityId });
    const net =
      known.find((a) => a.name === 'Field 3 west goal net') ??
      (await assets.create(manager, {
        facilityId,
        resourceId: spaces.field3,
        kind: 'net',
        name: 'Field 3 west goal net',
        identifier: 'NET-F3-W',
        policyReferences: [],
      }));
    const listed = await tasks.list(manager, { facilityId, assetId: net.id, limit: 50 });
    if (listed.items.length === 0) {
      await tasks.reportIssue(staff.desk.principal, {
        facilityId,
        assetId: net.id,
        resourceId: spaces.field3,
        issue: 'Goal net torn at the lower left corner; a ball goes through.',
        severity: 'medium',
        dueAt: calendarOf(ctx).iso(2, '12:00'),
        requiresInspection: false,
      });
    }
  });

  await optional(ctx, 'the planned closure of Field 3', async () => {
    const closures = service(ctx, ClosuresService);
    const reason = 'Turf seam repair on Field 3';
    const listed = await closures.listClosures(manager, facilityId);
    if (listed.some((c) => c.reason === reason)) return;
    const calendar = calendarOf(ctx);
    await closures.createClosure(manager, {
      facilityId,
      resourceId: spaces.field3,
      interval: { start: calendar.iso(3, '07:00'), end: calendar.iso(3, '12:00') },
      reason,
      source: 'maintenance',
    });
  });
  return spaces;
}
