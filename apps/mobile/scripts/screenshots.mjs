#!/usr/bin/env node
// Screenshot harness for the customer app's browser preview (development only; ADR-008).
//
//   pnpm demo --fresh --web                                  # repository root: API + Expo web
//   pnpm --filter @sportspark/mobile screenshots --label before
//
// Signs in through the demo parent sign-in with role and name locators, so a run is also an
// end-to-end smoke test of the web build against the demo API, then visits the main routes in both
// themes (classic and Legends) at two phone sizes with reduced motion, and ends each set with one
// offline view. The first target is the design system gallery (`/dev-gallery`, development builds
// only), captured page by page down its whole length so every component shows. Writes
//
//   screenshots/<label>/<theme>/<width>x<height>/NN-name.png
//   screenshots/<label>/<theme>/<width>x<height>/01-gallery-PP.png  (the gallery's pages 02, 03, ...)
//   screenshots/<label>/index.html        (contact sheet)
//
// under apps/mobile (git-ignored). Exits 1 when sign-in fails or the page reported an error, after
// writing what it captured. A browser render is not native acceptance (§6.2).
//
// Options: --label <name> (default "current"), --base <url> (default http://localhost:8081),
// --api <url> (default http://localhost:3000/v1, read for the ids of the offering, team and basket),
// --themes classic,legends, --viewports 390x844,375x667, --only <name,...> (route names).
import { chromium } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

/**
 * The routes to capture, in order. A route with `needs` uses an id read from the API after sign-in
 * (`readIds`); without one it is skipped and the contact sheet says so. A route with `pages` is
 * captured screen by screen down its scrolling content (`capturePages`), not only its first screen.
 */
const ROUTES = [
  // The design system gallery (src/dev-gallery, ADR-008): every component, in the set's theme.
  { name: 'gallery', path: '/dev-gallery', pages: true },
  { name: 'home', path: '/' },
  { name: 'discover', path: '/discover' },
  { name: 'offering', needs: 'offering', path: (ids) => `/registration/offering/${ids.offering}` },
  { name: 'basket', needs: 'basket', path: (ids) => `/registration/basket/${ids.basket}` },
  { name: 'schedule', path: '/schedule' },
  { name: 'family-calendar', path: '/family-calendar' },
  { name: 'teams', path: '/teams' },
  { name: 'team', needs: 'team', path: (ids) => `/team/${ids.team}` },
  { name: 'account', path: '/account' },
  { name: 'family', path: '/family' },
  { name: 'enrollments', path: '/enrollments' },
  { name: 'payments', path: '/payments' },
  { name: 'forms', path: '/forms' },
  { name: 'credits', path: '/credits' },
  { name: 'preferences', path: '/preferences' },
  { name: 'support', path: '/support' },
  { name: 'pass', path: '/pass' },
  { name: 'inbox', path: '/inbox' },
];

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
 * Reads, as the signed-in parent, the ids the dynamic routes need: the first published offering,
 * the first team entry and a basket (the one in progress if any, otherwise the latest). The page
 * asks the API itself, with the session the app stored (src/session/secure-session-store.web.ts).
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
    return {
      offerings: await read('/offerings?limit=20'),
      teamEntries: await read('/me/team-entries'),
      baskets: await read('/me/baskets?limit=20'),
    };
  }, api);
  return {
    offering: firstId(answers.offerings),
    team: firstId(answers.teamEntries, (e) => e?.teamEntry?.id),
    basket: firstId(answers.baskets, undefined, inProgress),
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
async function capturePages(page, dir, stem) {
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
    { overlap: PAGE_OVERLAP, max: MAX_PAGES },
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

async function captureSet(browser, theme, viewport) {
  const dir = path.join(outDir, theme, viewport.name);
  mkdirSync(dir, { recursive: true });
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 2,
    reducedMotion: 'reduce',
    isMobile: true,
    hasTouch: true,
  });
  // The web theme store reads localStorage (src/ui/secure-theme-store.web.ts).
  await context.addInitScript((name) => {
    globalThis.localStorage.setItem('sportspark.theme', name);
  }, theme);
  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(`${page.url()}: ${error.message}`));
  let ids = {};
  const shots = [];
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
  let n = 0;
  for (const route of signedIn ? ROUTES : []) {
    n += 1;
    if (only.length > 0 && !only.includes(route.name)) continue;
    const file = `${String(n).padStart(2, '0')}-${route.name}.png`;
    if (route.needs && !ids[route.needs]) {
      shots.push({ name: route.name, skipped: `no ${route.needs} in the demo data` });
      continue;
    }
    const target = typeof route.path === 'function' ? route.path(ids) : route.path;
    await page.goto(`${base}${target}`, { waitUntil: 'load', timeout: 120_000 });
    await settle(page);
    if (route.pages) {
      const stem = file.replace(/\.png$/, '');
      const files = await capturePages(page, dir, stem);
      files.forEach((pageFile, index) =>
        shots.push({
          name: index === 0 ? route.name : `${route.name} ${index + 1}`,
          file: pageFile,
          path: target,
        }),
      );
      continue;
    }
    await page.screenshot({ path: path.join(dir, file) });
    shots.push({ name: route.name, file, path: target });
  }
  if (signedIn && (only.length === 0 || only.includes('offline'))) {
    // Offline: Home with the connection dropped after it loaded (SCR-C-40).
    await page.goto(`${base}/`, { waitUntil: 'load', timeout: 120_000 });
    await settle(page);
    await context.setOffline(true);
    await page.waitForTimeout(1_500);
    await page.screenshot({ path: path.join(dir, '99-offline-home.png') });
    shots.push({ name: 'offline-home', file: '99-offline-home.png', path: '/ (offline)' });
    await context.setOffline(false);
  }
  await context.close();
  return { theme, viewport: viewport.name, shots, errors, signedIn };
}

const escape = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
  );

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
<style>
body{font-family:system-ui,sans-serif;margin:24px;background:#f4f4f1;color:#111}
h1{font-size:22px}h2{font-size:17px;margin-top:32px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px}
figure{margin:0}img{width:100%;border:1px solid #ccc;border-radius:12px;background:#fff}
figcaption{font-size:13px;margin-top:4px}code{font-size:11px;color:#555}
.skipped div{border:1px dashed #aaa;border-radius:12px;padding:24px 8px;font-size:13px;color:#555}
.errors{color:#a00;font-size:13px}
</style></head><body>
<h1>Customer app screenshots: ${escape(label)}</h1>
<p>Browser preview build (development only) against the demo API, reduced motion, scale 2; the demo banner and tour card are hidden. A browser render is not native acceptance.</p>
${sections}
</body></html>
`;
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch();
const sets = [];
try {
  for (const theme of themes) {
    for (const viewport of viewports) {
      console.log(`Capturing ${theme} at ${viewport.name}...`);
      sets.push(await captureSet(browser, theme, viewport));
    }
  }
} finally {
  await browser.close();
}
writeFileSync(path.join(outDir, 'index.html'), contactSheet(sets));
const captured = sets.reduce((sum, set) => sum + set.shots.filter((s) => s.file).length, 0);
const errors = sets.flatMap((set) => set.errors.map((e) => `${set.theme} ${set.viewport}: ${e}`));
console.log(`${captured} screenshot(s) in ${path.relative(process.cwd(), outDir) || outDir}`);
console.log(`Contact sheet: ${path.join(outDir, 'index.html')}`);
for (const set of sets) {
  for (const shot of set.shots.filter((s) => s.skipped)) {
    console.log(`Skipped ${set.theme} ${set.viewport} ${shot.name}: ${shot.skipped}`);
  }
}
if (errors.length > 0) {
  console.error(`Errors:\n  ${errors.join('\n  ')}`);
  process.exitCode = 1;
}
