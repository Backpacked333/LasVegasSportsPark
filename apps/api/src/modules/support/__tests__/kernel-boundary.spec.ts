import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * SUP-02 (§4.2 "only the owner reads or writes its tables", §4.10): support reads kernel records
 * through the kernel's read APIs — OperationalExceptions.get/list/history, OperationsService
 * requestedBy/find, AuditReader.forTarget, OutboxHistory.page, FacilityDirectory — and never
 * writes them. The only remaining select of a kernel table is the documented audit-evidence
 * lookup by audit id and by operation (`services/audit-evidence.ts`), which the kernel does not
 * expose yet.
 */
const MODULE_ROOT = path.resolve(__dirname, '..');

const SUPPORT_TABLES = new Set([
  'cases',
  'case_actions',
  'case_events',
  'exception_queues',
  'timeline_references',
  'support_timeline_backfill_cursors',
]);

/** Kernel reads still done here because the kernel offers no API for them (README). */
const ALLOWED_KERNEL_READS: Readonly<Record<string, readonly string[]>> = {
  'services/audit-evidence.ts': ['audit_records'],
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__') continue;
      out.push(...sourceFiles(full));
    } else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Tables named by query-builder calls (`selectFrom('x as y')`, `innerJoin('x')`, …). */
function builderTables(text: string): Array<{ method: string; table: string }> {
  const out: Array<{ method: string; table: string }> = [];
  const call =
    /\.(selectFrom|insertInto|updateTable|deleteFrom|mergeInto|innerJoin|leftJoin|rightJoin|fullJoin)\(\s*'([a-z_]+)(?:\s+as\s+\w+)?'/g;
  for (const m of text.matchAll(call)) out.push({ method: m[1] ?? '', table: m[2] ?? '' });
  return out;
}

/** Tables named after FROM / JOIN / INTO / UPDATE inside sql`…` templates. */
function rawSqlTables(text: string): string[] {
  const out: string[] = [];
  for (const template of text.matchAll(/sql(?:<[^>]*>)?`([^`]*)`/g)) {
    for (const m of (template[1] ?? '').matchAll(/\b(?:from|join|into|update)\s+([a-z_]+)/gi)) {
      out.push(m[1] ?? '');
    }
  }
  return out;
}

describe('support kernel boundary (SUP-02, §4.2)', () => {
  const files = sourceFiles(MODULE_ROOT).map((file) => ({
    file: path.relative(MODULE_ROOT, file).split(path.sep).join('/'),
    text: readFileSync(file, 'utf8'),
  }));

  it('support no longer selects from kernel tables', () => {
    expect(files.length).toBeGreaterThan(10);
    const violations: string[] = [];
    for (const { file, text } of files) {
      const allowed = new Set(ALLOWED_KERNEL_READS[file] ?? []);
      for (const { method, table } of builderTables(text)) {
        if (SUPPORT_TABLES.has(table)) continue;
        if (method === 'selectFrom' && allowed.has(table)) continue;
        violations.push(`${file}: ${method}('${table}')`);
      }
      for (const table of rawSqlTables(text)) {
        if (!SUPPORT_TABLES.has(table)) violations.push(`${file}: raw SQL names ${table}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('the remaining kernel lookups are read-only and stay in their one documented file', () => {
    const lookups = files.flatMap(({ file, text }) =>
      builderTables(text)
        .filter(({ table }) => !SUPPORT_TABLES.has(table))
        .map(({ method, table }) => `${file}: ${method}('${table}')`),
    );
    expect(lookups).toEqual([
      "services/audit-evidence.ts: selectFrom('audit_records')",
      "services/audit-evidence.ts: selectFrom('audit_records')",
    ]);
  });
});
