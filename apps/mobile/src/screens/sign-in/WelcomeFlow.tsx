/**
 * Handoff M 5a Welcome and sign in, and M 5b the code and "is this your family?" (SCR-C-01;
 * SPK-IAM-001, SPK-UX-001, §4.13, §5.2; ADR-008 visual system v2, **Proposed**).
 *
 * - 5a: the welcome picture over night, "Every game, class and camp for your family.", one field
 *   for phone or email (no password; signing in and signing up are the same steps), and "Send me
 *   a code", active once the entry looks like a phone or an email (`contactKind`). Apple and
 *   Google sign-in skip the code in the design; no identity provider is selected (DEC-018,
 *   §5.2), so they are shown disabled with the "Proposed" tag.
 * - 5b: "Check your texts" (or email), the 6 boxes (one field, filled from the SMS on both
 *   platforms through the one-time-code hints), checked on the 6th digit with no button; a wrong
 *   code shakes the boxes, clears them and says so in words; "Resend in 0:41" counts down on the
 *   injected clock.
 * - Then, signed in: when the desk already has the family (`GET /v1/me/households` lists more
 *   people), "We found your family at the park" with each person: "Yes, that's us" lands on Home;
 *   "Something's wrong" opens a message to the desk (Support). A new family goes to Add a child
 *   (M 3h).
 *
 * The code itself goes through `CodeSignInPort` (`features/sign-in/code-sign-in.ts`): a stand-in
 * in development demo builds, none in release builds (DEC-018), where this flow is not shown.
 */
import { useRouter, type Href } from 'expo-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { onboardingArtwork } from '../../artwork/manifest';
import { useApiQuery } from '../../api/useApiQuery';
import {
  CODE_LENGTH,
  contactKind,
  displayContact,
  resendWords,
  type CodeSignInPort,
  type ContactKind,
} from '../../features/sign-in/code-sign-in';
import { useApp, useConnectivity, useNow } from '../../providers/AppProviders';
import { LiveText } from '../../ui/announce';
import { Artwork } from '../../ui/Artwork';
import { Avatar } from '../../ui/Avatar';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { Screen } from '../../ui/Screen';
import { Shake } from '../../ui/Shake';
import { StatusBadge } from '../../ui/StatusBadge';
import { Text } from '../../ui/Text';
import {
  elevation,
  fonts,
  layout,
  makeStyles,
  MIN_TOUCH_SIZE,
  radius,
  spacing,
  tabular,
  type,
  useTheme,
} from '../../ui/theme';

type Step =
  | { kind: 'welcome' }
  | { kind: 'code'; contact: string; contactKind: ContactKind; sentAt: number; resend: number }
  | { kind: 'family' };

export const WRONG_CODE = "That code didn't match. Try again.";

function FloodlightButton({
  label,
  onPress,
  disabled,
  busy,
  testID,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  testID?: string;
}) {
  const styles = useStyles();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled, busy: !!busy }}
      style={({ pressed }) => [
        styles.flood,
        disabled ? styles.floodDisabled : null,
        pressed ? styles.pressed : null,
      ]}
      testID={testID}
    >
      <Text style={[styles.floodText, disabled ? styles.floodTextDisabled : null]}>
        {busy ? 'Sending…' : label}
      </Text>
    </Pressable>
  );
}

function Welcome({
  onSend,
  busy,
  error,
  extra,
}: {
  onSend: (contact: string, kind: ContactKind) => void;
  busy: boolean;
  error: string | null;
  extra?: ReactNode;
}) {
  const styles = useStyles();
  const theme = useTheme();
  const offline = useConnectivity().reachable === false;
  const [entry, setEntry] = useState('');
  const kind = contactKind(entry);
  return (
    <View style={styles.welcome} testID="welcome">
      <Artwork source={onboardingArtwork.welcome} aspectRatio={3 / 4} rounded={false} />
      <View style={styles.welcomeBody}>
        <View style={styles.logo}>
          <Icon name="sports_soccer" size={28} color={theme.colors.onFloodlight} />
        </View>
        <Text style={styles.headline} accessibilityRole="header">
          Every game, class and camp for your family.
        </Text>
        <Text style={styles.place}>Sportspark Las Vegas</Text>
        <Text style={styles.fieldLabel} nativeID="contact-label">
          Phone or email
        </Text>
        <TextInput
          value={entry}
          onChangeText={setEntry}
          accessibilityLabel="Phone or email"
          accessibilityLabelledBy="contact-label"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="username"
          textContentType="username"
          keyboardType="email-address"
          keyboardAppearance="dark"
          returnKeyType="send"
          onSubmitEditing={() => (kind ? onSend(entry, kind) : undefined)}
          placeholder="(702) 555-0148 or you@example.com"
          placeholderTextColor={theme.colors.nightMuted}
          style={[styles.input, kind ? styles.inputReady : null]}
          testID="welcome-contact"
        />
        <FloodlightButton
          label="Send me a code"
          onPress={() => (kind ? onSend(entry, kind) : undefined)}
          disabled={!kind || offline}
          busy={busy}
          testID="welcome-send"
        />
        {offline ? <Text style={styles.small}>Signing in needs a connection.</Text> : null}
        {error ? (
          <LiveText announcement={error} style={styles.errorOnNight}>
            {error}
          </LiveText>
        ) : null}
        <View style={styles.providers}>
          {['Apple', 'Google'].map((name) => (
            <View
              key={name}
              style={styles.provider}
              accessible
              accessibilityLabel={`${name}, proposed: not available yet`}
              accessibilityState={{ disabled: true }}
            >
              <Text style={styles.providerText}>{name}</Text>
            </View>
          ))}
        </View>
        <View style={styles.proposedLine}>
          <StatusBadge tone="pending" label="Proposed" />
          <Text style={styles.small}>Apple and Google sign-in</Text>
        </View>
        <Text style={[styles.small, styles.center]}>
          No password. New here? The same steps create your account.
        </Text>
        {extra}
      </View>
    </View>
  );
}

function CodeStep({
  step,
  port,
  onBack,
  onSignedIn,
  onResend,
}: {
  step: Extract<Step, { kind: 'code' }>;
  port: CodeSignInPort;
  onBack: () => void;
  onSignedIn: () => void;
  onResend: () => void;
}) {
  const styles = useStyles();
  const theme = useTheme();
  const { signIn } = useApp();
  const now = useNow(1_000);
  const [code, setCode] = useState('');
  const [checking, setChecking] = useState(false);
  const [wrong, setWrong] = useState(0);
  const [failed, setFailed] = useState(false);
  const input = useRef<TextInput>(null);
  const left = step.resend - (now.getTime() - step.sentAt) / 1000;

  const check = async (value: string) => {
    setChecking(true);
    setFailed(false);
    try {
      const outcome = await port.verifyCode(step.contact, value);
      if (outcome.kind === 'wrong') {
        setWrong((n) => n + 1);
        setCode('');
        input.current?.focus();
        return;
      }
      await signIn(outcome.session);
      onSignedIn();
    } catch {
      setFailed(true);
    } finally {
      setChecking(false);
    }
  };

  const change = (text: string) => {
    const digits = text.replace(/\D/gu, '').slice(0, CODE_LENGTH);
    setCode(digits);
    if (digits.length === CODE_LENGTH && !checking) void check(digits);
  };

  return (
    <View style={styles.code} testID="code-step">
      <Pressable
        onPress={onBack}
        accessibilityRole="button"
        accessibilityLabel="Back"
        style={styles.back}
      >
        <Icon name="arrow_back" size={24} color={theme.colors.primary} />
      </Pressable>
      <Text style={styles.codeTitle} accessibilityRole="header">
        {step.contactKind === 'phone' ? 'Check your texts' : 'Check your email'}
      </Text>
      <Text variant="body" tone="muted">
        {`We sent a ${CODE_LENGTH}-digit code to ${displayContact(step.contact)}.`}
      </Text>
      <Pressable onPress={() => input.current?.focus()} accessibilityElementsHidden>
        <Shake trigger={wrong} style={styles.boxes}>
          {Array.from({ length: CODE_LENGTH }, (_, i) => (
            <View
              key={i}
              style={[
                styles.box,
                i === Math.min(code.length, CODE_LENGTH - 1) ? styles.boxNext : null,
              ]}
            >
              <Text style={styles.digit}>{code[i] ?? ''}</Text>
            </View>
          ))}
        </Shake>
      </Pressable>
      <TextInput
        ref={input}
        value={code}
        onChangeText={change}
        autoFocus
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        autoComplete="sms-otp"
        maxLength={CODE_LENGTH}
        editable={!checking}
        accessibilityLabel={`Code, ${CODE_LENGTH} digits`}
        style={styles.hiddenInput}
        testID="code-input"
      />
      {wrong > 0 && code.length === 0 ? (
        <LiveText announcement={WRONG_CODE} style={styles.error}>
          {WRONG_CODE}
        </LiveText>
      ) : null}
      {failed ? (
        <LiveText announcement="We couldn't check the code. Try again." style={styles.error}>
          We couldn&apos;t check the code. Try again.
        </LiveText>
      ) : null}
      {left > 0 ? (
        <Text style={styles.resend}>{`Resend in ${resendWords(left)}`}</Text>
      ) : (
        <Pressable onPress={onResend} accessibilityRole="button" style={styles.resendButton}>
          <Text style={styles.resendLink}>Send a new code</Text>
        </Pressable>
      )}
      {port.hint ? (
        <Text variant="footnote" tone="muted">
          {port.hint}
        </Text>
      ) : null}
    </View>
  );
}

function FamilyStep() {
  const styles = useStyles();
  const theme = useTheme();
  const router = useRouter();
  const households = useApiQuery({ path: '/me/households' });
  const household = households.data?.items[0];
  const members = household?.members ?? [];
  const newFamily = households.data !== undefined && members.filter((m) => !m.isSelf).length === 0;
  useEffect(() => {
    // A new family: go on to add a child (M 3h).
    if (newFamily) router.replace('/people/new' as Href);
  }, [newFamily, router]);
  if (newFamily) return null;
  return (
    <View style={styles.code} testID="family-step">
      <View style={[elevation(theme, 'raised'), styles.familyCard]}>
        <StatusBadge tone="success" label="Verified" />
        <Text style={styles.familyTitle} accessibilityRole="header">
          We found your family at the park
        </Text>
        <Text variant="callout" tone="muted">
          The front desk already has these people under your number.
        </Text>
        {members.map((m) => (
          <View key={m.personId} style={styles.member}>
            <Avatar name={m.displayName} id={m.personId} size={40} decorative />
            <Text style={styles.memberName}>{m.displayName}</Text>
            <Text variant="footnote" tone="muted">
              {m.isSelf ? 'You' : m.kind === 'child' ? 'Child' : ''}
            </Text>
          </View>
        ))}
      </View>
      <View style={styles.familyButtons}>
        <Button
          label="Yes, that's us"
          size="lg"
          block
          onPress={() => router.replace('/')}
          testID="family-yes"
        />
        <Button
          label="Something's wrong"
          variant="text"
          block
          onPress={() => router.replace('/support')}
          testID="family-wrong"
        />
      </View>
    </View>
  );
}

export function WelcomeFlow({ port, extra }: { port: CodeSignInPort; extra?: ReactNode }) {
  const now = useNow();
  const [step, setStep] = useState<Step>({ kind: 'welcome' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async (contact: string, kind: ContactKind) => {
    setBusy(true);
    setError(null);
    try {
      const sent = await port.requestCode(contact, kind);
      setStep({
        kind: 'code',
        contact,
        contactKind: kind,
        sentAt: now.getTime(),
        resend: sent.resendAfterSeconds,
      });
    } catch {
      setError("We couldn't send a code. Check the number or email and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      {step.kind === 'welcome' ? (
        <Welcome onSend={(c, k) => void send(c, k)} busy={busy} error={error} extra={extra} />
      ) : step.kind === 'code' ? (
        <CodeStep
          step={step}
          port={port}
          onBack={() => setStep({ kind: 'welcome' })}
          onSignedIn={() => setStep({ kind: 'family' })}
          onResend={() => void send(step.contact, step.contactKind)}
        />
      ) : (
        <FamilyStep />
      )}
    </Screen>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  welcome: { backgroundColor: colors.night, flexGrow: 1 },
  welcomeBody: {
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xxl,
    marginTop: -spacing.xxxl * 2,
    gap: 14,
  },
  logo: {
    width: 48,
    height: 48,
    borderRadius: radius.md,
    backgroundColor: colors.floodlight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headline: { ...fonts.bold, fontSize: 34, lineHeight: 40, color: colors.onNight },
  place: { ...type.body, color: colors.nightText },
  fieldLabel: { ...fonts.semibold, fontSize: 13, color: colors.nightText, marginTop: spacing.xs },
  input: {
    height: 54,
    borderRadius: radius.md,
    borderWidth: 2,
    borderColor: colors.nightLine,
    backgroundColor: colors.nightRaised,
    paddingHorizontal: spacing.lg,
    ...fonts.semibold,
    fontSize: 18,
    color: colors.onNight,
  },
  inputReady: { borderColor: colors.floodlight },
  flood: {
    height: 56,
    borderRadius: radius.pill,
    backgroundColor: colors.floodlight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  floodDisabled: { backgroundColor: colors.nightLine },
  floodText: { ...fonts.bold, fontSize: 17, color: colors.onFloodlight },
  floodTextDisabled: { color: colors.nightMuted },
  pressed: { opacity: 0.8 },
  providers: { flexDirection: 'row', gap: 10 },
  provider: {
    flex: 1,
    height: 50,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.nightLine,
    alignItems: 'center',
    justifyContent: 'center',
    opacity: 0.6,
  },
  providerText: { ...fonts.semibold, fontSize: 15, color: colors.onNight },
  proposedLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  small: { ...fonts.regular, fontSize: 12, lineHeight: 17, color: colors.nightMuted },
  center: { textAlign: 'center' },
  errorOnNight: { ...type.callout, color: colors.onNight },
  code: { paddingHorizontal: layout.gutter, gap: spacing.sm },
  back: {
    width: MIN_TOUCH_SIZE,
    height: MIN_TOUCH_SIZE,
    justifyContent: 'center',
    marginLeft: -spacing.sm,
  },
  codeTitle: { ...fonts.bold, fontSize: 28, lineHeight: 34, color: colors.text },
  boxes: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  box: {
    flex: 1,
    height: 58,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.control,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxNext: { borderWidth: 2, borderColor: colors.primary },
  digit: { ...tabular({}), ...fonts.bold, fontSize: 24, color: colors.text },
  hiddenInput: { position: 'absolute', width: 1, height: 1, opacity: 0 },
  error: { ...type.callout, color: colors.danger },
  resend: { ...fonts.semibold, fontSize: 14, color: colors.textMuted, paddingTop: spacing.xs },
  resendButton: { minHeight: MIN_TOUCH_SIZE, justifyContent: 'center' },
  resendLink: { ...fonts.semibold, fontSize: 14, color: colors.primary },
  familyCard: { marginTop: spacing.xl, padding: 18, gap: spacing.md, borderRadius: radius.xl },
  familyTitle: { ...fonts.bold, fontSize: 20, lineHeight: 26, color: colors.text },
  member: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  memberName: { flex: 1, ...fonts.semibold, fontSize: 15, color: colors.text },
  familyButtons: { gap: spacing.sm, marginTop: spacing.xxl },
}));
