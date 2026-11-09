#!/usr/bin/env node
/**
 * Dependency scanning gate (spec §4.14 "dependency and secret scanning"). Runs
 * `pnpm audit --prod --json` and fails when a high or critical advisory affects a production
 * dependency, unless `.github/audit-allowlist.json` lists that advisory with a reason, an owner and
 * a review-by date that has not passed. Lower severities are printed, not gated.
 *
 *   node scripts/audit-gate.mjs [path/to/audit.json]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const GATED = new Set(['high', 'critical']);

function readAudit() {
  const file = process.argv[2];
  if (file) return JSON.parse(readFileSync(file, 'utf8'));
  try {
    return JSON.parse(execFileSync('pnpm', ['audit', '--prod', '--json'], { encoding: 'utf8' }));
  } catch (error) {
    // pnpm audit exits non-zero when it finds anything; its JSON is still on stdout.
    if (error.stdout) return JSON.parse(error.stdout);
    throw error;
  }
}

const audit = readAudit();
const allowlist = JSON.parse(
  readFileSync(new URL('../.github/audit-allowlist.json', import.meta.url), 'utf8'),
);
const today = new Date().toISOString().slice(0, 10);
const allowed = new Map(allowlist.advisories.map((a) => [a.id, a]));

const blocking = [];
const accepted = [];
const reported = [];
for (const advisory of Object.values(audit.advisories ?? {})) {
  const id = advisory.github_advisory_id;
  const where = advisory.findings
    .flatMap((f) => f.paths)
    .slice(0, 3)
    .join('; ');
  const line = `${advisory.severity} ${id} ${advisory.module_name}@${advisory.vulnerable_versions} (${where})`;
  if (!GATED.has(advisory.severity)) {
    reported.push(line);
    continue;
  }
  const entry = allowed.get(id);
  if (entry && entry.reviewBy >= today)
    accepted.push(
      `${line}\n    accepted until ${entry.reviewBy} (${entry.owner}): ${entry.reason}`,
    );
  else if (entry)
    blocking.push(`${line}\n    allowlist entry expired on ${entry.reviewBy}: review it`);
  else blocking.push(line);
}

for (const line of reported) console.log(`report  ${line}`);
for (const line of accepted) console.log(`accept  ${line}`);
for (const line of blocking) console.log(`BLOCK   ${line}`);
console.log(
  `\n${blocking.length} blocking, ${accepted.length} accepted (allowlist), ${reported.length} below the gate`,
);
process.exit(blocking.length > 0 ? 1 : 0);
