import { Inject, Injectable } from '@nestjs/common';
import {
  CurrencyCode,
  defineEvent,
  errors,
  z,
  type OrganizationProfile,
  type Principal,
  type SetDefaultCurrencyInput,
} from '@sportspark/contracts';
import type { Db } from '@sportspark/db';
import { AuditWriter } from '../audit/audit.writer';
import { AuthorizationService } from '../authorization/authorization.service';
import { CoreActions } from '../authorization/core-actions';
import { UnitOfWork, type Trx } from '../database/unit-of-work';
import { Outbox } from '../outbox/outbox';
import { DATABASE } from '../tokens';

/** SPK-PAY-001: the organization default currency was set (no money record changes). */
export const OrganizationDefaultCurrencySet = defineEvent(
  'core.organization_default_currency_set',
  z.object({ defaultCurrency: CurrencyCode, previousCurrency: CurrencyCode.nullable() }),
);

function organizationOf(principal: Principal): string {
  if (principal.kind === 'anonymous' || !principal.organizationId) {
    throw errors.authenticationRequired();
  }
  return principal.organizationId;
}

/**
 * The organization profile and its default currency (migration 0018; SPK-PAY-001, §2.1
 * configuration). Every signed-in principal reads the profile (its name and default currency are
 * not customer-private). Only a system administrator sets the currency (`core.set_default_currency`,
 * matching the Proposed `core.manage_organization_settings` row of the permission matrix), with the
 * organization's expected revision and a reason (§4.9). The default is a display and entry default:
 * no money record is converted or relabelled, and every amount keeps the currency it was stored
 * with. Until it is set the read answers null, and nothing assumes a currency in its place.
 */
@Injectable()
export class OrganizationSettingsService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
  ) {}

  /** The default currency of an organization, or null while it is not configured. */
  async defaultCurrency(organizationId: string, db: Db | Trx = this.db): Promise<string | null> {
    const row = await db
      .selectFrom('organizations')
      .select('default_currency')
      .where('id', '=', organizationId)
      .executeTakeFirst();
    return row?.default_currency ?? null;
  }

  async profile(principal: Principal): Promise<OrganizationProfile> {
    const organizationId = organizationOf(principal);
    const row = await this.db
      .selectFrom('organizations')
      .select(['id', 'name', 'default_currency', 'revision'])
      .where('id', '=', organizationId)
      .executeTakeFirst();
    if (!row) throw errors.notFound('organization');
    return {
      id: row.id,
      name: row.name,
      defaultCurrency: row.default_currency,
      revision: row.revision,
    };
  }

  async setDefaultCurrency(
    principal: Principal,
    input: SetDefaultCurrencyInput,
    correlationId: string | null,
  ): Promise<OrganizationProfile> {
    const organizationId = organizationOf(principal);
    await this.uow.run(async ({ trx }) => {
      await this.authorization.require(principal, CoreActions.setDefaultCurrency, {
        type: 'organization_settings',
        id: organizationId,
        organizationId,
      });
      const current = await trx
        .selectFrom('organizations')
        .select(['default_currency', 'revision'])
        .where('id', '=', organizationId)
        .forUpdate()
        .executeTakeFirst();
      if (!current) throw errors.notFound('organization');
      if (input.expectedRevision !== current.revision) {
        throw errors.staleRevision(input.expectedRevision, current.revision);
      }
      if (current.default_currency === input.currency) return; // setting the same value is not a change
      const revision = current.revision + 1;
      await trx
        .updateTable('organizations')
        .set({ default_currency: input.currency, revision })
        .where('id', '=', organizationId)
        .where('revision', '=', current.revision)
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: CoreActions.setDefaultCurrency.id,
        targetType: 'organization_settings',
        targetId: organizationId,
        beforeRevision: current.revision,
        afterRevision: revision,
        reason: input.reason,
        correlationId,
        details: { defaultCurrency: input.currency, previousCurrency: current.default_currency },
      });
      await this.outbox.enqueue(trx, OrganizationDefaultCurrencySet, {
        organizationId,
        aggregateType: 'organization',
        aggregateId: organizationId,
        payload: { defaultCurrency: input.currency, previousCurrency: current.default_currency },
        correlationId,
      });
    });
    return this.profile(principal);
  }
}
