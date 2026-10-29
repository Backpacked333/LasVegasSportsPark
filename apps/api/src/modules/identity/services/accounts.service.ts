import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  type Account,
  type CreateAccountInput,
  type Principal,
  type RelinkAccountInput,
} from '@sportspark/contracts';
import { isUniqueViolation, pgConstraintName, type Db } from '@sportspark/db';
import {
  APP_CONFIG,
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  IDENTITY_PROVIDER,
  LocalJwtIdentityProvider,
  Outbox,
  UnitOfWork,
  assertExpectedRevision,
  type AppConfig,
  type Clock,
  type IdentityProviderPort,
} from '../../../kernel';
import { IdentityActions } from '../identity.actions';
import { runInTransaction } from '../identity.transaction-context';
import { IdentityEvents } from '../identity.events';
import { requireStaffLoginAuthority, toAccount } from '../identity.shared';

/**
 * Login accounts (SPK-IAM-002, SPK-AT-025). An account is the link between a provider identity
 * and at most one person. Recovery changes the provider identity only: it never creates, restores
 * or widens access grants, so a recovered account has exactly the verified access it had before.
 */
@Injectable()
export class AccountsService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(IDENTITY_PROVIDER) private readonly identityProvider: IdentityProviderPort,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
  ) {}

  async createAccount(
    principal: Principal,
    input: CreateAccountInput,
    correlationId: string | null,
  ): Promise<Account> {
    const organizationId = principal.organizationId;
    if (!organizationId) throw errors.authenticationRequired();
    await this.authorization.require(principal, IdentityActions.manageAccount, {
      type: 'account',
      organizationId,
    });
    return runInTransaction(this.uow, async ({ trx }) => {
      if (input.personId) {
        const person = await trx
          .selectFrom('persons')
          .select(['status'])
          .where('organization_id', '=', organizationId)
          .where('id', '=', input.personId)
          .executeTakeFirst();
        if (!person) throw errors.notFound('person', input.personId);
        if (person.status !== 'active') {
          throw errors.invalidTransition('Person', person.status, 'link_account');
        }
        // §4.14, SPK-AT-025: provisioning the login of a staff person needs staff-role authority.
        await requireStaffLoginAuthority(
          this.authorization,
          trx,
          principal,
          organizationId,
          input.personId,
          this.clock.now(),
        );
      }
      const id = newId();
      try {
        await trx
          .insertInto('accounts')
          .values({
            id,
            organization_id: organizationId,
            issuer: input.issuer,
            subject: input.subject,
            person_id: input.personId ?? null,
            last_login_at: null,
            disabled_at: null,
            disabled_reason: null,
          })
          .execute();
      } catch (error) {
        if (isUniqueViolation(error)) throw this.conflict(error);
        throw error;
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: IdentityActions.manageAccount.id,
        targetType: 'account',
        targetId: id,
        afterRevision: 1,
        reason: input.reason ?? null,
        correlationId,
        details: {
          operation: 'create',
          issuer: input.issuer,
          subject: input.subject,
          personId: input.personId ?? null,
        },
      });
      if (input.personId) {
        await this.outbox.enqueue(trx, IdentityEvents.accountLinked, {
          organizationId,
          aggregateType: 'account',
          aggregateId: id,
          payload: { accountId: id, personId: input.personId, via: 'staff' },
          correlationId,
        });
      }
      const row = await trx
        .selectFrom('accounts')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      return toAccount(row);
    });
  }

  /**
   * SPK-AT-025: account recovery re-links the same account to a new provider identity. Grants,
   * relationships and staff memberships are untouched; only the verified prior access is restored.
   */
  async relinkAccount(
    principal: Principal,
    id: string,
    input: RelinkAccountInput,
    correlationId: string | null,
  ): Promise<Account> {
    const organizationId = principal.organizationId;
    if (!organizationId) throw errors.authenticationRequired();
    await this.authorization.require(principal, IdentityActions.manageAccount, {
      type: 'account',
      id,
      organizationId,
    });
    return runInTransaction(this.uow, async ({ trx }) => {
      const current = await trx
        .selectFrom('accounts')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .executeTakeFirst();
      if (!current) throw errors.notFound('account', id);
      // §4.14, SPK-AT-025: recovering the login of a person who holds a staff membership needs the
      // authority that assigns staff roles; support recovers customer accounts only. Verification
      // evidence, rate limits and a second approver remain pending (DEC-018, DEC-091).
      await requireStaffLoginAuthority(
        this.authorization,
        trx,
        principal,
        organizationId,
        current.person_id,
        this.clock.now(),
      );
      assertExpectedRevision(input.expectedRevision, current.revision);
      // Recovery restores only the prior access: a disabled account (disabled by a merge, or by
      // staff) is not re-activated by pointing it at another provider identity.
      if (current.status !== 'active') {
        throw errors.invalidTransition('Account', current.status, 'relink');
      }
      try {
        await trx
          .updateTable('accounts')
          .set({
            issuer: input.issuer,
            subject: input.subject,
            revision: current.revision + 1,
          })
          .where('id', '=', id)
          .where('revision', '=', current.revision)
          .execute();
      } catch (error) {
        if (isUniqueViolation(error)) throw this.conflict(error);
        throw error;
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: IdentityActions.manageAccount.id,
        targetType: 'account',
        targetId: id,
        beforeRevision: current.revision,
        afterRevision: current.revision + 1,
        reason: input.reason,
        correlationId,
        // The trail names which provider identity received the account (§4.14 audited actions).
        details: {
          operation: 'relink',
          previousIssuer: current.issuer,
          previousSubject: current.subject,
          issuer: input.issuer,
          subject: input.subject,
        },
      });
      await this.outbox.enqueue(trx, IdentityEvents.accountRelinked, {
        organizationId,
        aggregateType: 'account',
        aggregateId: id,
        payload: { accountId: id, personId: current.person_id },
        correlationId,
      });
      const row = await trx
        .selectFrom('accounts')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      return toAccount(row);
    });
  }

  /**
   * Development-only token minting for manual testing. Exists only when the local identity
   * provider is configured outside production; otherwise the route reports NOT_FOUND so the
   * endpoint is indistinguishable from absent (§5.2 security boundary).
   */
  async mintDevToken(input: {
    accountId: string;
    sessionId?: string;
    ttlSeconds?: number;
  }): Promise<{ token: string; accountId: string; expiresAt: string }> {
    if (
      this.config.AUTH_MODE !== 'local' ||
      this.config.NODE_ENV === 'production' ||
      !(this.identityProvider instanceof LocalJwtIdentityProvider)
    ) {
      throw errors.notFound('route');
    }
    const account = await this.db
      .selectFrom('accounts')
      .select(['id', 'issuer', 'subject', 'status'])
      .where('id', '=', input.accountId)
      .executeTakeFirst();
    if (!account || account.status !== 'active') throw errors.notFound('account', input.accountId);
    if (account.issuer !== this.config.AUTH_ISSUER) {
      throw errors.validation('The account belongs to another identity provider.');
    }
    const ttl = input.ttlSeconds ?? this.config.AUTH_TOKEN_TTL_SECONDS;
    const token = await this.identityProvider.mint({
      subject: account.subject,
      sessionId: input.sessionId ?? newId(),
      ttlSeconds: ttl,
    });
    return {
      token,
      accountId: account.id,
      expiresAt: new Date(this.clock.now().getTime() + ttl * 1000).toISOString(),
    };
  }

  private conflict(error: unknown) {
    const constraint = pgConstraintName(error) ?? '';
    if (constraint.includes('one_active_per_person')) {
      return errors.resourceConflict('This person already has an active account.');
    }
    return errors.resourceConflict('An account already exists for this provider identity.');
  }
}
