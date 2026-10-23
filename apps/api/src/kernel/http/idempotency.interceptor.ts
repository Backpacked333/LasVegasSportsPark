import { createHash } from 'node:crypto';
import {
  Inject,
  Injectable,
  SetMetadata,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { DomainError, IDEMPOTENCY_KEY_HEADER, IdempotencyKey, errors } from '@sportspark/contracts';
import type { Db } from '@sportspark/db';
import type { Response } from 'express';
import { from, of, throwError, type Observable } from 'rxjs';
import { catchError, mergeMap } from 'rxjs/operators';
import type { Clock } from '../clock';
import type { AppConfig } from '../config';
import { APP_CONFIG, CLOCK, DATABASE } from '../tokens';
import type { RequestWithContext } from './request-context';

export const IDEMPOTENT_KEY = 'sportspark:idempotent';

/** Marks a command handler as requiring an `Idempotency-Key` header (§4.9). */
export const Idempotent = () => SetMetadata(IDEMPOTENT_KEY, true);

type ClaimOutcome =
  | { kind: 'claimed' }
  | { kind: 'in_progress' }
  | { kind: 'conflict' }
  | { kind: 'replay'; status: number; body: unknown };

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
 * Idempotency for consequential commands: the same key with the same payload replays the stored
 * response; the same key with a different payload is a conflict; a key still executing is reported
 * as in progress. Stored responses expire after IDEMPOTENCY_TTL_HOURS.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
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
        response.status(outcome.status);
        response.setHeader('Idempotent-Replayed', 'true');
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
      case 'claimed':
        break;
    }

    const successStatus =
      this.reflector.get<number | undefined>(HTTP_CODE_METADATA, context.getHandler()) ??
      (request.method === 'POST' ? 201 : 200);

    return next.handle().pipe(
      mergeMap((body: unknown) =>
        from(this.complete(organizationId, scopeKey, key, successStatus, body)).pipe(
          mergeMap(() => of(body)),
        ),
      ),
      catchError((error: unknown) => {
        const settle =
          DomainError.is(error) && error.httpStatus < 500
            ? this.complete(
                organizationId,
                scopeKey,
                key,
                error.httpStatus,
                error.toResponseBody(request.correlationId),
              )
            : this.release(organizationId, scopeKey, key);
        return from(settle).pipe(mergeMap(() => throwError(() => error)));
      }),
    );
  }

  private async claim(
    organizationId: string,
    scopeKey: string,
    key: string,
    requestHash: string,
  ): Promise<ClaimOutcome> {
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + this.config.IDEMPOTENCY_TTL_HOURS * 3600_000);
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
        })
        .onConflict((oc) =>
          oc.columns(['organization_id', 'scope_key', 'idempotency_key']).doNothing(),
        )
        .returning('idempotency_key')
        .executeTakeFirst();
      if (inserted) return { kind: 'claimed' };
      const existing = await trx
        .selectFrom('idempotency_keys')
        .select(['request_hash', 'status', 'response_status', 'response_body'])
        .where('organization_id', '=', organizationId)
        .where('scope_key', '=', scopeKey)
        .where('idempotency_key', '=', key)
        .executeTakeFirst();
      if (!existing) return { kind: 'in_progress' };
      if (existing.request_hash !== requestHash) return { kind: 'conflict' };
      if (existing.status === 'in_progress') return { kind: 'in_progress' };
      return {
        kind: 'replay',
        status: existing.response_status ?? 200,
        body: existing.response_body,
      };
    });
  }

  private async complete(
    organizationId: string,
    scopeKey: string,
    key: string,
    status: number,
    body: unknown,
  ): Promise<void> {
    const { json } = await import('@sportspark/db');
    await this.db
      .updateTable('idempotency_keys')
      .set({
        status: 'completed',
        response_status: status,
        response_body: body === undefined ? null : json(body as object),
        completed_at: this.clock.now(),
      })
      .where('organization_id', '=', organizationId)
      .where('scope_key', '=', scopeKey)
      .where('idempotency_key', '=', key)
      .execute();
  }

  private async release(organizationId: string, scopeKey: string, key: string): Promise<void> {
    await this.db
      .deleteFrom('idempotency_keys')
      .where('organization_id', '=', organizationId)
      .where('scope_key', '=', scopeKey)
      .where('idempotency_key', '=', key)
      .where('status', '=', 'in_progress')
      .execute();
  }
}
