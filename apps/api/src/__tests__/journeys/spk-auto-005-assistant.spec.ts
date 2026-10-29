import { seedOrganization } from '@sportspark/db';
import { describe, expect, it } from 'vitest';
import type { TestApp } from '../../testing';
import {
  enableAutomation,
  fakeAssistant,
} from '../../modules/automation/testing/automation-fixtures';
import {
  disableCapability,
  drain,
  enableCapability,
  get,
  journeyApp,
  ok,
  post,
  staff,
  type Actor,
} from './support';

interface Recommendation {
  id: string;
  revision: number;
  status: string;
}

/**
 * SPK-AUTO-004 / SPK-AUTO-005 (AUT-02; capability `assistant`, DEC-016, provider DEC-013 related
 * and never enabling), across automation, communications (the applied notice), support (core
 * operations) and the kernel (capabilities, audit), on the assembled application with the
 * deployment flag on and the deterministic fake assistant. The assistant proposes; people approve
 * and apply through the same command and permissions as any client; an organization whose switch
 * is off, or an assistant switched off, never stops core work.
 */
describe('SPK-AUTO-005: the assistant per organization (assembled application)', () => {
  it('an organization that enabled the assistant gets a reviewable proposal applied once through the normal command; another organization is refused and keeps working; switching it off stops approvals but not core work', async () => {
    const t: TestApp = await journeyApp({
      clockStart: '2027-01-16T20:00:00.000Z',
      configure: enableAutomation(),
    });
    try {
      const fake = fakeAssistant(t.app);
      const admin = await staff(t, ['system_administrator']);
      const lm = await staff(t, ['league_manager']);
      const coach = await staff(t, ['coach']);
      const desk = await staff(t, ['front_desk']);
      const other = await seedOrganization(t.db, { slug: 'journey-other-org' });
      const otherSupport = await staff(t, ['support_operator'], other.organizationId);

      // Off by default: the request is refused and nothing is sent to the provider.
      const ask = (actor: Actor, prompt: string) =>
        post(t, '/v1/assistant/requests', actor.header, { prompt });
      const refused = await ask(lm, 'draft the weekend notice');
      expect(refused.status).toBe(403);
      expect(refused.body.details).toMatchObject({
        code: 'CAPABILITY_DISABLED',
        capability: 'assistant',
      });
      expect(fake.received).toHaveLength(0);
      // DEC-013 (the provider) is related, never enabling; DEC-016 enables it.
      const related = await post(t, '/v1/admin/capabilities/assistant/enable', admin.header, {
        decisionReference: 'DEC-013',
        reason: 'Provider chosen',
      });
      expect(related.status).toBe(400);
      await enableCapability(t, admin, 'assistant', 'DEC-016');

      // The assistant proposes a staff notice; nothing is sent until a person approves and applies.
      const title = 'Pitch 2 closed Saturday morning';
      fake.script(title, [
        {
          type: 'tool_calls',
          calls: [
            {
              tool: 'communications.send',
              arguments: {
                kind: 'staff_broadcast',
                category: 'operational',
                audience: { staffRoles: ['front_desk'] },
                title,
                body: 'Please direct early arrivals to Pitch 3.',
              },
            },
          ],
        },
        { type: 'answer', text: 'Drafted a notice for the front desk.' },
      ]);
      const answered = await ok<{ status: string; recommendations: Recommendation[] }>(
        ask(lm, title),
        201,
      );
      expect(answered.status).toBe('answered');
      expect(answered.recommendations).toHaveLength(1);
      const proposal = answered.recommendations[0]!;
      const deskInbox = async () =>
        (
          await ok<{ items: Array<{ title: string }> }>(
            get(t, '/v1/me/inbox?limit=50', desk.header),
          )
        ).items.filter((i) => i.title === title).length;
      await drain(t);
      expect(await deskInbox()).toBe(0);
      // SPK-AUTO-004: the proposal carries no authority of its own; a coach cannot approve it.
      const byCoach = await post(t, `/v1/recommendations/${proposal.id}/approve`, coach.header, {
        expectedRevision: proposal.revision,
      });
      expect(byCoach.status).toBeGreaterThanOrEqual(403);
      const approved = await ok<Recommendation>(
        post(t, `/v1/recommendations/${proposal.id}/approve`, lm.header, {
          expectedRevision: proposal.revision,
        }),
      );
      const applied = await ok<Recommendation>(
        post(t, `/v1/recommendations/${proposal.id}/apply`, lm.header, {
          expectedRevision: approved.revision,
        }),
      );
      expect(applied.status).toBe('applied');
      await drain(t);
      expect(await deskInbox()).toBe(1);
      const again = await post(t, `/v1/recommendations/${proposal.id}/apply`, lm.header, {
        expectedRevision: applied.revision,
      });
      expect(again.status).toBe(409);
      await drain(t);
      expect(await deskInbox()).toBe(1);

      // Another organization has not enabled it: refused, and its core operations work.
      const otherAsk = await ask(otherSupport, 'summarize today');
      expect(otherAsk.status).toBe(403);
      expect(otherAsk.body.details).toMatchObject({ code: 'CAPABILITY_DISABLED' });
      await ok(
        post(t, '/v1/cases', otherSupport.header, {
          category: 'other',
          title: 'Work continues without the assistant',
        }),
        201,
      );

      // Switched off here too: a pending proposal cannot be approved; reads and core work go on.
      fake.script('second notice', [
        {
          type: 'tool_calls',
          calls: [
            {
              tool: 'communications.send',
              arguments: {
                kind: 'staff_broadcast',
                category: 'operational',
                audience: { staffRoles: ['front_desk'] },
                title: 'second notice',
                body: 'Another notice.',
              },
            },
          ],
        },
        { type: 'answer', text: 'Drafted.' },
      ]);
      const pending = (
        await ok<{ recommendations: Recommendation[] }>(ask(lm, 'second notice'), 201)
      ).recommendations[0]!;
      await disableCapability(t, admin, 'assistant', 'DEC-016');
      const blocked = await post(t, `/v1/recommendations/${pending.id}/approve`, lm.header, {
        expectedRevision: pending.revision,
      });
      expect(blocked.status).toBe(403);
      expect(blocked.body.details).toMatchObject({ code: 'CAPABILITY_DISABLED' });
      expect(
        (await ok<Recommendation>(get(t, `/v1/recommendations/${pending.id}`, lm.header))).status,
      ).toBe('proposed');
      // Core work: the league manager sends the notice through the ordinary command.
      const composed = await ok<{ id: string }>(
        post(t, '/v1/notifications', lm.header, {
          kind: 'staff_broadcast',
          category: 'operational',
          audience: { staffRoles: ['front_desk'] },
          title: 'Sent by hand',
          body: 'The assistant is off; this went out anyway.',
        }),
        201,
      );
      await ok(post(t, `/v1/notifications/${composed.id}/send`, lm.header, {}));
      await drain(t);
      const titles = (
        await ok<{ items: Array<{ title: string }> }>(get(t, '/v1/me/inbox?limit=50', desk.header))
      ).items.map((i) => i.title);
      expect(titles).toContain('Sent by hand');
      expect(titles).not.toContain('second notice');
    } finally {
      await t.close();
    }
  });
});
