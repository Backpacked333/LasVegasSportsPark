/**
 * The customer vocabulary (PA-11, SPK-UX-011 **Proposed**; open values DEC-107): the one list of
 * internal words and the words customers see in their place, and the matchers the copy guard
 * (`src/copy/__tests__/customer-words.test.ts`) uses to keep internal words out of the app.
 *
 * How the guard decides what customers see. It parses the app's source with the TypeScript
 * compiler and reads only text that reaches the screen or a screen reader: JSX text, the string
 * and template literals of display props (`label`, `title`, `message`, `description`, any
 * `…Label` or `…Title`, and the others it lists), screen titles in navigator options and the
 * words passed to announcements. It ignores everything inside `SupportDetails` (the collapsed
 * "Details for support" fold, where codes belong), `testID`, `href`, route strings, object keys,
 * identifiers and comments. In that text it looks for the terms below as whole words, ignoring
 * case, after removing the kept phrases. A term is banned only as a customer-facing word: "quote"
 * matches "quote" and "quotes", not "quoted"; the code of a route or a type may keep its name.
 */

/** One internal word or label and what customers see instead. */
export interface VocabularyEntry {
  internal: string;
  customer: string;
}

/**
 * Internal → customer, as the redesign plan and PA-11 list them. The first column is what the
 * specification and the API call a thing; the second is the only word the app shows for it.
 */
export const CUSTOMER_VOCABULARY = [
  { internal: 'basket', customer: 'cart' },
  { internal: 'quote', customer: 'review / price summary' },
  { internal: 'hold', customer: 'save spots' },
  { internal: 'obligation', customer: 'amount due' },
  { internal: 'payment attempt', customer: 'payment' },
  { internal: 'enrollment', customer: 'registration' },
  { internal: 'entitlement', customer: 'makeups available' },
  { internal: 'session package', customer: 'class pack' },
  { internal: 'offering', customer: 'activity' },
  { internal: 'fixture', customer: 'game' },
  { internal: 'contribution request', customer: 'your share' },
  { internal: 'acknowledgment', customer: 'form / waiver' },
  { internal: 'household', customer: 'family' },
  { internal: 'Youth enrollment', customer: 'Register a child' },
  { internal: 'Individual league entry', customer: 'Join as a player' },
  { internal: 'Create a team entry', customer: 'Enter a new team' },
  { internal: 'Discover', customer: 'Explore' },
  { internal: 'Schedule', customer: 'Calendar' },
  { internal: 'Account', customer: 'You' },
] as const satisfies readonly VocabularyEntry[];

/** A word the guard refuses in customer text, and the customer word to use instead. */
export interface BannedTerm {
  /** The name the guard reports, e.g. "basket" or "DEC-". */
  term: string;
  /** Matches the term; whole words, case-insensitive for words, exact for codes. */
  pattern: RegExp;
  /** What to write instead. */
  instead: string;
}

function word(term: string, stem: string, instead: string): BannedTerm {
  return { term, pattern: new RegExp(`\\b${stem}\\b`, 'i'), instead };
}

/**
 * The internal words. "hold" and the tab names are in the vocabulary but not banned: they are
 * ordinary English ("hold the phone", "your schedule") and the guard would only add noise.
 */
export const BANNED_CUSTOMER_WORDS: readonly BannedTerm[] = [
  word('basket', 'baskets?', 'cart'),
  word('quote', 'quotes?', 'review or price summary'),
  word('obligation', 'obligations?', 'amount due'),
  word('payment attempt', 'payment\\s+attempts?', 'payment'),
  word('enrollment', 'enrol(?:l)?ments?', 'registration'),
  word('entitlement', 'entitlements?', 'makeups available'),
  word('session package', 'session\\s+packages?', 'class pack'),
  word('offering', 'offerings?', 'activity'),
  word('fixture', 'fixtures?', 'game'),
  word('contribution request', 'contribution\\s+requests?', 'your share'),
  word('acknowledgment', 'acknowledge?ments?', 'form or waiver'),
  word('household', 'households?', 'family'),
];

function code(term: string, pattern: RegExp): BannedTerm {
  return { term, pattern, instead: 'the SupportDetails fold' };
}

/**
 * Internal identifiers: screen and requirement ids, decisions, policies, amendments and section
 * references. They belong only in `SupportDetails` (SPK-UX-011 **Proposed**; §4.10).
 */
export const BANNED_CUSTOMER_CODES: readonly BannedTerm[] = [
  code('SCR-', /\bSCR-[A-Z0-9]/),
  code('SPK-', /\bSPK-[A-Z0-9]/),
  code('DEC-', /\bDEC-\d/),
  code('POL-', /\bPOL-\d/),
  code('PA-', /\bPA-\d/),
  code('§', /§/),
];

/** Everything the guard refuses in customer text: the internal words, then the codes. */
export const BANNED_CUSTOMER_TERMS: readonly BannedTerm[] = [
  ...BANNED_CUSTOMER_WORDS,
  ...BANNED_CUSTOMER_CODES,
];

/**
 * Phrases kept word for word whatever they contain: the customer-visible labels of
 * docs/package-a/journeys.md section 3 (SPK-UX-004, SPK-UX-010), with "…" where the label takes
 * a value, and the recovery words of the payment and command screens. The guard removes these
 * before it looks for banned terms; "…" matches any value, including a template expression.
 */
export const KEPT_PHRASES: readonly string[] = [
  'Registration opens …',
  'Registration open',
  'Registration paused',
  'Registration closed',
  'Price valid until …',
  'Price expired. Get a new price.',
  'Place held until …',
  'Your held place was released',
  'Open until …',
  'Accepted',
  'Declined',
  'Expired',
  'Revoked',
  'Awaiting approval',
  'Not approved: …',
  'Not approved',
  'Payment needs your action',
  'Payment processing',
  'Payment outcome being confirmed. Do not pay again.',
  'Payment failed',
  'Payment canceled',
  'Payment received. We are completing your registration.',
  'Payment returned. Registration was not completed.',
  'Registration pending: …',
  'Confirmed in …. Awaiting placement.',
  'Confirmed: …',
  'Confirmed. Next payment due ….',
  'Payment attention needed',
  'Canceled',
  'Transferred to …',
  'Completed',
  'Team entry awaiting approval',
  'Team entry approved',
  'Withdrawn',
  'Waitlisted for …',
  'Place offered. Accept by ….',
  'Booking pending',
  'Booked',
  'Credit: …',
  'Makeup sessions available: …, expires …',
  'Team total, received, allocated, remaining',
  'Available',
  'Unavailable',
  'Tentative',
  'No response',
  'Arrived',
  'Checked in to …',
  'Attended',
  'Departed',
  'Released to …',
  'Not yet scheduled',
  'Postponed',
  'Final',
  'Forfeit',
  'Abandoned',
  'Provisional',
  'Official',
  'Corrected on …',
  'Offered',
  'Published',
  'Changed: was …, now …',
  'Unread',
  'Read',
  'Acknowledged',
  'Replaced by a newer update',
  'Essential notices',
  'Promotional messages',
  'Calendar feed active',
  'Feed link revoked. Events already copied to your calendar are not removed.',
  'Processing',
  'Done',
  'Failed',
  'Needs attention',
  'Try again',
  'Check again',
  'Do not pay again',
];

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A kept phrase as a matcher: whole words, case-insensitive. A "…" between fixed parts matches the
 * value up to the next part (within one sentence); a "…" at the end matches only a template
 * expression, so a literal value after the fixed words is still read ("Waitlisted for …" keeps
 * `Waitlisted for ${name}`, but in "Waitlisted for the basket" the guard still sees "basket").
 */
export function keptPhrasePattern(phrase: string): RegExp {
  const parts = phrase.split('…').map(escape);
  const trailing = phrase.endsWith('…');
  const fixed = trailing ? parts.slice(0, -1) : parts;
  const body = fixed.join('(?:…|[^.…]+?)') + (trailing ? '(?:…)?' : '');
  const start = /^\w/.test(phrase) ? '\\b' : '';
  const end = /\w$/.test(phrase) ? '\\b' : '';
  return new RegExp(`${start}${body}${end}`, 'gi');
}

/** The kept phrases as matchers, longer first, so "Not approved: …" goes before "Not approved". */
export const KEPT_PHRASE_PATTERNS: readonly RegExp[] = [...KEPT_PHRASES]
  .sort((a, b) => b.length - a.length)
  .map(keptPhrasePattern);
