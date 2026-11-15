import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IdentityModule } from '../../modules/identity';
import { createTestApp, type TestApp } from '../../testing/test-app';
import { assertSeedAllowed, seedDevelopment } from '../seed-dev';

describe('development seed (K-14, §5.2)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ imports: [IdentityModule], principalResolver: 'module' });
  });
  afterAll(async () => {
    await t?.close();
  });

  it('§5.2: the seed runs twice with the same ids', async () => {
    const first = await seedDevelopment(t.app, {
      timezone: 'America/Los_Angeles',
      enable: ['rentals'],
    });
    expect(first.organization.slug).toBe('dev');
    expect(first.facility).toMatchObject({ slug: 'dev-facility', timezone: 'America/Los_Angeles' });
    expect(first.accounts.map((a) => [a.subject, a.roles])).toEqual([
      ['dev-admin', ['system_administrator']],
      ['dev-desk', ['front_desk']],
      ['dev-league', ['league_manager']],
      ['dev-coach', ['coach']],
      ['dev-official', ['official']],
      ['dev-parent', []],
    ]);
    expect(first.enabledCapabilities).toEqual(['rentals']);
    expect(first.devTokens).toEqual({
      method: 'POST',
      path: '/v1/dev/tokens',
      body: { accountId: first.accounts[0]?.accountId },
    });

    const second = await seedDevelopment(t.app, { enable: ['rentals'] });
    expect(second).toEqual({ ...first });

    // The seeded accounts sign in through the development token endpoint and resolve to principals.
    const minted = await t.http.post('/v1/dev/tokens').send(first.devTokens.body);
    expect(minted.status).toBe(201);
    const me = await t.http.get('/v1/me').set({ Authorization: `Bearer ${minted.body.token}` });
    expect(me.status).toBe(200);
    // The parent holds the six permissions over the child (SPK-IAM-003).
    const parent = first.accounts.find((a) => a.subject === 'dev-parent');
    const grants = await t.db
      .selectFrom('access_grants')
      .select('permission')
      .where('actor_person_id', '=', parent?.personId as string)
      .where('subject_person_id', '=', first.child.personId)
      .where('revoked_at', 'is', null)
      .execute();
    expect(grants.map((g) => g.permission).sort()).toEqual(
      ['collect', 'complete_forms', 'pay', 'receive_messages', 'register', 'view'].sort(),
    );
    // Seeded with no --enable, nothing else is enabled.
    const switches = await t.db
      .selectFrom('organization_capabilities')
      .select(['capability', 'decision_reference', 'reason'])
      .where('organization_id', '=', first.organization.id)
      .execute();
    expect(switches).toEqual([
      { capability: 'rentals', decision_reference: 'DEC-016', reason: 'local development' },
    ]);
  });

  it('§5.2: each seeded account has one primary verified email <subject>@example.test, also after a second run', async () => {
    const first = await seedDevelopment(t.app);
    await seedDevelopment(t.app);
    const contacts = await t.db
      .selectFrom('contact_points')
      .select(['person_id', 'kind', 'value', 'is_primary', 'verified_at'])
      .where(
        'person_id',
        'in',
        first.accounts.map((a) => a.personId),
      )
      .execute();
    expect(contacts).toHaveLength(first.accounts.length);
    for (const account of first.accounts) {
      const mine = contacts.filter((c) => c.person_id === account.personId);
      expect(mine).toEqual([
        expect.objectContaining({
          kind: 'email',
          value: `${account.subject}@example.test`,
          is_primary: true,
        }),
      ]);
      expect(mine[0]?.verified_at).not.toBeNull();
    }
  });

  it('the seed refuses NODE_ENV=production', () => {
    expect(() => assertSeedAllowed({ NODE_ENV: 'production', AUTH_MODE: 'local' })).toThrow(
      /NODE_ENV=production/,
    );
    expect(() => assertSeedAllowed({ NODE_ENV: 'development', AUTH_MODE: 'oidc' })).toThrow(
      /AUTH_MODE=local/,
    );
    expect(() => assertSeedAllowed({ NODE_ENV: 'development', AUTH_MODE: 'local' })).not.toThrow();
  });

  it('refuses a time zone that is not IANA', async () => {
    await expect(seedDevelopment(t.app, { timezone: 'Mars/Olympus' })).rejects.toThrow(/IANA/);
  });
});
