export * from './automation.module';
export * from './automation.actions';
export * from './automation.events';
export * from './automation.machines';
export * from './automation.settings';
export * from './ports/assistant-provider.port';
export {
  FakeAssistantProvider,
  FAKE_ASSISTANT_PROVIDER_NAME,
  type FakeAssistantStep,
  type FakeFailure,
} from './providers/fake-assistant.provider';
export { assistantProviderFor } from './providers/assistant-provider.factory';
export { AssistantService } from './services/assistant.service';
export { RecommendationsService } from './services/recommendations.service';
export {
  evidenceItem,
  freshnessOf,
  missingEvidence,
  type EvidenceBasis,
  type EvidenceDraft,
} from './evidence';
export * from './testing/automation-fixtures';
