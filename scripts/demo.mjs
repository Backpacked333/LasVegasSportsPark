#!/usr/bin/env node
// Demo launcher: `pnpm demo` starts the software in demo mode for walkthroughs.
//
//   1. Seeds a separate demo database (.pglite-demo/) with the demo dataset (ADR-007): one
//      organization, one facility in Las Vegas time, one sign-in account per role (desk, league
//      manager, administrator, coach, official, parent with a child) and a facility's worth of
//      sample data built through the modules' own services: spaces, programs and prices, families
//      and registrations, a league with results and standings, rentals, a register session and
//      message templates. Every optional module is turned on by the seed (the list is the API's
//      own `CAPABILITY_IDS`; DEC-016 keeps them off by default in real deployments).
//   2. Starts the API with its local identity provider (development only, never production) and
//      the worker's loops in the same process, so follow-ups happen while you walk through:
//      standings after a result, notices, a confirmed message being sent.
//   3. Starts the staff dashboard in demo mode with the seeded accounts and the screens the tours
//      open, so its role picker can sign in as each role. `--mobile` also starts the mobile app
//      (Expo) in demo mode. `--web` starts the mobile app's browser preview instead (Expo web on
//      http://localhost:8081, development only), allows that origin on the demo API
//      (`CORS_ALLOWED_ORIGINS`) and is what `apps/mobile/scripts/screenshots.mjs` runs against.
//
// The demo database is separate from the one `pnpm --filter @sportspark/api dev` uses. Delete
// .pglite-demo/ (or pass --fresh) to start the demo from an empty database again; without it the
// seed finds what it created before and adds nothing twice. Everything in the dataset is
// synthetic, and its dates are counted from the day it was seeded: after a few days, start fresh.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const dataDir = path.join(root, '.pglite-demo');
const STAFF_URL = 'http://localhost:5173';
const API_URL = 'http://localhost:3000';
const MOBILE_WEB_URL = 'http://localhost:8081';
const mobile = args.has('--mobile');
const web = args.has('--web');

if (args.has('--help')) {
  console.log(
    'pnpm demo [--fresh] [--mobile | --web]\n  --fresh   start from an empty demo database\n  --mobile  also start the mobile app in demo mode\n  --web     also start the mobile app in demo mode in a browser (development preview, port 8081)',
  );
  process.exit(0);
}
if (mobile && web) {
  console.error('Pass --mobile or --web, not both: each starts the mobile development server.');
  process.exit(1);
}
if (args.has('--fresh')) rmSync(dataDir, { recursive: true, force: true });

const apiEnv = {
  ...process.env,
  NODE_ENV: 'development',
  AUTH_MODE: 'local',
  AUTH_LOCAL_SECRET: randomBytes(32).toString('hex'),
  PGLITE_DATA_DIR: dataDir,
  // The browser preview of the mobile app is served from another origin than the API.
  ...(web ? { CORS_ALLOWED_ORIGINS: MOBILE_WEB_URL } : {}),
};
delete apiEnv.DATABASE_URL;

function run(command, commandArgs, env, capture) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: root,
      env,
      stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    });
    let out = '';
    if (capture) child.stdout.on('data', (chunk) => (out += chunk));
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0
        ? resolve(out)
        : reject(new Error(`${command} ${commandArgs.join(' ')} exited ${code}`)),
    );
  });
}

/**
 * The seed prints its summary as one JSON object whose first key is `organization`, then a
 * sign-in hint and the public links; return the summary. Anything printed before the object (the
 * package manager's banner) is skipped.
 */
function parseSeedSummary(output) {
  const start = output.search(/^\{\s*"organization"/m);
  const end = output.lastIndexOf('\nSign in:');
  if (start < 0) throw new Error(`Seed printed no summary:\n${output}`);
  return JSON.parse(output.slice(start, end > start ? end : undefined));
}

console.log('Building the API and seeding the demo database (about a minute)...');
const summary = parseSeedSummary(
  await run('pnpm', ['--filter', '@sportspark/api', 'seed:demo'], apiEnv, true),
);
// The six accounts of the development seed and the ones the dataset adds (the general manager).
const accounts = Object.fromEntries(
  [...summary.accounts, ...(summary.demo?.accounts ?? [])].map((a) => [a.subject, a.accountId]),
);
const publicLinks = summary.demo?.publicLinks ?? {};
const tourLinks = { ...(summary.demo?.tourLinks ?? {}), ...publicLinks };

const children = [];
function start(name, commandArgs, env) {
  const child = spawn('pnpm', commandArgs, { cwd: root, env, stdio: 'inherit' });
  child.on('exit', (code) => {
    console.log(`${name} stopped (${code ?? 'signal'}). Stopping the demo.`);
    stopAll();
  });
  children.push(child);
}
function stopAll() {
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  process.exitCode = 0;
}
process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);

// The API and the worker's loops in one process (PGlite allows one process to open the database).
// The demo API signs anyone in as a seeded account, so it answers this machine only. A phone
// running the customer app needs it on the local network: `--mobile` opens it there.
const apiArgs = ['--filter', '@sportspark/api', 'exec', 'node', 'dist/dev-all.js'];
if (mobile) {
  apiArgs.push('--lan');
  console.log(
    'The demo API is reachable from this network while --mobile runs (it has no real sign-in).',
  );
}
start('API', apiArgs, apiEnv);
start('Staff dashboard', ['--filter', '@sportspark/staff', 'dev:demo'], {
  ...process.env,
  VITE_DEMO_ACCOUNTS: JSON.stringify(accounts),
  VITE_DEMO_LINKS: JSON.stringify(tourLinks),
});
// The mobile app's demo environment, the same for the device (--mobile) and the browser (--web).
const mobileEnv = {
  ...process.env,
  SPORTSPARK_APP_MODE: 'demo',
  SPORTSPARK_DEMO_ACCOUNTS: JSON.stringify(accounts),
  // Discover and the public schedule start from the organization's public slug.
  SPORTSPARK_ORGANIZATION_SLUG: summary.organization.slug,
  SPORTSPARK_API_BASE_URL: process.env.SPORTSPARK_API_BASE_URL ?? `${API_URL}/v1`,
};
if (mobile) {
  // Development server only: demo mode is not in release builds of the app.
  start('Mobile app', ['--filter', '@sportspark/mobile', 'start'], mobileEnv);
}
if (web) {
  // Browser preview (development only): one page, served by Metro, no reloads (CI mode).
  // `--clear`: the web bundle embeds the app config, so a bundle cached from a run without the
  // demo environment would start in real mode.
  start(
    'Mobile app (web)',
    [
      '--filter',
      '@sportspark/mobile',
      'exec',
      'expo',
      'start',
      '--web',
      '--port',
      '8081',
      '--clear',
    ],
    { ...mobileEnv, CI: '1' },
  );
}

/** Waits until the API answers its readiness check, so the banner is the last thing printed. */
async function apiReady() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const res = await globalThis.fetch(`${API_URL}/v1/ready`);
      if (res.ok) return true;
    } catch {
      // not listening yet
    }
    await sleep(1000);
  }
  return false;
}

const link = (name) => (publicLinks[name] ? `${STAFF_URL}${publicLinks[name]}` : 'not created');
const missing = summary.demo?.notCreated ?? [];
const ready = await apiReady();
console.log(`
${ready ? 'Demo running' : 'Demo starting (the API has not answered yet)'} with sample data (synthetic people, dated from today).
  Staff dashboard:  ${STAFF_URL}  (pick a role on the sign-in screen)
  Lobby display:    ${link('lobby')}  (no sign-in)
  Public schedule:  ${link('publicSchedule')}  (no sign-in)
  Public standings: ${link('publicStandings')}  (no sign-in)
  API:              ${API_URL}
${mobile ? '  Mobile app:       see the Expo output above; sign in as the parent\n' : ''}${
  web ? `  Mobile app (web): ${MOBILE_WEB_URL}  (development preview; sign in as the parent)\n` : ''
}${
  missing.length > 0
    ? `  Not created:      ${missing.map((m) => `${m.what} (${m.why})`).join('; ')}\n`
    : ''
}Press Ctrl+C to stop.`);
