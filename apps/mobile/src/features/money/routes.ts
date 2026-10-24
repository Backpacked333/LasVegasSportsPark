/**
 * Routes of SCR-C-32 to SCR-C-38 (files under app/enrollments, app/payments, app/credits,
 * app/youth-feedback.tsx and app/support.tsx). Parameters are opaque record ids only: no names,
 * dates of birth or other child data ever appear in a route, and the person being looked at is
 * screen state, not a route parameter (§4.14).
 *
 * The Account hub (SCR-C-30) links its sections here through `ACCOUNT_SECTION_ROUTES`.
 */
export const moneyRoutes = {
  enrollments: () => '/enrollments' as const,
  enrollment: (enrollmentId: string) => `/enrollments/${enrollmentId}` as const,
  cancel: (enrollmentId: string) => `/enrollments/${enrollmentId}/cancel` as const,
  transfer: (enrollmentId: string) => `/enrollments/${enrollmentId}/transfer` as const,
  payments: () => '/payments' as const,
  obligation: (obligationId: string) => `/payments/${obligationId}` as const,
  credits: () => '/credits' as const,
  makeup: (makeupId: string) => `/credits/makeup/${makeupId}` as const,
  youthFeedback: () => '/youth-feedback' as const,
  support: () => '/support' as const,
};

/** Account hub sections (SCR-C-30) that open the screens of this group. */
export const ACCOUNT_SECTION_ROUTES = {
  'SCR-C-32': moneyRoutes.enrollments(),
  'SCR-C-34': moneyRoutes.payments(),
  'SCR-C-35': moneyRoutes.credits(),
  'SCR-C-37': moneyRoutes.youthFeedback(),
  'SCR-C-38': moneyRoutes.support(),
} as const;

/** First value of a route parameter (Expo Router gives a string or an array). */
export function param(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? '';
}
