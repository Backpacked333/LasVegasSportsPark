/**
 * Home "To do" (redesign handoff 1b, INTERACTIONS 1b rows 6 to 8, 3a): the things the family must
 * do, each acting in place: a fee opens the Pay sheet (2b), a missing or lapsed waiver the Sign
 * sheet (2c), a team invitation the Join sheet (3c).
 *
 * Sources, each answered by the API under its own authorization (the client only chooses whom to
 * ask about from `GET /v1/me`):
 * - fees: `GET /v1/obligations?debtorPersonId=&status=open` for the account holder and each person
 *   the account holds `pay` over (SPK-PAY-004/005); a balance with nothing left to pay is not a
 *   to-do;
 * - forms: `GET /v1/people/{id}/waivers` for each person the account may complete forms for
 *   (SPK-REG-011): a waiver `missing` or `lapsed` with a version in force;
 * - invitations: `GET /v1/me/team-invitations?status=pending` (CMP-03), the ones still open.
 *
 * A read that fails or is not available leaves its rows out (never guessed); the screen shows the
 * failure where the rows would be.
 */
import type { Schema } from '@sportspark/api-client';
import { useMemo } from 'react';
import { useApiQuery } from '../../api/useApiQuery';
import { formatMoney } from '../money/format';
import { useApiReads, useSignedIn } from '../today/queries';
import { useNow } from '../../providers/AppProviders';
import { snoozedInvitations } from '../teams/JoinTeamSheet';
import { holds, useHousehold, type HouseholdPerson } from './household';

type Obligation = Schema<'Obligation'>;
type PersonWaiver = Schema<'PersonWaiver'>;
type TeamInvitationView = Schema<'TeamInvitationView'>;

export type TodoItem =
  | {
      kind: 'pay';
      id: string;
      personId: string;
      title: string;
      obligation: Obligation;
      /** "$120" (whole amounts without cents, as the button shows them). */
      amount: string;
    }
  | {
      kind: 'sign';
      id: string;
      personId: string;
      title: string;
      waiver: PersonWaiver;
    }
  | {
      kind: 'join';
      id: string;
      personId: string;
      title: string;
      invitation: TeamInvitationView;
    };

/** "$120" for whole amounts, "$120.50" otherwise. */
export function shortMoney(amountMinor: number, currency: string): string {
  const full = formatMoney(amountMinor, currency);
  return full.replace(/\.00$/u, '');
}

/** Rough minutes to clear the list ("about 2 min"): paying and signing take longer than answering. */
const MINUTES: Readonly<Record<TodoItem['kind'], number>> = { pay: 0.75, sign: 0.75, join: 0.5 };

export function todoSummary(items: readonly TodoItem[]): string {
  if (items.length === 0) return '✓ All done';
  const minutes = Math.max(1, Math.round(items.reduce((sum, i) => sum + MINUTES[i.kind], 0)));
  return `${items.length} left · about ${minutes} min`;
}

/** The rows, in the design's order: fees, forms, invitations; each list by due date or name. */
export function todoItems(input: {
  obligations: readonly Obligation[];
  waivers: readonly { personId: string; waivers: readonly PersonWaiver[] }[];
  invitations: readonly TeamInvitationView[];
  selfId: string | null;
  now: Date;
  /** Invitations hidden with "Not now" (id → until). */
  snoozed?: ReadonlyMap<string, number>;
  /** A counter the caller bumps when `snoozed` changed (it lives outside React state). */
  hidden?: number;
}): TodoItem[] {
  const pay: TodoItem[] = input.obligations
    .filter((o) => o.status === 'open' && o.totals.remainingMinor > 0)
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt))
    .map((o) => ({
      kind: 'pay',
      id: `pay:${o.id}`,
      personId: o.debtor.personId ?? input.selfId ?? '',
      title: o.description,
      obligation: o,
      amount: shortMoney(o.totals.remainingMinor, o.totals.currency),
    }));
  const sign: TodoItem[] = input.waivers.flatMap(({ personId, waivers }) =>
    waivers
      .filter((w) => w.status !== 'current' && w.currentVersion !== null)
      .map((w): TodoItem => ({
        kind: 'sign',
        id: `sign:${personId}:${w.policyKey}`,
        personId,
        title: w.title,
        waiver: w,
      })),
  );
  const join: TodoItem[] = input.invitations
    .filter((i) => i.effectiveStatus === 'pending')
    .filter((i) => (input.snoozed?.get(i.id) ?? 0) <= input.now.getTime())
    .map((i) => ({
      kind: 'join',
      id: `join:${i.id}`,
      personId: input.selfId ?? '',
      title: i.teamName,
      invitation: i,
    }));
  return [...pay, ...sign, ...join];
}

/**
 * How many To do rows the whole family has (the Home tab's badge, handoff Shell row 2). The reads
 * are the same cached queries Home makes, so the badge updates after any pay, sign or join
 * without a refresh of its own. 0 while signed out or loading.
 */
export function useTodoCount(): number {
  const { people, selfId } = useHousehold();
  const reads = useTodoReads(people, selfId);
  const now = useNow();
  return todoItems({
    obligations: reads.obligations,
    waivers: reads.waivers,
    invitations: reads.invitations,
    selfId,
    now,
    snoozed: snoozedInvitations(),
  }).length;
}

/** The To do reads for a household. */
export function useTodoReads(people: readonly HouseholdPerson[], selfId: string | null) {
  const signedIn = useSignedIn();
  const payers = useMemo(() => people.filter((p) => holds(p, 'pay')), [people]);
  const signers = useMemo(
    () => people.filter((p) => holds(p, 'complete_forms') && !p.self),
    [people],
  );
  const obligationRequests = useMemo(
    () =>
      payers.map((p) => ({
        query: { debtorPersonId: p.id, status: 'open' as const, limit: 50 },
      })),
    [payers],
  );
  const waiverRequests = useMemo(() => signers.map((p) => ({ path: { id: p.id } })), [signers]);
  const obligations = useApiReads('/obligations', obligationRequests, signedIn && !!selfId);
  const waivers = useApiReads('/people/{id}/waivers', waiverRequests, signedIn && !!selfId);
  const invitations = useApiQuery({
    path: '/me/team-invitations',
    request: { query: { status: 'pending', limit: 50 } },
    enabled: signedIn && !!selfId,
  });
  const reads = [...obligations, ...waivers];
  return {
    obligations: obligations.flatMap((r) => r.data?.items ?? []),
    waivers: waivers.flatMap((r, index) =>
      r.data ? [{ personId: signers[index]?.id ?? r.data.personId, waivers: r.data.waivers }] : [],
    ),
    invitations: invitations.data?.items ?? [],
    loading:
      reads.some((r) => r.isPending) ||
      (invitations.data === undefined && invitations.error === null),
    updatedAt: [...reads.map((r) => r.updatedAt), invitations.updatedAt],
    refetch: () => {
      reads.forEach((r) => r.refetch());
      void invitations.refetch();
    },
  };
}
