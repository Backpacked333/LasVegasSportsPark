/**
 * Expo Router `+native-intent` handler (SCR-C-39, §4.13): every URL the operating system opens the
 * app with goes through `safeSystemPath`, so only Home and the link landing open from outside.
 */
import { readAppConfig } from '../config/app-config';
import { safeSystemPath } from './link-targets';

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    return safeSystemPath(path, {
      development: __DEV__,
      verifiedHosts: readAppConfig().verifiedLinkHosts ?? [],
    });
  } catch {
    // Never crash on a hostile or damaged URL: land on "Link not available".
    return '/link?problem=unsupported';
  }
}
