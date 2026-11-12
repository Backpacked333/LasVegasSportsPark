/**
 * How an offering is drawn in Discover lists (SCR-C-07): its kind's decorative icon and tile
 * colour, and the one-line summary read with its name.
 */
import type { Schema } from '@sportspark/api-client';
import {
  OFFERING_KIND_LABELS,
  ageBandLabel,
  formatMoney,
  type OfferingKind,
} from '../../features/registration/format';
import { offeringDates } from '../../features/registration/status';
import type { ThemeKindColors } from '../../ui/theme';

type PublicOffering = Schema<'PublicOffering'>;

/**
 * Decorative icon and tile colour per kind, the colour as the theme's kind colour to use
 * (`useTheme().kindColors[...]`); the kind's name is always in the row's text.
 */
export const KIND_LOOK: Record<OfferingKind, readonly [string, keyof ThemeKindColors]> = {
  season: ['sports_soccer', 'league'],
  term: ['school', 'program'],
  camp: ['wb_sunny', 'rental'],
  session: ['event', 'program'],
  trial: ['sports', 'league'],
  makeup: ['replay', 'program'],
  pickup: ['stadium', 'dropin'],
  private_coaching: ['person', 'basketball'],
  rental: ['event_available', 'rental'],
  package: ['confirmation_number', 'dropin'],
  membership: ['card_membership', 'league'],
  party: ['cake', 'party'],
};

export function offeringSummary(offering: PublicOffering): string {
  return [
    OFFERING_KIND_LABELS[offering.kind],
    offering.format,
    ageBandLabel(offering.ageBand),
    offeringDates(offering),
    offering.locationLabel,
    offering.price
      ? `From ${formatMoney(offering.price.basePriceMinor, offering.price.currency)}`
      : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
}
