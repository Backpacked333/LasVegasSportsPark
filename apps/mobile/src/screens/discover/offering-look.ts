/**
 * How an activity is drawn and filtered on Explore (SCR-C-07; ADR-008 visual system v2, PA-11
 * customer words): the category chips and the kind each one asks the API for, the sport words a
 * sport chip adds to the search, the customer word for each kind, and the short lines a media card
 * reads with the activity's name.
 *
 * Pure: no clock and no state. The picture is decorative (`artworkFor`); the words carry the
 * meaning.
 */
import type { CapabilityId, Schema } from '@sportspark/api-client';
import { ageBandLabel, formatMoney, type OfferingKind } from '../../features/registration/format';
import { promotionBadges } from '../../features/registration/promotions';
import { registrationWindowStatus } from '../../features/registration/status';

type PublicOffering = Schema<'PublicOffering'>;
type PublicPrice = Schema<'PublicPrice'>;

/** A category chip: its label, the `kind` it sends, and its decorative icon. */
export interface ExploreCategory {
  kind: OfferingKind;
  label: string;
  icon: string;
}

/** Categories every organization has (SPK-CAT-002 kinds). */
export const EXPLORE_CATEGORIES: readonly ExploreCategory[] = [
  { kind: 'season', label: 'Leagues', icon: 'sports_soccer' },
  { kind: 'term', label: 'Classes', icon: 'school' },
  { kind: 'camp', label: 'Camps', icon: 'wb_sunny' },
  { kind: 'trial', label: 'Trials', icon: 'sports' },
  { kind: 'private_coaching', label: 'Coaching', icon: 'person' },
];

/**
 * Package G categories: each shown only while the organization's switch is on (K-12, DEC-016,
 * DEC-072 to DEC-082; PA-11 "no entry point to a capability whose switch is off").
 */
export const CONDITIONAL_CATEGORIES: readonly (ExploreCategory & { capability: CapabilityId })[] = [
  { kind: 'pickup', label: 'Pickup', icon: 'stadium', capability: 'pickup_sessions' },
  { kind: 'rental', label: 'Rentals', icon: 'event_available', capability: 'rentals' },
  { kind: 'party', label: 'Parties', icon: 'cake', capability: 'parties' },
  {
    kind: 'package',
    label: 'Class packs',
    icon: 'confirmation_number',
    capability: 'session_packages',
  },
  { kind: 'membership', label: 'Memberships', icon: 'card_membership', capability: 'memberships' },
];

/** A sport chip: the word it adds to the search (`q`), which the API matches as a word. */
export interface ExploreSport {
  word: string;
  label: string;
}

export const EXPLORE_SPORTS: readonly ExploreSport[] = [
  { word: 'soccer', label: 'Soccer' },
  { word: 'futsal', label: 'Futsal' },
  { word: 'basketball', label: 'Basketball' },
];

/** The customer word for one activity of a kind (PA-11 vocabulary: a package is a class pack). */
export const KIND_WORD: Readonly<Record<OfferingKind, string>> = {
  season: 'League',
  term: 'Class',
  camp: 'Camp',
  session: 'Session',
  trial: 'Trial',
  makeup: 'Makeup session',
  pickup: 'Pickup',
  private_coaching: 'Coaching',
  rental: 'Rental',
  package: 'Class pack',
  membership: 'Membership',
  party: 'Party',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dayAndMonth(iso: string): { year: string; text: string } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return null;
  const [, year, month, day] = match as unknown as [string, string, string, string];
  return { year, text: `${MONTHS[Number(month) - 1] ?? month} ${Number(day)}` };
}

/** "Nov 2 to Dec 14, 2026", "Dec 28, 2026 to Jan 3, 2027" or "Nov 2, 2026": calendar dates only. */
export function shortDates(offering: Pick<PublicOffering, 'startsOn' | 'endsOn'>): string {
  const start = dayAndMonth(offering.startsOn);
  const end = dayAndMonth(offering.endsOn);
  if (!start || !end) return `${offering.startsOn} to ${offering.endsOn}`;
  if (offering.startsOn === offering.endsOn) return `${start.text}, ${start.year}`;
  if (start.year === end.year) return `${start.text} to ${end.text}, ${end.year}`;
  return `${start.text}, ${start.year} to ${end.text}, ${end.year}`;
}

/**
 * The price a card and the action bar advertise: "From $120.00", or "$24.00 a class" for a price
 * per class (SPK-PAY-013). None when no price is published or when no quote would give it
 * (quality review M-6: the reason is shown on the activity instead).
 */
export function advertisedPrice(price: PublicPrice | null): string | null {
  if (!price || price.notQuotable) return null;
  const amount = formatMoney(price.basePriceMinor, price.currency);
  return price.pricingBasis === 'per_session' ? `${amount} a class` : `From ${amount}`;
}

/** The card's first line: "Ages 8 to 10 · Nov 2 to Dec 14, 2026 · From $120.00". */
export function offeringCardLine(offering: PublicOffering): string {
  return [ageBandLabel(offering.ageBand), shortDates(offering), advertisedPrice(offering.price)]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
}

/** The card's second line: format and place, "7v7 · Field 2". */
export function offeringPlaceLine(offering: PublicOffering): string {
  return [offering.format, offering.locationLabel ?? offering.facility.name]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
}

/** The tags of a card: the registration window first, then each automatic discount. */
export function offeringTags(offering: PublicOffering): string[] {
  return [
    registrationWindowStatus(offering).label,
    ...promotionBadges(offering).map((badge) => badge.label),
  ];
}

/**
 * The card's one name for screen readers: the activity's name first, then its kind, its lines and
 * its tags ("Autumn Youth Program, Class, Ages 8 to 10 · …, Registration open").
 */
export function offeringCardLabel(offering: PublicOffering, extra: readonly string[] = []): string {
  return [
    offering.name,
    KIND_WORD[offering.kind],
    offeringCardLine(offering),
    offeringPlaceLine(offering),
    ...extra,
    ...offeringTags(offering),
  ]
    .filter((part) => part.trim() !== '')
    .join(', ');
}
