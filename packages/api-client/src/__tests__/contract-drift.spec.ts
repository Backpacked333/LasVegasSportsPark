/**
 * Drift checks between the client and the API's published contract (spec §4.8 "Publish exact
 * schemas in OpenAPI before client integration", §4.10 error codes).
 */
import { readFileSync } from 'node:fs';
import {
  CAPABILITIES,
  CAPABILITY_IDS as API_CAPABILITY_IDS,
  CLIENT_INFO_HEADER as API_CLIENT_INFO_HEADER,
  ErrorCodes,
  NAVIGATION_AREA_IDS,
  parseClientIdentity,
} from '@sportspark/contracts';
import { describe, expect, it } from 'vitest';
import { GENERATED_PATHS, renderPaths } from '../../scripts/generate';
import { CAPABILITY_DISABLED_CODE, CAPABILITY_IDS, CAPABILITY_PRESENTATION } from '../capabilities';
import { CLIENT_INFO_HEADER, formatClientInfo, parseClientInfo } from '../client-info';
import { API_ERROR_CODES } from '../errors';
import { NAVIGATION_AREAS } from '../permissions';
import { fakePermissions } from '../testing';

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

  it('names, per capability, exactly the decisions packages/contracts lets turn it on (K-12, DEC-016)', () => {
    expect([...CAPABILITY_IDS].sort()).toEqual([...API_CAPABILITY_IDS].sort());
    for (const id of API_CAPABILITY_IDS) {
      expect([...CAPABILITY_PRESENTATION[id].decisions], id).toEqual([
        ...CAPABILITIES[id].applicabilityReferences,
      ]);
    }
    // The kernel's CapabilityService.require sends this details.code (no new error code, DEC-092).
    expect(CAPABILITY_DISABLED_CODE).toBe('CAPABILITY_DISABLED');
    // The test double answers each switch with the enforcement the kernel reports.
    for (const c of fakePermissions().capabilities) {
      expect(c.enforcement, c.id).toBe(CAPABILITIES[c.id].enforcement);
    }
  });

  it('lists the fourteen SPK-UX-005 navigation areas of packages/contracts, in order (K-05)', () => {
    expect([...NAVIGATION_AREAS]).toEqual([...NAVIGATION_AREA_IDS]);
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
