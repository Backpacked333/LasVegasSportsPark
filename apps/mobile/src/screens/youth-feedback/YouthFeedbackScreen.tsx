/**
 * SCR-C-37 Youth feedback and development record (SPK-YOUTH-005, SPK-YOUTH-006, SPK-COMMS-002,
 * POL-036; journeys C10, C11).
 *
 * Pending decision. The approved assessment templates (skill areas, scales, visibility, review
 * status) and which feedback is parent-visible are DEC-054 (Program manager; Operator/privacy
 * owner); what a progression recommendation may use is DEC-055 (Program manager); youth
 * assessment and progression criteria are DEC-003 (Program manager). The API has no endpoint for
 * assessments, feedback or progression recommendations yet (Package G "Youth progression"), so
 * the screen sends no request and invents no skill area, scale or feedback: it shows the pending
 * state and what will apply once decided (approved, parent-visible items only; private coaching
 * notes never appear; a recommendation is an offer, not a guarantee of a place).
 *
 * States: pending decision (the whole screen); signed out (sign in). Loading, empty, error,
 * offline, stale and permission restriction apply once the API serves the record.
 */
import { Stack } from 'expo-router';
import { View } from 'react-native';
import { Body, Section } from '../../features/money/ui';
import { RequireSession } from '../../session/RequireSession';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';

/** Decisions and owners verbatim from docs/package-a/decision-register.md. */
export const YOUTH_FEEDBACK_DECISIONS = ['DEC-003', 'DEC-054', 'DEC-055'] as const;
export const YOUTH_FEEDBACK_OWNERS =
  'DEC-003, DEC-055: Program manager. DEC-054: Program manager; Operator/privacy owner';

export function YouthFeedbackScreen() {
  return (
    <Screen>
      <RequireSession what="feedback and development records">
        <View>
          <StateView
            variant="pending-decision"
            subject="Feedback and development records"
            decisions={[...YOUTH_FEEDBACK_DECISIONS]}
            owner={YOUTH_FEEDBACK_OWNERS}
          />
          <Section title="What this will show">
            <Body>
              Approved feedback and assessments a coach shares with you about a child you are
              authorized to see, with the skill area, date, scale, author and comments.
            </Body>
            <Body>Private coaching notes never appear here.</Body>
            <Body>
              A recommendation for a next group or program is an offer to consider. It does not
              guarantee a place, and it never registers or charges anyone.
            </Body>
          </Section>
        </View>
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
