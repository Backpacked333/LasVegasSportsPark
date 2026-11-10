import { localInstant, type DemoContext } from './context';

export interface DemoFacility {
  pitch1: string;
  pitch1North: string;
  pitch1South: string;
  pitch2: string;
  pitch2North: string;
  pitch2South: string;
  indoorCourt: string;
  room: string;
  restrictionId: string;
  maintenanceTaskId: string;
  resourceCount: number;
}

interface Created {
  id: string;
}

/**
 * The facility's spaces (SPK-SCHED-001/002), opening hours and one upcoming maintenance
 * restriction (SPK-FAC-003). Names, dimensions and hours are synthetic examples; the real
 * inventory is DEC-001 (docs/package-a/facility-inventory.md).
 */
export async function seedFacility(ctx: DemoContext): Promise<DemoFacility> {
  const { api, facilityId } = ctx;
  const admin = ctx.staff.admin;
  const resource = async (body: Record<string, unknown>): Promise<string> =>
    (await api.post<Created>('/resources', admin, { facilityId, ...body })).id;

  const pitchWithHalves = async (name: string): Promise<[string, string, string]> => {
    const pitch = await resource({
      kind: 'pitch',
      name,
      dimensions: { lengthM: 100, widthM: 64 },
      compatibleFormats: ['11v11'],
      defaultCleanupMinutes: 0,
    });
    const north = await resource({
      kind: 'subdivision',
      name: `${name} north half`,
      parentResourceId: pitch,
      compatibleFormats: ['7v7'],
    });
    const south = await resource({
      kind: 'subdivision',
      name: `${name} south half`,
      parentResourceId: pitch,
      compatibleFormats: ['7v7'],
    });
    return [pitch, north, south];
  };

  const [pitch1, pitch1North, pitch1South] = await pitchWithHalves('Demo Pitch 1');
  const [pitch2, pitch2North, pitch2South] = await pitchWithHalves('Demo Pitch 2');
  const indoorCourt = await resource({
    kind: 'pitch',
    name: 'Demo Indoor Court (boarded)',
    dimensions: { lengthM: 56, widthM: 26 },
    compatibleFormats: ['5v5', '6v6'],
    defaultCleanupMinutes: 0,
  });
  const room = await resource({ kind: 'room', name: 'Demo Club Room' });

  // Facility-wide hours, every day (synthetic; the operator's hours are DEC-001).
  for (let weekday = 0; weekday <= 6; weekday += 1) {
    await api.post('/operating-hours', admin, {
      facilityId,
      weekday,
      opensAt: '07:00',
      closesAt: '23:00',
    });
  }

  // An upcoming restriction on one half: reported, then approved by the facilities operator, which
  // closes the half through scheduling for that interval (SPK-FAC-003, SPK-FAC-004).
  const task = await api.post<Created>('/maintenance-tasks', ctx.staff.facilities, {
    facilityId,
    resourceId: pitch2South,
    issue: 'Demo: goal-mouth turf worn, re-seeding booked (synthetic example)',
    severity: 'medium',
  });
  const restriction = await api.post<Created>('/maintenance-restrictions', ctx.staff.facilities, {
    facilityId,
    resourceId: pitch2South,
    taskId: task.id,
    kind: 'closed',
    interval: { start: localInstant(ctx, 3, '07:00'), end: localInstant(ctx, 4, '12:00') },
    reason: 'Demo: goal-mouth re-seeding (synthetic example)',
  });

  return {
    pitch1,
    pitch1North,
    pitch1South,
    pitch2,
    pitch2North,
    pitch2South,
    indoorCourt,
    room,
    restrictionId: restriction.id,
    maintenanceTaskId: task.id,
    resourceCount: 8,
  };
}
