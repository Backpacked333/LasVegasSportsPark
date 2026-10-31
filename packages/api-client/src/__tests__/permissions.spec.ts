/**
 * The view of GET /v1/me/permissions both apps use (K-05, SPK-UX-005, DEC-016): outright actions
 * with their facility scope, conditional actions, visible areas, capability switches.
 */
import { describe, expect, it } from 'vitest';
import { NAVIGATION_AREAS, permissionsView } from '../permissions';
import { capabilityDisabledBody, fakePermissions } from '../testing';

const FACILITY_A = '0192f1a0-0000-7000-8000-00000000fa01';
const FACILITY_B = '0192f1a0-0000-7000-8000-00000000fa02';

describe('permissionsView (SPK-UX-005)', () => {
  it('tells outright actions, facility-scoped ones and conditional ones apart', () => {
    const view = permissionsView(
      fakePermissions({
        actions: [
          'finance.read_payment',
          { id: 'scheduling.publish_draft', facilityIds: [FACILITY_A] },
        ],
        conditionalActions: [
          { id: 'enrollment.create_booking', self: true },
          { id: 'competition.invite_player', teamRole: 'captain' },
        ],
      }),
    );
    expect(view.actionPermission('finance.read_payment')).toEqual({
      kind: 'outright',
      facilityIds: null,
    });
    expect(view.isPermitted('finance.read_payment', FACILITY_B)).toBe(true);
    expect(view.isPermitted('scheduling.publish_draft')).toBe(true);
    expect(view.isPermitted('scheduling.publish_draft', FACILITY_A)).toBe(true);
    expect(view.isPermitted('scheduling.publish_draft', FACILITY_B)).toBe(false);
    expect(
      view.actionPermission('scheduling.publish_draft', { facilityId: FACILITY_B }),
    ).toBeNull();
    expect(view.actionPermission('enrollment.create_booking')).toEqual({
      kind: 'conditional',
      self: true,
      subjectPermission: null,
      teamRole: null,
    });
    expect(view.isPermitted('enrollment.create_booking')).toBe(false);
    expect(view.actionPermission('competition.invite_player')).toMatchObject({
      kind: 'conditional',
      teamRole: 'captain',
    });
    expect(view.actionPermission('finance.approve_refund')).toBeNull();
  });

  it('lists the visible areas in specification order', () => {
    const view = permissionsView(fakePermissions({ areas: ['finance', 'today', 'admin'] }));
    expect(view.visibleAreas).toEqual(['today', 'finance', 'admin']);
    expect(view.isAreaVisible('finance')).toBe(true);
    expect(view.isAreaVisible('schedule')).toBe(false);
    expect(permissionsView(fakePermissions()).visibleAreas).toEqual([...NAVIGATION_AREAS]);
  });

  it('reads each capability switch; every switch starts off (DEC-016)', () => {
    const off = permissionsView(fakePermissions());
    expect(off.isCapabilityEnabled('rentals')).toBe(false);
    expect(off.isCapabilityEnabled('assistant')).toBe(false);
    const on = permissionsView(fakePermissions({ enabled: ['rentals', 'point_of_sale'] }));
    expect(on.isCapabilityEnabled('rentals')).toBe(true);
    expect(on.isCapabilityEnabled('point_of_sale')).toBe(true);
    expect(on.isCapabilityEnabled('parties')).toBe(false);
  });

  it('builds the CAPABILITY_DISABLED body the kernel sends (test helper)', () => {
    expect(capabilityDisabledBody('rentals', ['DEC-016', 'DEC-076'])).toMatchObject({
      code: 'ACCESS_DENIED',
      nextAction: 'contact_support_or_request_access',
      details: {
        code: 'CAPABILITY_DISABLED',
        capability: 'rentals',
        applicabilityReferences: ['DEC-016', 'DEC-076'],
      },
    });
    const caps = fakePermissions().capabilities;
    expect(caps.find((c) => c.id === 'installments')?.enforcement).toBe('recorded_only');
    expect(caps.find((c) => c.id === 'rentals')?.enforcement).toBe('commands');
  });
});
