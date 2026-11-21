/**
 * The registration's choices, kept on the device for 30 minutes (redesign handoff INTERACTIONS
 * "1e–1g" row 10: "Leave registration? Your choices are kept for 30 min."): who, which weeks, the
 * extras, uniform sizes, codes and the cart the flow made. In memory only (never storage, never a
 * route), keyed by the activity, read with the injected clock; nothing about a child leaves the
 * device this way (§4.14). The cart itself is the API's (it keeps or lets go of held places by
 * its own expiry); a lapsed draft simply starts the flow from Who again.
 */

/** How long choices are kept after the parent leaves the flow. */
export const DRAFT_KEEP_MS = 30 * 60_000;

export interface RegisterDraft {
  offeringId: string;
  personIds: readonly string[];
  /** Camp weeks chosen (offering ids); the offering itself for anything else. */
  weekIds: readonly string[];
  /** Add-on codes switched on (the same code on every chosen week). */
  extras: readonly string[];
  /** Uniform size per person. */
  uniformSizes: Readonly<Record<string, string>>;
  /** Promo codes applied on Review. */
  codes: readonly string[];
  /** The cart this flow made, once it exists. */
  basketId: string | null;
}

const drafts = new Map<string, { draft: RegisterDraft; savedAt: number }>();

export function emptyDraft(offeringId: string): RegisterDraft {
  return {
    offeringId,
    personIds: [],
    weekIds: [offeringId],
    extras: [],
    uniformSizes: {},
    codes: [],
    basketId: null,
  };
}

/** The kept draft of an activity, or null when there is none or it is older than 30 minutes. */
export function readDraft(offeringId: string, now: Date): RegisterDraft | null {
  const kept = drafts.get(offeringId);
  if (!kept) return null;
  if (now.getTime() - kept.savedAt > DRAFT_KEEP_MS) {
    drafts.delete(offeringId);
    return null;
  }
  return kept.draft;
}

export function saveDraft(draft: RegisterDraft, now: Date): void {
  drafts.set(draft.offeringId, { draft, savedAt: now.getTime() });
}

export function dropDraft(offeringId: string): void {
  drafts.delete(offeringId);
}

/** Tests start from nothing. */
export function clearDrafts(): void {
  drafts.clear();
}
