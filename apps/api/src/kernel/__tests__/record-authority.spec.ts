import { Controller, Module, Post } from '@nestjs/common';
import { importActorLabel, newId, systemPrincipal } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applicationRouteFacts } from '../../openapi-document';
import { customerPrincipal, staffPrincipal } from '../../testing/principals';
import { createTestApp, type TestApp } from '../../testing/test-app';
import { assertImportPrincipal, importContentMismatch } from '../authorization/import-principal';
import {
  RECORD_AUTHORITY_IMPL,
  RECORD_AUTHORITY_PORT,
  type RecordAuthorityPort,
} from '../authorization/record-authority.port';
import { NoRecordAuthority, RecordAuthority } from '../http/record-authority.decorator';
import { collectRouteFacts } from '../http/route-catalog';

@Controller('record-authority-probe')
class ProbeController {
  @Post('people')
  @RecordAuthority('person', 'organization')
  createPerson(): void {}

  @Post('events/:id/move')
  @RecordAuthority('future_schedule', { facilityId: 'params.id' })
  move(): void {}

  @Post('devices')
  @NoRecordAuthority('Not a §5.3 record category')
  device(): void {}

  @Post('unclassified')
  unclassified(): void {}
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

describe('record-authority classification and port (K-11, §5.6)', () => {
  it('a handler with both decorators fails at startup', () => {
    expect(() => {
      class Both {
        @RecordAuthority('person')
        @NoRecordAuthority('Not a §5.3 record category')
        handler(): void {}
      }
      return Both;
    }).toThrow(/exactly once/);
    expect(() => NoRecordAuthority('too short')).toThrow(/11 characters/);
  });

  it("route facts carry each handler's classification", () => {
    const facts = collectRouteFacts([ProbeModule]);
    const by = new Map(facts.map((f) => [`${f.method} ${f.path}`, f.recordAuthority]));
    expect(by.get('POST /record-authority-probe/people')).toEqual({
      kind: 'guarded',
      category: 'person',
      scope: 'organization',
    });
    expect(by.get('POST /record-authority-probe/events/{id}/move')).toEqual({
      kind: 'guarded',
      category: 'future_schedule',
      scope: { facilityId: 'params.id' },
    });
    expect(by.get('POST /record-authority-probe/devices')).toEqual({
      kind: 'exempt',
      reason: 'Not a §5.3 record category',
    });
    expect(by.get('POST /record-authority-probe/unclassified')).toBeNull();
    // The application's own kernel commands are classified by decorator.
    const app = new Map(applicationRouteFacts().map((f) => [`${f.method} ${f.path}`, f]));
    expect(app.get('POST /admin/capabilities/{capability}/enable')?.recordAuthority).toEqual({
      kind: 'exempt',
      reason: 'Not a §5.3 record category',
    });
  });

  describe('RECORD_AUTHORITY_PORT', () => {
    let t: TestApp;
    beforeAll(async () => {
      t = await createTestApp();
    });
    afterAll(async () => {
      await t?.close();
    });

    it('without an implementation the port refuses nothing', async () => {
      const port = t.app.get<RecordAuthorityPort>(RECORD_AUTHORITY_PORT);
      await expect(
        port.assertNoLegacyAuthority(t.organizationId, 'person'),
      ).resolves.toBeUndefined();
      await expect(
        port.assertNoLegacyAuthority(t.organizationId, 'future_schedule', {
          facilityId: t.facilityId,
        }),
      ).resolves.toBeUndefined();
    });

    it('a registered implementation answers through the port with the scope it was given', async () => {
      const calls: unknown[] = [];
      const impl: RecordAuthorityPort = {
        assertNoLegacyAuthority: async (organizationId, category, scope) => {
          calls.push([organizationId, category, scope]);
        },
      };
      const app = await createTestApp({
        providers: [{ provide: RECORD_AUTHORITY_IMPL, useValue: impl }],
      });
      try {
        const port = app.app.get<RecordAuthorityPort>(RECORD_AUTHORITY_PORT);
        await port.assertNoLegacyAuthority(app.organizationId, 'program', { programId: 'p' });
        expect(calls).toEqual([[app.organizationId, 'program', { programId: 'p' }]]);
      } finally {
        await app.close();
      }
    });
  });
});

describe('import provenance (K-13, §5.3, §5.4, SPK-AT-024)', () => {
  const org = newId();
  const provenance = { batchId: newId(), externalKey: 'legacy-person-42', recordId: newId() };

  it('assertImportPrincipal accepts only the system import principal of the same batch', () => {
    expect(() =>
      assertImportPrincipal(systemPrincipal(org, importActorLabel(provenance.batchId)), provenance),
    ).not.toThrow();
    expect(importActorLabel(provenance.batchId)).toBe(`migration.import:${provenance.batchId}`);
  });

  it("a staff principal or another batch's principal is refused", () => {
    for (const principal of [
      staffPrincipal(org, ['system_administrator'], {
        actorLabel: importActorLabel(provenance.batchId),
      }),
      customerPrincipal(org),
      systemPrincipal(org, importActorLabel(newId())),
      systemPrincipal(org, 'migration.import'),
    ]) {
      expect(() => assertImportPrincipal(principal, provenance)).toThrow(
        expect.objectContaining({ code: 'ACCESS_DENIED' }),
      );
    }
    expect(importContentMismatch({ recordId: provenance.recordId })).toMatchObject({
      code: 'RESOURCE_CONFLICT',
      details: { code: 'IMPORT_CONTENT_MISMATCH', recordId: provenance.recordId },
    });
  });
});
