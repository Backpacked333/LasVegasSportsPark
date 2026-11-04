import type { NextFunction, Request, Response } from 'express';

/**
 * Response headers every API answer carries (R3-SECURITY-04, §4.14 protected storage, child
 * information minimised): `Cache-Control: no-store`, so authenticated JSON (a child's date of
 * birth, contact points) is never written to a browser's or a shared cache and does not outlive the
 * staff session that ends with the tab; and `X-Content-Type-Options: nosniff`, so a JSON answer is
 * never sniffed into something a browser would render. A route that needs another cache policy
 * sets its own `Cache-Control` (the handler runs after this and its header wins).
 */
export const API_CACHE_CONTROL = 'no-store';

export function responseHeadersMiddleware(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Cache-Control', API_CACHE_CONTROL);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
}
