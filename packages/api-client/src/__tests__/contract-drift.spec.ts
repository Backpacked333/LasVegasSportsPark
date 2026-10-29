/**
 * Drift checks between the client and the API's published contract (spec §4.8 "Publish exact
 * schemas in OpenAPI before client integration", §4.10 error codes).
 */
import { readFileSync } from 'node:fs';
import {
  CLIENT_INFO_HEADER as API_CLIENT_INFO_HEADER,
  ErrorCodes,
  parseClientIdentity,
} from '@sportspark/contracts';
import { describe, expect, it } from 'vitest';
import { GENERATED_PATHS, renderPaths } from '../../scripts/generate';
import { CLIENT_INFO_HEADER, formatClientInfo, parseClientInfo } from '../client-info';
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

  it('formats X-Sportspark-Client exactly as the API reads it (K-03, SPK-AT-027)', () => {
    expect(CLIENT_INFO_HEADER.toLowerCase()).toBe(API_CLIENT_INFO_HEADER);
    const samples = [
      'sportspark-mobile/1.2.0 (ios)',
      'sportspark-mobile/2.0.0-beta.3 (android)',
      'sportspark-staff/0.1.0 (web)',
      'sportspark-mobile/1.2 (ios)',
      'sportspark-tv/1.0.0 (ios)',
      'sportspark-mobile/1.0.0 (windows)',
    ];
    for (const sample of samples) {
      const api = parseClientIdentity(sample);
      expect(parseClientInfo(sample), sample).toEqual(api);
      if (api) expect(formatClientInfo(api)).toBe(sample);
    }
    // The client never formats a value the API would refuse.
    expect(() => formatClientInfo({ app: 'mobile', platform: 'ios', version: '1.2' })).toThrow();
  });
});
