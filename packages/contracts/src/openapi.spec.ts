import { describe, expect, it } from 'vitest';
import { ErrorCodes, NEXT_ACTIONS } from './errors';
import { buildOpenApiDocument, nullableReferences } from './openapi';
import { namedSchemaCollisions, QueryBoolean, z } from './index';

type SchemaObject = Record<string, unknown>;

const document = buildOpenApiDocument('test');
const schemas = (document.components?.schemas ?? {}) as Record<string, SchemaObject>;

function property(component: string, name: string): unknown {
  const schema = schemas[component];
  if (!schema) throw new Error(`component ${component} is missing`);
  const direct = (schema['properties'] as Record<string, unknown> | undefined)?.[name];
  if (direct) return direct;
  // An extended schema is `allOf [$ref base, { properties }]`.
  for (const part of (schema['allOf'] as SchemaObject[] | undefined) ?? []) {
    const nested = (part['properties'] as Record<string, unknown> | undefined)?.[name];
    if (nested) return nested;
  }
  throw new Error(`${component}.${name} is missing`);
}

describe('OpenAPI emission (K-01, §4.8 publish exact schemas)', () => {
  it('§4.8: no component schema is nullable at the component level (no components.schemas[*].type or enum contains null)', () => {
    const nullable = Object.entries(schemas)
      .filter(
        ([, schema]) =>
          (Array.isArray(schema['type']) && (schema['type'] as unknown[]).includes('null')) ||
          (Array.isArray(schema['enum']) && (schema['enum'] as unknown[]).includes(null)),
      )
      .map(([name]) => name);
    expect(nullable).toEqual([]);
  });

  it('§4.8: a nullable reference is anyOf [$ref, null] (Me.person, ClaimAccepted.relationship, FixtureDetail.away, BasketLine.applicationStatus, Restriction.approvedBy, ImportException.decidedBy)', () => {
    const cases: Array<[string, string, string]> = [
      ['Me', 'person', 'Person'],
      ['ClaimAccepted', 'relationship', 'Relationship'],
      ['FixtureDetail', 'away', 'FixtureSide'],
      ['BasketLine', 'applicationStatus', 'ApplicationStatus'],
      ['Restriction', 'approvedBy', 'ActorSnapshot'],
      ['ImportException', 'decidedBy', 'ActorSnapshot'],
    ];
    for (const [component, name, target] of cases) {
      expect(property(component, name), `${component}.${name}`).toEqual({
        anyOf: [{ $ref: `#/components/schemas/${target}` }, { type: 'null' }],
      });
    }
  });

  it('no allOf still carries a null type next to a reference', () => {
    let leftovers = 0;
    JSON.stringify(document, (_key, value: unknown) => {
      const allOf = (value as SchemaObject | null)?.['allOf'];
      if (
        Array.isArray(allOf) &&
        allOf.some(
          (part: SchemaObject) =>
            Array.isArray(part['type']) && (part['type'] as unknown[]).includes('null'),
        )
      ) {
        leftovers += 1;
      }
      return value;
    });
    expect(leftovers).toBe(0);
  });

  it('nullableReferences keeps metadata next to anyOf and rewrites recursive oneOf references', () => {
    expect(
      nullableReferences({
        allOf: [{ $ref: '#/x' }, { type: ['string', 'null'], enum: ['a', null], description: 'd' }],
      }),
    ).toEqual({ description: 'd', anyOf: [{ $ref: '#/x' }, { type: 'null' }] });
    expect(nullableReferences({ oneOf: [{ $ref: '#/x' }, { type: 'null' }] })).toEqual({
      anyOf: [{ $ref: '#/x' }, { type: 'null' }],
    });
    // A non-null allOf is left as it is.
    expect(nullableReferences({ allOf: [{ $ref: '#/x' }, { minLength: 1 }] })).toEqual({
      allOf: [{ $ref: '#/x' }, { minLength: 1 }],
    });
  });

  it('§4.10: ErrorResponse code and nextAction are the closed lists of ErrorCodes', () => {
    const error = schemas['ErrorResponse'] as { properties: Record<string, SchemaObject> };
    expect([...(error.properties['code']?.['enum'] as string[])].sort()).toEqual(
      Object.keys(ErrorCodes).sort(),
    );
    const nextActions = error.properties['nextAction']?.['enum'] as string[];
    for (const { nextAction } of Object.values(ErrorCodes))
      expect(nextActions).toContain(nextAction);
    expect([...nextActions].sort()).toEqual([...NEXT_ACTIONS].sort());
  });

  it('no component name is given to two different schemas (IF-08)', () => {
    expect(namedSchemaCollisions()).toEqual([]);
  });

  it('a name given to two different schemas is reported as a collision (IF-08)', () => {
    z.object({ a: z.string() }).openapi('ContractsSpecCollisionProbe');
    z.object({ b: z.string() }).openapi('ContractsSpecCollisionProbe');
    expect(namedSchemaCollisions()).toContain('ContractsSpecCollisionProbe');
  });

  it('QueryBoolean accepts only the strings true and false (IF-06)', () => {
    expect(QueryBoolean.parse('true')).toBe(true);
    expect(QueryBoolean.parse('false')).toBe(false);
    expect(QueryBoolean.safeParse('yes').success).toBe(false);
    expect(QueryBoolean.safeParse('1').success).toBe(false);
  });
});
