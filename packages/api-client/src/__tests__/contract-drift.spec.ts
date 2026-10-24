/**
 * Drift checks between the client and the API's published contract (spec §4.8 "Publish exact
 * schemas in OpenAPI before client integration", §4.10 error codes).
 */
import { readFileSync } from 'node:fs';
import { ErrorCodes } from '@sportspark/contracts';
import { describe, expect, it } from 'vitest';
import { GENERATED_PATHS, renderPaths } from '../../scripts/generate';
import { API_ERROR_CODES } from '../errors';

describe('contract drift', () => {
  it('src/generated/paths.ts is current against docs/api/openapi.json (run `pnpm --filter @sportspark/api-client generate`)', async () => {
    const expected = await renderPaths();
    const committed = readFileSync(GENERATED_PATHS, 'utf8');
    // Compare lengths first so a stale file fails with a short message, not a 39k-line diff.
    expect(committed.length, 'paths.ts is stale: regenerate it').toBe(expected.length);
    expect(committed === expected, 'paths.ts is stale: regenerate it').toBe(true);
  });

  it('knows exactly the error codes that packages/contracts defines (§4.10)', () => {
    expect([...API_ERROR_CODES].sort()).toEqual(Object.keys(ErrorCodes).sort());
  });
});
