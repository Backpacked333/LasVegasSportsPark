/**
 * Screens of the seeded demo dataset the tours open on a record (a season, an offering, a rental),
 * by name. The ids are random per seeded database, so `pnpm demo` reads the paths from the seed's
 * summary (`demo.tourLinks` and `demo.publicLinks` of apps/api/src/dev/seed-demo.ts) and hands
 * them to the demo build as VITE_DEMO_LINKS. A step names a link and a fallback screen; without
 * the link (the demo database was not seeded with the dataset) the tour opens the fallback.
 */
export const DEMO_LINK_NAMES = [
  'season',
  'seasonResults',
  'standings',
  'competition',
  'teamEntries',
  'messageSchedule',
  'perSessionClass',
  'memberClass',
  'camp',
  'campUniforms',
  'waitlist',
  'registerSession',
  'openAmountSale',
  'rentalRoster',
  'paperWaiverPerson',
  'missingWaiverPerson',
  // Pages that need no sign-in.
  'lobby',
  'publicSchedule',
  'publicStandings',
  'publicFixtures',
] as const;

export type DemoLinkName = (typeof DEMO_LINK_NAMES)[number];
export type DemoLinks = Readonly<Partial<Record<DemoLinkName, string>>>;

/** Keeps only known names that map to a path of this application (never another origin). */
export function parseDemoLinks(raw: string | undefined | null): DemoLinks {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const out: Partial<Record<DemoLinkName, string>> = {};
    for (const name of DEMO_LINK_NAMES) {
      const path = (value as Record<string, unknown>)[name];
      if (typeof path === 'string' && /^\/[^/\\]/.test(path)) out[name] = path;
    }
    return out;
  } catch {
    return {};
  }
}

export function demoLinksFromEnv(): DemoLinks {
  return parseDemoLinks(import.meta.env.VITE_DEMO_LINKS as string | undefined);
}

/** Where a tour step opens: its seeded record when the demo has it, otherwise its fallback. */
export function stepPath(
  step: { path: string; link?: DemoLinkName | undefined },
  links: DemoLinks,
): string {
  return (step.link ? links[step.link] : undefined) ?? step.path;
}
