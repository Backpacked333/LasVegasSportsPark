import { newId, type Principal } from '@sportspark/contracts';
import { describe, expect, it } from 'vitest';
import { defineActions } from '../authorization/actions';
import type {
  RelationshipAuthorityPort,
  TeamAuthorityPort,
} from '../authorization/authorization.port';
import { AuthorizationService } from '../authorization/authorization.service';
import { customerPrincipal, staffPrincipal } from '../../testing/principals';

const Actions = defineActions({
  viewSchedule: {
    id: 'test.view_schedule',
    description: 'view a participant schedule',
    staffRoles: ['front_desk', 'program_manager'],
    allowSelf: true,
    subjectPermission: 'view',
  },
  collect: {
    id: 'test.collect',
    description: 'collect a child',
    staffRoles: ['front_desk'],
    subjectPermission: 'collect',
  },
  manageTeam: {
    id: 'test.manage_team',
    description: 'manage a team entry',
    staffRoles: ['league_manager'],
    teamRole: 'captain',
  },
});

function service(
  grants: Array<[actor: string, subject: string, permission: string]> = [],
  captains: Array<[person: string, team: string]> = [],
  children: string[] = [],
) {
  // Mirrors the identity module's contract: an adult holds every permission over themselves;
  // a child never holds pay or collect over themselves.
  const relationships: RelationshipAuthorityPort = {
    hasPermission: async (_org, actor, subject, permission) => {
      if (actor === subject) {
        return !(children.includes(actor) && (permission === 'pay' || permission === 'collect'));
      }
      return grants.some(([a, s, p]) => a === actor && s === subject && p === permission);
    },
  };
  const teams: TeamAuthorityPort = {
    hasTeamRole: async (_org, person, team, role) =>
      role === 'captain' && captains.some(([p, t]) => p === person && t === team),
  };
  return new AuthorizationService(relationships, teams);
}

describe('AuthorizationService (§4.14, SPK-IAM-003)', () => {
  const org = newId();
  const otherOrg = newId();
  const child = newId();

  it('denies anonymous principals', async () => {
    const anon: Principal = {
      kind: 'anonymous',
      organizationId: null,
      accountId: null,
      personId: null,
      staffRoles: [],
      facilityIds: [],
      sessionId: null,
      actorLabel: 'anon',
    };
    const d = await service().decide(anon, Actions.viewSchedule, {
      type: 'schedule',
      organizationId: org,
      subjectPersonIds: [child],
    });
    expect(d.allowed).toBe(false);
    await expect(
      service().require(anon, Actions.viewSchedule, { type: 'schedule', organizationId: org }),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
  });

  it('never crosses organization scope, even for staff and system actions', async () => {
    const staff = staffPrincipal(otherOrg, ['front_desk']);
    const d = await service().decide(staff, Actions.viewSchedule, {
      type: 'schedule',
      organizationId: org,
      subjectPersonIds: [child],
    });
    expect(d).toMatchObject({ allowed: false, reason: 'organization scope mismatch' });
    await expect(
      service().require(staff, Actions.viewSchedule, {
        type: 'schedule',
        organizationId: org,
        protected: true,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('allows staff by role and enforces facility scope', async () => {
    const facility = newId();
    const scoped = staffPrincipal(org, ['front_desk'], { facilityIds: [facility] });
    expect(
      (
        await service().decide(scoped, Actions.viewSchedule, {
          type: 'schedule',
          organizationId: org,
          facilityId: facility,
        })
      ).allowed,
    ).toBe(true);
    expect(
      await service().decide(scoped, Actions.viewSchedule, {
        type: 'schedule',
        organizationId: org,
        facilityId: newId(),
      }),
    ).toMatchObject({ allowed: false, reason: 'facility scope mismatch' });
    const wrongRole = staffPrincipal(org, ['official']);
    expect(
      (
        await service().decide(wrongRole, Actions.viewSchedule, {
          type: 'schedule',
          organizationId: org,
        })
      ).allowed,
    ).toBe(false);
  });

  it('SPK-IAM-001/003: a coach who is also a parent receives each permission only in its proper scope', async () => {
    const facilityA = newId();
    const facilityB = newId();
    const CoachActions = defineActions({
      readEvent: {
        id: 'test.read_event_as_coach',
        description: 'read an event (coaches by role, guardians by relationship)',
        staffRoles: ['coach'],
        allowSelf: true,
        subjectPermission: 'view',
      },
    });
    const coachParent = staffPrincipal(org, ['coach'], { facilityIds: [facilityA] });
    const svc = service([[coachParent.personId!, child, 'view']]);
    // Outside the coach's facility, the guardian grant still applies to their own child.
    expect(
      await svc.decide(coachParent, CoachActions.readEvent, {
        type: 'event',
        organizationId: org,
        facilityId: facilityB,
        subjectPersonIds: [child],
        protected: true,
      }),
    ).toEqual({ allowed: true, basis: 'relationship:view' });
    // ...and gives nothing over someone else's child: the coach role does not stretch to facility B.
    const strangerChild = newId();
    expect(
      await svc.decide(coachParent, CoachActions.readEvent, {
        type: 'event',
        organizationId: org,
        facilityId: facilityB,
        subjectPersonIds: [strangerChild],
        protected: true,
      }),
    ).toMatchObject({ allowed: false, reason: 'facility scope mismatch', protectedRecord: true });
    await expect(
      svc.require(coachParent, CoachActions.readEvent, {
        type: 'event',
        organizationId: org,
        facilityId: facilityB,
        subjectPersonIds: [strangerChild],
        protected: true,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      svc.require(coachParent, CoachActions.readEvent, {
        type: 'event',
        organizationId: org,
        facilityId: facilityB,
        subjectPersonIds: [strangerChild],
      }),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    // Inside the coach's facility, the coach role applies to any participant.
    expect(
      await svc.decide(coachParent, CoachActions.readEvent, {
        type: 'event',
        organizationId: org,
        facilityId: facilityA,
        subjectPersonIds: [strangerChild],
      }),
    ).toEqual({ allowed: true, basis: 'staff role' });
  });

  it('SPK-IAM-003: a facility-scoped staff member keeps self authority, and team authority, at another facility', async () => {
    const facilityA = newId();
    const facilityB = newId();
    const scoped = staffPrincipal(org, ['front_desk', 'league_manager'], {
      facilityIds: [facilityA],
    });
    const team = newId();
    const svc = service([], [[scoped.personId!, team]]);
    expect(
      await svc.decide(scoped, Actions.viewSchedule, {
        type: 'schedule',
        organizationId: org,
        facilityId: facilityB,
        subjectPersonIds: [scoped.personId!],
      }),
    ).toEqual({ allowed: true, basis: 'self' });
    expect(
      await svc.decide(scoped, Actions.manageTeam, {
        type: 'team_entry',
        organizationId: org,
        facilityId: facilityB,
        teamEntryId: team,
      }),
    ).toEqual({ allowed: true, basis: 'team_role:captain' });
    expect(
      await svc.decide(scoped, Actions.manageTeam, {
        type: 'team_entry',
        organizationId: org,
        facilityId: facilityB,
        teamEntryId: newId(),
      }),
    ).toMatchObject({ allowed: false, reason: 'facility scope mismatch' });
  });

  it('one permission never implies another: view does not allow collect', async () => {
    const parent = customerPrincipal(org);
    const svc = service([[parent.personId!, child, 'view']]);
    expect(
      (
        await svc.decide(parent, Actions.viewSchedule, {
          type: 'schedule',
          organizationId: org,
          subjectPersonIds: [child],
        })
      ).allowed,
    ).toBe(true);
    const collect = await svc.decide(parent, Actions.collect, {
      type: 'release',
      organizationId: org,
      subjectPersonIds: [child],
    });
    expect(collect.allowed).toBe(false);
    await expect(
      svc.require(parent, Actions.collect, {
        type: 'release',
        organizationId: org,
        subjectPersonIds: [child],
      }),
    ).rejects.toMatchObject({ code: 'PARTICIPANT_AUTHORITY_REQUIRED' });
  });

  it('requires authority over every subject in a multi-participant target', async () => {
    const parent = customerPrincipal(org);
    const otherChild = newId();
    const svc = service([[parent.personId!, child, 'view']]);
    expect(
      (
        await svc.decide(parent, Actions.viewSchedule, {
          type: 'schedule',
          organizationId: org,
          subjectPersonIds: [child, otherChild],
        })
      ).allowed,
    ).toBe(false);
    expect(
      (
        await svc.decide(parent, Actions.viewSchedule, {
          type: 'schedule',
          organizationId: org,
          subjectPersonIds: [child, parent.personId!],
        })
      ).allowed,
    ).toBe(true);
  });

  it('never lets a child principal pay or collect for themselves, even on an allowSelf action', async () => {
    const childPrincipal = customerPrincipal(org);
    const svc = service([], [], [childPrincipal.personId!]);
    const PayActions = defineActions({
      pay: {
        id: 'test.pay',
        description: 'pay for a participant',
        staffRoles: ['front_desk'],
        allowSelf: true,
        subjectPermission: 'pay',
      },
    });
    const pay = await svc.decide(childPrincipal, PayActions.pay, {
      type: 'order',
      organizationId: org,
      subjectPersonIds: [childPrincipal.personId!],
    });
    expect(pay.allowed).toBe(false);
    const view = await svc.decide(childPrincipal, Actions.viewSchedule, {
      type: 'schedule',
      organizationId: org,
      subjectPersonIds: [childPrincipal.personId!],
    });
    expect(view.allowed).toBe(true);
  });

  it('allows self when the action permits it and the relationship authority agrees', async () => {
    const adult = customerPrincipal(org);
    expect(
      (
        await service().decide(adult, Actions.viewSchedule, {
          type: 'schedule',
          organizationId: org,
          subjectPersonIds: [adult.personId!],
        })
      ).allowed,
    ).toBe(true);
    expect(
      (
        await service().decide(adult, Actions.collect, {
          type: 'release',
          organizationId: org,
          subjectPersonIds: [adult.personId!],
        })
      ).allowed,
    ).toBe(true);
  });

  it('grants team-role actions only to the role holder on that team entry', async () => {
    const captain = customerPrincipal(org);
    const team = newId();
    const svc = service([], [[captain.personId!, team]]);
    expect(
      (
        await svc.decide(captain, Actions.manageTeam, {
          type: 'team_entry',
          organizationId: org,
          teamEntryId: team,
        })
      ).allowed,
    ).toBe(true);
    expect(
      (
        await svc.decide(captain, Actions.manageTeam, {
          type: 'team_entry',
          organizationId: org,
          teamEntryId: newId(),
        })
      ).allowed,
    ).toBe(false);
  });

  it('reports protected denials as not-found and unprotected denials as access denied', async () => {
    const stranger = customerPrincipal(org);
    await expect(
      service().require(stranger, Actions.viewSchedule, {
        type: 'schedule',
        organizationId: org,
        subjectPersonIds: [child],
        protected: true,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      service().require(stranger, Actions.manageTeam, {
        type: 'team_entry',
        organizationId: org,
        teamEntryId: newId(),
      }),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  });

  it('system principals are allowed within their organization only', async () => {
    const system: Principal = {
      kind: 'system',
      organizationId: org,
      accountId: null,
      personId: null,
      staffRoles: [],
      facilityIds: [],
      sessionId: null,
      actorLabel: 'worker',
    };
    expect(
      (await service().decide(system, Actions.collect, { type: 'release', organizationId: org }))
        .allowed,
    ).toBe(true);
    expect(
      (
        await service().decide(system, Actions.collect, {
          type: 'release',
          organizationId: otherOrg,
        })
      ).allowed,
    ).toBe(false);
  });
});
