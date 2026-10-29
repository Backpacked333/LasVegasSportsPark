/**
 * Client identification (spec §4.13: API compatibility window and minimum supported app version;
 * SPK-AT-027 "Old mobile app contacts updated API: supported behavior or clear update requirement").
 *
 * Every request carries it. The API kernel's client-compatibility guard reads it
 * (apps/api/src/kernel/http/client-compatibility.guard.ts): a build below the minimum configured
 * for its app and platform gets 426 CLIENT_UPDATE_REQUIRED (DEC-092 proposed); the minimum versions
 * are pending DEC-061, so none is enforced by default.
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
