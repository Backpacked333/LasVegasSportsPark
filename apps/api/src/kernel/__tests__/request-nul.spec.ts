import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IdentityModule } from '../../modules/identity/identity.module';
import {
  authHeaderForPerson,
  createStaffMemberFixture,
} from '../../modules/identity/testing/identity-fixtures';
import { createTestApp, type TestApp } from '../../testing/test-app';
import { nulCharacterPaths } from '../http/zod-validation.pipe';

const NUL = '\u0000';
const key = () => `k-${newId()}`;

describe('request strings holding U+0000 (R2-TENANCY-INPUT-04b, §4.10)', () => {
  it('§4.10: the walk names every string value and object key holding U+0000, at any depth', () => {
    expect(nulCharacterPaths({ a: 'ok', b: ['x', `y${NUL}`], c: { [`k${NUL}`]: 1 } })).toEqual([
      'b.1',
      `c.k${NUL}`,
    ]);
    let deep: unknown = `z${NUL}`;
    for (let i = 0; i < 20_000; i += 1) deep = { n: deep };
    expect(nulCharacterPaths(deep)).toHaveLength(1);
    expect(nulCharacterPaths({ when: new Date(0), n: 1, t: true, none: null })).toEqual([]);
  });

  describe('through a module command', () => {
    let t: TestApp;
    beforeAll(async () => {
      t = await createTestApp({
        imports: [IdentityModule],
        principalResolver: 'module',
        clockStart: '2026-10-23T12:00:00Z',
      });
    });
    afterAll(async () => {
      await t?.close();
    });

    it('§4.10: POST /v1/people with a NUL in the name answers 400 VALIDATION_FAILED naming the field, not 500, and writes nothing', async () => {
      const staff = await createStaffMemberFixture(t, { roles: ['front_desk'] });
      const header = await authHeaderForPerson(t, staff.personId);
      const before = await t.db
        .selectFrom('persons')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .executeTakeFirstOrThrow();
      const res = await t.http
        .post('/v1/people')
        .set(header)
        .set('Idempotency-Key', key())
        .send({
          kind: 'adult',
          givenName: `Pat${NUL}`,
          familyName: 'Doe',
          dateOfBirth: '1990-01-01',
        });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED', nextAction: 'correct_input' });
      expect(res.body.details).toEqual([
        expect.objectContaining({ path: 'givenName', code: 'custom' }),
      ]);
      const after = await t.db
        .selectFrom('persons')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .executeTakeFirstOrThrow();
      expect(Number(after.n)).toBe(Number(before.n));

      const query = await t.http.get(`/v1/people?query=Pa${encodeURIComponent(NUL)}t`).set(header);
      expect(query.status).toBe(400);
      expect(query.body.code).toBe('VALIDATION_FAILED');

      const ok = await t.http
        .post('/v1/people')
        .set(header)
        .set('Idempotency-Key', key())
        .send({ kind: 'adult', givenName: 'Pat', familyName: 'Doe', dateOfBirth: '1990-01-01' });
      expect(ok.status).toBe(201);
    });
  });
});
