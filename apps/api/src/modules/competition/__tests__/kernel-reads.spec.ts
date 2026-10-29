import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * CMP-11 (§4.2 only the owner reads its tables, §4.10, K-10): competition reads kernel records
 * through the kernel's services (OperationalExceptions get/list, FacilityDirectory, AuditReader),
 * never by selecting the kernel's tables. Tests and test fixtures may inspect any table.
 */
const MODULE_ROOT = join(__dirname, '..');
const KERNEL_TABLES = ['operational_exceptions', 'facilities', 'audit_records'] as const;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === '__tests__' || name === 'testing') continue;
      out.push(...sourceFiles(path));
    } else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) {
      out.push(path);
    }
  }
  return out;
}

describe('CMP-11: competition uses kernel reads instead of kernel tables', () => {
  it('competition no longer selects from operational_exceptions, facilities or audit_records', () => {
    const files = sourceFiles(MODULE_ROOT);
    expect(files.length).toBeGreaterThan(10);
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const table of KERNEL_TABLES) {
        // selectFrom / innerJoin / leftJoin / updateTable / insertInto / deleteFrom of the table
        const pattern = new RegExp(
          `(selectFrom|innerJoin|leftJoin|rightJoin|fullJoin|updateTable|insertInto|deleteFrom)\\(\\s*['"\`]${table}( as \\w+)?['"\`]`,
        );
        if (pattern.test(text)) offenders.push(`${relative(MODULE_ROOT, file)}: ${table}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the services that used to read kernel tables depend on the kernel readers', () => {
    const read = (path: string) => readFileSync(join(MODULE_ROOT, path), 'utf8');
    expect(read('services/results.service.ts')).toMatch(/exceptions\.(get|list)\(/);
    expect(read('services/fixture-obligations.service.ts')).toMatch(/exceptions\.list\(/);
    expect(read('services/readiness.service.ts')).toMatch(/AuditReader/);
    for (const path of [
      'services/seasons.service.ts',
      'services/fixture-obligations.service.ts',
      'services/fixture-generation.service.ts',
    ]) {
      expect(read(path)).toMatch(/FacilityDirectory/);
    }
  });
});
