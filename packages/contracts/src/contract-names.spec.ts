import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `src/api/index.ts` and `src/index.ts` re-export every contract file with `export *`. When two
 * files export one identifier, `export *` silently drops the name (or the build fails far from
 * the cause), so this test names both files (K-01, §4.8).
 */
const here = __dirname;

function contractFiles(): string[] {
  const top = readdirSync(here)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts') && f !== 'index.ts')
    .map((f) => path.join(here, f));
  const api = readdirSync(path.join(here, 'api'))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts') && f !== 'index.ts')
    .map((f) => path.join(here, 'api', f));
  return [...top, ...api];
}

/** Identifiers a file exports at top level (declarations and `export { a, b as c }` lists). */
function exportedNames(source: string): string[] {
  const names = new Set<string>();
  const declaration =
    /^export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function\*?|class|interface|type|enum|abstract\s+class)\s+([A-Za-z_$][\w$]*)/gm;
  for (const match of source.matchAll(declaration)) names.add(match[1] as string);
  const list = /^export\s+(?:type\s+)?\{([^}]*)\}(?!\s*from)/gm;
  for (const match of source.matchAll(list)) {
    for (const part of (match[1] as string).split(',')) {
      const name = part
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (name) names.add(name);
    }
  }
  return [...names];
}

describe('contract export names (K-01)', () => {
  it('reads declarations and export lists', () => {
    expect(
      exportedNames(
        'export const A = 1;\nexport type B = string;\nexport interface C {}\nexport function D() {}\nexport { e, f as G };\nexport * from "./x";',
      ).sort(),
    ).toEqual(['A', 'B', 'C', 'D', 'G', 'e']);
  });

  it('no two contract files export the same identifier', () => {
    const owners = new Map<string, string[]>();
    for (const file of contractFiles()) {
      for (const name of exportedNames(readFileSync(file, 'utf8'))) {
        owners.set(name, [...(owners.get(name) ?? []), path.relative(here, file)]);
      }
    }
    const duplicates = [...owners.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([name, files]) => `${name}: ${files.join(' and ')}`);
    expect(duplicates).toEqual([]);
  });
});
