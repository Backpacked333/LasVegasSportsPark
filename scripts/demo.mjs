#!/usr/bin/env node
// Demo launcher: `pnpm demo` starts the software in demo mode for walkthroughs.
//
//   1. Seeds a separate demo database (.pglite-demo/) with the development seed: one organization,
//      one facility in Las Vegas time, and one sign-in account per role (desk, league manager,
//      administrator, coach, official, parent with a child), with the optional modules turned on.
//   2. Starts the API with its local identity provider (development only, never production).
//   3. Starts the staff dashboard in demo mode with the seeded accounts, so its role picker can
//      sign in as each role. `--mobile` also starts the mobile app (Expo) in demo mode.
//
// The demo database is separate from the one `pnpm --filter @sportspark/api dev` uses. Delete
// .pglite-demo/ (or pass --fresh) to start the demo from an empty database again. The API's worker
// process does not run (PGlite allows one process), so follow-ups that only the worker performs,
// such as notices and expiries, do not happen in the demo.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const dataDir = path.join(root, '.pglite-demo');
const TIMEZONE = 'America/Los_Angeles';
// Every optional module is on in the demo so each role can see all of its screens (DEC-016 keeps
// them off by default in real deployments).
const CAPABILITIES = [
  'memberships',
  'session_packages',
  'rentals',
  'parties',
  'tournaments',
  'point_of_sale',
  'accounting',
  'youth_progression',
  'pickup_sessions',
  'installments',
  'supervised_pickup',
  'advanced_fairness',
  'retention_tools',
];

if (args.has('--help')) {
  console.log(
    'pnpm demo [--fresh] [--mobile]\n  --fresh   start from an empty demo database\n  --mobile  also start the mobile app in demo mode',
  );
  process.exit(0);
}
if (args.has('--fresh')) rmSync(dataDir, { recursive: true, force: true });

const apiEnv = {
  ...process.env,
  NODE_ENV: 'development',
  AUTH_MODE: 'local',
  AUTH_LOCAL_SECRET: randomBytes(32).toString('hex'),
  PGLITE_DATA_DIR: dataDir,
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

/** The seed prints its summary as JSON, then a sign-in hint; return the summary. */
function parseSeedSummary(output) {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('\nSign in:');
  if (start < 0) throw new Error(`Seed printed no summary:\n${output}`);
  return JSON.parse(output.slice(start, end > start ? end : undefined));
}

console.log('Seeding the demo database (builds the API first)...');
const seedArgs = ['--filter', '@sportspark/api', 'seed:dev', '--timezone', TIMEZONE];
for (const id of CAPABILITIES) seedArgs.push('--enable', id);
const summary = parseSeedSummary(await run('pnpm', seedArgs, apiEnv, true));
const accounts = Object.fromEntries(summary.accounts.map((a) => [a.subject, a.accountId]));

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

start('API', ['--filter', '@sportspark/api', 'exec', 'node', 'dist/main.js'], apiEnv);
start('Staff dashboard', ['--filter', '@sportspark/staff', 'dev:demo'], {
  ...process.env,
  VITE_DEMO_ACCOUNTS: JSON.stringify(accounts),
});
if (args.has('--mobile')) {
  // Development server only: demo mode is not in release builds of the app.
  start('Mobile app', ['--filter', '@sportspark/mobile', 'start'], {
    ...process.env,
    SPORTSPARK_APP_MODE: 'demo',
    SPORTSPARK_DEMO_ACCOUNTS: JSON.stringify(accounts),
  });
}

console.log(`
Demo running with sample data.
  Staff dashboard: http://localhost:5173  (pick a role on the sign-in screen)
  API:             http://localhost:3000
${args.has('--mobile') ? '  Mobile app:      see the Expo output above; sign in as the parent\n' : ''}Press Ctrl+C to stop.`);
