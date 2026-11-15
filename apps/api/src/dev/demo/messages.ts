import {
  MessageScheduleService,
  MessageSequencesService,
  MessageTemplatesService,
  ScheduledMessageSender,
} from '../../modules/communications';
import { optional, service, settle, type DemoContext } from './context';
import type { DemoStaff } from './people';

/**
 * Message templates and a sequence for seasons (SPK-COMMS-009). The sequence is created and
 * switched on before the season exists, so creating the season produces its schedule. Afterwards
 * the league manager confirms the message that is already due (the job then sends it), skips
 * one, and leaves the others waiting for confirmation.
 */
export const SEQUENCE_NAME = 'League season messages';

const TEMPLATES: ReadonlyArray<{
  name: string;
  title: string;
  body: string;
  anchor: 'registration_opens' | 'registration_closes' | 'starts' | 'ends';
  offsetDays: number;
}> = [
  {
    name: 'Season: registration is open',
    title: 'Registration is open for {{season_name}}',
    body: 'Team registration for {{competition_name}}, {{season_name}} is open until {{registration_closes_date}}. Games start on {{start_date}} at {{facility_name}}.',
    anchor: 'registration_opens',
    offsetDays: 1,
  },
  {
    name: 'Season: last days to register',
    title: 'Last days to enter a team in {{season_name}}',
    body: 'Registration for {{season_name}} closes on {{registration_closes_date}}. Captains: check that every player has accepted the waiver.',
    anchor: 'registration_closes',
    offsetDays: -3,
  },
  {
    name: 'Season: welcome',
    title: 'Welcome to {{season_name}}',
    body: 'Welcome to {{competition_name}}. The season runs from {{start_date}} to {{end_date}} at {{facility_name}}. Fixtures and standings are in the app.',
    anchor: 'starts',
    offsetDays: 6,
  },
  {
    name: 'Season: final week',
    title: 'Final week of {{season_name}}',
    body: 'The last games of {{season_name}} are played by {{end_date}}. Thank you for playing at {{facility_name}}.',
    anchor: 'ends',
    offsetDays: -7,
  },
];

/** Templates and the season sequence, switched on. Run before the season is created. */
export async function seedMessageSequence(
  ctx: DemoContext,
  staff: DemoStaff,
  competitionId: string,
): Promise<void> {
  const league = staff.league.principal;
  const templates = service(ctx, MessageTemplatesService);
  const sequences = service(ctx, MessageSequencesService);
  const known = (await templates.list(league, {})).items;
  const templateIds: string[] = [];
  for (const spec of TEMPLATES) {
    const template =
      known.find((t) => t.name === spec.name) ??
      (await templates.create(
        league,
        { name: spec.name, category: 'operational', title: spec.title, body: spec.body },
        null,
      ));
    templateIds.push(template.id);
  }
  const listed = await sequences.list(league, {
    facilityId: ctx.facilityId,
    subjectType: 'season',
  });
  if (listed.items.some((s) => s.name === SEQUENCE_NAME)) return;
  let sequence = await sequences.create(
    league,
    {
      name: SEQUENCE_NAME,
      facilityId: ctx.facilityId,
      subjectType: 'season',
      scopeId: competitionId,
    },
    null,
  );
  for (const [index, spec] of TEMPLATES.entries()) {
    sequence = await sequences.addStep(
      league,
      sequence.id,
      {
        templateId: templateIds[index] as string,
        anchor: spec.anchor,
        offsetDays: spec.offsetDays,
        sendTimeLocal: '09:00',
      },
      null,
    );
  }
  await sequences.update(
    league,
    sequence.id,
    { active: true, expectedRevision: sequence.revision },
    null,
  );
}

/**
 * The season's schedule: the registration notice (already due) is confirmed and sent, the
 * last-days reminder is skipped, the welcome and the final-week message wait for confirmation.
 */
export async function seedSeasonSchedule(
  ctx: DemoContext,
  staff: DemoStaff,
  seasonId: string,
): Promise<void> {
  await optional(ctx, "the season's message schedule (sent, waiting, skipped)", async () => {
    const league = staff.league.principal;
    const schedules = service(ctx, MessageScheduleService);
    const subject = { type: 'season' as const, id: seasonId };
    let schedule = await schedules.schedule(league, subject);
    if (schedule.messages.length === 0) {
      // The season existed before its sequence did (an interrupted earlier run): produce it now.
      await schedules.generate(league, subject, {}, null);
      schedule = await schedules.schedule(league, subject);
    }
    const byTitle = (fragment: string) =>
      schedule.messages.find(
        (m) => m.title.includes(fragment) || m.templateName.includes(fragment),
      );
    const opening = byTitle('registration is open') ?? byTitle('Registration is open');
    const lastDays = byTitle('Last days') ?? byTitle('last days');
    if (lastDays && lastDays.status === 'needs_confirmation') {
      await schedules.skip(
        league,
        lastDays.id,
        {
          reason: 'Both divisions were full before the reminder was due.',
          expectedRevision: lastDays.revision,
        },
        null,
      );
    }
    if (opening && opening.status === 'needs_confirmation') {
      await schedules.confirm(league, opening.id, { expectedRevision: opening.revision }, null);
      // The periodic job sends what is confirmed and due; the seed runs it once, as a worker would.
      await service(ctx, ScheduledMessageSender).run({ now: ctx.clock.now(), batchSize: 50 });
      await settle(ctx);
    }
  });
}
