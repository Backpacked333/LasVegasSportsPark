/**
 * Demo dataset (ADR-007): the development seed (organization `dev`, facility `dev-facility` in
 * Las Vegas time, six sign-in accounts) and, on top of it, a facility to walk through: spaces,
 * programs with prices, families and registrations, a league with results and standings, rentals,
 * a register session, message templates and a schedule, with every capability turned on. Built by
 * calling the modules' services, never by writing their tables. Idempotent; refuses unless
 * NODE_ENV is development or test and AUTH_MODE=local. Everything in it is synthetic.
 *
 *   pnpm --filter @sportspark/api seed:demo
 *
 * Prints the summary as one JSON object (the accounts first), then the "Sign in:" hint and the
 * public links; progress goes to standard error so the output stays parseable (`scripts/demo.mjs`
 * reads it). The script loads the compiled application (`dist/`, built by the package script).
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../dist/app.module.js';
import { assertSeedAllowed } from '../dist/dev/seed-dev.js';
import { seedDemo } from '../dist/dev/seed-demo.js';
import { loadConfig } from '../dist/kernel/config.js';
import { closeDatabase } from '../dist/kernel/database/database.provider.js';
import { DATABASE } from '../dist/kernel/tokens.js';

async function main(): Promise<void> {
  const unknown = process.argv.slice(2).filter((arg) => arg !== '--');
  if (unknown.length > 0) {
    throw new Error(`unknown argument ${unknown[0]}; seed:demo takes none`);
  }
  const config = loadConfig();
  assertSeedAllowed(config);
  // Errors only: Nest writes other levels to standard output, which carries the summary.
  const app = await NestFactory.createApplicationContext(AppModule.forRoot({ config }), {
    logger: ['error'],
  });
  try {
    const summary = await seedDemo(app, { log: (line) => console.error(`seed:demo ${line}`) });
    console.log(JSON.stringify(summary, null, 2));
    console.log(
      `\nSign in: POST /v1/dev/tokens with ${JSON.stringify(summary.devTokens.body)} (any accountId above).`,
    );
    for (const [name, path] of Object.entries(summary.demo.publicLinks)) {
      console.log(`Public link (${name}, no sign-in): ${path}`);
    }
    for (const missing of summary.demo.notCreated) {
      console.error(`seed:demo could not create ${missing.what}: ${missing.why}`);
    }
  } finally {
    const db = app.get(DATABASE);
    await app.close();
    await closeDatabase(db);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    // A refused command says why in its details (which field, which rule).
    const details = (error as { details?: unknown } | null)?.details;
    if (details !== undefined) console.error(JSON.stringify(details, null, 2));
    process.exit(1);
  });
