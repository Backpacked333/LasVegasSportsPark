/**
 * SCR-C-39 verified link landing: the safe deep-link destinations (§4.13, SPK-UX-001 "Verified
 * links into relevant activities and operations"). Which links count as verified, and on which
 * domains, is DEC-061 (Technical lead/operator): only the app scheme exists today, and a scheme
 * link is not proof of origin. So every link is untrusted input: it is parsed against a closed list
 * of destinations, ids must be UUIDs, and a link never performs an action by itself. The person
 * always sees the target and confirms (an invitation is accepted only by pressing Accept).
 *
 * Link format (engineering proposal, not a policy value): `sportspark://link?to=<target>&...`.
 */

/** The app scheme from app.config.ts. */
export const APP_SCHEME = 'sportspark';
/** The one in-app route every external link is sent to (src/screens/link/LinkLandingScreen). */
export const LINK_LANDING_PATH = '/link';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Invitation and claim tokens are 16 to 512 characters (`Token` in packages/contracts). */
const TOKEN = /^[A-Za-z0-9_\-.~]{16,512}$/;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

export function isLinkToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN.test(value);
}

/** Where a validated link may lead. Nothing outside this list is ever opened from a link. */
export type LinkTarget =
  /** SCR-C-17: a guardian, caregiver or pickup-delegate invitation (SPK-IAM-004). */
  | { to: 'invitation'; id: string; token: string }
  /** SCR-C-17: a team invitation (SPK-CAP-001). */
  | { to: 'team-invitation'; id: string; token: string }
  /** SCR-C-01: a claim of a participant record entered at the desk (SPK-IAM-002). */
  | { to: 'claim'; token: string }
  /** An asynchronous outcome, shown in its current state (`GET /v1/operations/{id}`). */
  | { to: 'operation'; id: string }
  | { to: 'inbox' }
  | { to: 'account' }
  | { to: 'family' }
  | { to: 'preferences' };

export type LinkResolution =
  | { kind: 'target'; target: LinkTarget }
  /** Incomplete or damaged: a required part is missing or has the wrong form. */
  | { kind: 'malformed' }
  /** A destination this app does not open from links (or not yet). */
  | { kind: 'unsupported' };

type Params = Record<string, string | string[] | undefined>;

function single(params: Params, name: string): string | undefined {
  const value = params[name];
  if (Array.isArray(value)) return value.length === 1 ? value[0] : undefined;
  return value;
}

/** Validates the landing's query parameters. Unknown extra parameters are ignored, never used. */
export function resolveLinkParams(params: Params): LinkResolution {
  const to = single(params, 'to');
  if (to === undefined || to === '') {
    return single(params, 'problem') === 'unsupported'
      ? { kind: 'unsupported' }
      : { kind: 'malformed' };
  }
  const id = single(params, 'id');
  const token = single(params, 'token');
  switch (to) {
    case 'invitation':
    case 'team-invitation':
      return isUuid(id) && isLinkToken(token)
        ? { kind: 'target', target: { to, id: id.toLowerCase(), token } }
        : { kind: 'malformed' };
    case 'claim':
      return isLinkToken(token) ? { kind: 'target', target: { to, token } } : { kind: 'malformed' };
    case 'operation':
      return isUuid(id)
        ? { kind: 'target', target: { to, id: id.toLowerCase() } }
        : { kind: 'malformed' };
    case 'inbox':
    case 'account':
    case 'family':
    case 'preferences':
      return { kind: 'target', target: { to } };
    default:
      return { kind: 'unsupported' };
  }
}

/** The shareable link for a target (invitations sent from SCR-C-31). */
export function buildAppLink(target: LinkTarget): string {
  const query = new URLSearchParams({ to: target.to });
  if ('id' in target) query.set('id', target.id);
  if ('token' in target) query.set('token', target.token);
  return `${APP_SCHEME}://link?${query.toString()}`;
}

/** Splits `scheme://rest` into its parts; `null` for a bare path. */
function splitScheme(url: string): { scheme: string; rest: string } | null {
  const m = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(url);
  if (!m) return null;
  return { scheme: (m[1] as string).toLowerCase(), rest: m[2] as string };
}

function pathOf(rest: string, scheme: string): string {
  if (scheme === 'exp' || scheme === 'exps') {
    // Development server URLs: exp://host:port/--/path?query
    const marker = rest.indexOf('/--/');
    return marker === -1 ? '/' : rest.slice(marker + 3);
  }
  if (scheme === 'http' || scheme === 'https') {
    const slash = rest.indexOf('/');
    return slash === -1 ? '/' : rest.slice(slash);
  }
  // Custom scheme: sportspark://link?x is path "/link?x"; sportspark:///link?x as well.
  return `/${rest.replace(/^\/+/, '')}`;
}

/**
 * `+native-intent` `redirectSystemPath` (§4.13 "Safe deep-link destinations"): every URL the
 * operating system hands the app is rewritten to Home or to the link landing, which validates it.
 * No other route opens from outside the app. Bare paths come only from in-app or test navigation
 * (the operating system always passes a full URL) and are left to the router, whose unknown-path
 * screen is "Link not available".
 *
 * Proposed default pending DEC-061: the safe external destinations are Home and the link landing.
 * Development server URLs (`exp://`) are accepted only in development builds.
 */
export function safeSystemPath(path: string, options: { development: boolean }): string {
  const parts = splitScheme(path.trim());
  if (!parts) return path;
  const allowedSchemes = new Set([APP_SCHEME, 'https']);
  if (options.development) {
    allowedSchemes.add('exp');
    allowedSchemes.add('exps');
    allowedSchemes.add('http');
  }
  if (!allowedSchemes.has(parts.scheme)) return `${LINK_LANDING_PATH}?problem=unsupported`;
  const inApp = pathOf(parts.rest, parts.scheme);
  const [route = '/', query] = inApp.split('?', 2);
  const normalized = route.replace(/\/+$/, '') || '/';
  if (normalized === '/') return '/';
  if (normalized === LINK_LANDING_PATH) {
    return query ? `${LINK_LANDING_PATH}?${query}` : LINK_LANDING_PATH;
  }
  return `${LINK_LANDING_PATH}?problem=unsupported`;
}
