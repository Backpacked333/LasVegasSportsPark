import { Injectable } from '@nestjs/common';
import {
  PolicyKindSchema,
  z,
  type AssistantMissingEvidence,
  type PersonDetail,
  type Principal,
} from '@sportspark/contracts';
import { PoliciesService, CatalogActions } from '../../catalog';
import { MatchActions, ReadinessService } from '../../competition';
import { FinanceActions, PaymentsService } from '../../finance';
import { IdentityActions, PeopleService } from '../../identity';
import { ReportingActions, ReportsService } from '../../reporting';
import { ScheduleDraftsService, SchedulingActions } from '../../scheduling';
import { SupportActions, TimelineService, TodayService } from '../../support';
import { missingEvidence, type EvidenceDraft } from '../evidence';
import { queryTool, type AnyQueryTool, type QueryResult } from './tool.types';

const LocalDate = z.iso.date();

/**
 * Read tools (SPK-AUTO-001): each calls one exported query of the owning module with the
 * requester's principal and turns its answer into supporting records with their as-of instants
 * (SPK-AUTO-002). Whatever the module withholds from this principal stays withheld: the module
 * throws, and the assistant reports the information as not available (never why).
 */
@Injectable()
export class QueryTools {
  constructor(
    private readonly today: TodayService,
    private readonly timeline: TimelineService,
    private readonly readiness: ReadinessService,
    private readonly people: PeopleService,
    private readonly payments: PaymentsService,
    private readonly drafts: ScheduleDraftsService,
    private readonly policies: PoliciesService,
    private readonly reports: ReportsService,
  ) {}

  all(): AnyQueryTool[] {
    return [
      this.todayFeed(),
      this.fixtureReadiness(),
      this.person(),
      this.payment(),
      this.scheduleDraft(),
      this.policyVersions(),
      this.demandReport(),
      this.customerTimeline(),
    ];
  }

  /** SPK-AUTO-001 "Summarize today's unresolved issues" (support's Today workspace). */
  private todayFeed(): AnyQueryTool {
    return queryTool({
      kind: 'query',
      name: 'support.today_feed',
      actionId: SupportActions.readToday.id,
      description: "Today's unresolved issues within the caller's queues and facilities",
      argumentsDoc: { facilityId: 'optional facility id' },
      argsSchema: z.object({ facilityId: z.uuid().optional() }).strict(),
      run: async (principal: Principal, args): Promise<QueryResult> => {
        const feed = await this.today.feed(principal, args);
        const evidence: EvidenceDraft[] = feed.items.map((item) => ({
          recordType: item.affected?.type ?? `${item.source}_item`,
          recordId: item.affected?.id ?? item.id,
          label: item.title,
          asOf: feed.generatedAt,
          basis: 'evaluation',
        }));
        const missing = todaySourceGaps(feed.sources);
        return {
          output: {
            generatedAt: feed.generatedAt,
            facilities: feed.facilities.map((f) => ({
              facilityId: f.facilityId,
              name: f.name,
              localDate: f.localDate,
              activities: f.activities,
            })),
            items: feed.items.map((i) => ({
              id: i.id,
              group: i.group,
              category: i.category,
              title: i.title,
              severity: i.severity,
              affected: i.affected,
              ownerQueue: i.ownerQueue,
              status: i.status,
              ageMinutes: i.ageMinutes,
              deadlineAt: i.deadlineAt,
              overdue: i.overdue,
              nextActions: i.nextActions.map((a) => a.action),
            })),
            sources: feed.sources,
          },
          evidence,
          missing,
        };
      },
    });
  }

  /** SPK-AUTO-001 "Explain readiness blockers"; unknown checks stay unknown (SPK-READY-002). */
  private fixtureReadiness(): AnyQueryTool {
    return queryTool({
      kind: 'query',
      name: 'competition.fixture_readiness',
      actionId: MatchActions.readReadiness.id,
      description: 'The readiness assessment of a fixture: checks, blockers, unknown evidence',
      argumentsDoc: { fixtureId: 'fixture id' },
      argsSchema: z.object({ fixtureId: z.uuid() }).strict(),
      contextType: 'fixture',
      contextArgs: (id) => ({ fixtureId: id }),
      run: async (principal, args): Promise<QueryResult> => {
        const r = await this.readiness.evaluate(principal, args.fixtureId);
        const evidence: EvidenceDraft[] = [
          {
            recordType: 'fixture',
            recordId: r.fixtureId,
            label: `Fixture readiness: ${r.status}`,
            asOf: r.evaluatedAt,
            basis: 'evaluation',
          },
        ];
        for (const issue of r.issues) {
          if (!issue.source.id) continue;
          if (issue.source.type === 'fixture' && issue.source.id === r.fixtureId) continue;
          evidence.push({
            recordType: issue.source.type,
            recordId: issue.source.id,
            label: issue.code,
            asOf: issue.lastEvaluatedAt,
            basis: 'evaluation',
          });
        }
        const missing = r.checks
          .filter((c) => c.status === 'unknown')
          .map((c) =>
            missingEvidence(
              'readiness_check',
              `${r.fixtureId}:${c.name}`,
              'competition.fixture_readiness',
              'unknown_evidence',
              `The ${c.name} check has no confirming evidence; it is reported unknown, not ready.`,
            ),
          );
        return { output: r, evidence, missing };
      },
    });
  }

  /**
   * A person as identity shows it to this principal, minimized for the provider (R4-PRIVACY-04,
   * §4.14 "child information must be minimized", SPK-AT-026): who the person is (name, kind,
   * status, merge), never the date of birth or a contact value. No SPK-AUTO-001 use needs them,
   * and everything a tool returns is sent to the assistant provider (DEC-013).
   */
  private person(): AnyQueryTool {
    return queryTool({
      kind: 'query',
      name: 'identity.person',
      actionId: IdentityActions.readPerson.id,
      description:
        'A person: name, kind and status (self, guardians holding view, staff); no date of birth or contact details',
      argumentsDoc: { personId: 'person id' },
      argsSchema: z.object({ personId: z.uuid() }).strict(),
      contextType: 'person',
      contextArgs: (id) => ({ personId: id }),
      run: async (principal, args): Promise<QueryResult> => {
        const person = await this.people.getPerson(principal, args.personId);
        return {
          output: assistantPersonView(person),
          evidence: [
            {
              recordType: 'person',
              recordId: person.id,
              label: null,
              asOf: person.updatedAt,
              basis: 'record',
            },
          ],
          missing: [],
        };
      },
    });
  }

  /** SPK-AUTO-001 "Explain financial exceptions from approved records" (finance's own record). */
  private payment(): AnyQueryTool {
    return queryTool({
      kind: 'query',
      name: 'finance.payment',
      actionId: FinanceActions.readCheckout.id,
      description: 'A payment attempt with its provider outcome (payer or finance readers)',
      argumentsDoc: { paymentAttemptId: 'payment attempt id' },
      argsSchema: z.object({ paymentAttemptId: z.uuid() }).strict(),
      contextType: 'payment_attempt',
      contextArgs: (id) => ({ paymentAttemptId: id }),
      run: async (principal, args): Promise<QueryResult> => {
        const payment = await this.payments.get(principal, args.paymentAttemptId);
        const missing =
          payment.status === 'unknown'
            ? [
                missingEvidence(
                  'payment_outcome',
                  payment.id,
                  'finance.payment',
                  'unknown_evidence',
                  'The provider outcome of this payment is not yet known; it is awaiting reconciliation.',
                ),
              ]
            : [];
        return {
          output: payment,
          evidence: [
            {
              recordType: 'payment_attempt',
              recordId: payment.id,
              label: `Payment ${payment.status}`,
              asOf: payment.resolvedAt ?? payment.updatedAt,
              basis: 'record',
            },
          ],
          missing,
        };
      },
    });
  }

  /** A schedule draft with its last validation (the basis of a schedule repair). */
  private scheduleDraft(): AnyQueryTool {
    return queryTool({
      kind: 'query',
      name: 'scheduling.schedule_draft',
      actionId: SchedulingActions.manageDrafts.id,
      description: 'A schedule draft: changes, base revisions and last validation',
      argumentsDoc: { draftId: 'schedule draft id' },
      argsSchema: z.object({ draftId: z.uuid() }).strict(),
      contextType: 'schedule_draft',
      contextArgs: (id) => ({ draftId: id }),
      run: async (principal, args): Promise<QueryResult> => {
        const draft = await this.drafts.get(principal, args.draftId);
        const missing = [];
        if (!draft.validationResults) {
          missing.push(
            missingEvidence(
              'schedule_draft_validation',
              draft.id,
              'scheduling.schedule_draft',
              'not_evaluated',
              'The draft has not been validated; conflicts are checked again when it is published.',
            ),
          );
        } else if (
          draft.validatedAt &&
          new Date(draft.validatedAt).getTime() < new Date(draft.lastSavedAt).getTime()
        ) {
          missing.push(
            missingEvidence(
              'schedule_draft_validation',
              draft.id,
              'scheduling.schedule_draft',
              'not_evaluated',
              'The last validation predates the latest change to the draft.',
            ),
          );
        }
        return {
          output: draft,
          evidence: [
            {
              recordType: 'schedule_draft',
              recordId: draft.id,
              label: draft.name,
              // The last change of the draft's content (autosave), from the scheduling clock.
              asOf: draft.lastSavedAt,
              basis: 'record',
            },
          ],
          missing,
        };
      },
    });
  }

  /** SPK-AUTO-001 "Find relevant policies": approved policy versions only. */
  private policyVersions(): AnyQueryTool {
    return queryTool({
      kind: 'query',
      name: 'catalog.policy_versions',
      actionId: CatalogActions.readCatalog.id,
      description: 'Approved policy versions, optionally by kind and key',
      argumentsDoc: { kind: 'optional policy kind', key: 'optional policy key' },
      argsSchema: z
        .object({ kind: PolicyKindSchema.optional(), key: z.string().min(1).max(100).optional() })
        .strict(),
      run: async (principal, args): Promise<QueryResult> => {
        const page = await this.policies.list(principal, {
          limit: 20,
          approvalStatus: 'approved',
          ...(args.kind ? { kind: args.kind } : {}),
          ...(args.key ? { key: args.key } : {}),
        });
        const missing =
          page.items.length === 0
            ? [
                missingEvidence(
                  'policy_version',
                  args.key ?? args.kind ?? null,
                  'catalog.policy_versions',
                  'not_available',
                  'No approved policy version matches; nothing is assumed in its place.',
                ),
              ]
            : [];
        return {
          output: page.items.map((p) => ({
            id: p.id,
            kind: p.kind,
            key: p.key,
            version: p.version,
            title: p.title,
            content: p.content,
            effectiveFrom: p.effectiveFrom,
            effectiveTo: p.effectiveTo,
          })),
          evidence: page.items.map((p) => ({
            recordType: 'policy_version',
            recordId: p.id,
            label: `${p.key} v${p.version}`,
            asOf: p.updatedAt,
            basis: 'record' as const,
          })),
          missing,
        };
      },
    });
  }

  /** SPK-AUTO-001 "Summarize demand and renewals" (reporting's demand report). */
  private demandReport(): AnyQueryTool {
    return queryTool({
      kind: 'query',
      name: 'reporting.demand_report',
      actionId: ReportingActions.viewDemandReports.id,
      description:
        'Demand by day, time, age band, format and program for a facility and date range',
      argumentsDoc: { facilityId: 'facility id', from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' },
      argsSchema: z.object({ facilityId: z.uuid(), from: LocalDate, to: LocalDate }).strict(),
      run: async (principal, args): Promise<QueryResult> => {
        const evaluation = await this.reports.evaluate(principal, 'demand', args);
        const response = evaluation.response;
        return {
          output: response,
          evidence: [
            {
              recordType: 'report',
              recordId: `demand:${args.facilityId}:${args.from}:${args.to}`,
              label: `${response.report.title} (${response.freshness.class})`,
              asOf: response.asOf,
              // F1 is a live read; F2/F3 figures are derived as of the stated instant.
              basis: response.freshness.class === 'F1' ? 'evaluation' : 'snapshot',
            },
          ],
          missing: [],
        };
      },
    });
  }

  /** A person's customer timeline (support staff only, protected). */
  private customerTimeline(): AnyQueryTool {
    return queryTool({
      kind: 'query',
      name: 'support.customer_timeline',
      actionId: SupportActions.readTimeline.id,
      description: "A person's scoped customer timeline (support staff only)",
      argumentsDoc: { personId: 'person id' },
      argsSchema: z.object({ personId: z.uuid() }).strict(),
      run: async (principal, args): Promise<QueryResult> => {
        const t = await this.timeline.timeline(principal, args.personId, { limit: 50 });
        const missing = t.sources
          .filter((s) => s.status !== 'ok')
          .map((s) =>
            missingEvidence(
              'timeline_source',
              s.source,
              'support.customer_timeline',
              s.status === 'not_permitted' ? 'not_available' : 'source_unavailable',
              `The ${s.source} entries are not included.`,
            ),
          );
        return {
          output: t,
          evidence: t.entries.map((e) => ({
            recordType: e.record.type,
            recordId: e.record.id,
            label: e.title,
            asOf: e.occurredAt,
            basis: 'record' as const,
          })),
          missing,
        };
      },
    });
  }
}

/**
 * R4-PRIVACY-04: the only person fields the assistant provider receives. Date of birth and contact
 * points (their values, kinds and verification) stay in identity.
 */
export function assistantPersonView(person: PersonDetail): {
  id: string;
  kind: PersonDetail['kind'];
  givenName: string;
  familyName: string;
  status: PersonDetail['status'];
  mergedIntoPersonId: string | null;
} {
  return {
    id: person.id,
    kind: person.kind,
    givenName: person.givenName,
    familyName: person.familyName,
    status: person.status,
    mergedIntoPersonId: person.mergedIntoPersonId,
  };
}

/**
 * What a Today read left out, as missing evidence (SPK-AUTO-002 "missing evidence is named"):
 * a source that could not be read or is not available to the caller, and (R3-PERFORMANCE-01) a
 * source the feed's per-request bound truncated, which is only partly included (`limit_reached`).
 */
export function todaySourceGaps(
  sources: ReadonlyArray<{
    source: string;
    facilityId: string | null;
    status: string;
    truncated?: boolean;
    omitted?: number | null;
  }>,
): AssistantMissingEvidence[] {
  const gaps: AssistantMissingEvidence[] = [];
  for (const s of sources) {
    const id = s.facilityId ? `${s.source}:${s.facilityId}` : s.source;
    if (s.status !== 'ok') {
      gaps.push(
        missingEvidence(
          'today_source',
          id,
          'support.today_feed',
          s.status === 'not_permitted' ? 'not_available' : 'source_unavailable',
          s.status === 'not_permitted'
            ? `The ${s.source} source is not available to you, so its issues are not included.`
            : `The ${s.source} source could not be read; its issues are not included.`,
        ),
      );
    } else if (s.truncated) {
      gaps.push(
        missingEvidence(
          'today_source',
          id,
          'support.today_feed',
          'limit_reached',
          `The ${s.source} source is only partly included: ${
            s.omitted === null || s.omitted === undefined
              ? 'more records than shown'
              : `${s.omitted} record(s)`
          } were left out by the feed's per-request bound.`,
        ),
      );
    }
  }
  return gaps;
}
