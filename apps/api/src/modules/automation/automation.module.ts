import { Module, type OnModuleInit, type Provider } from '@nestjs/common';
import type { EventPayload } from '@sportspark/contracts';
import { APP_CONFIG, EventHandlerRegistry, runWithTransaction, type AppConfig } from '../../kernel';
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
  loadAutomationSettings,
  type AutomationSettings,
} from './automation.settings';
import { AssistantController } from './controllers/assistant.controller';
import { AutomationEnabledGuard } from './controllers/automation-enabled.guard';
import { RecommendationsController } from './controllers/recommendations.controller';
import { ASSISTANT_PROVIDER_PORT } from './ports/assistant-provider.port';
import { assistantProviderFor } from './providers/assistant-provider.factory';
import { AssistantEngine } from './services/assistant-engine.service';
import { AssistantService } from './services/assistant.service';
import { RecommendationsService } from './services/recommendations.service';
import { ToolRunner } from './services/tool-runner.service';
import { CommandTools } from './tools/command-tools';
import { QueryTools } from './tools/query-tools';
import { ToolRegistry } from './tools/tool-registry';

const providers: Provider[] = [
  { provide: AUTOMATION_SETTINGS, useFactory: (): AutomationSettings => loadAutomationSettings() },
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
 * AUTOMATION_ENABLED is false.
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
  ) {}

  onModuleInit(): void {
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
