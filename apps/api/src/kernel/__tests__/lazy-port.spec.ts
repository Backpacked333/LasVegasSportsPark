import { Injectable, Logger, Module } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestApp, type TestApp } from '../../testing/test-app';
import { customerPrincipal } from '../../testing/principals';
import { TEAM_AUTHORITY_IMPL } from '../kernel.module';
import { AuthorizationService } from '../authorization/authorization.service';
import { defineActions } from '../authorization/actions';
import { lazyPort } from '../lazy-port';

@Injectable()
class ClassBackedTeamAuthority {
  calls = 0;
  async hasTeamRole(): Promise<boolean> {
    this.calls += 1;
    return true;
  }
}

@Module({
  providers: [
    ClassBackedTeamAuthority,
    { provide: TEAM_AUTHORITY_IMPL, useExisting: ClassBackedTeamAuthority },
  ],
  exports: [TEAM_AUTHORITY_IMPL, ClassBackedTeamAuthority],
})
class TeamAuthorityTestModule {}

const Actions = defineActions({
  manage: {
    id: 'lazytest.manage',
    description: 'team-role action',
    staffRoles: [],
    teamRole: 'captain',
  },
});

describe('lazy ports (module-registered implementations)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ imports: [TeamAuthorityTestModule] });
  });
  afterAll(async () => {
    await t?.close();
  });

  it('resolves a useClass/useExisting implementation at call time, after container instantiation', async () => {
    const authorization = t.app.get(AuthorizationService);
    const captain = customerPrincipal(t.organizationId);
    const decision = await authorization.decide(captain, Actions.manage, {
      type: 'team_entry',
      organizationId: t.organizationId,
      teamEntryId: '00000000-0000-7000-8000-000000000001',
    });
    expect(decision).toEqual({ allowed: true, basis: 'team_role:captain' });
    expect(t.app.get(ClassBackedTeamAuthority).calls).toBe(1);
  });

  it('is never mistaken for a thenable and falls back when no implementation is registered', async () => {
    const fallback = { ping: async () => 'fallback' };
    const port = lazyPort<typeof fallback>(
      t.app.get(ModuleRef),
      Symbol('MISSING_IMPL'),
      fallback,
      'missing',
    );
    expect((port as { then?: unknown }).then).toBeUndefined();
    await expect(Promise.resolve(port)).resolves.toBe(port);
    expect(await port.ping()).toBe('fallback');
  });

  it('§5.11: warns once on the first real call that falls back, never because the container inspected the value', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const fallback = { ping: async () => 'fallback' };
      const port = lazyPort<typeof fallback>(
        t.app.get(ModuleRef),
        Symbol('MISSING_IMPL'),
        fallback,
        'no MISSING_IMPL registered',
      );
      // What Nest and the Promise machinery read from a provider value while the container is built.
      expect(port.constructor).toBe(Object);
      expect((port as { then?: unknown }).then).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
      await port.ping();
      await port.ping();
      expect(warn.mock.calls).toEqual([['no MISSING_IMPL registered']]);
    } finally {
      warn.mockRestore();
    }
  });
});
