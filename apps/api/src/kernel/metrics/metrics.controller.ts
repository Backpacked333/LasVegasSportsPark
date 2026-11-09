import { timingSafeEqual } from 'node:crypto';
import { Controller, Get, Headers, Inject, Res } from '@nestjs/common';
import { errors, type MetricsSnapshot, type Principal } from '@sportspark/contracts';
import type { Response } from 'express';
import { CurrentPrincipal } from '../auth/principal.decorator';
import { Public } from '../auth/public.decorator';
import { AuthorizationService } from '../authorization/authorization.service';
import { CoreActions } from '../authorization/core-actions';
import type { AppConfig } from '../config';
import { AnyClientVersion } from '../http/client-compatibility.guard';
import { APP_CONFIG } from '../tokens';
import { MetricsSnapshotService, toPrometheusText } from './metrics-snapshot.service';

/** The header a metrics scraper sends its token in (not Authorization, which carries identities). */
export const METRICS_TOKEN_HEADER = 'x-metrics-token';

/**
 * §5.11 observability: the kernel's signal snapshot for the organization's managers
 * (`GET /v1/admin/metrics`, core.view_metrics) and, for an infrastructure scraper, the global
 * snapshot in Prometheus text (`GET /v1/metrics`, only when METRICS_TOKEN is configured, with
 * that token in X-Metrics-Token; otherwise it does not exist).
 */
@Controller()
export class MetricsController {
  constructor(
    private readonly metrics: MetricsSnapshotService,
    private readonly authorization: AuthorizationService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('admin/metrics')
  async organizationMetrics(@CurrentPrincipal() principal: Principal): Promise<MetricsSnapshot> {
    if (!principal.organizationId) throw errors.authenticationRequired();
    await this.authorization.require(principal, CoreActions.viewMetrics, {
      type: 'organization_metrics',
      organizationId: principal.organizationId,
    });
    return this.metrics.snapshot(principal.organizationId);
  }

  @Public()
  @AnyClientVersion()
  @Get('metrics')
  async scrape(
    @Headers(METRICS_TOKEN_HEADER) token: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const expected = this.config.METRICS_TOKEN;
    if (!expected) throw errors.notFound('route', 'GET /v1/metrics');
    if (!token || !sameSecret(token, expected)) {
      throw errors.authenticationRequired('The metrics token is missing or wrong.');
    }
    res
      .status(200)
      .type('text/plain; version=0.0.4')
      .send(toPrometheusText(await this.metrics.snapshot(null)));
  }
}

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
