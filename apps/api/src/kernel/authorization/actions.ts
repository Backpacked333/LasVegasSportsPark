import {
  CAPABILITIES,
  type ActionId,
  type CapabilityId,
  type StaffRole,
} from '@sportspark/contracts';

/** Guardian/self permissions that may be granted over a participant (SPK-IAM-003). */
export const GrantPermissions = [
  'view',
  'register',
  'pay',
  'receive_messages',
  'complete_forms',
  'collect',
] as const;
export type GrantPermission = (typeof GrantPermissions)[number];

/** Team roles are relationships within a season team entry, owned by the competition module. */
export const TeamRoles = ['captain', 'co_captain', 'member'] as const;
export type TeamRole = (typeof TeamRoles)[number];

export interface ActionDefinition {
  id: ActionId;
  description: string;
  /** Staff roles permitted to perform the action within their organization/facility scope. */
  staffRoles: readonly StaffRole[];
  /** A customer may act on themselves as the subject person. */
  allowSelf?: boolean;
  /** A customer may act when they hold this permission over every subject person of the target. */
  subjectPermission?: GrantPermission;
  /** A customer may act when they hold this role on the target team entry. */
  teamRole?: TeamRole;
  /** Documentation: specification requirement ids this action implements. */
  requirements?: readonly string[];
  /**
   * The conditional capability whose new commitments this action creates (K-12, DEC-016): its
   * command calls `CapabilityService.require` in its unit of work, and GET /v1/me/permissions
   * hides an area whose held actions are all disabled. Only a capability enforced on commands may
   * be named; reads, cancellations, refunds and other unwinding actions never name one.
   */
  capability?: CapabilityId;
}

/**
 * Registry of every consequential action in the system. Modules declare their actions with
 * `defineActions` so the permission matrix in docs/package-a can be generated from code and
 * authorization decisions share one evaluation path.
 */
export class ActionRegistry {
  private readonly actions = new Map<ActionId, ActionDefinition>();

  register(definition: ActionDefinition): ActionDefinition {
    if (definition.capability !== undefined) {
      const capability = CAPABILITIES[definition.capability];
      if (!capability) {
        throw new Error(
          `action ${definition.id} names unknown capability ${definition.capability}`,
        );
      }
      if (capability.enforcement !== 'commands') {
        throw new Error(
          `action ${definition.id} names capability ${definition.capability}, which is recorded only and never checked (DEC-016)`,
        );
      }
    }
    const existing = this.actions.get(definition.id);
    if (existing && existing !== definition) {
      throw new Error(`action ${definition.id} is already registered`);
    }
    this.actions.set(definition.id, definition);
    return definition;
  }

  get(id: ActionId): ActionDefinition | undefined {
    return this.actions.get(id);
  }

  list(): ActionDefinition[] {
    return [...this.actions.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
}

/** Process-wide registry: action definitions are static module metadata, not per-request state. */
export const actionRegistry = new ActionRegistry();

export function defineActions<
  const T extends Record<string, Omit<ActionDefinition, 'id'> & { id: ActionId }>,
>(definitions: T): { [K in keyof T]: ActionDefinition & { id: T[K]['id'] } } {
  const out = {} as { [K in keyof T]: ActionDefinition & { id: T[K]['id'] } };
  for (const key of Object.keys(definitions) as (keyof T)[]) {
    const definition = definitions[key];
    if (!definition) continue;
    out[key] = actionRegistry.register(definition) as ActionDefinition & {
      id: T[typeof key]['id'];
    };
  }
  return out;
}
