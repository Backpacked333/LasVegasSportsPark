import { Inject, Injectable } from '@nestjs/common';
import {
  CAPABILITIES,
  CAPABILITY_IDS,
  CapabilityIdSchema,
  CapabilitySwitchMachine,
  DomainError,
  defineEvent,
  errors,
  newId,
  z,
  type CapabilityId,
  type CapabilityView,
  type ChangeCapabilityInput,
  type Principal,
} from '@sportspark/contracts';
import { json, type Db } from '@sportspark/db';
import { AuditWriter, snapshotActor } from '../audit/audit.writer';
import { CoreActions } from '../authorization/core-actions';
import { AuthorizationService } from '../authorization/authorization.service';
import type { Clock } from '../clock';
import { executorFor } from '../database/transaction-context';
import { UnitOfWork, type Trx } from '../database/unit-of-work';
import { Outbox } from '../outbox/outbox';
import { CLOCK, DATABASE } from '../tokens';

/** §1.6, DEC-016 (K-12): a capability switch changed for an organization. */
export const CapabilityChanged = defineEvent(
  'core.capability_changed',
  z.object({
    capability: CapabilityIdSchema,
    enabled: z.boolean(),
    decisionReference: z.string(),
  }),
);

interface SwitchRow {
  capability: string;
  enabled: boolean;
  decision_reference: string;
  reason: string;
  changed_by: Record<string, unknown>;
  changed_at: Date | string;
  revision: number;
}

/**
 * Per-organization capability switches (K-12, IF-30; §1.6 conditional capabilities, §6.5
 * Package G). No row means disabled. A gated command calls `require` inside its unit of work, so a
 * disabled capability refuses new commitments with ACCESS_DENIED `details.code CAPABILITY_DISABLED`
 * (no new error code: that is a §4.10 decision, DEC-092). Reads, cancellations, refunds, reversals,
 * settlements, retirements, ends, reconciliations, expiry jobs and provider outcomes never call it
 * (overview.md, Proposed), and `recorded_only` capabilities are never checked.
 */
@Injectable()
export class CapabilityService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
  ) {}

  async isEnabled(
    organizationId: string,
    capability: CapabilityId,
    db?: Db | Trx,
  ): Promise<boolean> {
    const row = await (db ?? executorFor(this.db))
      .selectFrom('organization_capabilities')
      .select('enabled')
      .where('organization_id', '=', organizationId)
      .where('capability', '=', capability)
      .executeTakeFirst();
    return row?.enabled === true;
  }

  /** Refuses a new commitment of a disabled capability (call inside the command's unit of work). */
  async require(organizationId: string, capability: CapabilityId, db?: Db | Trx): Promise<void> {
    const definition = CAPABILITIES[capability];
    if (!definition) throw new Error(`unknown capability ${String(capability)}`);
    if (definition.enforcement !== 'commands') {
      throw new Error(
        `capability ${capability} is recorded only and is never checked (DEC-016); remove the check`,
      );
    }
    if (await this.isEnabled(organizationId, capability, db)) return;
    throw errors.accessDenied(
      `This organization has not enabled ${capability.replaceAll('_', ' ')}.`,
      {
        code: 'CAPABILITY_DISABLED',
        capability,
        applicabilityReferences: [...definition.applicabilityReferences],
      },
    );
  }

  /** Every catalogued capability with the organization's current switch. */
  async list(organizationId: string, db?: Db | Trx): Promise<CapabilityView[]> {
    const rows = (await (db ?? executorFor(this.db))
      .selectFrom('organization_capabilities')
      .select([
        'capability',
        'enabled',
        'decision_reference',
        'reason',
        'changed_by',
        'changed_at',
        'revision',
      ])
      .where('organization_id', '=', organizationId)
      .execute()) as SwitchRow[];
    const byId = new Map(rows.map((row) => [row.capability, row]));
    return CAPABILITY_IDS.map((id) => toView(id, byId.get(id) ?? null));
  }

  async listForPrincipal(principal: Principal): Promise<CapabilityView[]> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, CoreActions.viewCapabilities, {
      type: 'capability',
      organizationId,
    });
    return this.list(organizationId);
  }

  /**
   * Enables or disables a capability (core.manage_capabilities, system administrator): the
   * decision reference must be one of the capability's applicability references (DEC-016 or its
   * own Register E record; a related decision such as DEC-057 for point of sale is refused). The
   * row is locked, the switch machine decides the transition, and the change is recorded in the
   * append-only history, audited and announced (`core.capability_changed`).
   */
  async change(
    principal: Principal,
    capability: CapabilityId,
    event: 'enable' | 'disable',
    input: ChangeCapabilityInput,
    correlationId: string | null,
  ): Promise<CapabilityView> {
    const organizationId = organizationOf(principal);
    const definition = CAPABILITIES[capability];
    return this.uow.run(async ({ trx }) => {
      await this.authorization.require(principal, CoreActions.manageCapabilities, {
        type: 'capability',
        id: capability,
        organizationId,
      });
      if (!definition.applicabilityReferences.includes(input.decisionReference)) {
        throw errors.validation(
          `${input.decisionReference} does not decide whether ${capability} applies; name one of ${definition.applicabilityReferences.join(', ')}.`,
          {
            code: 'NOT_AN_APPLICABILITY_DECISION',
            capability,
            decisionReference: input.decisionReference,
            applicabilityReferences: [...definition.applicabilityReferences],
          },
        );
      }
      const now = this.clock.now();
      const actor = snapshotActor(principal);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const current = (await trx
          .selectFrom('organization_capabilities')
          .select([
            'capability',
            'enabled',
            'decision_reference',
            'reason',
            'changed_by',
            'changed_at',
            'revision',
          ])
          .where('organization_id', '=', organizationId)
          .where('capability', '=', capability)
          .forUpdate()
          .executeTakeFirst()) as SwitchRow | undefined;
        const currentRevision = current?.revision ?? 0;
        if (input.expectedRevision !== undefined && input.expectedRevision !== currentRevision) {
          throw errors.staleRevision(input.expectedRevision, currentRevision);
        }
        const to = CapabilitySwitchMachine.next(current?.enabled ? 'enabled' : 'disabled', event);
        const enabled = to === 'enabled';
        const revision = currentRevision + 1;
        const values = {
          enabled,
          decision_reference: input.decisionReference,
          reason: input.reason,
          changed_by: json(actor),
          changed_at: now,
          revision,
        };
        if (current) {
          await trx
            .updateTable('organization_capabilities')
            .set(values)
            .where('organization_id', '=', organizationId)
            .where('capability', '=', capability)
            .where('revision', '=', currentRevision)
            .executeTakeFirstOrThrow();
        } else {
          const inserted = await trx
            .insertInto('organization_capabilities')
            .values({ organization_id: organizationId, capability, ...values })
            .onConflict((oc) => oc.columns(['organization_id', 'capability']).doNothing())
            .returning('revision')
            .executeTakeFirst();
          // A concurrent first change committed the row: re-evaluate against it.
          if (!inserted) continue;
        }
        await trx
          .insertInto('organization_capability_changes')
          .values({
            id: newId(),
            organization_id: organizationId,
            capability,
            enabled,
            decision_reference: input.decisionReference,
            reason: input.reason,
            changed_by: json(actor),
            changed_at: now,
            revision,
            correlation_id: correlationId,
          })
          .execute();
        await this.audit.record(trx, {
          organizationId,
          actor: principal,
          action: `${CoreActions.manageCapabilities.id}.${event}`,
          targetType: 'capability',
          targetId: capability,
          beforeRevision: current ? currentRevision : null,
          afterRevision: revision,
          reason: input.reason,
          correlationId,
          details: { capability, enabled, decisionReference: input.decisionReference },
        });
        await this.outbox.enqueue(trx, CapabilityChanged, {
          organizationId,
          aggregateType: 'capability',
          aggregateId: capability,
          payload: { capability, enabled, decisionReference: input.decisionReference },
          correlationId,
        });
        return toView(capability, {
          capability,
          enabled,
          decision_reference: input.decisionReference,
          reason: input.reason,
          changed_by: actor,
          changed_at: now,
          revision,
        });
      }
      throw new DomainError('RESOURCE_CONFLICT', 'The capability changed concurrently; reload it.');
    });
  }
}

function toView(capability: CapabilityId, row: SwitchRow | null): CapabilityView {
  const definition = CAPABILITIES[capability];
  const changedBy = (row?.changed_by ?? {}) as { personId?: unknown };
  return {
    capability,
    enabled: row?.enabled ?? false,
    enforcement: definition.enforcement,
    description: definition.description,
    applicabilityReferences: [...definition.applicabilityReferences],
    relatedDecisions: [...definition.relatedDecisions],
    owningModules: [...definition.owningModules],
    decisionReference: row?.decision_reference ?? null,
    reason: row?.reason ?? null,
    changedByPersonId: typeof changedBy.personId === 'string' ? changedBy.personId : null,
    changedAt: row ? new Date(row.changed_at).toISOString() : null,
    revision: row?.revision ?? null,
  };
}

function organizationOf(principal: Principal): string {
  if (!principal.organizationId) throw errors.authenticationRequired();
  return principal.organizationId;
}
