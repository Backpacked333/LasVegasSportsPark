import { Inject, Injectable, type CanActivate } from '@nestjs/common';
import { AUTOMATION_SETTINGS, type AutomationSettings } from '../automation.settings';
import { automationUnavailable } from '../automation.shared';

/**
 * SPK-AUTO-005: while the optional assistant is disabled (AUTOMATION_ENABLED, default false) every
 * automation endpoint answers INTEGRATION_UNAVAILABLE before any validation, idempotency claim or
 * database access (controller guards run after authentication and before interceptors). No other
 * module depends on this one, so core operations are unaffected.
 */
@Injectable()
export class AutomationEnabledGuard implements CanActivate {
  constructor(@Inject(AUTOMATION_SETTINGS) private readonly settings: AutomationSettings) {}

  canActivate(): boolean {
    if (!this.settings.enabled) throw automationUnavailable();
    return true;
  }
}
