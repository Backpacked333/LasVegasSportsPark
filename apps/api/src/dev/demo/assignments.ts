import type { Principal } from '@sportspark/contracts';
import { AssignmentsService } from '../../modules/workforce';
import type { DemoCatalog, DemoSession } from './catalog';
import { optional, service, type DemoContext } from './context';
import type { DemoLeague } from './league';
import type { DemoAdult, DemoStaff } from './people';

/**
 * Staff assignments this week (SPK-STAFF-001 to 003), so "My assignments" has content: the coach
 * has today's class (accepted) and next week's (offered, to accept in the demo); the official has
 * the games of the next league night, one accepted and one offered.
 */
export async function seedAssignments(
  ctx: DemoContext,
  staff: DemoStaff,
  catalog: DemoCatalog,
  league: DemoLeague,
): Promise<void> {
  const assignments = service(ctx, AssignmentsService);
  const manager = staff.manager.principal;
  const hasAny = async (person: DemoAdult): Promise<boolean> =>
    (await assignments.list(manager, { personId: person.personId, limit: 5, order: 'asc' })).items
      .length > 0;

  const assign = async (
    person: DemoAdult,
    by: Principal,
    target:
      | { targetType: 'session'; targetId: string; offeringId: string }
      | { targetType: 'fixture'; targetId: string },
    kind: 'coach' | 'official',
    role: string,
    accept: boolean,
  ): Promise<void> => {
    const created = await assignments.create(
      by,
      {
        personId: person.personId,
        kind,
        role,
        engagement: 'regular',
        offer: true,
        ...target,
        policyReferences: [],
      },
      null,
    );
    if (accept) {
      await assignments.accept(
        person.principal,
        created.assignment.id,
        { policyReferences: [] },
        null,
      );
    }
  };

  await optional(ctx, "the coach's assignments", async () => {
    if (await hasAny(staff.coach)) return;
    // Sessions that have not ended: today's class while it is still to come, otherwise next week's.
    const now = ctx.clock.now().toISOString();
    const open = (sessions: DemoSession[]): DemoSession[] => sessions.filter((s) => s.end > now);
    const [next, following] = open(catalog.termClass.sessions);
    const [futsal] = open(catalog.memberClass.sessions);
    const coach = async (
      session: DemoSession | undefined,
      offeringId: string,
      accept: boolean,
    ): Promise<void> => {
      if (!session) return;
      await assign(
        staff.coach,
        manager,
        { targetType: 'session', targetId: session.id, offeringId },
        'coach',
        'coach',
        accept,
      );
    };
    await coach(next, catalog.termClass.id, true);
    await coach(futsal, catalog.memberClass.id, true);
    await coach(following, catalog.termClass.id, false);
  });

  await optional(ctx, "the official's assignments", async () => {
    if (await hasAny(staff.official)) return;
    const now = ctx.clock.now().toISOString();
    const upcoming = league.fixtures
      .filter((f) => f.scheduledStart && f.scheduledStart > now)
      .sort((a, b) => (a.scheduledStart as string).localeCompare(b.scheduledStart as string));
    // Two games of the next night that do not overlap: the first of each division at 19:00 would
    // clash, so take the first game and the first one that starts after it ends.
    const first = upcoming[0];
    const second = upcoming.find(
      (f) =>
        first && f.scheduledStart && first.scheduledEnd && f.scheduledStart >= first.scheduledEnd,
    );
    if (first) {
      await assign(
        staff.official,
        staff.league.principal,
        { targetType: 'fixture', targetId: first.id },
        'official',
        'referee',
        true,
      );
    }
    if (second) {
      await assign(
        staff.official,
        staff.league.principal,
        { targetType: 'fixture', targetId: second.id },
        'official',
        'referee',
        false,
      );
    }
  });
}
