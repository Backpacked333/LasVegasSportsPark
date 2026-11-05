import type { AuthorityScopeSource, ImportEntityTypeValue } from '@sportspark/contracts';

/**
 * Route classification for the §5.6 record-authority guard (K-11, IF-41): "a synchronized copy
 * never becomes an independent writer". Every write handler carries exactly one of
 *
 * - `@RecordAuthority(category, scope)`: the command creates or changes records of a §5.3
 *   category, so it is refused while the legacy system is authoritative for that category at the
 *   scope (`scope` names where the scope comes from; `'unproven'` refuses while any assignment of
 *   the category names the legacy system), or
 * - `@NoRecordAuthority(reason)`: the command changes no record of a §5.3 category; the reason
 *   says why (at least 11 characters).
 *
 * The decorators are metadata only: the migration module's write guard enforces them (MIG-00) and
 * route facts carry them (`route-catalog.ts`). Both on one handler fails when the class is
 * defined, so the application never starts with an ambiguous classification.
 */
export const RECORD_AUTHORITY_KEY = 'sportspark:record-authority';

export type RecordAuthorityClassification =
  | { kind: 'guarded'; category: ImportEntityTypeValue; scope: AuthorityScopeSource }
  | { kind: 'exempt'; reason: string };

function classify(classification: RecordAuthorityClassification): MethodDecorator {
  return (target, propertyKey, descriptor) => {
    const handler = descriptor.value as object | undefined;
    if (!handler) {
      throw new Error(
        `@${classification.kind === 'guarded' ? 'RecordAuthority' : 'NoRecordAuthority'} applies to a handler method (${String(propertyKey)})`,
      );
    }
    const existing = Reflect.getMetadata(RECORD_AUTHORITY_KEY, handler) as
      RecordAuthorityClassification | undefined;
    if (existing) {
      const owner = (target as { constructor?: { name?: string } }).constructor?.name ?? 'handler';
      throw new Error(
        `${owner}.${String(propertyKey)} carries both @RecordAuthority and @NoRecordAuthority (or one twice); classify a write route exactly once (§5.6)`,
      );
    }
    Reflect.defineMetadata(RECORD_AUTHORITY_KEY, classification, handler);
    return descriptor;
  };
}

/** The command writes records of `category` (§5.3); refused while the legacy system holds them. */
export const RecordAuthority = (
  category: ImportEntityTypeValue,
  scope: AuthorityScopeSource = 'unproven',
): MethodDecorator => classify({ kind: 'guarded', category, scope });

/** The command changes no record of a §5.3 category; `reason` (11+ characters) says why. */
export const NoRecordAuthority = (reason: string): MethodDecorator => {
  if (reason.trim().length < 11) {
    throw new Error(`@NoRecordAuthority needs a reason of at least 11 characters ("${reason}")`);
  }
  return classify({ kind: 'exempt', reason: reason.trim() });
};

/** The classification a handler declares, if any. */
export function recordAuthorityOf(handler: object): RecordAuthorityClassification | null {
  return (
    (Reflect.getMetadata(RECORD_AUTHORITY_KEY, handler) as
      RecordAuthorityClassification | undefined) ?? null
  );
}
