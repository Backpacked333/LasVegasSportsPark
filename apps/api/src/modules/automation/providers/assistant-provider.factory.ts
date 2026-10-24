import type { AppConfig } from '../../../kernel';
import type { AutomationSettings } from '../automation.settings';
import {
  AssistantProviderError,
  type AssistantProviderPort,
} from '../ports/assistant-provider.port';
import { FakeAssistantProvider } from './fake-assistant.provider';

/** Answers every turn with a failure: production with the assistant disabled has no provider. */
const NO_PROVIDER: AssistantProviderPort = {
  name: 'none',
  respond: async () => {
    throw new AssistantProviderError('failed', 'No assistant provider is selected.');
  },
};

/**
 * The provider behind the assistant is a provider-selection gate (§5.2, DEC-013): only the
 * deterministic fake exists, and it is refused in production. Enabling the assistant in production
 * without a selected provider stops the process at startup, like the kernel's identity gate.
 */
export function assistantProviderFor(
  config: AppConfig,
  settings: AutomationSettings,
): AssistantProviderPort {
  if (config.NODE_ENV === 'production') {
    if (settings.enabled) {
      throw new Error(
        'AUTOMATION_ENABLED=true but no assistant provider has been selected (specification §5.2, decision DEC-013). ' +
          'Record the decision in docs/package-a/decision-register.md and implement an adapter behind AssistantProviderPort.',
      );
    }
    return NO_PROVIDER;
  }
  return new FakeAssistantProvider();
}
