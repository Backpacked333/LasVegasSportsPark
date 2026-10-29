import { Inject, Module, type OnModuleInit, type Provider } from '@nestjs/common';
import type { EventPayload } from '@sportspark/contracts';
import {
  APP_CONFIG,
  EventHandlerRegistry,
  INTEGRATION_REGISTRY,
  MODULE_SETTINGS,
  PeriodicJobRegistry,
  moduleSettings,
  runWithTransaction,
  type AppConfig,
  type IntegrationRegistryPort,
} from '../../kernel';
import { CatalogModule } from '../catalog';
import { CommunicationsModule } from '../communications';
import { CompetitionModule } from '../competition';
import { FinanceModule } from '../finance';
import { IdentityModule } from '../identity';
import { ReportingModule } from '../reporting';
import { SchedulingModule } from '../scheduling';
import { SupportModule } from '../support';
import { RecommendationExpiryDue } from './automation.events';
import {
  AUTOMATION_SETTINGS,
  AutomationModuleSettings,
  toAutomationSettings,
  type AutomationModuleSettingsValue,
  type AutomationSettings,
} from './automation.settings';
import { AssistantController } from './controllers/assistant.controller';
import { AutomationEnabledGuard } from './controllers/automation-enabled.guard';
import { RecommendationsController } from './controllers/recommendations.controller';
import {
  ASSISTANT_PROVIDER_PORT,
  type AssistantProviderPort,
} from './ports/assistant-provider.port';
import { assistantProviderFor } from './providers/assistant-provider.factory';
import {
  FAKE_ASSISTANT_SCENARIOS,
  FakeAssistantProvider,
} from './providers/fake-assistant.provider';
import { AssistantEngine } from './services/assistant-engine.service';
import { AssistantService, FAIL_STALLED_REQUESTS_JOB } from './services/assistant.service';
import { RecommendationsService } from './services/recommendations.service';
import { ToolRunner } from './services/tool-runner.service';
import { CommandTools } from './tools/command-tools';
import { QueryTools } from './tools/query-tools';
import { ToolRegistry } from './tools/tool-registry';

/** AUT-01 (§5.1, §5.2): the integration register entry of the assistant provider port. */
export const ASSISTANT_INTEGRATION_ID = 'automation.assistant_provider';

const providers: Provider[] = [
  // K-15, IF-43: the AUTOMATION_* section of the kernel configuration, validated at boot.
  moduleSettings(AutomationModuleSettings.module),
  {
    provide: AUTOMATION_SETTINGS,
    inject: [MODULE_SETTINGS(AutomationModuleSettings.module)],
    useFactory: (section: AutomationModuleSettingsValue): AutomationSettings =>
      toAutomationSettings(section),
  },
  {
    provide: ASSISTANT_PROVIDER_PORT,
    inject: [APP_CONFIG, AUTOMATION_SETTINGS],
    useFactory: (config: AppConfig, settings: AutomationSettings) =>
      assistantProviderFor(config, settings),
  },
  QueryTools,
  CommandTools,
  ToolRegistry,
  ToolRunner,
  AssistantEngine,
  RecommendationsService,
  AssistantService,
  AutomationEnabledGuard,
];

/**
 * AutomationModule (specification §3.21 SPK-AUTO-001..005, §4.2 "Automation: reviewable
 * recommendations", SPK-AT-026). The optional assistant: it answers with the caller's own
 * permissions through the owning modules' exported services (identity, scheduling, competition,
 * catalog, finance, communications, support, reporting), names its evidence with freshness and
 * keeps missing evidence visible, and turns consequential changes into recommendations a person
 * approves and applies through the owning module's normal command with their own principal.
 * It depends on the other modules; none depends on it (SPK-AUTO-005): it is last in
 * DOMAIN_MODULES, registers no port or handler another module consumes, and is inert while
 * AUTOMATION_ENABLED is false. Per organization, the capability switch `assistant` (DEC-016)
 * decides whether new requests, approvals and applies are accepted (AUT-02).
 */
@Module({
  imports: [
    IdentityModule,
    CatalogModule,
    SchedulingModule,
    CompetitionModule,
    CommunicationsModule,
    FinanceModule,
    SupportModule,
    ReportingModule,
  ],
  providers,
  controllers: [AssistantController, RecommendationsController],
  exports: [AUTOMATION_SETTINGS, ASSISTANT_PROVIDER_PORT, AssistantService, RecommendationsService],
})
export class AutomationModule implements OnModuleInit {
  constructor(
    private readonly registry: EventHandlerRegistry,
    private readonly recommendations: RecommendationsService,
    private readonly assistant: AssistantService,
    private readonly periodicJobs: PeriodicJobRegistry,
    @Inject(INTEGRATION_REGISTRY) private readonly integrations: IntegrationRegistryPort,
    @Inject(ASSISTANT_PROVIDER_PORT) private readonly provider: AssistantProviderPort,
  ) {}

  onModuleInit(): void {
    // AUT-01 (§5.1, §5.2, DEC-013): the adapter behind ASSISTANT_PROVIDER_PORT, listed whether or
    // not the assistant is enabled, so the register states which adapter would answer. Only the
    // deterministic fake exists and production refuses it; in production the port is the
    // no-provider stand-in, which is no adapter, so the gate lists none (pending DEC-013).
    if (this.provider instanceof FakeAssistantProvider) {
      this.integrations.register({
        id: ASSISTANT_INTEGRATION_ID,
        gate: 'assistant',
        port: 'ASSISTANT_PROVIDER_PORT',
        adapter: { name: this.provider.name, kind: 'fake' },
        productionAllowed: false,
        scenarios: [...FAKE_ASSISTANT_SCENARIOS],
        reconciliationOwner: 'system_administrator',
      });
    }
    // AUT-03 (§4.12, IF-24): a request whose process stopped mid-request is failed with its
    // operation, one transaction each. Not gated by the deployment flag or the capability: it only
    // ends this module's own records.
    this.periodicJobs.register({
      name: FAIL_STALLED_REQUESTS_JOB,
      intervalSeconds: 300,
      failureOwner: 'system_administrator',
      run: (context) => this.assistant.failStalled(context),
    });
    // The expiry timer only touches automation's own table, so it runs even while disabled:
    // proposals made while the assistant was on still expire.
    this.registry.on<EventPayload<typeof RecommendationExpiryDue>>(
      RecommendationExpiryDue.type,
      'automation.expire_recommendation',
      (event, ctx) =>
        runWithTransaction(ctx.trx, () => this.recommendations.onExpiryDue(ctx.trx, event)),
    );
  }
}
