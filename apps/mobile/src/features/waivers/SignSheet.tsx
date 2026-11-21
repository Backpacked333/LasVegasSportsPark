/**
 * Sign a form sheet (redesign handoff 2c; INTERACTIONS 2c; key flow "Sign a waiver and get
 * cleared"; SPK-REG-011, SPK-REG-009, ADR-004 waiver policy; §4.9).
 *
 * - The form is the version in force (`GET /v1/policy-versions/{id}` of the waiver's
 *   `currentVersion`): a plain-words summary first ("In short", the version's `summary` when it
 *   has one), then the full text in a box that scrolls on its own. The version shown is the one
 *   recorded: its id goes with the acceptance (`policyVersionId`).
 * - The parent types their name (prefilled with the account holder's name; kept until the app
 *   closes). The button names who is signed: "Sign for Leo", "Sign for Leo and Maya"; fewer than
 *   3 characters reads "Type your name to sign" and is disabled.
 * - "Also sign for Maya" appears only when a sibling's same waiver (same policy key) is missing,
 *   lapsed, or ends within 30 days; it is on by default, as drawn.
 * - Signing records one acceptance per person (`POST /v1/waiver-acceptances`, `method: digital`,
 *   the typed name and version in `evidence`), each with its own idempotency key. All saved: the
 *   sheet closes and the caller shows "Signed. Leo is cleared to check in." Some saved: the sheet
 *   closes and the caller names who was signed; the other row stays. None saved: the sheet stays
 *   open with the shared `CommandError`.
 * - The text fails to load: "Couldn't load the form." with Try again, and Sign is disabled.
 * - Offline: Sign is disabled with "Signing needs a connection."
 */
import type { ApiError } from '@sportspark/api-client';
import { useEffect, useState, type RefObject } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { useApp, useConnectivity } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { CommandError } from '../../ui/CommandError';
import { TextField } from '../../ui/Field';
import { Icon } from '../../ui/Icon';
import { Sheet } from '../../ui/Sheet';
import { Text } from '../../ui/Text';
import { fonts, makeStyles, radius, spacing, useTheme } from '../../ui/theme';
import { formWording } from '../registration/forms';
import { useKnownFacilityZone } from '../today/known-zone';
import { localDayKey } from '../today/time';
import { formatCalendarDate, PERSON_WAIVERS_KEY, type PersonWaiver } from './waivers';

/** Days before a sibling's waiver ends that "Also sign" offers to renew it (handoff 2c). */
export const ALSO_SIGN_WITHIN_DAYS = 30;

const DAY_MS = 86_400_000;

/** The typed name, kept until the app closes (handoff 2c row 1). */
let typedNameMemory: string | null = null;

export interface SignPerson {
  id: string;
  givenName: string;
  waiver: PersonWaiver;
}

/** Whether a sibling's waiver is one "Also sign" should offer: same form, and due within 30 days. */
export function offersAlsoSign(main: PersonWaiver, sibling: PersonWaiver, now: Date): boolean {
  if (sibling.policyKey !== main.policyKey) return false;
  if (sibling.status !== 'current') return sibling.currentVersion !== null;
  if (!sibling.validUntil) return false;
  return Date.parse(sibling.validUntil) - now.getTime() <= ALSO_SIGN_WITHIN_DAYS * DAY_MS;
}

/** "Leo", "Leo and Maya". */
function both(names: readonly string[]): string {
  return names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

export interface SignOutcome {
  signed: string[];
  failed: string[];
}

export interface SignSheetProps {
  open: boolean;
  onClose: () => void;
  person: SignPerson | null;
  /** Siblings whose same waiver may be signed with it (already filtered by `offersAlsoSign`). */
  siblings: readonly SignPerson[];
  /** "needed before Junior Skills". */
  context?: string | null;
  /** The account holder's name, to prefill. */
  signerName: string;
  /** Called when at least one acceptance saved. */
  onSigned: (outcome: SignOutcome) => void;
  returnFocusTo?: RefObject<unknown>;
}

export function SignSheet({
  open,
  onClose,
  person,
  siblings,
  context,
  signerName,
  onSigned,
  returnFocusTo,
}: SignSheetProps) {
  const styles = useStyles();
  const { colors } = useTheme();
  const { services } = useApp();
  const offline = useConnectivity().reachable === false;
  const zone = useKnownFacilityZone().zone;
  const version = person?.waiver.currentVersion ?? null;
  const policy = useApiQuery({
    path: '/policy-versions/{id}',
    request: { path: { id: version?.policyVersionId ?? '' } },
    enabled: open && version !== null,
  });
  const accept = useApiCommand('post', '/waiver-acceptances', {
    invalidate: [PERSON_WAIVERS_KEY, ['api', '/acknowledgments']],
  });
  const [name, setName] = useState(typedNameMemory ?? signerName);
  const [also, setAlso] = useState(true);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setFailure(null);
  }, [open, person?.id]);
  useEffect(() => {
    if (!typedNameMemory) setName(signerName);
  }, [signerName]);

  const sibling = siblings[0] ?? null;
  const content = (policy.data?.content ?? {}) as Record<string, unknown>;
  const summary = typeof content.summary === 'string' ? content.summary : null;
  const { summary: _omit, ...rest } = content;
  const wording = policy.data ? formWording(rest) : [];
  const who = person ? [person.givenName, ...(also && sibling ? [sibling.givenName] : [])] : [];
  const nameOk = name.trim().length >= 3;
  const loaded = policy.data !== undefined;
  const label = !nameOk ? 'Type your name to sign' : `Sign for ${both(who)}`;

  const signOne = (target: SignPerson) =>
    accept.submit({
      body: {
        subjectPersonId: target.id,
        policyKey: target.waiver.policyKey,
        policyVersionId: target.waiver.currentVersion?.policyVersionId ?? version?.policyVersionId,
        method: 'digital',
        evidence: {
          channel: 'customer_app',
          appVersion: services.config.appVersion,
          typedName: name.trim(),
          shownVersion: version?.version ?? null,
        },
      },
    });

  const submit = async () => {
    if (!person) return;
    setBusy(true);
    setFailure(null);
    const targets = [person, ...(also && sibling ? [sibling] : [])];
    const outcome: SignOutcome = { signed: [], failed: [] };
    let lastError: ApiError | null = null;
    for (const target of targets) {
      try {
        await signOne(target);
        outcome.signed.push(target.givenName);
      } catch (error) {
        lastError = error as ApiError;
        outcome.failed.push(target.givenName);
      }
    }
    setBusy(false);
    if (outcome.signed.length === 0) {
      setFailure(lastError);
      return;
    }
    typedNameMemory = name;
    onSigned(outcome);
  };

  return (
    <Sheet
      open={open && person !== null}
      onClose={onClose}
      title={person?.waiver.title ?? 'Sign a form'}
      eyebrow={person ? `For ${person.givenName}${context ? ` · ${context}` : ''}` : undefined}
      locked={busy}
      returnFocusTo={returnFocusTo}
      testID="sign-sheet"
    >
      {person ? (
        <View style={styles.body}>
          {summary ? (
            <View style={styles.summary} testID="sign-summary">
              <Text variant="callout" style={styles.summaryTitle}>
                In short
              </Text>
              <Text variant="callout">{summary}</Text>
            </View>
          ) : null}
          {loaded ? (
            <ScrollView
              style={styles.fullText}
              contentContainerStyle={styles.fullTextContent}
              nestedScrollEnabled
              accessibilityLabel={`Full text of ${person.waiver.title}, version ${version?.version ?? ''}`}
              testID="sign-full-text"
            >
              {wording.map((paragraph, index) => (
                <Text key={index} variant="callout" style={styles.paragraph}>
                  {paragraph}
                </Text>
              ))}
            </ScrollView>
          ) : policy.error ? (
            <View style={styles.loadError} testID="sign-text-error">
              <Text variant="callout">Couldn't load the form.</Text>
              <Button label="Try again" variant="secondary" onPress={() => void policy.refetch()} />
            </View>
          ) : (
            <View style={[styles.fullText, styles.loading]}>
              <Text variant="footnote" tone="muted">
                Loading the form…
              </Text>
            </View>
          )}
          <TextField
            label="Type your full name to sign"
            value={name}
            onChangeText={(value) => {
              setName(value);
              typedNameMemory = value;
            }}
            autoCapitalize="words"
            autoComplete="name"
            testID="sign-name"
          />
          <Text variant="footnote" tone="muted">
            {`Signed as ${person.givenName}'s parent · ${formatCalendarDate(localDayKey(services.now(), zone))} · recorded with your account`}
          </Text>
          {sibling ? (
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: also }}
              accessibilityLabel={`Also sign for ${sibling.givenName}`}
              onPress={() => setAlso((v) => !v)}
              style={styles.also}
              testID="sign-also"
            >
              <View style={[styles.box, also ? styles.boxOn : null]}>
                {also ? <Icon name="check" size={18} color={colors.primaryText} /> : null}
              </View>
              <Text variant="callout" style={styles.alsoText}>
                <Text variant="callout">Also sign for </Text>
                <Text variant="callout" style={styles.bold}>
                  {sibling.givenName}
                </Text>
                <Text variant="callout">
                  {sibling.waiver.validUntil && sibling.waiver.status === 'current'
                    ? `. ${sibling.givenName}'s waiver ends on ${formatCalendarDate(sibling.waiver.validUntil)}.`
                    : `. ${sibling.givenName} needs it too.`}
                </Text>
              </Text>
            </Pressable>
          ) : null}
          <CommandError
            wording="registration"
            error={failure}
            what="the form"
            onRetry={() => void submit()}
          />
          <Button
            label={label}
            size="lg"
            block
            busy={busy}
            disabled={!nameOk || !loaded || offline}
            onPress={() => void submit()}
            testID="sign-submit"
          />
          {offline ? (
            <Text variant="footnote" tone="muted">
              Signing needs a connection.
            </Text>
          ) : null}
        </View>
      ) : null}
    </Sheet>
  );
}

const useStyles = makeStyles(({ colors, toneBackgrounds }) => ({
  body: { gap: spacing.md, paddingBottom: spacing.sm },
  summary: {
    gap: spacing.xs,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: toneBackgrounds.success,
  },
  summaryTitle: { ...fonts.bold, color: colors.success },
  fullText: {
    maxHeight: 220,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  fullTextContent: { padding: spacing.md, gap: spacing.md },
  paragraph: { color: colors.text },
  loading: { padding: spacing.md, minHeight: 80 },
  loadError: { gap: spacing.sm },
  also: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 44 },
  box: {
    width: 26,
    height: 26,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: colors.control,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  alsoText: { flex: 1 },
  bold: { ...fonts.bold },
}));
