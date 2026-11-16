#!/usr/bin/env node
// Screenshot harness for the customer app's browser preview (development only; ADR-008).
//
//   pnpm demo --fresh --web                                  # repository root: API + Expo web
//   pnpm --filter @sportspark/mobile screenshots --label after --before <dir of a previous run>
//
// Signs in through the demo parent sign-in with role and name locators, so a run is also an
// end-to-end smoke test of the web build against the demo API, then visits the routes below in
// both themes (classic and Legends) at two phone sizes with reduced motion. Each set starts with the
// signed-out views, drives one registration through its steps (a fresh cart, a price, saved spots,
// then releases them again), and ends with one offline view; the first size of each theme also
// gets an offline pass over the main screens. The first target is the design system gallery
// (`/dev-gallery`, development builds only), captured page by page down its whole length. Writes
//
//   screenshots/<label>/<theme>/<width>x<height>/NN-name.png
//   screenshots/<label>/<theme>/<width>x<height>/NN-name-PP.png   (pages 02, 03, ... of long screens)
//   screenshots/<label>/index.html          (contact sheet)
//   screenshots/<label>/before-after.html   (with --before: before beside after, both themes)
//   screenshots/<label>/before-after-NN.png (the same, rendered at scale 1 to send as images)
//
// under apps/mobile (git-ignored). Exits 1 when sign-in fails or the page reported an error, after
// writing what it captured. A browser render is not native acceptance (§6.2).
//
// Payment views: a development build shows the development payment method pickers
// (src/features/{registration,money}/dev) where a release build shows the pay-at-desk message and
// its "Details for support" fold (DEC-019, PA-11). So that the screenshots show what customers get,
// the harness serves the bundle with those two pickers switched off (`__DEV__` read as false in
// those two modules only); `--dev-payments` keeps the development pickers. The contact sheets say
// which was used.
//
// Options: --label <name> (default "current"), --base <url> (default http://localhost:8081),
// --api <url> (default http://localhost:3000/v1, read for the ids of the demo records),
// --themes classic,legends, --viewports 390x844,375x667, --only <name,...> (route names),
// --before <dir> (a previous run's output: adds the before/after sheet), --dev-payments,
// --offline-routes <name,...> (the offline pass; "none" skips it).
import { chromium } from '@playwright/test';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function option(name, fallback) {
  const args = process.argv.slice(2);
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const label = option('label', 'current');
if (!/^[A-Za-z0-9._-]+$/.test(label)) {
  console.error(`--label may contain letters, digits, ".", "-" and "_" only (got "${label}").`);
  process.exit(2);
}
const base = option('base', 'http://localhost:8081').replace(/\/$/, '');
const api = option('api', 'http://localhost:3000/v1').replace(/\/$/, '');
const themes = option('themes', 'classic,legends').split(',');
const viewports = option('viewports', '390x844,375x667')
  .split(',')
  .map((v) => {
    const [width, height] = v.split('x').map(Number);
    return { width, height, name: v };
  });
const only = option('only', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const outDir = path.join(appDir, 'screenshots', label);
const beforeDir = option('before', '');
const devPayments = process.argv.includes('--dev-payments');
const offlineRoutes = option(
  'offline-routes',
  'discover,offering,schedule,teams,team,account,payments,pass,inbox',
)
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s && s !== 'none');

/**
 * The routes to capture, in order. A route with `needs` uses an id read from the API after sign-in
 * (`readIds`) or set by an earlier route's `act`; without it the route is skipped and the contact
 * sheet says so. `act(page, ids)` runs after the screen settles (taps by role and name), and the
 * screen is captured after it. A route with `pages` is captured screen by screen down its scrolling
 * content (`capturePages`; a number caps the pages). `signedOut` routes are captured before sign-in.
 * Names match the earlier runs' names where the screen is the same, so the before/after sheet pairs
 * them.
 */
const ROUTES = [
  // Signed out (J7): sign-in, onboarding, and the two tabs that work without an account.
  { name: 'sign-in', path: '/sign-in', signedOut: true },
  { name: 'onboarding-signed-out', path: '/onboarding', signedOut: true },
  { name: 'home-signed-out', path: '/', signedOut: true },
  { name: 'discover-signed-out', path: '/discover', signedOut: true },
  // The design system gallery (src/dev-gallery, ADR-008): every component, in the set's theme.
  { name: 'gallery', path: '/dev-gallery', pages: true },
  { name: 'home', path: '/', pages: 4 },
  { name: 'onboarding', path: '/onboarding' },
  // Explore (J2): the list, a filter, the two filter sheets and a search with no results.
  { name: 'discover', path: '/discover' },
  {
    name: 'discover-filtered',
    path: '/discover',
    act: (page) => tapIn(page, 'Activity type', 'Camps'),
  },
  { name: 'discover-format-sheet', path: '/discover', act: (page) => tap(page, 'Format') },
  { name: 'discover-dates-sheet', path: '/discover', act: (page) => tap(page, 'Pick dates') },
  { name: 'discover-no-results', path: '/discover', act: searchNothing },
  // Activity details (J2): a term program, a camp and a rental.
  {
    name: 'offering',
    needs: 'offering',
    path: (ids) => `/registration/offering/${ids.offering}`,
    pages: 3,
  },
  {
    name: 'offering-camp',
    needs: 'camp',
    path: (ids) => `/registration/offering/${ids.camp}`,
    pages: 3,
  },
  {
    name: 'offering-rental',
    needs: 'rental',
    path: (ids) => `/registration/offering/${ids.rental}`,
  },
  // Registration (J3): Who, Options (the camp asks for options), Cart, Forms, Review, Pay.
  { name: 'reg-1-who', needs: 'camp', path: (ids) => `/registration/start/${ids.camp}` },
  {
    name: 'reg-1-who-type-sheet',
    needs: 'offering',
    path: (ids) => `/registration/start/${ids.offering}`,
    act: (page) => tap(page, 'Registration type'),
  },
  {
    name: 'reg-2-options',
    needs: 'camp',
    path: (ids) => `/registration/start/${ids.camp}`,
    act: checkEligible,
    pages: 4,
  },
  {
    name: 'basket',
    needs: 'cartOffering',
    path: (ids) => `/registration/start/${ids.cartOffering}`,
    act: fillCart,
  },
  {
    name: 'reg-3-forms',
    needs: 'basket',
    path: (ids) => `/registration/forms?basketId=${ids.basket}`,
  },
  {
    name: 'reg-4-review',
    needs: 'basket',
    path: (ids) => `/registration/basket/${ids.basket}`,
    act: getPrice,
    pages: 3,
  },
  { name: 'reg-5-pay', needs: 'quote', path: (ids) => `/registration/checkout/${ids.quote}` },
  {
    name: 'reg-5-pay-spots-saved',
    needs: 'quote',
    path: (ids) => `/registration/checkout/${ids.quote}`,
    act: saveSpots,
  },
  {
    name: 'reg-5-pay-support-open',
    needs: 'quote',
    path: (ids) => `/registration/checkout/${ids.quote}`,
    act: (page) => tap(page, 'Details for support'),
  },
  {
    name: 'basket-spots-saved',
    needs: 'basket',
    path: (ids) => `/registration/basket/${ids.basket}`,
    act: releaseAfter,
  },
  {
    name: 'reg-6-complete',
    needs: 'checkout',
    path: (ids) => `/registration/outcome/${ids.checkout}`,
  },
  // Calendar (J4): the week, one person, and the old family calendar route (now a redirect).
  { name: 'schedule', path: '/schedule' },
  {
    name: 'schedule-one-person',
    path: '/schedule',
    act: (page) => tapIn(page, 'Show activities for', 2),
  },
  { name: 'family-calendar', path: '/family-calendar' },
  // Teams (J5).
  { name: 'teams', path: '/teams' },
  { name: 'team', needs: 'team', path: (ids) => `/team/${ids.team}`, pages: 2 },
  // You and money (J6).
  { name: 'account', path: '/account', pages: 3 },
  { name: 'payments', path: '/payments' },
  {
    name: 'payment-due',
    needs: 'obligation',
    path: (ids) => `/payments/${ids.obligation}`,
    pages: 2,
  },
  { name: 'credits', path: '/credits' },
  { name: 'forms', path: '/forms' },
  { name: 'family', path: '/family' },
  { name: 'enrollments', path: '/enrollments' },
  {
    name: 'enrollments-child',
    path: '/enrollments',
    act: (page) => tapRadioIn(page, 'Show registrations for', 1),
  },
  { name: 'preferences', path: '/preferences' },
  { name: 'support', path: '/support' },
  // Pass and inbox (J7).
  { name: 'pass', path: '/pass' },
  { name: 'pass-issued', path: '/pass', act: (page) => tap(page, 'Get my pass') },
  { name: 'inbox', path: '/inbox' },
  // Empty states the demo data reaches.
  { name: 'empty-waitlists', path: '/registration/waitlists' },
  { name: 'empty-invitations', path: '/invitations' },
  { name: 'empty-bookings', path: '/bookings' },
  { name: 'empty-memberships', path: '/memberships' },
  { name: 'empty-class-packs', path: '/session-packages' },
  { name: 'empty-team-shares', path: '/team/contributions' },
  { name: 'empty-feedback', path: '/youth-feedback' },
];

/** Taps the button named `name` (the first one). */
async function tap(page, name) {
  await page.getByRole('button', { name, exact: true }).first().click({ timeout: 15_000 });
  await settle(page);
}

/** Taps a button inside the toolbar (chip row) named `group`: by name, or by position. */
async function tapIn(page, group, which) {
  const buttons = page.getByRole('toolbar', { name: group }).getByRole('button');
  const button =
    typeof which === 'number' ? buttons.nth(which) : buttons.filter({ hasText: which }).first();
  await button.click({ timeout: 15_000 });
  await settle(page);
}

/** Chooses the radio at `index` in the radio group named `group`. */
async function tapRadioIn(page, group, index) {
  await page
    .getByRole('radiogroup', { name: group })
    .getByRole('radio')
    .nth(index)
    .click({ timeout: 15_000 });
  await settle(page);
}

async function searchNothing(page) {
  // The search field is the `search` role itself on the web (SearchField).
  const field = page.getByRole('search', { name: 'Search activities' }).first();
  await field.fill('zzqx');
  await field.press('Enter');
  await settle(page);
}

/** Who: ticks the first person the API reports as eligible (the camp then asks for options). */
async function checkEligible(page) {
  await page
    .getByRole('checkbox', { name: /^[^.]+\. Eligible\./ })
    .first()
    .click({ timeout: 15_000 });
  await settle(page);
}

/**
 * The cart: with a cart in progress, opens it; otherwise registers the first eligible child for a
 * term offering they are not registered for (Registration type "Register a child", tick, "Add to
 * cart"), which opens the cart. A cart whose spots are still saved from an interrupted run is
 * released first.
 */
async function fillCart(page, ids) {
  if (ids.basket && ids.basketStatus === 'held') {
    await page.goto(`${base}/registration/basket/${ids.basket}`, { waitUntil: 'load' });
    await settle(page);
    await tap(page, 'Release my saved spots');
    ids.basket = null;
    await page.goto(`${base}/registration/start/${ids.cartOffering}`, { waitUntil: 'load' });
    await settle(page);
  }
  if (ids.basket) {
    await page.goto(`${base}/registration/basket/${ids.basket}`, { waitUntil: 'load' });
    await settle(page);
    return;
  }
  const type = page.getByRole('button', { name: 'Registration type', exact: true });
  if ((await type.count()) > 0) {
    await type.first().click();
    await page
      .getByRole('radio', { name: /^Register a child\./ })
      .first()
      .click({ timeout: 15_000 });
    await settle(page);
  }
  await checkEligible(page);
  await page
    .getByRole('button', { name: /^Add (to cart|\d+ people to cart)$/ })
    .first()
    .click();
  await page.waitForURL(/\/registration\/basket\//, { timeout: 30_000 });
  ids.basket = page.url().split('/registration/basket/')[1].split(/[?#]/)[0];
  ids.basketStatus = 'open';
  await settle(page);
}

/** Review: "Get your price" on the cart opens the price (its id is the Pay step's). */
async function getPrice(page, ids) {
  await page
    .getByRole('button', { name: 'Get your price', exact: true })
    .click({ timeout: 15_000 });
  await page.waitForURL(/\/registration\/quote\//, { timeout: 30_000 });
  ids.quote = page.url().split('/registration/quote/')[1].split(/[?#]/)[0];
  await settle(page);
}

/** Pay: "Save my spots" holds the cart; the pay-at-desk message then shows (release build). */
async function saveSpots(page, ids) {
  await tap(page, 'Save my spots');
  ids.basketStatus = 'held';
}

/** After the held cart is captured, its spots are released so the next set starts a fresh cart. */
function releaseAfter(page, ids) {
  ids.afterCapture = async () => {
    try {
      await tap(page, 'Release my saved spots');
    } catch {
      // Captured as it is; the next set's cart step releases what is still held.
    }
    ids.basket = null;
    ids.quote = null;
    ids.basketStatus = null;
  };
}

/** The items of an API answer that is a page (`{ items }`) or a list. */
const itemsOf = (body) =>
  Array.isArray(body) ? body : Array.isArray(body?.items) ? body.items : [];

/** First item id of an API answer, preferring items `prefer` accepts. */
function firstId(body, pick = (item) => item?.id, prefer = () => true) {
  const ids = itemsOf(body).filter((item) => typeof pick(item) === 'string');
  return pick(ids.find(prefer) ?? ids[0]) ?? null;
}

/** A basket the customer can still act on (src/features/registration/in-progress.ts). */
const inProgress = (b) =>
  (b.status === 'open' && b.lines?.length > 0) ||
  b.status === 'held' ||
  b.status === 'checking_out';

/**
 * Reads, as the signed-in parent, the ids the dynamic routes need: published offerings by kind (a
 * term program, a camp, a rental), the first team entry, a cart in progress, an open amount due and
 * a completed registration. The page asks the API itself, with the session the app stored
 * (src/session/secure-session-store.web.ts).
 */
async function readIds(page) {
  const answers = await page.evaluate(async (apiBase) => {
    const session = JSON.parse(globalThis.sessionStorage.getItem('sportspark.session') ?? 'null');
    const read = async (path) => {
      const response = await globalThis.fetch(`${apiBase}${path}`, {
        headers: { Authorization: `Bearer ${session?.token ?? ''}` },
      });
      return response.ok ? response.json() : null;
    };
    const me = await read('/me');
    const personId = me?.person?.id ?? '';
    return {
      offerings: await read('/offerings?limit=50'),
      teamEntries: await read('/me/team-entries'),
      baskets: await read('/me/baskets?limit=20'),
      obligations: await read(`/obligations?debtorPersonId=${personId}`),
      checkouts: await read('/me/registration-checkouts?limit=20'),
    };
  }, api);
  const open = (o) => o.publicationState === 'registration_open';
  const ofKind = (kind) => firstId(answers.offerings, undefined, (o) => open(o) && o.kind === kind);
  const basket = itemsOf(answers.baskets).find(inProgress) ?? null;
  // The cart registers the child for a term program they are not registered for already (an
  // equivalent registration is refused, DUPLICATE_ENTITLEMENT) and that needs no coach approval.
  const registered = new Set(
    itemsOf(answers.baskets)
      .filter((b) => b.status === 'fulfilled')
      .flatMap((b) => (b.lines ?? []).map((l) => l.offeringId)),
  );
  const cartOffering = firstId(
    answers.offerings,
    undefined,
    (o) => open(o) && o.kind === 'term' && !registered.has(o.id) && !/approval/i.test(o.name),
  );
  return {
    offering: ofKind('term'),
    cartOffering,
    camp: ofKind('camp'),
    rental: ofKind('rental'),
    team: firstId(answers.teamEntries, (e) => e?.teamEntry?.id),
    basket: basket?.id ?? null,
    basketStatus: basket?.status ?? null,
    obligation: firstId(answers.obligations, undefined, (o) => o.totals?.remainingMinor > 0),
    checkout: firstId(answers.checkouts, undefined, (c) => c.status === 'completed'),
  };
}

/** Waits until the screen has no loading indicator (or gives up after a while) and fonts are in. */
async function settle(page) {
  try {
    await page.waitForLoadState('networkidle', { timeout: 8_000 });
  } catch {
    // Polling reads can keep the network busy; the progress check below still applies.
  }
  try {
    await page.waitForFunction(
      () => globalThis.document.querySelectorAll('[role="progressbar"]').length === 0,
      undefined,
      { timeout: 10_000 },
    );
  } catch {
    // Captured as it is: a screen still loading is what the person would see.
  }
  await page.evaluate(() => globalThis.document.fonts.ready);
  await hideDemoOverlay(page);
  await page.waitForTimeout(600);
}

/** At most this many screens of one route with `pages`. */
const MAX_PAGES = 40;
/** Each page after the first repeats this much of the one before, so nothing falls between. */
const PAGE_OVERLAP = 48;

/**
 * Captures a long screen as consecutive screenshots: finds the screen's main scroll view (the
 * scrollable element that scrolls furthest), then scrolls it one viewport at a time. Returns the
 * files written (`<stem>.png`, `<stem>-02.png`, ...).
 */
async function capturePages(page, dir, stem, max = MAX_PAGES) {
  const count = await page.evaluate(
    ({ overlap, max }) => {
      const scrollers = [...globalThis.document.querySelectorAll('*')].filter((el) => {
        const overflow = globalThis.getComputedStyle(el).overflowY;
        return (overflow === 'auto' || overflow === 'scroll') && el.scrollHeight > el.clientHeight;
      });
      const main = scrollers.sort(
        (a, b) => b.scrollHeight - b.clientHeight - (a.scrollHeight - a.clientHeight),
      )[0];
      if (!main) return 1;
      main.setAttribute('data-screenshot-scroller', '');
      const step = Math.max(1, main.clientHeight - overlap);
      return Math.min(max, Math.ceil((main.scrollHeight - main.clientHeight) / step) + 1);
    },
    { overlap: PAGE_OVERLAP, max },
  );
  const files = [];
  for (let index = 0; index < count; index += 1) {
    if (index > 0) {
      await page.evaluate(
        ({ index: i, overlap }) => {
          const main = globalThis.document.querySelector('[data-screenshot-scroller]');
          if (main) main.scrollTop = i * Math.max(1, main.clientHeight - overlap);
        },
        { index, overlap: PAGE_OVERLAP },
      );
      // Lists render what scrolled into view, and images decode, after the scroll.
      await page.waitForTimeout(400);
    }
    const file = index === 0 ? `${stem}.png` : `${stem}-${String(index + 1).padStart(2, '0')}.png`;
    await page.screenshot({ path: path.join(dir, file) });
    files.push(file);
  }
  return files;
}

/**
 * The demo banner and tour card (src/demo/DemoOverlay.tsx) sit over every screen in demo mode;
 * they are not part of the app customers get, so they are hidden from the screenshots.
 */
async function hideDemoOverlay(page) {
  await page.evaluate(() => {
    const bar = globalThis.document.querySelector('[aria-label="Demo mode"]');
    if (bar?.parentElement) bar.parentElement.style.display = 'none';
  });
}

async function signIn(page) {
  await page.goto(`${base}/sign-in`, { waitUntil: 'load', timeout: 300_000 });
  const button = page.getByRole('button', { name: 'Sign in as the parent' });
  await button.waitFor({ timeout: 120_000 });
  await button.click();
  await page.waitForFunction(
    () => globalThis.sessionStorage.getItem('sportspark.session') !== null,
    undefined,
    { timeout: 60_000 },
  );
}

/**
 * The development payment method pickers are switched off in the served bundle (see the header);
 * the patched bundle is kept for the run. `patched` says whether both modules were found.
 */
const DEV_PICKER = 'const DevPaymentMethodPicker = __DEV__ ?';
let bundleCache = null;
const paymentPatch = { patched: null };
async function servePatchedBundle(route) {
  if (!bundleCache) {
    const response = await route.fetch();
    const text = await response.text();
    const count = text.split(DEV_PICKER).length - 1;
    paymentPatch.patched = count === 2;
    bundleCache = {
      headers: response.headers(),
      body: text.replaceAll(DEV_PICKER, 'const DevPaymentMethodPicker = false ?'),
    };
  }
  await route.fulfill({ status: 200, headers: bundleCache.headers, body: bundleCache.body });
}

async function captureSet(browser, theme, viewport, withOfflinePass) {
  const dir = path.join(outDir, theme, viewport.name);
  mkdirSync(dir, { recursive: true });
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 2,
    reducedMotion: 'reduce',
    isMobile: true,
    hasTouch: true,
  });
  if (!devPayments) await context.route(/\/entry\.bundle\?/, servePatchedBundle);
  // The web theme store reads localStorage (src/ui/secure-theme-store.web.ts).
  await context.addInitScript((name) => {
    globalThis.localStorage.setItem('sportspark.theme', name);
  }, theme);
  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(`${page.url()}: ${error.message}`));
  // A refused command (not a read) is reported with the API's error code.
  page.on('response', async (response) => {
    const method = response.request().method();
    if (!response.url().startsWith(api) || method === 'GET' || method === 'OPTIONS') return;
    if (response.status() < 400) return;
    const body = await response.json().catch(() => null);
    errors.push(
      `${method} ${response.url().replace(api, '')} answered ${response.status()} ${body?.code ?? ''} ${body?.message ?? ''}`.trim(),
    );
  });
  let ids = {};
  const shots = [];
  const wanted = (name) => only.length === 0 || only.includes(name);

  /** Visits one route, runs its `act`, captures it. Returns false when it could not. */
  const capture = async (route, file) => {
    if (route.needs && !ids[route.needs]) {
      shots.push({ name: route.name, skipped: `no ${route.needs} in the demo data` });
      return;
    }
    const target = typeof route.path === 'function' ? route.path(ids) : route.path;
    try {
      await page.goto(`${base}${target}`, { waitUntil: 'load', timeout: 120_000 });
      await settle(page);
      if (route.act) await route.act(page, ids);
    } catch (error) {
      errors.push(`${route.name}: ${error.message.split('\n')[0]}`);
    }
    const shown = page.url().replace(base, '');
    if (route.pages) {
      const stem = file.replace(/\.png$/, '');
      const max = route.pages === true ? MAX_PAGES : route.pages;
      const files = await capturePages(page, dir, stem, max);
      files.forEach((pageFile, index) =>
        shots.push({
          name: index === 0 ? route.name : `${route.name} ${index + 1}`,
          route: route.name,
          file: pageFile,
          path: shown,
        }),
      );
    } else {
      await page.screenshot({ path: path.join(dir, file) });
      shots.push({ name: route.name, route: route.name, file, path: shown });
    }
    if (ids.afterCapture) {
      const after = ids.afterCapture;
      ids.afterCapture = null;
      await after();
    }
  };

  let n = 0;
  for (const route of ROUTES.filter((r) => r.signedOut)) {
    n += 1;
    if (wanted(route.name)) await capture(route, `${String(n).padStart(2, '0')}-${route.name}.png`);
  }
  let signedIn = true;
  try {
    await signIn(page);
    ids = await readIds(page);
  } catch (error) {
    signedIn = false;
    errors.push(`Sign-in failed: ${error.message.split('\n')[0]}`);
    await page.screenshot({ path: path.join(dir, '00-sign-in-failed.png') });
    shots.push({ name: 'sign-in-failed', file: '00-sign-in-failed.png' });
  }
  for (const route of signedIn ? ROUTES.filter((r) => !r.signedOut) : []) {
    n += 1;
    if (wanted(route.name)) await capture(route, `${String(n).padStart(2, '0')}-${route.name}.png`);
  }
  // A cart left with saved spots (a failed step) is released for the next set.
  if (signedIn && ids.basket && ids.basketStatus === 'held') {
    try {
      await page.goto(`${base}/registration/basket/${ids.basket}`, { waitUntil: 'load' });
      await settle(page);
      await tap(page, 'Release my saved spots');
    } catch {
      // The next set's cart step tries again.
    }
  }
  if (signedIn && wanted('offline')) {
    // Offline: Home with the connection dropped after it loaded (SCR-C-40).
    await page.goto(`${base}/`, { waitUntil: 'load', timeout: 120_000 });
    await settle(page);
    await context.setOffline(true);
    await page.waitForTimeout(1_500);
    await page.screenshot({ path: path.join(dir, '99-offline-home.png') });
    shots.push({
      name: 'offline-home',
      route: 'offline-home',
      file: '99-offline-home.png',
      path: '/ (offline)',
    });
    await context.setOffline(false);
  }
  if (signedIn && withOfflinePass && wanted('offline')) {
    // The offline pass: each screen loaded, then the connection dropped.
    let k = 0;
    for (const name of offlineRoutes) {
      const route = ROUTES.find((r) => r.name === name && !r.act && !r.signedOut);
      if (!route || (route.needs && !ids[route.needs])) continue;
      k += 1;
      const target = typeof route.path === 'function' ? route.path(ids) : route.path;
      const file = `O${String(k).padStart(2, '0')}-offline-${name}.png`;
      try {
        await page.goto(`${base}${target}`, { waitUntil: 'load', timeout: 120_000 });
        await settle(page);
        await context.setOffline(true);
        await page.waitForTimeout(1_500);
        await page.screenshot({ path: path.join(dir, file) });
        shots.push({
          name: `offline-${name}`,
          route: `offline-${name}`,
          file,
          path: `${target} (offline)`,
        });
      } catch (error) {
        errors.push(`offline ${name}: ${error.message.split('\n')[0]}`);
      } finally {
        await context.setOffline(false);
      }
    }
  }
  await context.close();
  return { theme, viewport: viewport.name, shots, errors, signedIn };
}

const escape = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
  );

const paymentNote = () =>
  devPayments
    ? 'Payment views show the development payment method pickers (--dev-payments).'
    : paymentPatch.patched === false
      ? 'Payment views: the development pickers could not be switched off (bundle markers not found), so they show the development pickers.'
      : 'Payment views show the release-build wording: the development payment method pickers were switched off in the served bundle.';

const SHEET_STYLE = `
body{font-family:system-ui,sans-serif;margin:24px;background:#f4f4f1;color:#111}
h1{font-size:22px}h2{font-size:17px;margin-top:32px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px}
figure{margin:0}img{width:100%;border:1px solid #ccc;border-radius:12px;background:#fff}
figcaption{font-size:13px;margin-top:4px}code{font-size:11px;color:#555;word-break:break-all}
.skipped div{border:1px dashed #aaa;border-radius:12px;padding:24px 8px;font-size:13px;color:#555}
.errors{color:#a00;font-size:13px}`;

function contactSheet(sets) {
  const sections = sets
    .map((set) => {
      const cells = set.shots
        .map((shot) =>
          shot.file
            ? `<figure><a href="${set.theme}/${set.viewport}/${shot.file}"><img loading="lazy" src="${set.theme}/${set.viewport}/${shot.file}" alt="${escape(shot.name)}"></a><figcaption>${escape(shot.name)}${shot.path ? ` <code>${escape(shot.path)}</code>` : ''}</figcaption></figure>`
            : `<figure class="skipped"><div>Skipped: ${escape(shot.skipped)}</div><figcaption>${escape(shot.name)}</figcaption></figure>`,
        )
        .join('\n');
      const errors =
        set.errors.length > 0
          ? `<ul class="errors">${set.errors.map((e) => `<li>${escape(e)}</li>`).join('')}</ul>`
          : '';
      return `<section><h2>${escape(set.theme)} · ${escape(set.viewport)}</h2>${errors}<div class="grid">${cells}</div></section>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Customer app screenshots: ${escape(label)}</title>
<style>${SHEET_STYLE}</style></head><body>
<h1>Customer app screenshots: ${escape(label)}</h1>
<p>Browser preview build (development only) against the demo API, reduced motion, scale 2; the demo banner and tour card are hidden. ${escape(paymentNote())} A browser render is not native acceptance.</p>
${sections}
</body></html>
`;
}

/** Rows of the before/after sheet in one `.sheet` block each, so each renders to its own PNG. */
const ROWS_PER_SHEET = 8;
const THUMB = 180;

/**
 * The before/after sheet: a previous run (`--before`, copied next to it as `before/`) beside this
 * one. For each size, every route in both runs gets one row: classic before, classic after, Legends
 * before, Legends after (first screen of each). Then the routes only this run has, classic beside
 * Legends. Returns the HTML.
 */
function beforeAfterSheet(sets) {
  const stemName = (file) => file.replace(/^(\d\d|O\d\d)-/, '').replace(/\.png$/, '');
  const beforeFiles = (theme, size) => {
    const dir = path.join(outDir, 'before', theme, size);
    if (!existsSync(dir)) return new Map();
    return new Map(
      readdirSync(dir)
        .filter((f) => f.endsWith('.png'))
        .map((f) => [stemName(f), `before/${theme}/${size}/${f}`]),
    );
  };
  const afterFirst = (theme, size) => {
    const set = sets.find((s) => s.theme === theme && s.viewport === size);
    const map = new Map();
    for (const shot of set?.shots ?? []) {
      if (shot.file && shot.route && !map.has(shot.route)) {
        map.set(shot.route, `${theme}/${size}/${shot.file}`);
      }
    }
    return map;
  };
  const img = (src, caption) =>
    src
      ? `<figure><img src="${src}" width="${THUMB}"><figcaption>${escape(caption)}</figcaption></figure>`
      : `<figure class="none"><div>not captured</div><figcaption>${escape(caption)}</figcaption></figure>`;
  const chunk = (rows) => {
    const out = [];
    for (let i = 0; i < rows.length; i += ROWS_PER_SHEET)
      out.push(rows.slice(i, i + ROWS_PER_SHEET));
    return out;
  };
  const blocks = [];
  const sizes = [...new Set(sets.map((s) => s.viewport))];
  const themesRun = [...new Set(sets.map((s) => s.theme))];
  for (const size of sizes) {
    const after = Object.fromEntries(themesRun.map((t) => [t, afterFirst(t, size)]));
    const before = Object.fromEntries(themesRun.map((t) => [t, beforeFiles(t, size)]));
    const names = [...new Set(themesRun.flatMap((t) => [...after[t].keys()]))];
    const paired = names.filter((name) => themesRun.some((t) => before[t].has(name)));
    const afterOnly = names.filter((name) => !paired.includes(name));
    const pairedRows = paired.map(
      (name) =>
        `<div class="row"><div class="name">${escape(name)}</div>${themesRun
          .map(
            (t) => img(before[t].get(name), `${t} before`) + img(after[t].get(name), `${t} after`),
          )
          .join('')}</div>`,
    );
    chunk(pairedRows).forEach((rows, i, all) =>
      blocks.push(
        `<section class="sheet"><h2>Before and after · ${escape(size)} · ${i + 1} of ${all.length}</h2>${rows.join('')}</section>`,
      ),
    );
    const triples = [];
    for (let i = 0; i < afterOnly.length; i += 2) triples.push(afterOnly.slice(i, i + 2));
    const onlyRows = triples.map(
      (group) =>
        `<div class="row">${group
          .map(
            (name) =>
              `<div class="name">${escape(name)}</div>${themesRun.map((t) => img(after[t].get(name), t)).join('')}`,
          )
          .join('')}</div>`,
    );
    chunk(onlyRows).forEach((rows, i, all) =>
      blocks.push(
        `<section class="sheet"><h2>New in this run · ${escape(size)} · ${i + 1} of ${all.length}</h2>${rows.join('')}</section>`,
      ),
    );
  }
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Customer app: before and after</title>
<style>
body{font-family:system-ui,sans-serif;margin:0;background:#f4f4f1;color:#111}
header{padding:24px 24px 0}h1{font-size:22px;margin:0 0 8px}header p{font-size:13px;max-width:900px}
.sheet{padding:16px 24px 24px;width:max-content;background:#f4f4f1}
h2{font-size:17px;margin:8px 0 12px}
.row{display:flex;gap:10px;align-items:flex-start;margin-bottom:14px}
.name{width:120px;font-size:13px;font-weight:600;padding-top:4px;word-break:break-word}
figure{margin:0;width:${THUMB}px}img{display:block;width:${THUMB}px;border:1px solid #bbb;border-radius:10px;background:#fff}
figcaption{font-size:11px;color:#444;margin-top:2px}
.none div{width:${THUMB - 2}px;height:${Math.round(THUMB * 1.6)}px;border:1px dashed #aaa;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:12px;color:#777}
</style></head><body>
<header><h1>Customer app: before and after (${escape(label)})</h1>
<p>Before: the run copied from <code>${escape(beforeDir)}</code>. After: this run. First screen of each route, browser preview build against the demo API, reduced motion; the demo banner and tour card are hidden. ${escape(paymentNote())} A browser render is not native acceptance.</p></header>
${blocks.join('\n')}
</body></html>
`;
}

/** Renders each `.sheet` block of the before/after page to its own PNG at scale 1. */
async function renderSheets(browser, htmlFile) {
  const context = await browser.newContext({
    viewport: { width: 1400, height: 1000 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  await page.goto(`file://${htmlFile}`, { waitUntil: 'load' });
  await page.evaluate(() =>
    Promise.all(
      [...globalThis.document.images].map((i) =>
        i.complete ? null : i.decode().catch(() => null),
      ),
    ),
  );
  const sheets = page.locator('.sheet');
  const count = await sheets.count();
  const files = [];
  for (let i = 0; i < count; i += 1) {
    const file = path.join(outDir, `before-after-${String(i + 1).padStart(2, '0')}.png`);
    await sheets.nth(i).screenshot({ path: file });
    files.push(file);
  }
  await context.close();
  return files;
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch();
const sets = [];
let sheetFiles = [];
try {
  for (const theme of themes) {
    for (const [index, viewport] of viewports.entries()) {
      console.log(`Capturing ${theme} at ${viewport.name}...`);
      sets.push(
        await captureSet(browser, theme, viewport, index === 0 && offlineRoutes.length > 0),
      );
    }
  }
  writeFileSync(path.join(outDir, 'index.html'), contactSheet(sets));
  if (beforeDir) {
    for (const theme of themes) {
      for (const viewport of viewports) {
        const from = path.join(path.resolve(beforeDir), theme, viewport.name);
        if (existsSync(from))
          cpSync(from, path.join(outDir, 'before', theme, viewport.name), { recursive: true });
      }
    }
    const htmlFile = path.join(outDir, 'before-after.html');
    writeFileSync(htmlFile, beforeAfterSheet(sets));
    sheetFiles = await renderSheets(browser, htmlFile);
  }
} finally {
  await browser.close();
}
const captured = sets.reduce((sum, set) => sum + set.shots.filter((s) => s.file).length, 0);
const errors = sets.flatMap((set) => set.errors.map((e) => `${set.theme} ${set.viewport}: ${e}`));
console.log(`${captured} screenshot(s) in ${path.relative(process.cwd(), outDir) || outDir}`);
console.log(`Contact sheet: ${path.join(outDir, 'index.html')}`);
if (beforeDir) {
  console.log(
    `Before/after: ${path.join(outDir, 'before-after.html')} (${sheetFiles.length} PNG sheet(s))`,
  );
}
console.log(paymentNote());
for (const set of sets) {
  for (const shot of set.shots.filter((s) => s.skipped)) {
    console.log(`Skipped ${set.theme} ${set.viewport} ${shot.name}: ${shot.skipped}`);
  }
}
if (errors.length > 0) {
  console.error(`Errors:\n  ${errors.join('\n  ')}`);
  process.exitCode = 1;
}
