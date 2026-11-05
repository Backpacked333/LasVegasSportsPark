/**
 * Emits docs/package-a/permission-matrix.generated.md from the kernel action registry (spec §4.11
 * authorization, §6.7 "Permission matrix"). Importing the application module evaluates every
 * module's `defineActions`, so the registry holds every action the running API can authorize.
 *
 * Run with `pnpm build && pnpm permission-matrix` from the repository root.
 */
import 'reflect-metadata';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { format, resolveConfig } from 'prettier';
import { AppModule } from '../src/app.module';
import { actionRegistry, type ActionDefinition } from '../src/kernel/authorization/actions';

/** Referenced so the import above is kept: loading it registers every module's actions. */
void AppModule;

const target = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'docs',
  'package-a',
  'permission-matrix.generated.md',
);

function cell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll(/\s+/g, ' ').trim();
}

function list(values: readonly string[] | undefined): string {
  if (!values || values.length === 0) return '—';
  return values.map((value) => `\`${value}\``).join(', ');
}

function optional(value: string | undefined): string {
  return value ? `\`${value}\`` : '—';
}

function row(action: ActionDefinition): string {
  return [
    `\`${action.id}\``,
    cell(action.description),
    list(action.staffRoles),
    action.allowSelf ? 'yes' : 'no',
    optional(action.subjectPermission),
    optional(action.teamRole),
    action.requirements && action.requirements.length > 0
      ? action.requirements.map(cell).join(', ')
      : '—',
  ].join(' | ');
}

async function main(): Promise<void> {
  const actions = actionRegistry.list();
  if (actions.length === 0) {
    throw new Error('no actions registered: did the application module fail to load?');
  }

  const perModule = new Map<string, number>();
  for (const action of actions) {
    const owner = action.id.split('.')[0] ?? action.id;
    perModule.set(owner, (perModule.get(owner) ?? 0) + 1);
  }

  const lines = [
    '# Permission matrix (generated)',
    '',
    '> Generated from code by `apps/api/scripts/emit-permission-matrix.ts`; do not edit by hand.',
    '> Regenerate with `pnpm build && pnpm permission-matrix` from the repository root.',
    '',
    `Every action registered with \`defineActions\` in the kernel action registry ` +
      `(\`apps/api/src/kernel/authorization/actions.ts\`) when the application module is loaded: ` +
      `${actions.length} actions. This file is **Verified** in the sense of §6.7: each row is ` +
      `what \`AuthorizationService\` evaluates today. Proposed actions that are not registered, ` +
      `and pending decisions about who should hold an action, are in ` +
      `[\`permission-matrix.md\`](permission-matrix.md).`,
    '',
    'Columns: **Staff roles** may perform the action within their organization or facility scope; ' +
      '**Self** means a customer may act on themselves as the subject person; **Subject permission** ' +
      'is the grant a customer must hold over every subject person; **Team role** is the role a ' +
      'customer must hold on the target team entry; **Requirements** are the specification ids the ' +
      'action declares.',
    '',
    '## Actions per namespace',
    '',
    'The namespace is the prefix of the action id: a domain module, or `exceptions` and ' +
      '`operations` for the actions the shared kernel declares.',
    '',
    '| Namespace | Actions |',
    '| --- | --- |',
    ...[...perModule.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([owner, count]) => `| \`${owner}\` | ${count} |`),
    `| **Total** | **${actions.length}** |`,
    '',
    '## Actions',
    '',
    '| Action | Description | Staff roles | Self | Subject permission | Team role | Requirements |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...actions.map((action) => `| ${row(action)} |`),
    '',
  ];

  const config = (await resolveConfig(target)) ?? {};
  const document = await format(lines.join('\n'), { ...config, filepath: target });
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, document);
  console.warn(`wrote ${target} (${actions.length} actions)`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
