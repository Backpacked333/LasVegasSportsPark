/* eslint-disable @typescript-eslint/no-require-imports -- images must be static requires so Metro bundles them */
/**
 * The bundled artwork of the customer app (ADR-008, "Imagery"): every image is a static `require`
 * so Metro bundles it and the app works offline (§4.15). Subjects, sizes and byte budgets are in
 * `assets/artwork/README.md`; `__tests__/artwork-manifest.test.ts` enforces them.
 *
 * Images are decorative: they are drawn through the shared `Artwork` component, which hides them
 * from screen readers (SPK-UX-009). Meaning always lives in the text beside them.
 */
import type { ImageRequireSource } from 'react-native';

/** A bundled image, as Metro resolves a static `require` (an asset id). */
export type ArtworkSource = ImageRequireSource;

/** The two crops every activity image comes in: 16:9 (1280×720) and 1:1 (640×640). */
export type ArtworkShape = 'wide' | 'square';

/** Activity images; `park` is the fallback when nothing more specific fits. */
export const ACTIVITY_ART = [
  'soccer-league',
  'soccer-youth',
  'kids-class',
  'futsal-indoor',
  'basketball',
  'camp',
  'party',
  'rental-field',
  'pickup',
  'coaching',
  'membership',
  'trial',
  'team',
  'park',
] as const;
export type ActivityArt = (typeof ACTIVITY_ART)[number];

export const activityArtwork: Readonly<
  Record<ActivityArt, Readonly<Record<ArtworkShape, ArtworkSource>>>
> = {
  'soccer-league': {
    wide: require('../../assets/artwork/soccer-league-wide.webp'),
    square: require('../../assets/artwork/soccer-league-square.webp'),
  },
  'soccer-youth': {
    wide: require('../../assets/artwork/soccer-youth-wide.webp'),
    square: require('../../assets/artwork/soccer-youth-square.webp'),
  },
  'kids-class': {
    wide: require('../../assets/artwork/kids-class-wide.webp'),
    square: require('../../assets/artwork/kids-class-square.webp'),
  },
  'futsal-indoor': {
    wide: require('../../assets/artwork/futsal-indoor-wide.webp'),
    square: require('../../assets/artwork/futsal-indoor-square.webp'),
  },
  basketball: {
    wide: require('../../assets/artwork/basketball-wide.webp'),
    square: require('../../assets/artwork/basketball-square.webp'),
  },
  camp: {
    wide: require('../../assets/artwork/camp-wide.webp'),
    square: require('../../assets/artwork/camp-square.webp'),
  },
  party: {
    wide: require('../../assets/artwork/party-wide.webp'),
    square: require('../../assets/artwork/party-square.webp'),
  },
  'rental-field': {
    wide: require('../../assets/artwork/rental-field-wide.webp'),
    square: require('../../assets/artwork/rental-field-square.webp'),
  },
  pickup: {
    wide: require('../../assets/artwork/pickup-wide.webp'),
    square: require('../../assets/artwork/pickup-square.webp'),
  },
  coaching: {
    wide: require('../../assets/artwork/coaching-wide.webp'),
    square: require('../../assets/artwork/coaching-square.webp'),
  },
  membership: {
    wide: require('../../assets/artwork/membership-wide.webp'),
    square: require('../../assets/artwork/membership-square.webp'),
  },
  trial: {
    wide: require('../../assets/artwork/trial-wide.webp'),
    square: require('../../assets/artwork/trial-square.webp'),
  },
  team: {
    wide: require('../../assets/artwork/team-wide.webp'),
    square: require('../../assets/artwork/team-square.webp'),
  },
  park: {
    wide: require('../../assets/artwork/park-wide.webp'),
    square: require('../../assets/artwork/park-square.webp'),
  },
};

/** Empty-state and outcome illustrations: 4:3 (800×600), transparent, for light and dark pages. */
export const ILLUSTRATION_NAMES = [
  'empty-home',
  'empty-calendar',
  'empty-teams',
  'empty-cart',
  'empty-inbox',
  'empty-search',
  'empty-family',
  'empty-payments',
  'offline',
  'success',
] as const;
export type IllustrationName = (typeof ILLUSTRATION_NAMES)[number];

export const illustrations: Readonly<Record<IllustrationName, ArtworkSource>> = {
  'empty-home': require('../../assets/artwork/empty-home.webp'),
  'empty-calendar': require('../../assets/artwork/empty-calendar.webp'),
  'empty-teams': require('../../assets/artwork/empty-teams.webp'),
  'empty-cart': require('../../assets/artwork/empty-cart.webp'),
  'empty-inbox': require('../../assets/artwork/empty-inbox.webp'),
  'empty-search': require('../../assets/artwork/empty-search.webp'),
  'empty-family': require('../../assets/artwork/empty-family.webp'),
  'empty-payments': require('../../assets/artwork/empty-payments.webp'),
  offline: require('../../assets/artwork/offline.webp'),
  success: require('../../assets/artwork/success.webp'),
};

/** Onboarding pages: 3:4 (1080×1440). */
export const ONBOARDING_ART = ['welcome', 'family', 'pass'] as const;
export type OnboardingArt = (typeof ONBOARDING_ART)[number];

export const onboardingArtwork: Readonly<Record<OnboardingArt, ArtworkSource>> = {
  welcome: require('../../assets/artwork/onboarding-welcome.webp'),
  family: require('../../assets/artwork/onboarding-family.webp'),
  pass: require('../../assets/artwork/onboarding-pass.webp'),
};

/** The Home band: 21:9 (1470×630), by facility-local time of day (`homeBandFor`). */
export const HOME_BANDS = ['day', 'night'] as const;
export type HomeBand = (typeof HOME_BANDS)[number];

export const homeBand: Readonly<Record<HomeBand, ArtworkSource>> = {
  day: require('../../assets/artwork/home-day.webp'),
  night: require('../../assets/artwork/home-night.webp'),
};
