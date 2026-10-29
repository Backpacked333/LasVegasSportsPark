import { Injectable } from '@nestjs/common';
import {
  errors,
  type Integrations,
  type Principal,
  type ProviderGateValue,
  type StaffRole,
} from '@sportspark/contracts';
import { AuthorizationService } from '../authorization/authorization.service';
import { CoreActions } from '../authorization/core-actions';

/**
 * The integration register (K-09, IF-04; §5.1 integration register, §5.2 provider-selection
 * gates). No provider is selected: every gate is pending its decision, its §5.1 fields stay null
 * and its evidence level is null until the decision is recorded. Modules register the adapters
 * they run (all deterministic fakes today) in `onModuleInit`; a duplicate id throws at startup.
 */
export type ProviderGate = ProviderGateValue;
export type IntegrationScenario = 'success' | 'failure' | 'timeout_unknown' | 'duplicate';

export interface IntegrationRegistration {
  /** `<module>.<port>`, for example `finance.payment_provider`. */
  id: string;
  gate: ProviderGate;
  /** The port the adapter implements (`PAYMENT_PROVIDER_PORT`). */
  port: string;
  adapter: { name: string; kind: 'fake' | 'local' | 'provider' };
  productionAllowed: boolean;
  /** The §5.2 scenarios a fake reproduces deterministically. */
  scenarios: IntegrationScenario[];
  /** The staff queue that reconciles the adapter's outcomes, if any. */
  reconciliationOwner: StaffRole | null;
}

export interface IntegrationRegistryPort {
  register(entry: IntegrationRegistration): void;
  list(): readonly IntegrationRegistration[];
}

export const INTEGRATION_REGISTRY = Symbol('INTEGRATION_REGISTRY');

/** The §5.2 gates and the decision each is pending (decision register, Register B). */
export const PROVIDER_GATES: ReadonlyArray<{ gate: ProviderGate; decisionRef: string }> = [
  { gate: 'identity', decisionRef: 'DEC-018' },
  { gate: 'payments', decisionRef: 'DEC-019' },
  { gate: 'messaging', decisionRef: 'DEC-020' },
  { gate: 'hosting', decisionRef: 'DEC-021' },
  { gate: 'accounting', decisionRef: 'DEC-022' },
  { gate: 'hardware', decisionRef: 'DEC-023' },
  { gate: 'assistant', decisionRef: 'DEC-013' },
];

/** The §5.1 fields of a gate whose decision is pending: all unknown. */
const PENDING_REGISTER = {
  productAndVendor: null,
  accountOwner: null,
  authorizedAccess: null,
  supportedOperations: null,
  sandboxAvailability: null,
  documentation: null,
  eventBehavior: null,
  rateLimits: null,
  idempotency: null,
  failureHandling: null,
  reconciliationOwner: null,
  exitProcedure: null,
} as const;

const ID = /^[a-z]+\.[a-z0-9_]+$/;

@Injectable()
export class IntegrationRegistry implements IntegrationRegistryPort {
  private readonly entries = new Map<string, IntegrationRegistration>();

  constructor(private readonly authorization: AuthorizationService) {}

  register(entry: IntegrationRegistration): void {
    if (!ID.test(entry.id)) {
      throw new Error(`integration id ${entry.id} must read <module>.<port>`);
    }
    if (this.entries.has(entry.id)) {
      throw new Error(`integration ${entry.id} is already registered`);
    }
    if (!PROVIDER_GATES.some((g) => g.gate === entry.gate)) {
      throw new Error(`integration ${entry.id} names unknown gate ${entry.gate}`);
    }
    if (entry.adapter.kind !== 'provider' && entry.productionAllowed) {
      // §5.2: fakes and local adapters never serve production.
      throw new Error(
        `integration ${entry.id}: a ${entry.adapter.kind} adapter is never production-allowed`,
      );
    }
    if (entry.adapter.kind === 'provider') {
      // §5.2: no provider is selected; a provider adapter needs its gate's recorded decision.
      throw new Error(
        `integration ${entry.id}: no provider is selected for gate ${entry.gate} (§5.2); register a fake`,
      );
    }
    if (entry.adapter.kind === 'fake' && entry.scenarios.length === 0) {
      throw new Error(`integration ${entry.id}: a fake adapter lists the scenarios it reproduces`);
    }
    this.entries.set(entry.id, {
      ...entry,
      adapter: { ...entry.adapter },
      scenarios: [...new Set(entry.scenarios)],
    });
  }

  list(): readonly IntegrationRegistration[] {
    return [...this.entries.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** GET /v1/admin/integrations (core.view_integrations). */
  async describe(principal: Principal): Promise<Integrations> {
    if (!principal.organizationId) throw errors.authenticationRequired();
    await this.authorization.require(principal, CoreActions.viewIntegrations, {
      type: 'integration_register',
      organizationId: principal.organizationId,
    });
    const adapters = this.list();
    return {
      gates: PROVIDER_GATES.map(({ gate, decisionRef }) => ({
        gate,
        decisionRef,
        status: 'pending_decision' as const,
        register: { ...PENDING_REGISTER },
        evidenceLevel: null,
        adapters: adapters
          .filter((a) => a.gate === gate)
          .map((a) => ({ ...a, adapter: { ...a.adapter }, scenarios: [...a.scenarios] })),
      })),
    };
  }
}
