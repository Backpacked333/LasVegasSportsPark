import { Controller, HttpCode, Post } from '@nestjs/common';
import { CAPABILITIES, CAPABILITY_IDS, newId, type Principal } from '@sportspark/contracts';
import { json, seedOrganization } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { customerPrincipal, staffPrincipal } from '../../testing/principals';
import { createTestApp, type TestApp } from '../../testing/test-app';
import { defineActions } from '../authorization/actions';
import { CurrentPrincipal } from '../auth/principal.decorator';
import { CapabilityService } from '../capabilities/capability.service';
import { UnitOfWork } from '../database/unit-of-work';
import { Idempotent } from '../http/idempotency.interceptor';

/** A command that creates a new commitment of a gated capability (as a module's would). */
@Controller('capability-probe')
class CapabilityProbeController {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly capabilities: CapabilityService,
  ) {}

  @Post()
  @HttpCode(201)
  @Idempotent()
  async create(@CurrentPrincipal() principal: Principal): Promise<{ created: boolean }> {
    return this.uow.run(async () => {
      await this.capabilities.require(principal.organizationId as string, 'point_of_sale');
      return { created: true };
    });
  }
}

const key = () => `cap-${newId()}`;

describe('per-organization capability switches (K-12, §1.6, §6.5, DEC-016)', () => {
  let t: TestApp;
  let admin: { Authorization: string };

  beforeAll(async () => {
    t = await createTestApp({ controllers: [CapabilityProbeController], capabilities: [] });
    admin = await t.authHeader(staffPrincipal(t.organizationId, ['system_administrator']));
  });
  afterAll(async () => {
    await t?.close();
  });

  const change = (
    header: Record<string, string>,
    capability: string,
    event: 'enable' | 'disable',
    body: Record<string, unknown>,
  ) =>
    t.http
      .post(`/v1/admin/capabilities/${capability}/${event}`)
      .set(header)
      .set('Idempotency-Key', key())
      .send(body);

  it('DEC-016: without a row every capability is disabled and a gated command answers ACCESS_DENIED details.code CAPABILITY_DISABLED', async () => {
    const gm = await t.authHeader(staffPrincipal(t.organizationId, ['general_manager']));
    const listed = await t.http.get('/v1/admin/capabilities').set(gm);
    expect(listed.status).toBe(200);
    expect(listed.body.items.map((c: { capability: string }) => c.capability)).toEqual([
      ...CAPABILITY_IDS,
    ]);
    for (const item of listed.body.items) {
      expect(item).toMatchObject({ enabled: false, decisionReference: null, revision: null });
      expect(item.applicabilityReferences[0]).toBe('DEC-016');
    }
    const pos = listed.body.items.find(
      (c: { capability: string }) => c.capability === 'point_of_sale',
    );
    expect(pos).toMatchObject({
      applicabilityReferences: ['DEC-016', 'DEC-079'],
      relatedDecisions: ['DEC-057', 'DEC-019', 'POL-018'],
      enforcement: 'commands',
    });

    const desk = await t.authHeader(staffPrincipal(t.organizationId, ['front_desk']));
    const refused = await t.http
      .post('/v1/capability-probe')
      .set(desk)
      .set('Idempotency-Key', key());
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({
      code: 'ACCESS_DENIED',
      details: {
        code: 'CAPABILITY_DISABLED',
        capability: 'point_of_sale',
        applicabilityReferences: ['DEC-016', 'DEC-079'],
      },
    });
    const service = t.app.get(CapabilityService);
    expect(await service.isEnabled(t.organizationId, 'point_of_sale')).toBe(false);
    await expect(service.require(t.organizationId, 'installments')).rejects.toThrow(
      /recorded only/,
    );
  });

  it('only a system administrator enables a capability and only with DEC-016 or its own Register E record; DEC-057 is refused for point_of_sale', async () => {
    const gm = await t.authHeader(staffPrincipal(t.organizationId, ['general_manager']));
    const notAdmin = await change(gm, 'point_of_sale', 'enable', {
      decisionReference: 'DEC-079',
      reason: 'Point of sale approved for the snack bar',
    });
    expect(notAdmin.status).toBe(403);
    const customer = await t.authHeader(customerPrincipal(t.organizationId));
    expect(
      (
        await change(customer, 'point_of_sale', 'enable', {
          decisionReference: 'DEC-079',
          reason: 'x',
        })
      ).status,
    ).toBe(403);

    const related = await change(admin, 'point_of_sale', 'enable', {
      decisionReference: 'DEC-057',
      reason: 'Taxes approved',
    });
    expect(related.status).toBe(400);
    expect(related.body.details).toMatchObject({
      code: 'NOT_AN_APPLICABILITY_DECISION',
      applicabilityReferences: ['DEC-016', 'DEC-079'],
    });
    const malformed = await change(admin, 'point_of_sale', 'enable', {
      decisionReference: 'DEC-79',
      reason: 'x',
    });
    expect(malformed.status).toBe(400);
    expect(
      (
        await change(admin, 'not_a_capability', 'enable', {
          decisionReference: 'DEC-016',
          reason: 'x',
        })
      ).status,
    ).toBe(400);

    const enabled = await change(admin, 'point_of_sale', 'enable', {
      decisionReference: 'DEC-079',
      reason: 'Point of sale approved for the snack bar',
    });
    expect(enabled.status).toBe(200);
    expect(enabled.body).toMatchObject({
      capability: 'point_of_sale',
      enabled: true,
      decisionReference: 'DEC-079',
      revision: 1,
    });
    const desk = await t.authHeader(staffPrincipal(t.organizationId, ['front_desk']));
    expect(
      (await t.http.post('/v1/capability-probe').set(desk).set('Idempotency-Key', key())).status,
    ).toBe(201);
    // Enabling twice is not a change; a stale revision is refused.
    expect(
      (
        await change(admin, 'point_of_sale', 'enable', {
          decisionReference: 'DEC-016',
          reason: 'again',
        })
      ).body.code,
    ).toBe('INVALID_TRANSITION');
    expect(
      (
        await change(admin, 'point_of_sale', 'disable', {
          decisionReference: 'DEC-016',
          reason: 'Paused',
          expectedRevision: 7,
        })
      ).body.code,
    ).toBe('STALE_REVISION');
    // Disabling stops new commitments again.
    const disabled = await change(admin, 'point_of_sale', 'disable', {
      decisionReference: 'DEC-016',
      reason: 'Point of sale paused',
      expectedRevision: 1,
    });
    expect(disabled.body).toMatchObject({ enabled: false, revision: 2 });
    expect(
      (await t.http.post('/v1/capability-probe').set(desk).set('Idempotency-Key', key())).status,
    ).toBe(403);
    // Another organization is unaffected.
    const other = await seedOrganization(t.db);
    expect(
      await t.app.get(CapabilityService).isEnabled(other.organizationId, 'point_of_sale'),
    ).toBe(false);
  });

  it('the change is audited and kept in history; the database rejects an unknown capability and any update or delete of history', async () => {
    const enabled = await change(admin, 'memberships', 'enable', {
      decisionReference: 'DEC-072',
      reason: 'Memberships offered from spring',
    });
    expect(enabled.status).toBe(200);
    const history = await t.db
      .selectFrom('organization_capability_changes')
      .selectAll()
      .where('organization_id', '=', t.organizationId)
      .where('capability', '=', 'memberships')
      .execute();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      enabled: true,
      decision_reference: 'DEC-072',
      reason: 'Memberships offered from spring',
      revision: 1,
    });
    const audit = await t.db
      .selectFrom('audit_records')
      .selectAll()
      .where('organization_id', '=', t.organizationId)
      .where('target_type', '=', 'capability')
      .where('target_id', '=', 'memberships')
      .execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'core.manage_capabilities.enable',
      reason: 'Memberships offered from spring',
      after_revision: 1,
    });
    const events = await t.db
      .selectFrom('outbox_events')
      .select('payload')
      .where('organization_id', '=', t.organizationId)
      .where('event_type', '=', 'core.capability_changed')
      .where('aggregate_id', '=', 'memberships')
      .execute();
    expect(events.map((e) => e.payload)).toEqual([
      { capability: 'memberships', enabled: true, decisionReference: 'DEC-072' },
    ]);

    // Append-only history.
    const historyId = history[0]?.id as string;
    await expect(
      t.db
        .updateTable('organization_capability_changes')
        .set({ reason: 'rewritten' })
        .where('id', '=', historyId)
        .execute(),
    ).rejects.toThrow(/append-only/);
    await expect(
      t.db.deleteFrom('organization_capability_changes').where('id', '=', historyId).execute(),
    ).rejects.toThrow(/append-only/);

    const row = (capability: string, decision = 'DEC-016') => ({
      organization_id: t.organizationId,
      capability,
      enabled: true,
      decision_reference: decision,
      reason: 'direct',
      changed_by: json({ kind: 'system' }),
      changed_at: new Date(),
    });
    // An unknown capability and a reference that cannot enable it are refused by the database.
    await expect(
      t.db.insertInto('organization_capabilities').values(row('jetpacks')).execute(),
    ).rejects.toThrow();
    await expect(
      t.db
        .insertInto('organization_capabilities')
        .values(row('point_of_sale', 'DEC-057'))
        .execute(),
    ).rejects.toThrow();
    await expect(
      t.db.insertInto('organization_capabilities').values(row('assistant', 'DEC-013')).execute(),
    ).rejects.toThrow();
  });

  it('the database accepts exactly the catalogue with each applicability reference', async () => {
    const org = await seedOrganization(t.db);
    for (const capability of CAPABILITY_IDS) {
      for (const reference of CAPABILITIES[capability].applicabilityReferences) {
        await t.db
          .insertInto('organization_capabilities')
          .values({
            organization_id: org.organizationId,
            capability,
            enabled: true,
            decision_reference: reference,
            reason: 'catalogue check',
            changed_by: json({ kind: 'system' }),
            changed_at: new Date(),
          })
          .onConflict((oc) =>
            oc
              .columns(['organization_id', 'capability'])
              .doUpdateSet({ decision_reference: reference }),
          )
          .execute();
      }
    }
    const rows = await t.db
      .selectFrom('organization_capabilities')
      .select('capability')
      .where('organization_id', '=', org.organizationId)
      .execute();
    expect(rows).toHaveLength(CAPABILITY_IDS.length);
  });

  it('an action may name only a capability enforced on commands', () => {
    expect(() =>
      defineActions({
        bad: {
          id: 'kerneltest.recorded_only_gate',
          description: 'x',
          staffRoles: [],
          capability: 'installments',
        },
      }),
    ).toThrow(/recorded only/);
    expect(() =>
      defineActions({
        bad: {
          id: 'kerneltest.unknown_gate',
          description: 'x',
          staffRoles: [],
          capability: 'jetpacks' as never,
        },
      }),
    ).toThrow(/unknown capability/);
  });
});
