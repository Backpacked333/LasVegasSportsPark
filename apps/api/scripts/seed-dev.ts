/**
 * Development seed for local sign-in (K-14, §5.2): synthetic organization `dev`, facility
 * `dev-facility` and six local accounts (dev-admin, dev-desk, dev-league, dev-coach, dev-official,
 * dev-parent with a child). Idempotent; refuses unless NODE_ENV is development or test and
 * AUTH_MODE=local. Enables no capability unless asked (`--enable <capability>`, recorded with
 * DEC-016).
 *
 *   pnpm --filter @sportspark/api seed:dev [--timezone America/Los_Angeles] [--enable rentals]
 *
 * The script loads the compiled application (`dist/`, built by the package script first): Nest
 * resolves constructor dependencies from the decorator metadata `tsc` emits, which tsx does not.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { CapabilityIdSchema, type CapabilityId } from '@sportspark/contracts';
import { AppModule } from '../dist/app.module.js';
import { assertSeedAllowed, seedDevelopment } from '../dist/dev/seed-dev.js';
import { loadConfig } from '../dist/kernel/config.js';
import { closeDatabase } from '../dist/kernel/database/database.provider.js';
import { DATABASE } from '../dist/kernel/tokens.js';

function parseArgs(argv: readonly string[]): { timezone?: string; enable: CapabilityId[] } {
  const out: { timezone?: string; enable: CapabilityId[] } = { enable: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === '--timezone' && value) {
      out.timezone = value;
      i += 1;
    } else if (arg === '--enable' && value) {
      out.enable.push(CapabilityIdSchema.parse(value));
      i += 1;
    } else if (arg !== '--') {
      throw new Error(
        `unknown argument ${arg}; use --timezone <IANA zone> and --enable <capability>`,
      );
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  assertSeedAllowed(config);
  const app = await NestFactory.createApplicationContext(AppModule.forRoot({ config }), {
    logger: ['error', 'warn'],
  });
  try {
    const summary = await seedDevelopment(app, args);
    console.log(JSON.stringify(summary, null, 2));
    console.log(
      `\nSign in: POST /v1/dev/tokens with ${JSON.stringify(summary.devTokens.body)} (any accountId above).`,
    );
  } finally {
    const db = app.get(DATABASE);
    await app.close();
    await closeDatabase(db);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
