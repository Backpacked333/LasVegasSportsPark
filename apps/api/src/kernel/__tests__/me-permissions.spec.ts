import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// Loading the domain modules registers every action, as in the running application.
import '../../modules';
import { customerPrincipal, staffPrincipal } from '../../testing/principals';
import { createTestApp, type TestApp } from '../../testing/test-app';
import { actionRegistry, defineActions } from '../authorization/actions';
import { areaOfAction } from '../authorization/navigation-areas';

interface Area {
  id: string;
  visible: boolean;
  actionIds: string[];
}

// An action that creates new commitments of a capability (K-12), held only by officials.
defineActions({
  probe: {
    id: 'reporting.test_capability_probe',
    description: 'test probe for capability-gated areas',
    staffRoles: ['official'],
    capability: 'tournaments',
  },
});

describe('GET /v1/me/permissions (K-05, SPK-UX-005, §4.14)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ capabilities: [] });
  });
  afterAll(async () => {
    await t?.close();
  });

  const visibleAreas = (areas: Area[]) => areas.filter((a) => a.visible).map((a) => a.id);

  it('SPK-UX-005: a front-desk principal sees today, people, registrations and arrival but not finance or admin', async () => {
    const desk = await t.authHeader(staffPrincipal(t.organizationId, ['front_desk']));
    const res = await t.http.get('/v1/me/permissions').set(desk);
    expect(res.status).toBe(200);
    expect(res.body.principalKind).toBe('staff');
    expect(res.body.staffRoles).toEqual(['front_desk']);
    expect(res.body.areas).toHaveLength(14);
    const visible = visibleAreas(res.body.areas);
    for (const area of ['today', 'people', 'registrations', 'arrival']) {
      expect(visible, area).toContain(area);
    }
    expect(visible).not.toContain('finance');
    expect(visible).not.toContain('admin');
    const ids = res.body.actions.map((a: { id: string }) => a.id);
    expect(ids).toContain('entry.check_in');
    expect(ids).toContain('finance.record_tender');
    expect(ids).not.toContain('finance.refund');
    // Organization-wide role: every action reports every facility (null).
    expect(res.body.actions.every((a: { facilityIds: unknown }) => a.facilityIds === null)).toBe(
      true,
    );
    expect(res.body.evaluatedAt).toBe(t.clock.now().toISOString());
  });

  it('identity-05: a role scoped to one facility reports only that facility on each of its actions', async () => {
    const east = newId();
    const principal = staffPrincipal(t.organizationId, ['front_desk', 'coach'], {
      facilityIds: [t.facilityId, east],
      staffScopes: [
        { role: 'front_desk', facilityIds: [t.facilityId] },
        { role: 'coach', facilityIds: [] },
      ],
    });
    const res = await t.http.get('/v1/me/permissions').set(await t.authHeader(principal));
    expect(res.status).toBe(200);
    const byId = new Map<string, string[] | null>(
      res.body.actions.map((a: { id: string; facilityIds: string[] | null }) => [
        a.id,
        a.facilityIds,
      ]),
    );
    // Held only through the facility-scoped front desk role.
    expect(byId.get('entry.check_in')).toEqual([t.facilityId]);
    expect(byId.get('finance.record_tender')).toEqual([t.facilityId]);
    for (const action of actionRegistry.list()) {
      const desk = action.staffRoles.includes('front_desk');
      const coach = action.staffRoles.includes('coach');
      if (coach) {
        // Held through the organization-wide coach role (alone or with the desk): every facility.
        expect(byId.get(action.id), action.id).toBeNull();
      } else if (desk) {
        expect(byId.get(action.id), action.id).toEqual([t.facilityId]);
      } else {
        expect(byId.has(action.id), action.id).toBe(false);
      }
    }
  });

  it('a customer has no outright actions, lists conditional ones, and sees no staff area', async () => {
    const parent = await t.authHeader(customerPrincipal(t.organizationId));
    const res = await t.http.get('/v1/me/permissions').set(parent);
    expect(res.status).toBe(200);
    expect(res.body.principalKind).toBe('customer');
    expect(res.body.actions).toEqual([]);
    expect(visibleAreas(res.body.areas)).toEqual([]);
    const pay = res.body.conditionalActions.find(
      (a: { id: string }) => a.id === 'finance.pay_obligation',
    );
    expect(pay).toMatchObject({ subjectPermission: 'pay' });
    expect(res.body.capabilities).toHaveLength(15);
    expect(res.body.capabilities.every((c: { enabled: boolean }) => c.enabled === false)).toBe(
      true,
    );
    expect((await t.http.get('/v1/me/permissions')).status).toBe(401);
  });

  it('K-12: an area whose held actions all belong to a disabled capability is hidden', async () => {
    const official = await t.authHeader(staffPrincipal(t.organizationId, ['official']));
    const before = await t.http.get('/v1/me/permissions').set(official);
    const reports = (before.body.areas as Area[]).find((a) => a.id === 'reports');
    expect(reports?.actionIds).toContain('reporting.test_capability_probe');
    if (reports?.actionIds.length === 1) expect(reports.visible).toBe(false);
    await t.enableCapability('tournaments');
    const after = await t.http.get('/v1/me/permissions').set(official);
    expect((after.body.areas as Area[]).find((a) => a.id === 'reports')?.visible).toBe(true);
    expect(
      after.body.capabilities.find((c: { id: string }) => c.id === 'tournaments'),
    ).toMatchObject({ enabled: true, enforcement: 'commands' });
    await t.disableCapability('tournaments');
  });

  it('the area mapping is explicit first, then by module prefix (Proposed)', () => {
    expect(areaOfAction('identity.create_person')).toBe('people');
    expect(areaOfAction('identity.manage_staff_membership')).toBe('staff');
    expect(areaOfAction('competition.manage_roster')).toBe('teams');
    expect(areaOfAction('competition.publish_result')).toBe('leagues');
    expect(areaOfAction('finance.refund')).toBe('finance');
    expect(areaOfAction('finance.checkout')).toBe('registrations');
    expect(areaOfAction('exceptions.read')).toBe('today');
    expect(areaOfAction('core.view_audit')).toBe('admin');
    expect(areaOfAction('migration.read_authority')).toBeNull();
    expect(areaOfAction('unknown.thing')).toBeNull();
  });
});
