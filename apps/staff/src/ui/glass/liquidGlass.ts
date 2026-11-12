/**
 * Liquid glass optics for the dashboard chrome (SPK-UX-010 visual system): the displacement map
 * that bends the page behind a glass body inside a band along its edge (the bezel), applied as an
 * SVG filter through `backdrop-filter`. Only Chromium renders SVG filters there; every other
 * engine keeps the CSS frost of `glass.css` (blur, fill and rim, no bend), which is also what
 * jsdom and a reduced-transparency setting get.
 *
 * Framework-free: `Glass.tsx` mounts the markup this module returns.
 */
export type GlassProfile = 'bevel' | 'convex' | 'rim' | 'flat';

/**
 * Backdrop shift across the bezel, s = 0 at the outer edge to 1 at its inner end. bevel: a
 * rounded edge, the shift falls off as (1 - s)^2. convex: a dome over a circle (bezel = radius),
 * the whole face magnifies. rim: the bevel in the outer 35 % only.
 */
const BEND: Record<GlassProfile, (s: number) => number> = {
  bevel: (s) => (1 - s) ** 2,
  convex: (s) => ((1 - s) * (2 - s)) / 2,
  rim: (s) => (s < 0.35 ? (1 - s / 0.35) ** 2 : 0),
  flat: () => 0,
};
/** Fold limit: displacement x steepest slope must stay under the bezel, or lines mirror. */
const SLOPE: Record<GlassProfile, number> = { bevel: 2, convex: 1.5, rim: 2 / 0.35, flat: 0 };

export function maxDisplacement(bezel: number, profile: GlassProfile): number {
  return SLOPE[profile] ? bezel / SLOPE[profile] : 0;
}

/** The map and the element must use the same corner shape, so the bend follows the visible edge. */
export type GlassCorner = 'round' | 'squircle';

export const squircleCorners =
  typeof CSS !== 'undefined' &&
  typeof CSS.supports === 'function' &&
  CSS.supports('corner-shape', 'squircle');

function sdShape(x: number, y: number, w: number, h: number, r: number, corner: GlassCorner) {
  const qx = Math.abs(x - w / 2) - (w / 2 - r);
  const qy = Math.abs(y - h / 2) - (h / 2 - r);
  if (corner === 'squircle' && r > 0 && qx > 0 && qy > 0) {
    return r * (((qx / r) ** 4 + (qy / r) ** 4) ** 0.25 - 1);
  }
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Maps by size and shape; the oldest is dropped past the limit (a resized window makes many). */
const MAP_LIMIT = 32;
const maps = new Map<string, string>();

export function displacementMap(
  w: number,
  h: number,
  radius: number,
  bezel: number,
  profile: GlassProfile,
  corner: GlassCorner = 'round',
): string | null {
  const key = `${w}x${h}:${radius}:${bezel}:${profile}:${corner}`;
  const hit = maps.get(key);
  if (hit) return hit;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const bend = BEND[profile];
  const r = Math.min(radius, w / 2, h / 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const depth = -sdShape(px, py, w, h, r, corner);
      let dx = 0;
      let dy = 0;
      if (depth > 0 && depth < bezel) {
        const nx = sdShape(px + 0.5, py, w, h, r, corner) - sdShape(px - 0.5, py, w, h, r, corner);
        const ny = sdShape(px, py + 0.5, w, h, r, corner) - sdShape(px, py - 0.5, w, h, r, corner);
        const len = Math.hypot(nx, ny) || 1;
        const m = bend(depth / bezel);
        // Inward: the rim shows the backdrop from further inside.
        dx = (-nx / len) * m;
        dy = (-ny / len) * m;
      }
      const i = (y * w + x) * 4;
      d[i] = 128 + dx * 127;
      d[i + 1] = 128 + dy * 127;
      d[i + 2] = 128;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const url = canvas.toDataURL();
  if (maps.size >= MAP_LIMIT) {
    const oldest = maps.keys().next().value;
    if (oldest !== undefined) maps.delete(oldest);
  }
  maps.set(key, url);
  return url;
}

export interface GlassFilterOptions {
  w: number;
  h: number;
  radius: number;
  bezel: number;
  profile: GlassProfile;
  /** Largest shift in px, at the outer edge. */
  displacement: number;
  blur: number;
  saturate?: number;
  corner?: GlassCorner;
}

/**
 * SVG filter markup for one element size, to mount inside `<svg><defs>` (parsed as SVG, or the
 * browser drops the whole backdrop filter). Order: bend, then blur (it removes the stair steps of
 * the nearest-neighbour displacement), then saturation. The bezel is capped at the corner radius
 * and the displacement at the profile's fold limit. Null when no canvas is available.
 */
export function glassFilterSvg(id: string, o: GlassFilterOptions): string | null {
  const bezel = Math.min(o.bezel, o.radius, o.w / 2, o.h / 2);
  const displacement = Math.min(o.displacement, maxDisplacement(bezel, o.profile));
  const map = displacementMap(o.w, o.h, o.radius, bezel, o.profile, o.corner ?? 'round');
  if (!map) return null;
  const blur = Math.max(o.blur, o.profile === 'convex' ? 1 : 0.5);
  return (
    `<filter id="${id}" x="0" y="0" width="${o.w}" height="${o.h}" filterUnits="userSpaceOnUse" ` +
    `color-interpolation-filters="sRGB">` +
    `<feImage href="${map}" x="0" y="0" width="${o.w}" height="${o.h}" preserveAspectRatio="none" result="map"/>` +
    `<feDisplacementMap in="SourceGraphic" in2="map" scale="${displacement * 2}" ` +
    `xChannelSelector="R" yChannelSelector="G" result="bent"/>` +
    `<feGaussianBlur in="bent" stdDeviation="${blur}" result="frost"/>` +
    `<feColorMatrix in="frost" type="saturate" values="${o.saturate ?? 1.4}"/>` +
    `</filter>`
  );
}

/**
 * Whether `backdrop-filter: url(#filter)` renders (Chromium only). Headless Chrome reports
 * "HeadlessChrome/...", which the pattern alone misses, hence the `userAgentData` test.
 */
export function supportsSvgBackdrop(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return (
    ('userAgentData' in navigator || /\bChrome\/\d+/.test(ua)) &&
    !/Firefox|FxiOS|CriOS|EdgiOS|jsdom/.test(ua)
  );
}
