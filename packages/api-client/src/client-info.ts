/**
 * Client identification (spec §4.13: API compatibility window and minimum supported app version;
 * SPK-AT-027 "Old mobile app contacts updated API: supported behavior or clear update requirement").
 *
 * The API kernel defines no client compatibility header today (verified absence in
 * apps/api/src/kernel, 2026-10-24), so the name is proposed here, once, for the API to adopt with
 * the version gate (DEC-061, DEC-092). Every request carries it.
 */
export const CLIENT_INFO_HEADER = 'X-Sportspark-Client';

export type ClientApp = 'mobile' | 'staff';
export type ClientPlatform = 'ios' | 'android' | 'web';

export interface ClientInfo {
  app: ClientApp;
  platform: ClientPlatform;
  /** The build's app version (semver), from the app configuration. */
  version: string;
}

/** `sportspark-mobile/0.1.0 (ios)`: product token, version, platform. No device or user data. */
export function formatClientInfo(info: ClientInfo): string {
  if (!/^[0-9A-Za-z.+-]+$/.test(info.version)) {
    throw new Error(`Invalid client version: ${info.version}`);
  }
  return `sportspark-${info.app}/${info.version} (${info.platform})`;
}

export function parseClientInfo(value: string): ClientInfo | null {
  const match = /^sportspark-(mobile|staff)\/([0-9A-Za-z.+-]+) \((ios|android|web)\)$/.exec(value);
  if (!match) return null;
  return {
    app: match[1] as ClientApp,
    version: match[2] as string,
    platform: match[3] as ClientPlatform,
  };
}
