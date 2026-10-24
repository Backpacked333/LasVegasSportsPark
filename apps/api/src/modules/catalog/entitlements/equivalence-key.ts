import type { EntitlementKind, EquivalenceScope } from '@sportspark/contracts';

/**
 * §4.7 invariant 2: "no equivalent duplicate active entitlement where prohibited". An
 * entitlement definition states the scope within which two entitlements are equivalent; the
 * enrollment module stores the resulting key on each active entitlement and enforces uniqueness
 * with a partial unique index. `null` means duplicates are permitted (scope `none`).
 */
export interface EquivalenceDefinition {
  kind: EntitlementKind;
  equivalenceScope: EquivalenceScope;
  equivalenceRule: Record<string, unknown>;
}

export interface EquivalenceContext {
  offeringId: string;
  programId: string;
  participantPersonId: string;
  /** Required for scope `session`. */
  sessionId?: string | null;
  /** Required for scope `program_period`: e.g. the offering's `startsOn..endsOn` or a term label. */
  periodKey?: string | null;
}

export function equivalenceKey(
  definition: EquivalenceDefinition,
  ctx: EquivalenceContext,
): string | null {
  const participant = `person:${ctx.participantPersonId}`;
  switch (definition.equivalenceScope) {
    case 'none':
      return null;
    case 'offering':
      return `${definition.kind}|offering:${ctx.offeringId}|${participant}`;
    case 'program':
      return `${definition.kind}|program:${ctx.programId}|${participant}`;
    case 'program_period': {
      if (!ctx.periodKey) {
        throw new Error('equivalence scope program_period requires a periodKey');
      }
      return `${definition.kind}|program:${ctx.programId}|period:${ctx.periodKey}|${participant}`;
    }
    case 'session': {
      if (!ctx.sessionId) throw new Error('equivalence scope session requires a sessionId');
      return `${definition.kind}|session:${ctx.sessionId}|${participant}`;
    }
  }
}

/** The default period key for `program_period`: the offering's dates. */
export function periodKeyForDates(startsOn: string, endsOn: string): string {
  return `${startsOn}..${endsOn}`;
}
