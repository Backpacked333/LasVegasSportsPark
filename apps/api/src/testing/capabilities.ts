import { CAPABILITIES, newId, type CapabilityId } from '@sportspark/contracts';
import { json, type Db } from '@sportspark/db';

/**
 * Test fixture for capability switches (K-12): writes the switch row and its history directly,
 * never through the gated command, so a module's tests enable what they exercise without depending
 * on the administration endpoint. Fixtures are never gated.
 */
export async function setCapability(
  db: Db,
  organizationId: string,
  capability: CapabilityId,
  enabled: boolean,
): Promise<void> {
  if (!CAPABILITIES[capability]) throw new Error(`unknown capability ${capability}`);
  const now = new Date();
  const actor = {
    kind: 'system',
    accountId: null,
    personId: null,
    staffRoles: [],
    sessionId: null,
    actorLabel: 'test.fixture',
  };
  const existing = await db
    .selectFrom('organization_capabilities')
    .select(['revision', 'enabled'])
    .where('organization_id', '=', organizationId)
    .where('capability', '=', capability)
    .executeTakeFirst();
  if (existing?.enabled === enabled) return;
  const revision = (existing?.revision ?? 0) + 1;
  const values = {
    enabled,
    decision_reference: 'DEC-016',
    reason: 'test fixture',
    changed_by: json(actor),
    changed_at: now,
    revision,
  };
  if (existing) {
    await db
      .updateTable('organization_capabilities')
      .set(values)
      .where('organization_id', '=', organizationId)
      .where('capability', '=', capability)
      .execute();
  } else {
    await db
      .insertInto('organization_capabilities')
      .values({ organization_id: organizationId, capability, ...values })
      .execute();
  }
  await db
    .insertInto('organization_capability_changes')
    .values({
      id: newId(),
      organization_id: organizationId,
      capability,
      enabled,
      decision_reference: 'DEC-016',
      reason: 'test fixture',
      changed_by: json(actor),
      changed_at: now,
      revision,
      correlation_id: null,
    })
    .execute();
}
