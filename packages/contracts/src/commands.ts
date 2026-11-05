import { z } from './zod';

/**
 * Command behavior contract (specification §4.9).
 * Consequential commands carry an idempotency key (HTTP header `Idempotency-Key`),
 * an expected revision for sensitive edits, policy references, and a reason for overrides/corrections.
 */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
export const CORRELATION_ID_HEADER = 'x-correlation-id';

export const IdempotencyKey = z.string().min(8).max(128);
export type IdempotencyKey = z.infer<typeof IdempotencyKey>;

export const Revision = z.number().int().min(1);

export const CommandMetaSchema = z.object({
  expectedRevision: Revision.optional(),
  reason: z.string().min(1).max(2000).optional(),
  policyReferences: z.array(z.string().min(1).max(200)).max(20).optional(),
});
export type CommandMeta = z.infer<typeof CommandMetaSchema>;

/** Mix-in for command bodies: `const Body = withCommandMeta(z.object({...}))`. */
export function withCommandMeta<T extends z.ZodRawShape>(shape: T) {
  return z.object({ ...shape, ...CommandMetaSchema.shape });
}

export const OperationStatus = z.enum([
  'pending',
  'running',
  'succeeded',
  'failed',
  'recovery_required',
  'compensated',
]);
export type OperationStatus = z.infer<typeof OperationStatus>;

export const OperationSchema = z.object({
  id: z.uuid(),
  kind: z.string(),
  status: OperationStatus,
  correlationId: z.string().nullable(),
  result: z.unknown().nullable(),
  error: z
    .object({ code: z.string(), message: z.string(), details: z.unknown().optional() })
    .nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
});
export type Operation = z.infer<typeof OperationSchema>;

/** Standard accepted-response envelope for asynchronous commands. */
export const OperationAcceptedSchema = z.object({
  operationId: z.uuid(),
  status: OperationStatus,
  href: z.string(),
});
export type OperationAccepted = z.infer<typeof OperationAcceptedSchema>;

// ---------------------------------------------------------------------------------------------
// Client identification (SPK-AT-027, §4.13; K-03)
// ---------------------------------------------------------------------------------------------

/**
 * The client identification header every app build sends: `sportspark-<app>/<version>
 * (<platform>)`, for example `sportspark-mobile/1.2.0 (ios)`. It carries no device or user data.
 * The kernel's client-compatibility guard reads it; the API client (`packages/api-client/src/
 * client-info.ts`) formats it, and a drift test there keeps both readings equal.
 */
export const CLIENT_INFO_HEADER = 'x-sportspark-client';

export const CLIENT_APPS = ['mobile', 'staff'] as const;
export const CLIENT_PLATFORMS = ['ios', 'android', 'web'] as const;
export type ClientApp = (typeof CLIENT_APPS)[number];
export type ClientPlatform = (typeof CLIENT_PLATFORMS)[number];

export interface ClientIdentity {
  app: ClientApp;
  platform: ClientPlatform;
  version: string;
}

const CLIENT_INFO_PATTERN = /^sportspark-(mobile|staff)\/([0-9A-Za-z.+-]+) \((ios|android|web)\)$/;
/** Semantic version with an optional pre-release and build (`1.2.0`, `1.3.0-beta.1`). */
export const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Reads the header; null when it is not `sportspark-(mobile|staff)/<semver> (ios|android|web)`. */
export function parseClientIdentity(value: string): ClientIdentity | null {
  const match = CLIENT_INFO_PATTERN.exec(value.trim());
  if (!match || !SEMVER_PATTERN.test(match[2] as string)) return null;
  return {
    app: match[1] as ClientApp,
    version: match[2] as string,
    platform: match[3] as ClientPlatform,
  };
}

/** Semantic-version order: numeric major.minor.patch, a pre-release sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const pa = SEMVER_PATTERN.exec(a);
  const pb = SEMVER_PATTERN.exec(b);
  if (!pa || !pb) throw new Error(`not a semantic version: ${!pa ? a : b}`);
  for (let i = 1; i <= 3; i += 1) {
    const diff = Number(pa[i]) - Number(pb[i]);
    if (diff !== 0) return diff;
  }
  if (pa[4] && !pb[4]) return -1;
  if (!pa[4] && pb[4]) return 1;
  return 0;
}

// ---------------------------------------------------------------------------------------------
// Record authority route classification (§5.6; K-11, IF-41)
// ---------------------------------------------------------------------------------------------

/**
 * Where a guarded write's authority scope comes from (§5.6, §4.8: scope comes from the
 * authenticated route and the record, never from identifiers a client adds to the body).
 *
 * - `organization`: the command creates a new top-level record that no narrower assignment can
 *   cover yet (a new program, person, household, account or competition).
 * - `unproven` (the default): the command changes an existing record, or names its parent by id,
 *   and the guard cannot know the record's facility, program or competition before the owning
 *   module loads it. The write is refused while ANY assignment of the category in effect, at any
 *   scope, names the legacy system (§4.7 invariant 11).
 * - declared sources: the validated field the handler itself uses to decide where the record is
 *   written. Only these fields are ever read; any other body field is ignored.
 */
export type ScopeSourceField =
  | 'params.id'
  | 'body.facilityId'
  | 'body.programId'
  | 'body.competitionId'
  | 'body.schedule.facilityId';

export interface DeclaredScope {
  facilityId?: ScopeSourceField;
  programId?: ScopeSourceField;
  competitionId?: ScopeSourceField;
}

export type AuthorityScopeSource = 'organization' | 'unproven' | DeclaredScope;

/** The record scope an in-process authority check names (RECORD_AUTHORITY_PORT, IF-42). */
export interface RecordAuthorityScope {
  facilityId?: string;
  programId?: string;
  competitionId?: string;
}

// ---------------------------------------------------------------------------------------------
// Import provenance (§5.3, §5.4, SPK-AT-024; K-13, IF-40)
// ---------------------------------------------------------------------------------------------

/**
 * What an owning module's import command receives from the migration module: the batch, the
 * external key of the source row and the UUID v7 migration reserved for it in its external
 * mapping. The command inserts with `id = recordId`, so a re-import finds the same record.
 */
export const ImportProvenanceSchema = z.object({
  batchId: z.uuid(),
  externalKey: z.string().min(1).max(200),
  recordId: z.uuid(),
});
export type ImportProvenance = z.infer<typeof ImportProvenanceSchema>;

/** The actor label of the one principal that may run an import command for `batchId`. */
export function importActorLabel(batchId: string): string {
  return `migration.import:${batchId}`;
}
