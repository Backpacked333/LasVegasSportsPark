import type { NextFunction, Request, Response } from 'express';

/**
 * Response headers every API answer carries (R3-SECURITY-04, §4.14 protected storage, child
 * information minimised, encrypted transport):
 *
 * - `Cache-Control: no-store`, so authenticated JSON (a child's date of birth, contact points) is
 *   never written to a browser's or a shared cache and does not outlive the staff session that
 *   ends with the tab. A route that needs another cache policy sets its own `Cache-Control` (the
 *   handler runs after this and its header wins).
 * - `X-Content-Type-Options: nosniff`, so a JSON answer is never sniffed into something a browser
 *   would render; `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'` and
 *   `X-Frame-Options: DENY`, so nothing the API answers runs script or renders inside a frame;
 *   `Referrer-Policy: no-referrer`, so ids in API URLs never leave in a Referer header.
 * - `Strict-Transport-Security` on answers over https (as Express sees the request, which
 *   follows `TRUST_PROXY` behind a proxy), so browsers keep using https.
 */
export const API_CACHE_CONTROL = 'no-store';
export const API_CONTENT_SECURITY_POLICY = "default-src 'none'; frame-ancestors 'none'";

export function responseHeadersMiddleware(options: { hstsMaxAgeSeconds?: number } = {}) {
  const hsts =
    options.hstsMaxAgeSeconds && options.hstsMaxAgeSeconds > 0
      ? `max-age=${options.hstsMaxAgeSeconds}; includeSubDomains`
      : null;
  return (req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('Cache-Control', API_CACHE_CONTROL);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', API_CONTENT_SECURITY_POLICY);
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (hsts && req.secure) res.setHeader('Strict-Transport-Security', hsts);
    next();
  };
}
