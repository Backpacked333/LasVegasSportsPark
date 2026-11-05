/**
 * The seeded demo accounts, by seed subject (`dev-desk`, `dev-league`, ...). The ids are random per
 * seeded database, so `pnpm demo` reads them from the seed's output and hands them to the demo
 * build as VITE_DEMO_ACCOUNTS. Anything that is not a subject-to-UUID map is ignored.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DemoAccounts = Readonly<Record<string, string>>;

export function parseDemoAccounts(raw: string | undefined | null): DemoAccounts {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const out: Record<string, string> = {};
    for (const [subject, id] of Object.entries(value)) {
      if (typeof id === 'string' && UUID.test(id)) out[subject] = id;
    }
    return out;
  } catch {
    return {};
  }
}

export function demoAccountsFromEnv(): DemoAccounts {
  return parseDemoAccounts(import.meta.env.VITE_DEMO_ACCOUNTS);
}
