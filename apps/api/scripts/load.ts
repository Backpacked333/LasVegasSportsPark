/**
 * Workload rehearsal against a running API (spec §5.10, §5.9). Creates synthetic people through
 * the API, then runs the read mix of the manifest for its duration with the manifest's sessions
 * (scaled), and writes a report with percentiles per workflow against the §5.9 targets, the build
 * and the environment, for a release evidence ledger row (§6.8 item 11). Numbers measured on a
 * developer machine are rehearsals, not capacity (§5.10).
 *
 *   pnpm --filter @sportspark/api dev:all -- --seed --seed-summary /tmp/seed.json   # one shell
 *   pnpm --filter @sportspark/api load -- --base-url http://localhost:3000 \
 *     --seed-summary /tmp/seed.json --scale 0.01 --duration 30 --out load-report.json
 *
 * Against staging, set DEV_TOKENS_PASSCODE for the development sign-in.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { scaleManifest, WorkloadManifestSchema } from '../src/dev/load/manifest';
import { seededRandom, summarize, type Sample } from '../src/dev/load/stats';

interface Args {
  baseUrl: string;
  seedSummary: string;
  manifest: string;
  scale: number;
  duration: number | null;
  out: string | null;
}

function parseArgs(argv: readonly string[]): Args {
  const value = (name: string) => {
    const at = argv.indexOf(name);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const baseUrl = value('--base-url') ?? 'http://localhost:3000';
  const seedSummary = value('--seed-summary');
  if (!seedSummary) throw new Error('--seed-summary <file> is required (dev:all --seed-summary)');
  return {
    baseUrl: baseUrl.replace(/\/$/, ''),
    seedSummary,
    manifest: value('--manifest') ?? path.resolve(__dirname, '../load/workload.manifest.json'),
    scale: Number(value('--scale') ?? '0.01'),
    duration: value('--duration') ? Number(value('--duration')) : null,
    out: value('--out') ?? null,
  };
}

async function timed(url: string, init: RequestInit): Promise<Sample> {
  const started = performance.now();
  try {
    const res = await fetch(url, init);
    await res.arrayBuffer();
    return { ms: performance.now() - started, status: res.status };
  } catch {
    return { ms: performance.now() - started, status: 0 };
  }
}

async function token(base: string, accountId: string): Promise<string> {
  const res = await fetch(`${base}/v1/dev/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId, passcode: process.env['DEV_TOKENS_PASSCODE'] }),
  });
  if (!res.ok) throw new Error(`development sign-in failed for ${accountId}: ${res.status}`);
  return ((await res.json()) as { token: string }).token;
}

const GIVEN = ['Ana', 'Ben', 'Carla', 'Dev', 'Eli', 'Fatima', 'Gus', 'Hana', 'Ivan', 'Jo'];
const FAMILY = ['Garcia', 'Smith', 'Nguyen', 'Patel', 'Kim', 'Lopez', 'Brown', 'Chen', 'Diaz'];

/** Runs `worker` in `concurrency` loops until `until`, each loop pausing `pauseMs` between calls. */
async function loops(
  concurrency: number,
  until: number,
  pauseMs: number,
  worker: () => Promise<Sample>,
): Promise<Sample[]> {
  const samples: Sample[] = [];
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (performance.now() < until) {
        samples.push(await worker());
        if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
      }
    }),
  );
  return samples;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const manifestText = readFileSync(args.manifest, 'utf8');
  const manifest = scaleManifest(
    WorkloadManifestSchema.parse(JSON.parse(manifestText)),
    args.scale,
  );
  const seed = JSON.parse(readFileSync(args.seedSummary, 'utf8')) as {
    accounts: Array<{ subject: string; accountId: string }>;
  };
  const account = (subject: string) => {
    const found = seed.accounts.find((a) => a.subject === subject);
    if (!found) throw new Error(`the seed has no ${subject} account`);
    return found.accountId;
  };
  const base = args.baseUrl;
  const admin = await token(base, account('dev-admin'));
  const desk = await token(base, account('dev-desk'));
  const parent = await token(base, account('dev-parent'));
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  // Setup: synthetic people, created through the identity module's own command (§4.2).
  const random = seededRandom(5_10);
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)] as T;
  const people = manifest.envelope.people;
  const setupStarted = performance.now();
  const setup: Sample[] = [];
  for (let i = 0; i < people; i += 10) {
    const batch = Array.from({ length: Math.min(10, people - i) }, () =>
      timed(`${base}/v1/people`, {
        method: 'POST',
        headers: {
          ...auth(admin),
          'Content-Type': 'application/json',
          'Idempotency-Key': randomUUID(),
        },
        body: JSON.stringify({ kind: 'adult', givenName: pick(GIVEN), familyName: pick(FAMILY) }),
      }),
    );
    setup.push(...(await Promise.all(batch)));
  }
  const setupSeconds = (performance.now() - setupStarted) / 1000;

  // The read mix for the manifest's duration.
  const duration = args.duration ?? manifest.durationSeconds;
  const until = performance.now() + duration * 1000;
  const perMinute = (rate: number) => Math.max(0, Math.round(60_000 / rate));
  const [staffLookup, customerReads, readiness] = await Promise.all([
    loops(
      manifest.envelope.activeStaffOrScannerSessions,
      until,
      perMinute(manifest.arrivalRates.staffLookupPerSessionPerMinute),
      () =>
        timed(`${base}/v1/people?query=${encodeURIComponent(pick(FAMILY).slice(0, 3))}&limit=25`, {
          headers: auth(desk),
        }),
    ),
    loops(
      manifest.envelope.activeCustomerSessions,
      until,
      perMinute(manifest.arrivalRates.customerReadsPerSessionPerMinute),
      () => timed(`${base}/v1/me/permissions`, { headers: auth(parent) }),
    ),
    loops(1, until, perMinute(manifest.arrivalRates.readinessProbesPerMinute), () =>
      timed(`${base}/v1/ready`, {}),
    ),
  ]);

  const ready = (await (await fetch(`${base}/v1/ready`)).json()) as Record<string, unknown>;
  let commit = 'unknown';
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    // Not a checkout: the report says so.
  }
  const staff = summarize(staffLookup);
  const report = {
    kind: 'workload rehearsal (§5.10); not capacity or a facility fact',
    measuredAt: new Date().toISOString(),
    build: { commit, apiVersion: ready['version'] ?? null },
    environment: { baseUrl: base, node: process.version, readiness: ready['status'] ?? null },
    manifest: {
      file: path.relative(process.cwd(), args.manifest),
      sha256: createHash('sha256').update(manifestText).digest('hex'),
      scale: args.scale,
      envelope: manifest.envelope,
      durationSeconds: duration,
    },
    setup: {
      peopleCreated: setup.filter((s) => s.status === 201).length,
      seconds: setupSeconds,
      ...summarize(setup),
    },
    workflows: {
      staffLookup: {
        ...staff,
        targetP95Ms: manifest.targets.staffLookupP95Ms,
        meetsTarget: staff.p95Ms !== null && staff.p95Ms <= manifest.targets.staffLookupP95Ms,
      },
      customerReads: summarize(customerReads),
      readinessProbes: summarize(readiness),
    },
  };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (args.out) writeFileSync(args.out, text);
  process.stdout.write(text);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
