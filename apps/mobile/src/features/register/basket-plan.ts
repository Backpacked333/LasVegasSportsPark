/**
 * The cart lines a registration needs, and how to get the flow's cart there (redesign handoff
 * 1e–1f; SPK-REG-004, SPK-PAY-014, SPK-REG-012). Pure.
 *
 * One line per person and chosen week (or the activity), carrying the extras switched on (by
 * add-on code, sold per day for each day of the week, or once) and the person's uniform size. The
 * cart is brought to exactly these lines: lines nobody wants any more are removed, missing ones are
 * added; a held cart is let go of first (its places are held again right after). Prices are never
 * sent: the API prices every line (SPK-PAY-001).
 */
import type { Schema } from '@sportspark/api-client';
import type { RegistrationIntent } from '../registration/format';

type BasketLine = Schema<'BasketLine'>;
type OfferingAddon = Schema<'OfferingAddon'>;
type OfferingUniform = Schema<'OfferingUniform'>;

export interface DesiredLine {
  participantPersonId: string;
  offeringId: string;
  intent: RegistrationIntent;
  addons: { addonId: string; sessionIds?: string[] }[];
  uniform: { offeringUniformId: string; size: string } | null;
  /** A price tier and its chosen days (an offering sold by tier, `PurchaseChoices`). */
  priceTierId?: string;
  selectedSessionIds?: string[];
}

/** What each chosen week offers: its add-ons, its uniform and its live session ids. */
export interface WeekExtras {
  addons: readonly OfferingAddon[];
  uniform: OfferingUniform | null;
  sessionIds: readonly string[];
}

export function desiredLines(input: {
  personIds: readonly string[];
  weekIds: readonly string[];
  intent: RegistrationIntent;
  extras: readonly string[];
  uniformSizes: Readonly<Record<string, string>>;
  extrasOf: (offeringId: string) => WeekExtras | undefined;
}): DesiredLine[] {
  const out: DesiredLine[] = [];
  for (const offeringId of input.weekIds) {
    const week = input.extrasOf(offeringId);
    for (const participantPersonId of input.personIds) {
      const addons = (week?.addons ?? [])
        .filter((a) => a.status === 'active' && input.extras.includes(a.code))
        .map((a) =>
          a.selection === 'per_session'
            ? { addonId: a.id, sessionIds: [...(week?.sessionIds ?? [])] }
            : { addonId: a.id },
        );
      const size = input.uniformSizes[participantPersonId];
      const uniform =
        week?.uniform && week.uniform.status === 'active' && size
          ? { offeringUniformId: week.uniform.id, size }
          : null;
      out.push({ participantPersonId, offeringId, intent: input.intent, addons, uniform });
    }
  }
  return out;
}

/** Whether every person has the size a required uniform needs. */
export function missingUniformSizes(
  personIds: readonly string[],
  uniform: OfferingUniform | null | undefined,
  sizes: Readonly<Record<string, string>>,
): string[] {
  if (!uniform || uniform.status !== 'active' || uniform.requirement !== 'required') return [];
  return personIds.filter((id) => !sizes[id]);
}

function key(line: {
  participantPersonId: string;
  offeringId: string;
  addons: readonly { addonId: string; sessionIds?: readonly string[] }[];
  uniform: { offeringUniformId: string; size: string } | null;
  priceTierId?: string | null;
  selectedSessionIds?: readonly string[] | null;
}): string {
  const addons = line.addons
    .map((a) => `${a.addonId}[${[...(a.sessionIds ?? [])].sort().join(',')}]`)
    .sort()
    .join('+');
  const uniform = line.uniform ? `${line.uniform.offeringUniformId}=${line.uniform.size}` : '';
  const tier = line.priceTierId
    ? `${line.priceTierId}[${[...(line.selectedSessionIds ?? [])].sort().join(',')}]`
    : '';
  return `${line.offeringId}:${line.participantPersonId}:${addons}:${uniform}:${tier}`;
}

/** A cart line as the plan compares it. */
export function basketLineKey(line: BasketLine): string {
  return key({
    participantPersonId: line.participantPersonId,
    offeringId: line.offeringId,
    addons: line.addons.map((a) => ({
      addonId: a.addonId,
      ...(a.sessionIds.length > 0 ? { sessionIds: a.sessionIds } : {}),
    })),
    uniform: line.uniform
      ? { offeringUniformId: line.uniform.offeringUniformId, size: line.uniform.size }
      : null,
    priceTierId: line.priceTierId,
    selectedSessionIds: line.selectedSessionIds,
  });
}

export function desiredLineKey(line: DesiredLine): string {
  return key(line);
}

/** Lines the cart still counts (pending or held, not removed or failed). */
export function liveLines(lines: readonly BasketLine[]): BasketLine[] {
  return lines.filter((l) => l.outcome === 'pending' || l.outcome === 'held');
}

export function planChanges(
  lines: readonly BasketLine[],
  desired: readonly DesiredLine[],
): { remove: BasketLine[]; add: DesiredLine[] } {
  const live = liveLines(lines);
  const wanted = new Map(desired.map((d) => [desiredLineKey(d), d] as const));
  const have = new Map(live.map((l) => [basketLineKey(l), l] as const));
  return {
    remove: live.filter((l) => !wanted.has(basketLineKey(l))),
    add: desired.filter((d) => !have.has(desiredLineKey(d))),
  };
}
