import { DomainError } from '@sportspark/contracts';
import { describe, expect, it } from 'vitest';
import { matchAuthorityRoute } from '../services/authority-routes';
import { areasFor, CATEGORY_RULES, DEPENDENCY_ORDER } from './categories';
import { batchChecksum, canonicalJson, payloadHash } from './checksum';
import { compareControlTotals } from './control-totals';
import { csvToStagedRows, parseCsv } from './csv';

describe('neutral staging contract: CSV (staging-v1)', () => {
  it('parses RFC 4180 quoting, embedded separators and line breaks, CRLF and a BOM', () => {
    const text = '﻿a,b,c\r\n1,"x, y","say ""hi"""\n2,"multi\nline",\n\n';
    expect(parseCsv(text)).toEqual([
      ['a', 'b', 'c'],
      ['1', 'x, y', 'say "hi"'],
      ['2', 'multi\nline', ''],
    ]);
  });

  it('refuses malformed CSV instead of guessing', () => {
    expect(() => parseCsv('a,"b')).toThrow(DomainError);
    expect(() => parseCsv('a,b"c"')).toThrow(DomainError);
    expect(() => parseCsv('"a"b,c')).toThrow(DomainError);
  });

  it('maps a header row and external_id into staged rows; empty cells are absent', () => {
    const rows = csvToStagedRows(
      'person',
      'external_id,givenName,email\nP-1,Ana,\nP-2,Ben,ben@example.test\n',
    );
    expect(rows).toEqual([
      { entityType: 'person', externalId: 'P-1', payload: { givenName: 'Ana' } },
      {
        entityType: 'person',
        externalId: 'P-2',
        payload: { givenName: 'Ben', email: 'ben@example.test' },
      },
    ]);
    expect(() => csvToStagedRows('person', 'givenName\nAna\n')).toThrow(/external_id/);
    expect(() => csvToStagedRows('person', 'external_id,a,a\n1,2,3\n')).toThrow(/duplicate column/);
    expect(() => csvToStagedRows('person', 'external_id,a\n1\n')).toThrow(/one value per column/);
    expect(() => csvToStagedRows('person', 'external_id,a\n,2\n')).toThrow(/external_id/);
  });
});

describe('checksums (§5.4)', () => {
  it('payload hashes ignore key order; the batch checksum ignores row order and chunking', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[1,{"y":2,"z":1}]},"b":1}',
    );
    expect(payloadHash({ a: 1, b: 2 })).toBe(payloadHash({ b: 2, a: 1 }));
    const rows = [
      { entityType: 'person', externalId: 'P-1', payloadHash: payloadHash({ a: 1 }) },
      { entityType: 'person', externalId: 'P-2', payloadHash: payloadHash({ a: 2 }) },
    ];
    expect(batchChecksum(rows)).toBe(batchChecksum([...rows].reverse()));
    expect(batchChecksum(rows)).not.toBe(
      batchChecksum([rows[0]!, { ...rows[1]!, payloadHash: payloadHash({ a: 3 }) }]),
    );
    expect(batchChecksum(rows)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('control totals (§5.5 level 1)', () => {
  const staged = [
    { entityType: 'open_obligation' as const, payload: { amountMinor: 20_000, currency: 'USD' } },
    { entityType: 'open_obligation' as const, payload: { amountMinor: '10500', currency: 'USD' } },
    { entityType: 'credit' as const, payload: { amountMinor: 4_500, currency: 'USD' } },
    { entityType: 'credit' as const, payload: { amountMinor: 1_000, currency: 'CAD' } },
    { entityType: 'person' as const, payload: {} },
  ];

  it('reports each category and currency on its own: +500 and -500 never cancel out', () => {
    const result = compareControlTotals(
      {
        counts: { open_obligation: 2, credit: 2, person: 1 },
        amounts: [
          { entityType: 'open_obligation', currency: 'USD', totalMinor: 30_000 },
          { entityType: 'credit', currency: 'USD', totalMinor: 5_000 },
          { entityType: 'credit', currency: 'CAD', totalMinor: 1_000 },
        ],
      },
      staged,
    );
    expect(result.discrepancies).toEqual([
      {
        kind: 'amount',
        entityType: 'credit',
        currency: 'USD',
        expected: 5_000,
        actual: 4_500,
        difference: -500,
        code: 'amount_mismatch',
      },
      {
        kind: 'amount',
        entityType: 'open_obligation',
        currency: 'USD',
        expected: 30_000,
        actual: 30_500,
        difference: 500,
        code: 'amount_mismatch',
      },
    ]);
    expect(result.checked).toBe(6);
  });

  it('flags undeclared totals and declared totals that were never staged', () => {
    const result = compareControlTotals(
      {
        counts: { household: 3 },
        amounts: [{ entityType: 'refund', currency: 'USD', totalMinor: 100 }],
      },
      staged,
    );
    const codes = result.discrepancies.map(
      (d) => `${d.kind}:${d.entityType}:${d.currency ?? ''}:${d.code}`,
    );
    expect(codes).toEqual([
      'count:credit::undeclared_total',
      'count:household::declared_not_staged',
      'count:open_obligation::undeclared_total',
      'count:person::undeclared_total',
      'amount:credit:CAD:undeclared_total',
      'amount:credit:USD:undeclared_total',
      'amount:open_obligation:USD:undeclared_total',
      'amount:refund:USD:declared_not_staged',
    ]);
  });
});

describe('categories', () => {
  it('cover every §5.3 inventory line exactly once, in an order where references resolve first', () => {
    expect([...DEPENDENCY_ORDER].sort()).toEqual(Object.keys(CATEGORY_RULES).sort());
    const order = (t: string) => DEPENDENCY_ORDER.indexOf(t as never);
    expect(order('person')).toBeLessThan(order('household'));
    expect(order('person')).toBeLessThan(order('relationship_evidence'));
    expect(order('person')).toBeLessThan(order('open_obligation'));
    expect(order('person')).toBeLessThan(order('credit'));
  });

  it('§5.5: approval areas follow the categories a batch contains', () => {
    expect(areasFor(['credit', 'person', 'future_schedule', 'roster'])).toEqual([
      'identity',
      'participation',
      'schedule',
      'finance',
    ]);
    expect(areasFor(['person'])).toEqual(['identity']);
  });
});

describe('authority routes', () => {
  it('match Express route patterns with or without the /v1 prefix', () => {
    expect(matchAuthorityRoute('POST', '/v1/people')?.category).toBe('person');
    // support-migration-01: the program scope comes from the path, never from the request body.
    expect(matchAuthorityRoute('patch', '/v1/programs/:id')).toMatchObject({
      category: 'program',
      scope: { programId: 'params.id' },
    });
    expect(matchAuthorityRoute('GET', '/v1/people')).toBeUndefined();
    expect(matchAuthorityRoute('POST', '/v1/import-batches')).toBeUndefined();
    expect(matchAuthorityRoute('POST', undefined)).toBeUndefined();
  });
});
