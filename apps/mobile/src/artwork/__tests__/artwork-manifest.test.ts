/**
 * ADR-008 ("Imagery"): the bundled artwork exists, is webp, has its documented size and fits its
 * byte budget, and the whole set stays within 5 MB. Replacing an image (assets/artwork/README.md)
 * keeps its name and size; this test is what enforces it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  ACTIVITY_ART,
  HOME_BANDS,
  ILLUSTRATION_NAMES,
  ONBOARDING_ART,
  activityArtwork,
  homeBand,
  illustrations,
  onboardingArtwork,
} from '../manifest';

const ASSETS = path.resolve(__dirname, '../../../assets/artwork');
const MANIFEST = path.resolve(__dirname, '../manifest.ts');
const KB = 1024;
const TOTAL_BUDGET = 5 * KB * KB;

interface Expected {
  file: string;
  width: number;
  height: number;
  budget: number;
  transparent?: boolean;
}

const EXPECTED: Expected[] = [
  ...ACTIVITY_ART.flatMap((key) => [
    { file: `${key}-wide.webp`, width: 1280, height: 720, budget: 160 * KB },
    { file: `${key}-square.webp`, width: 640, height: 640, budget: 45 * KB },
  ]),
  ...ILLUSTRATION_NAMES.map((name) => ({
    file: `${name}.webp`,
    width: 800,
    height: 600,
    budget: 90 * KB,
    transparent: true,
  })),
  ...ONBOARDING_ART.map((name) => ({
    file: `onboarding-${name}.webp`,
    width: 1080,
    height: 1440,
    budget: 200 * KB,
  })),
  ...HOME_BANDS.map((band) => ({
    file: `home-${band}.webp`,
    width: 1470,
    height: 630,
    budget: 120 * KB,
  })),
];

/** The canvas size and alpha flag of a webp file (lossy `VP8 `, lossless `VP8L` or `VP8X`). */
function webpInfo(bytes: Buffer): { width: number; height: number; alpha: boolean } {
  const chunk = bytes.toString('ascii', 12, 16);
  if (chunk === 'VP8X') {
    return {
      width: 1 + bytes.readUIntLE(24, 3),
      height: 1 + bytes.readUIntLE(27, 3),
      alpha: ((bytes[20] ?? 0) & 0x10) !== 0,
    };
  }
  if (chunk === 'VP8 ') {
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
      alpha: false,
    };
  }
  if (chunk === 'VP8L') {
    const bits = bytes.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
      alpha: ((bits >>> 28) & 1) !== 0,
    };
  }
  throw new Error(`unknown webp chunk ${JSON.stringify(chunk)}`);
}

describe('ADR-008 bundled artwork', () => {
  it('lists 43 images: 14 activities in two crops, 10 illustrations, 3 onboarding, 2 home bands', () => {
    expect(EXPECTED).toHaveLength(43);
    expect(Object.keys(activityArtwork).sort()).toEqual([...ACTIVITY_ART].sort());
    expect(Object.keys(illustrations).sort()).toEqual([...ILLUSTRATION_NAMES].sort());
    expect(Object.keys(onboardingArtwork).sort()).toEqual([...ONBOARDING_ART].sort());
    expect(Object.keys(homeBand).sort()).toEqual([...HOME_BANDS].sort());
  });

  it('requires exactly the expected files, statically (Metro bundles only static requires)', () => {
    const source = readFileSync(MANIFEST, 'utf8');
    const required = [...source.matchAll(/require\('\.\.\/\.\.\/assets\/artwork\/([^']+)'\)/g)].map(
      (m) => m[1],
    );
    expect(required.sort()).toEqual(EXPECTED.map((e) => e.file).sort());
    // No computed requires: every `require(` in the manifest is one of the literal ones above.
    expect(source.match(/require\(/g)).toHaveLength(required.length);
  });

  it('resolves every manifest entry under Jest', () => {
    const sources = [
      ...Object.values(activityArtwork).flatMap((crops) => [crops.wide, crops.square]),
      ...Object.values(illustrations),
      ...Object.values(onboardingArtwork),
      ...Object.values(homeBand),
    ];
    expect(sources).toHaveLength(43);
    for (const source of sources) expect(source).toBeDefined();
  });

  it('has no file in assets/artwork that the manifest does not use', () => {
    const images = readdirSync(ASSETS).filter((f) => f !== 'README.md');
    expect(images.sort()).toEqual(EXPECTED.map((e) => e.file).sort());
  });

  it.each(EXPECTED)(
    '$file exists, is webp, is $width×$height and fits its byte budget',
    ({ file, width, height, budget, transparent }) => {
      const full = path.join(ASSETS, file);
      const bytes = readFileSync(full);
      expect(bytes.toString('ascii', 0, 4)).toBe('RIFF');
      expect(bytes.toString('ascii', 8, 12)).toBe('WEBP');
      // The RIFF size field covers the whole file after the first eight bytes.
      expect(bytes.readUInt32LE(4) + 8).toBe(bytes.length);
      const info = webpInfo(bytes);
      expect({ width: info.width, height: info.height }).toEqual({ width, height });
      if (transparent) expect(info.alpha).toBe(true);
      expect(statSync(full).size).toBeLessThanOrEqual(budget);
    },
  );

  it('keeps the whole set within 5 MB', () => {
    const total = EXPECTED.reduce((sum, e) => sum + statSync(path.join(ASSETS, e.file)).size, 0);
    expect(total).toBeLessThanOrEqual(TOTAL_BUDGET);
  });
});
