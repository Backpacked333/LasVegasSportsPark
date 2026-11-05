import type { AssignmentTargetType } from '@sportspark/contracts';
import { sql } from 'kysely';
import type { Trx } from '../../../kernel';
import type { RequirementRow } from '../workforce.shared';

/**
 * The locks that order commands on what a target's role requires (WRK-02, SPK-STAFF-001,
 * SPK-READY-004, R2-RACES-02). A requirement is unique per (target type, target id, role), so the
 * key below names it whether or not its row exists yet:
 *
 * - Every assignment command (propose, offer, accept, decline, withdraw, replace, an escalation)
 *   and a qualification revocation, for each requirement its accepted assignments name, take the
 *   key's lock SHARED and then the requirement row's share lock (`lockRequirementShared`).
 * - Creating a requirement takes the key's lock EXCLUSIVE before it inserts the row
 *   (`lockRequirementKey`), so no assignment command or revocation for that target and role is in
 *   flight while it inserts and looks for accepted assignees to flag: each one either committed
 *   before (and the creation reads it) or waits and reads the new requirement.
 * - Editing or retiring a requirement takes the row's lock `FOR UPDATE`, which conflicts with the
 *   share lock in the same way.
 *
 * Transaction-scoped; a key taken twice in one transaction stacks. Callers holding several keys
 * take them in (target type, target id, role) order, the order a retirement locks its rows in.
 */
export async function lockRequirementKey(
  trx: Trx,
  organizationId: string,
  targetType: AssignmentTargetType,
  targetId: string,
  role: string,
  mode: 'shared' | 'exclusive',
): Promise<void> {
  const key = `workforce.requirement:${organizationId}:${targetType}:${targetId}:${role}`;
  if (mode === 'shared') {
    await sql`select pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`.execute(trx);
  } else {
    await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(trx);
  }
}

/**
 * The requirement key's shared lock, then the requirement row's share lock (when the row exists).
 * Returns the requirement (retired or not), read after the locks, so it is the latest committed
 * version.
 */
export async function lockRequirementShared(
  trx: Trx,
  organizationId: string,
  targetType: AssignmentTargetType,
  targetId: string,
  role: string,
): Promise<RequirementRow | undefined> {
  await lockRequirementKey(trx, organizationId, targetType, targetId, role, 'shared');
  return trx
    .selectFrom('assignment_requirements')
    .selectAll()
    .where('organization_id', '=', organizationId)
    .where('target_type', '=', targetType)
    .where('target_id', '=', targetId)
    .where('role', '=', role)
    .forShare()
    .executeTakeFirst();
}
