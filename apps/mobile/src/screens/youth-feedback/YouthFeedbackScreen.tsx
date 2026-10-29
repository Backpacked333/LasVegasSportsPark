/**
 * SCR-C-37 Youth feedback and development record (SPK-YOUTH-005, SPK-YOUTH-006, SPK-COMMS-002,
 * POL-036; journeys C10, C11; ENR-14).
 *
 * - `GET /v1/me/youth-feedback` answers with the published, family-visible assessments and the
 *   shared progression recommendations of the participants this account may view: the API leaves
 *   out drafts, returned and unreviewed items, staff-only items, staff notes and review notes, so
 *   the screen shows exactly what it receives and never filters or adds anything. A child without
 *   a `view` grant is simply absent (permission restriction, SPK-IAM-003).
 * - Each assessment shows the skill area, the observation date, the scale value with its level
 *   name and the number of levels from the approved template, the coach's comments, the offering
 *   and when it was published. The API gives no author for the family view (reported), so none
 *   is shown.
 * - A recommendation is an offer: its suitability text, when it was shared and the recommended
 *   offering (opened in Discover) or program; it never registers, holds or charges anyone
 *   (SPK-YOUTH-006).
 * - Capability `youth_progression` (DEC-016): while it is off, the screen says so and what was
 *   already shared stays readable (reads are never gated). Which feedback is parent-visible and
 *   what a recommendation may use stay DEC-054 and DEC-055 (Program manager): the screen invents
 *   neither and says so.
 * - States: loading; empty (nothing shared yet); error with the code and "Try again"; offline or
 *   stale with the age of what is shown; not available (NOT_FOUND, ACCESS_DENIED); turned off.
 *   Given names only (§4.14); nothing is logged and no id of a child is put in a route.
 */
import type { Schema } from '@sportspark/api-client';
import { Stack, useRouter, type Href } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { useApiQuery } from '../../api/useApiQuery';
import { registrationRoutes } from '../../features/registration/routes';
import { Caption, Section } from '../../features/today/Section';
import {
  nameOf,
  useMe,
  useOfferings,
  usePersonNames,
  useSignedIn,
} from '../../features/today/queries';
import { displayZone, formatWhen } from '../../features/today/time';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { CapabilityGate } from '../../ui/CapabilityGate';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { StatusBadge } from '../../ui/StatusBadge';
import { colors, spacing, type } from '../../ui/theme';

type YouthFeedback = Schema<'YouthFeedback'>;
type Assessment = YouthFeedback['assessments'][number];
type Recommendation = YouthFeedback['recommendations'][number];

/** Decisions that still govern what is shared (decision register, Program manager). */
export const YOUTH_FEEDBACK_DECISIONS = ['DEC-054', 'DEC-055'] as const;

/** "Oct 20, 2026" for a date-only value (no clock, so no time zone applies). */
export function formatDateOnly(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return date;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** "Level 3 of 5: Confident", or just the value when the template's levels are not given. */
export function scaleText(
  a: Pick<Assessment, 'scaleValue' | 'scaleLabel' | 'scaleLevels'>,
): string {
  const of = a.scaleLevels ? ` of ${a.scaleLevels}` : '';
  return `Level ${a.scaleValue}${of}${a.scaleLabel ? `: ${a.scaleLabel}` : ''}`;
}

function AssessmentRow({ assessment }: { assessment: Assessment }) {
  const area = assessment.skillArea.label ?? assessment.skillArea.key;
  const zone = displayZone(null);
  const facts = [
    `${area}`,
    `Observed ${formatDateOnly(assessment.observedOn)}`,
    scaleText(assessment),
    assessment.offeringName ? `In ${assessment.offeringName}` : null,
  ].filter(Boolean);
  return (
    <View
      style={styles.card}
      accessible
      accessibilityLabel={[
        ...facts,
        // One sentence per fact for screen readers: the comment's own final stop is dropped.
        assessment.comments ? `Comments: ${assessment.comments.replace(/[.\s]+$/, '')}` : null,
        `Shared ${formatWhen(assessment.publishedAt, zone.zone)}`,
      ]
        .filter(Boolean)
        .join('. ')}
      testID={`assessment-${assessment.id}`}
    >
      <Text style={styles.title}>{area}</Text>
      <StatusBadge tone="info" label={scaleText(assessment)} />
      <Text style={styles.caption}>
        Observed {formatDateOnly(assessment.observedOn)}
        {assessment.offeringName ? ` in ${assessment.offeringName}` : ''}
      </Text>
      {assessment.comments ? <Text style={styles.body}>{assessment.comments}</Text> : null}
      <Text style={styles.caption}>Shared {formatWhen(assessment.publishedAt, zone.zone)}</Text>
    </View>
  );
}

function RecommendationRow({
  recommendation,
  offeringName,
  fromName,
}: {
  recommendation: Recommendation;
  offeringName: string | null;
  fromName: string | null;
}) {
  const router = useRouter();
  const zone = displayZone(null);
  const target = recommendation.recommendedOfferingId
    ? (offeringName ?? 'A recommended activity')
    : 'A recommended program';
  return (
    <View style={styles.card} testID={`recommendation-${recommendation.id}`}>
      <StatusBadge tone="pending" label="Recommendation: an offer to consider" />
      <Text style={styles.title}>{target}</Text>
      {fromName ? <Text style={styles.caption}>After {fromName}</Text> : null}
      <Text style={styles.body}>{recommendation.suitability}</Text>
      <Text style={styles.caption}>Shared {formatWhen(recommendation.sharedAt, zone.zone)}</Text>
      <Text style={styles.caption}>
        It does not guarantee a place, and it never registers or charges anyone.
      </Text>
      {recommendation.recommendedOfferingId ? (
        <Button
          label="View the recommended activity"
          variant="secondary"
          onPress={() =>
            router.push(
              registrationRoutes.offering(recommendation.recommendedOfferingId as string) as Href,
            )
          }
        />
      ) : (
        <Text style={styles.caption}>Ask the front desk which activities the program runs.</Text>
      )}
    </View>
  );
}

function FeedbackRecord({ feedback }: { feedback: YouthFeedback }) {
  const me = useMe();
  const people = [
    ...new Set([
      ...feedback.assessments.map((a) => a.participantPersonId),
      ...feedback.recommendations.map((r) => r.participantPersonId),
    ]),
  ];
  const names = usePersonNames(people, me.data);
  const offerings = useOfferings(
    feedback.recommendations.flatMap((r) => [
      r.fromOfferingId,
      ...(r.recommendedOfferingId ? [r.recommendedOfferingId] : []),
    ]),
  );
  return (
    <View>
      {people.map((personId) => {
        const assessments = feedback.assessments.filter((a) => a.participantPersonId === personId);
        const recommendations = feedback.recommendations.filter(
          (r) => r.participantPersonId === personId,
        );
        return (
          <Section
            key={personId}
            title={nameOf(names, personId)}
            testID={`feedback-person-${personId}`}
          >
            {assessments.length > 0 ? (
              <View accessibilityRole="list" style={styles.list}>
                {assessments.map((a) => (
                  <AssessmentRow key={a.id} assessment={a} />
                ))}
              </View>
            ) : (
              <Caption>No feedback shared yet.</Caption>
            )}
            {recommendations.length > 0 ? (
              <View accessibilityRole="list" style={styles.list}>
                {recommendations.map((r) => (
                  <RecommendationRow
                    key={r.id}
                    recommendation={r}
                    offeringName={
                      r.recommendedOfferingId
                        ? (offerings.get(r.recommendedOfferingId)?.name ?? null)
                        : null
                    }
                    fromName={offerings.get(r.fromOfferingId)?.name ?? null}
                  />
                ))}
              </View>
            ) : null}
          </Section>
        );
      })}
    </View>
  );
}

function YouthFeedbackContent() {
  const feedback = useApiQuery({ path: '/me/youth-feedback', enabled: useSignedIn() });
  return (
    <View>
      <CapabilityGate
        capability="youth_progression"
        whenOff="notice"
        stillAvailable="Feedback and recommendations already shared with you stay here."
      >
        <QueryBoundary
          query={feedback}
          label="feedback and development records"
          isEmpty={(f) => f.assessments.length === 0 && f.recommendations.length === 0}
          empty={{
            title: 'No feedback yet',
            description:
              'Feedback a coach shares about a child you are authorized to see, after it is reviewed, will appear here, with any recommendation for a next group or program.',
          }}
        >
          {(f) => <FeedbackRecord feedback={f} />}
        </QueryBoundary>
      </CapabilityGate>
      <Section title="About this record">
        <Caption>
          Only feedback a reviewer approved for families is shown. Private coaching notes never
          appear here.
        </Caption>
        <Caption>
          Which feedback is shared with families and what a recommendation may draw on are still
          being decided ({YOUTH_FEEDBACK_DECISIONS.join(', ')}, Program manager); the app shows only
          what the facility has shared.
        </Caption>
      </Section>
    </View>
  );
}

export function YouthFeedbackScreen() {
  return (
    <Screen>
      <RequireSession what="feedback and development records">
        <YouthFeedbackContent />
      </RequireSession>
    </Screen>
  );
}

/** Route component for app/youth-feedback.tsx. */
export function YouthFeedbackRoute() {
  return (
    <>
      <Stack.Screen options={{ title: 'Feedback and development' }} />
      <YouthFeedbackScreen />
    </>
  );
}

const styles = StyleSheet.create({
  list: { paddingHorizontal: spacing.lg, gap: spacing.sm },
  card: {
    padding: spacing.md,
    gap: spacing.xs,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 6,
    backgroundColor: colors.background,
  },
  title: { ...type.body, fontWeight: '700', color: colors.text },
  body: { ...type.body, color: colors.text },
  caption: { ...type.caption, color: colors.textMuted },
});
