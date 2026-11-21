/**
 * The game answer control of the redesign (handoff 1b "Is Maya going?", 1i, 3a, 3f; SPK-CAP-003):
 * "Is Maya going?", "8 of 12 answered", and Going / Maybe / Not going as one segmented control
 * (`SegmentedControl` `filled`). Shared by Home's hero and Game day; the write is `useGameAnswer`
 * (optimistic, Undo, revert on failure).
 *
 * Disabled, with the reason on one line, while offline ("Answering needs a connection.", 3f),
 * after kickoff ("Answers closed at kickoff"), when the game no longer takes answers, and for a
 * person this account may not answer for (the API decides; `register` is what it checks).
 */
import type { Schema } from '@sportspark/api-client';
import { View } from 'react-native';
import { useConnectivity } from '../../providers/AppProviders';
import { SegmentedControl, type Segment } from '../../ui/SegmentedControl';
import { Text } from '../../ui/Text';
import { fonts, makeStyles, spacing } from '../../ui/theme';
import { fixtureAcceptsRsvp } from '../today/status';
import { ANSWER_WORDS, answerCounts, useGameAnswer, type Answer } from './answers';
import { PROPOSED } from './proposed';

type FixtureDetail = Schema<'FixtureDetail'>;
type FixtureSide = Schema<'FixtureSide'>;

export const ANSWERS_CLOSED = 'Answers closed at kickoff';
export const ANSWER_NEEDS_CONNECTION = 'Answering needs a connection.';

export interface GameAnswerProps {
  fixture: FixtureDetail;
  /** The side the person plays on (its counts). */
  side: FixtureSide | null;
  personId: string;
  personName: string;
  self: boolean;
  selfId: string | null;
  /** Whether this account may answer for the person (oneself, or `register` over a child). */
  mayAnswer: boolean;
  now: Date;
  testID?: string;
}

export function GameAnswer({
  fixture,
  side,
  personId,
  personName,
  self,
  selfId,
  mayAnswer,
  now,
  testID = 'game-answer',
}: GameAnswerProps) {
  const styles = useStyles();
  const offline = useConnectivity().reachable === false;
  const { shown, recorded, answer } = useGameAnswer({
    fixture,
    personId,
    personName,
    self,
    selfId,
  });
  const started = !!fixture.scheduledStart && now.getTime() >= Date.parse(fixture.scheduledStart);
  const closed = started || !fixtureAcceptsRsvp(fixture.status);
  const counts = side ? answerCounts(side.availability, recorded, shown) : null;
  const segments: Segment<Answer>[] = (['available', 'tentative', 'unavailable'] as const)
    .filter((state) => state !== 'tentative' || PROPOSED.maybeAnswer)
    .map((state) => ({ value: state, label: ANSWER_WORDS[state] }));
  const value =
    shown === 'available' || shown === 'tentative' || shown === 'unavailable' ? shown : null;
  const reason = closed
    ? ANSWERS_CLOSED
    : offline
      ? ANSWER_NEEDS_CONNECTION
      : !mayAnswer
        ? `Only ${personName}'s guardian with permission to register can answer.`
        : null;
  const question = self ? 'Are you going?' : `Is ${personName} going?`;
  return (
    <View style={styles.box} testID={testID}>
      <View style={styles.head}>
        <Text variant="callout" style={styles.question}>
          {question}
        </Text>
        {counts && counts.total > 0 ? (
          <Text
            variant="footnote"
            tone="muted"
            accessibilityLabel={`${counts.answered} of ${counts.total} players answered`}
            testID={`${testID}-count`}
          >
            {`${counts.answered} of ${counts.total} answered`}
          </Text>
        ) : null}
      </View>
      <SegmentedControl
        label={question}
        pattern="radio"
        variant="filled"
        segments={segments}
        value={value}
        onChange={answer}
        disabled={reason !== null}
        testID={`${testID}-choices`}
      />
      {reason ? (
        <Text variant="footnote" tone="muted" testID={`${testID}-reason`}>
          {reason}
        </Text>
      ) : null}
    </View>
  );
}

const useStyles = makeStyles(() => ({
  box: { gap: spacing.sm },
  head: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.sm,
  },
  question: { ...fonts.semibold, flexShrink: 1 },
}));
