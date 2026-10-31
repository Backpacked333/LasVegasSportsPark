import { createHash } from 'node:crypto';
import {
  applyDecorators,
  Inject,
  Injectable,
  Logger,
  SetMetadata,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import {
  DomainError,
  IDEMPOTENCY_KEY_HEADER,
  IdempotencyKey,
  errors,
  newId,
  type ErrorResponseBody,
} from '@sportspark/contracts';
import { json, type Db } from '@sportspark/db';
import type { Response } from 'express';
import { sql } from 'kysely';
import { from, of, throwError, type Observable } from 'rxjs';
import { catchError, finalize, mergeMap } from 'rxjs/operators';
import type { Clock } from '../clock';
import type { AppConfig } from '../config';
import { withCommitFence, type CommitFence } from '../database/commit-fence';
import { APP_CONFIG, CLOCK, DATABASE } from '../tokens';
import { toErrorResponse } from './domain-exception.filter';
import type { RequestWithContext } from './request-context';

export const IDEMPOTENT_KEY = 'sportspark:idempotent';
export const IDEMPOTENT_WITHHOLD_KEY = 'sportspark:idempotent-withhold';

export interface IdempotentOptions {
  /**
   * Top-level response fields that carry a one-time secret, which the owning module stores only as
   * a hash (an invitation, claim, export download or calendar feed token, or a path embedding one).
   * The original response carries them, but they are never stored with the key, so the idempotency
   * store holds no usable credential at rest (§4.14 protected secret storage). A replay answers
   * IDEMPOTENCY_SECRET_WITHHELD naming the created record instead of returning a success body that
   * lacks its secret; the client revokes and reissues to obtain a new one.
   */
  withhold?: readonly string[];
}

/** Marks a command handler as requiring an `Idempotency-Key` header (§4.9). */
export const Idempotent = (options: IdempotentOptions = {}) =>
  applyDecorators(
    SetMetadata(IDEMPOTENT_KEY, true),
    SetMetadata(IDEMPOTENT_WITHHOLD_KEY, options.withhold ?? []),
  );

type ClaimOutcome =
  | { kind: 'claimed'; token: string }
  | { kind: 'in_progress' }
  | { kind: 'conflict' }
  | { kind: 'outcome_unavailable'; operationId: string | null }
  | { kind: 'replay'; status: number; body: unknown };

interface ClaimRef {
  organizationId: string;
  scopeKey: string;
  key: string;
  token: string;
}

/** Stable hash of a JSON value regardless of key order. */
export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);
  return `{${entries.join(',')}}`;
}

/**
 * Idempotency for consequential commands (§4.9): the same key with the same payload replays the
 * stored response; the same key with a different payload is a conflict; a key still executing is
 * reported as in progress. Stored responses expire after IDEMPOTENCY_TTL_HOURS.
 *
 * The record follows the business transaction (§4.7 invariant 5):
 * - Every `UnitOfWork` transaction inside the handler marks the key `committed_at` atomically with
 *   its own commit (a commit fence), and rolls back if a retry has taken the key over.
 * - Domain (4xx) outcomes are stored. An unexpected (5xx) failure releases the key only when nothing
 *   committed during the request; after a commit it is stored and replayed, never re-executed.
 * - A failure storing the response leaves the key claimed. A claim is a lease
 *   (IDEMPOTENCY_LEASE_SECONDS): once it lapses, a retry takes the key over only when nothing
 *   committed, and otherwise gets IDEMPOTENCY_OUTCOME_UNAVAILABLE instead of running the command again.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    @Inject(DATABASE) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const idempotent = this.reflector.getAllAndOverride<boolean>(IDEMPOTENT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!idempotent) return next.handle();
    const withhold =
      this.reflector.get<readonly string[] | undefined>(
        IDEMPOTENT_WITHHOLD_KEY,
        context.getHandler(),
      ) ?? [];

    const request = context.switchToHttp().getRequest<RequestWithContext>();
    const response = context.switchToHttp().getResponse<Response>();
    const principal = request.principal;
    if (!principal || principal.kind === 'anonymous' || !principal.organizationId) {
      throw errors.authenticationRequired();
    }
    const organizationId = principal.organizationId;
    const rawKey = request.headers[IDEMPOTENCY_KEY_HEADER];
    const parsedKey = IdempotencyKey.safeParse(Array.isArray(rawKey) ? rawKey[0] : rawKey);
    if (!parsedKey.success) {
      throw errors.validation(
        'An Idempotency-Key header (8-128 characters) is required for this command.',
      );
    }
    const key = parsedKey.data;
    const scopeKey = principal.accountId
      ? `account:${principal.accountId}`
      : `${principal.kind}:${principal.actorLabel}`;
    const requestHash = canonicalHash({
      method: request.method,
      path: request.originalUrl.split('?')[0],
      body: request.body ?? null,
    });

    const outcome = await this.claim(organizationId, scopeKey, key, requestHash);
    switch (outcome.kind) {
      case 'replay': {
        response.setHeader('Idempotent-Replayed', 'true');
        if (withhold.length > 0 && outcome.status < 300) {
          // §4.9 still holds (the command is not run again and the record is named), but the
          // one-time secret was never stored (§4.14).
          const stored = outcome.body as { id?: unknown } | null;
          throw errors.idempotencySecretWithheld({
            resourceId: typeof stored?.id === 'string' ? stored.id : null,
          });
        }
        response.status(outcome.status);
        const body = outcome.body;
        if (body && typeof body === 'object' && 'correlationId' in body && 'code' in body) {
          return of({ ...(body as Record<string, unknown>), correlationId: request.correlationId });
        }
        return of(body);
      }
      case 'in_progress':
        throw errors.idempotencyInProgress();
      case 'conflict':
        throw errors.idempotencyConflict();
      case 'outcome_unavailable':
        throw errors.idempotencyOutcomeUnavailable(
          outcome.operationId ? { operationId: outcome.operationId } : undefined,
        );
      case 'claimed':
        break;
    }
    const claim: ClaimRef = { organizationId, scopeKey, key, token: outcome.token };

    const successStatus =
      this.reflector.get<number | undefined>(HTTP_CODE_METADATA, context.getHandler()) ??
      (request.method === 'POST' ? 201 : 200);

    // Nest binds the handler to the async context `handle()` is called in, so the fence reaches
    // every UnitOfWork the handler runs.
    const fenced = withCommitFence(this.fenceFor(claim), () => next.handle());
    let handlerSucceeded = false;
    return fenced.result.pipe(
      mergeMap((body: unknown) => {
        handlerSucceeded = true;
        fenced.close();
        return from(this.complete(claim, successStatus, withholdFields(body, withhold))).pipe(
          mergeMap(() => of(body)),
        );
      }),
      catchError((error: unknown) => {
        fenced.close();
        if (handlerSucceeded) {
          // The command finished but its response could not be stored. Releasing the key would
          // let a retry run it again, so the key stays claimed until its lease lapses.
          this.logger.error(`could not store the response for idempotency key: ${String(error)}`);
          return throwError(() => error);
        }
        const { status, body } = toErrorResponse(error, request.correlationId);
        if (DomainError.is(error) && error.httpStatus < 500) {
          return from(
            this.complete(claim, status, body).catch((settleError: unknown) => {
              this.logger.error(`could not settle idempotency key: ${String(settleError)}`);
            }),
          ).pipe(mergeMap(() => throwError(() => error)));
        }
        return from(
          this.settleUnexpected(claim, status, body).catch((settleError: unknown) => {
            this.logger.error(`could not settle idempotency key: ${String(settleError)}`);
            return { body, operationId: null };
          }),
        ).pipe(
          mergeMap((settled) =>
            throwError(() =>
              settled.operationId ? this.withOperation(error, settled.body, request) : error,
            ),
          ),
        );
      }),
      finalize(() => fenced.close()),
    );
  }

  /**
   * The commit fence for one claimed request: inside each transaction that wrote something, mark the
   * key committed, which also proves the claim is still this request's. Read-only transactions
   * are not marked, so a request that only read can still be retried.
   */
  private fenceFor(claim: ClaimRef): CommitFence {
    let committed = false;
    return {
      linkOperation: async (trx, operationId, options) => {
        // A key taken over by a retry matches nothing here; beforeCommit then rolls this back.
        await trx
          .updateTable('idempotency_keys')
          .set({
            operation_id: options?.primary
              ? operationId
              : sql<string>`coalesce(operation_id, ${operationId}::uuid)`,
          })
          .where('organization_id', '=', claim.organizationId)
          .where('scope_key', '=', claim.scopeKey)
          .where('idempotency_key', '=', claim.key)
          .where('claim_token', '=', claim.token)
          .execute();
      },
      beforeCommit: async (trx) => {
        if (committed) return undefined;
        const wrote = await sql<{
          wrote: boolean;
        }>`select pg_current_xact_id_if_assigned() is not null as wrote`.execute(trx);
        if (!wrote.rows[0]?.wrote) return undefined;
        const marked = await trx
          .updateTable('idempotency_keys')
          .set({ committed_at: sql`coalesce(committed_at, ${this.clock.now()})` })
          .where('organization_id', '=', claim.organizationId)
          .where('scope_key', '=', claim.scopeKey)
          .where('idempotency_key', '=', claim.key)
          .where('claim_token', '=', claim.token)
          .returning('idempotency_key')
          .executeTakeFirst();
        // A retry took the key over after this request's lease lapsed: roll back, so at most one
        // execution commits.
        if (!marked) throw errors.idempotencyInProgress();
        return () => {
          committed = true;
        };
      },
    };
  }

  private async claim(
    organizationId: string,
    scopeKey: string,
    key: string,
    requestHash: string,
  ): Promise<ClaimOutcome> {
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + this.config.IDEMPOTENCY_TTL_HOURS * 3600_000);
    const leaseUntil = new Date(now.getTime() + this.config.IDEMPOTENCY_LEASE_SECONDS * 1000);
    const token = newId();
    return this.db.transaction().execute(async (trx) => {
      await trx
        .deleteFrom('idempotency_keys')
        .where('organization_id', '=', organizationId)
        .where('scope_key', '=', scopeKey)
        .where('idempotency_key', '=', key)
        .where('expires_at', '<', now)
        .execute();
      const inserted = await trx
        .insertInto('idempotency_keys')
        .values({
          organization_id: organizationId,
          scope_key: scopeKey,
          idempotency_key: key,
          request_hash: requestHash,
          status: 'in_progress',
          response_status: null,
          response_body: null,
          operation_id: null,
          completed_at: null,
          expires_at: expiresAt,
          claim_token: token,
          locked_until: leaseUntil,
          committed_at: null,
        })
        .onConflict((oc) =>
          oc.columns(['organization_id', 'scope_key', 'idempotency_key']).doNothing(),
        )
        .returning('idempotency_key')
        .executeTakeFirst();
      if (inserted) return { kind: 'claimed', token };
      const existing = await trx
        .selectFrom('idempotency_keys')
        .select([
          'request_hash',
          'status',
          'response_status',
          'response_body',
          'operation_id',
          'claim_token',
          'locked_until',
          'committed_at',
        ])
        .where('organization_id', '=', organizationId)
        .where('scope_key', '=', scopeKey)
        .where('idempotency_key', '=', key)
        .forUpdate()
        .executeTakeFirst();
      if (!existing) return { kind: 'in_progress' };
      if (existing.request_hash !== requestHash) return { kind: 'conflict' };
      if (existing.status === 'completed') {
        return {
          kind: 'replay',
          status: existing.response_status ?? 200,
          body: existing.response_body,
        };
      }
      // The claiming request may still be running (also after committing a first step).
      if (existing.locked_until === null || new Date(existing.locked_until) > now) {
        return { kind: 'in_progress' };
      }
      // Its lease lapsed after it committed changes but before its response was stored: running
      // the command again could repeat its effect.
      if (existing.committed_at !== null) {
        return { kind: 'outcome_unavailable', operationId: existing.operation_id };
      }
      // The claiming request stopped before committing anything and its lease lapsed: take over.
      const taken = await trx
        .updateTable('idempotency_keys')
        .set({ claim_token: token, locked_until: leaseUntil, expires_at: expiresAt })
        .where('organization_id', '=', organizationId)
        .where('scope_key', '=', scopeKey)
        .where('idempotency_key', '=', key)
        .where('status', '=', 'in_progress')
        .where('committed_at', 'is', null)
        .where(sql<boolean>`claim_token is not distinct from ${existing.claim_token}`)
        .returning('idempotency_key')
        .executeTakeFirst();
      return taken ? { kind: 'claimed', token } : { kind: 'in_progress' };
    });
  }

  /** Stores the outcome for replay; a no-op when the claim is no longer this request's. */
  private async complete(claim: ClaimRef, status: number, body: unknown): Promise<void> {
    await this.db
      .updateTable('idempotency_keys')
      .set({
        status: 'completed',
        response_status: status,
        response_body: body === undefined ? null : json(body as object),
        completed_at: this.clock.now(),
      })
      .where('organization_id', '=', claim.organizationId)
      .where('scope_key', '=', claim.scopeKey)
      .where('idempotency_key', '=', claim.key)
      .where('claim_token', '=', claim.token)
      .execute();
  }

  /**
   * An unexpected (5xx) failure: when the request committed changes, store the error for replay so
   * a retry never runs the command again; otherwise release the key so the client can retry.
   * `committed_at` was written in the business transaction itself, so this decision follows what
   * actually committed, even when a commit acknowledgement was lost.
   */
  private async settleUnexpected(
    claim: ClaimRef,
    status: number,
    body: ErrorResponseBody,
  ): Promise<{ body: ErrorResponseBody; operationId: string | null }> {
    return this.db.transaction().execute(async (trx) => {
      const key = await trx
        .selectFrom('idempotency_keys')
        .select(['operation_id', 'committed_at'])
        .where('organization_id', '=', claim.organizationId)
        .where('scope_key', '=', claim.scopeKey)
        .where('idempotency_key', '=', claim.key)
        .where('claim_token', '=', claim.token)
        .where('status', '=', 'in_progress')
        .forUpdate()
        .executeTakeFirst();
      if (key?.committed_at) {
        // §4.9: the stored error (and its replays) names the operation the command started, which
        // records the real outcome, so the client can poll it instead of retrying blind.
        const stored = key.operation_id ? withOperationDetails(body, key.operation_id) : body;
        await trx
          .updateTable('idempotency_keys')
          .set({
            status: 'completed',
            response_status: status,
            response_body: json(stored),
            completed_at: this.clock.now(),
          })
          .where('organization_id', '=', claim.organizationId)
          .where('scope_key', '=', claim.scopeKey)
          .where('idempotency_key', '=', claim.key)
          .where('claim_token', '=', claim.token)
          .execute();
        return { body: stored, operationId: key.operation_id };
      }
      await trx
        .deleteFrom('idempotency_keys')
        .where('organization_id', '=', claim.organizationId)
        .where('scope_key', '=', claim.scopeKey)
        .where('idempotency_key', '=', claim.key)
        .where('claim_token', '=', claim.token)
        .where('status', '=', 'in_progress')
        .where('committed_at', 'is', null)
        .execute();
      return { body, operationId: null };
    });
  }

  /**
   * The error the first response carries once the key names an operation: the same code, status and
   * message as the stored body, with the operation reference, so the first response and its replays
   * agree. The original error is logged here because the filter only sees its replacement.
   */
  private withOperation(
    original: unknown,
    body: ErrorResponseBody,
    request: RequestWithContext,
  ): DomainError {
    const err = original instanceof Error ? original : new Error(String(original));
    this.logger.error(
      `[${request.correlationId}] failed after committing operation work: ${err.message}`,
      err.stack,
    );
    return new DomainError(body.code, body.message, {
      details: body.details,
      nextAction: body.nextAction,
      cause: original,
    });
  }
}

/** A copy of a success body without its one-time secret fields, for storage. */
function withholdFields(body: unknown, fields: readonly string[]): unknown {
  if (fields.length === 0 || !body || typeof body !== 'object' || Array.isArray(body)) return body;
  const stored: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  for (const field of fields) delete stored[field];
  return stored;
}

/** Adds `operationId` to an error body's details (merged into object details). */
function withOperationDetails(body: ErrorResponseBody, operationId: string): ErrorResponseBody {
  const details =
    body.details && typeof body.details === 'object' && !Array.isArray(body.details)
      ? { ...(body.details as Record<string, unknown>), operationId }
      : body.details === undefined
        ? { operationId }
        : { operationId, details: body.details };
  return { ...body, details };
}
