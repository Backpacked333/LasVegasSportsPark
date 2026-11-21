/**
 * Register 3/3 · Review and pay on one screen (redesign handoff M 1f; INTERACTIONS "1e–1g" rows 6
 * and 7; SPK-REG-005 to SPK-REG-009, SPK-PAY-001, SPK-PAY-007, SPK-REG-011, §4.9).
 *
 * - **The hold timer comes first**: "Maya's place is held for 14:52", from the cart's server-owned
 *   expiry (the countdown is a guide); from a waitlist offer, the place is held until the offer
 *   ends.
 * - **The line**: the activity, who it is for, the API's quote lines (registration, each extra,
 *   the uniform with its size chosen on the line itself), each discount in green and the total.
 *   Every amount is the API's (SPK-PAY-001). "Edit" goes back to the choices.
 * - **Promo code**: "Apply" asks for a new price with the code; an applied code is a green line
 *   with its amount and ✕ to remove it; a code the API does not know reads "That code isn't valid
 *   for this activity." under the field.
 * - **Forms**: each required form and waiver with its state ("Signed by Dana · valid until
 *   Aug 2027", ▲ "Needed before paying") and Sign, which opens the sign sheet on this screen, so
 *   Pay never sends anyone elsewhere. Once signed the places are held.
 * - **Paying** behaves like the Pay sheet (2b): never optimistic, a spinner and "Paying…", one
 *   Idempotency-Key per intent, an unknown outcome is "Do not pay again" (SPK-PAY-007). Development
 *   builds pay with the API's fake provider; release builds say "Pay at the front desk for now"
 *   (**Pending decision** DEC-019, the "In-app payment proposed" tag).
 */
import type { ApiError, Schema } from '@sportspark/api-client';
import { useRouter } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useInsets } from '../../../ui/insets';
import { usePermissions } from '../../../api/permissions';
import { artworkFor } from '../../../artwork/artworkFor';
import { PAY_METHODS } from '../../../features/money/PaySheet';
import { PAY_AT_DESK_MESSAGE, PAY_AT_DESK_SUPPORT } from '../../../features/money/surfaces';
import { formatMoney } from '../../../features/registration/format';
import { quoteLineBasisLines } from '../../../features/registration/price-basis';
import { formWording, useFormsStatus } from '../../../features/registration/forms';
import { useApiRecords } from '../../../features/registration/queries';
import type { useRegisterBasket } from '../../../features/register/useRegisterBasket';
import type { useRegistrationPayment } from '../../../features/register/useRegistrationPayment';
import {
  UNKNOWN_OUTCOME_BODY,
  UNKNOWN_OUTCOME_LABEL,
  UNREADABLE_OUTCOME_BODY,
} from '../../../features/register/useRegistrationPayment';
import { formatCalendarDate } from '../../../features/waivers/waivers';
import { useConnectivity, useNow } from '../../../providers/AppProviders';
import { LiveRegion, sentences } from '../../../ui/announce';
import { Artwork } from '../../../ui/Artwork';
import { Button } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import { CommandError } from '../../../ui/CommandError';
import { TextField } from '../../../ui/Field';
import { Icon } from '../../../ui/Icon';
import { IconButton } from '../../../ui/IconButton';
import { InfoCard } from '../../../ui/InfoCard';
import { RefusedBeforeRunning } from '../../../ui/RefusedBeforeRunning';
import { Sheet } from '../../../ui/Sheet';
import { Skeleton } from '../../../ui/Skeleton';
import { StatusBadge } from '../../../ui/StatusBadge';
import { SupportDetails } from '../../../ui/SupportDetails';
import { Text } from '../../../ui/Text';
import {
  fonts,
  layout,
  makeStyles,
  radius,
  spacing,
  tabularFigures,
  useTheme,
} from '../../../ui/theme';
import { FormsContent } from '../RequiredFormsScreen';
import { StepHeader } from './StepChrome';

type Basket = Schema<'Basket'>;
type Quote = Schema<'Quote'>;
type QuoteLine = Schema<'QuoteLine'>;
type Offering = Schema<'Offering'>;
type OfferingUniform = Schema<'OfferingUniform'>;

/** "14:52": minutes and seconds left, never negative. */
export function countdown(expiresAt: string, now: Date): string {
  const left = Math.max(0, Math.floor((Date.parse(expiresAt) - now.getTime()) / 1000));
  const minutes = Math.floor(left / 60);
  const seconds = left % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours}:${String(minutes % 60).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Whether a price can still be paid (active and not expired). */
export function quoteUsable(quote: Pick<Quote, 'status' | 'expiresAt'>, now: Date): boolean {
  return quote.status === 'active' && Date.parse(quote.expiresAt) > now.getTime();
}

/** The words of a quote line on Review. */
export function lineLabel(
  line: QuoteLine,
  weekNameOf: (offeringId: string) => string | null,
): string {
  if (line.lineKind === 'addon') return line.addon?.name ?? line.description;
  if (line.lineKind === 'uniform') return line.uniform?.name ?? 'Uniform';
  return weekNameOf(line.offeringId) ?? 'Registration';
}

export interface FormRow {
  key: string;
  title: string;
  done: boolean;
  detail: string;
}

/** The forms (acknowledgments) and waivers the cart's lines need, with their state. */
function useFormRows(
  basket: Basket | null,
  nameOf: (personId: string) => string,
): {
  rows: FormRow[];
  refetch: () => void;
} {
  const permissions = usePermissions();
  const waiversOn = permissions.isCapabilityEnabled('liability_waivers') === true;
  const lines = basket?.lines.filter((l) => l.outcome === 'pending' || l.outcome === 'held') ?? [];
  const requirements = lines.map((l) => ({
    participantPersonId: l.participantPersonId,
    policyVersionIds: l.policies.requiredFormPolicyVersionIds,
  }));
  const status = useFormsStatus(requirements, basket !== null);
  const policyIds = [...new Set(requirements.flatMap((r) => r.policyVersionIds))];
  const policies = useApiRecords('/policy-versions/{id}', policyIds, basket !== null);
  const offerings = useApiRecords(
    '/offerings/{id}/required-waivers',
    [...new Set(lines.map((l) => l.offeringId))],
    basket !== null && waiversOn,
  );
  const people = [...new Set(lines.map((l) => l.participantPersonId))];
  const waivers = useApiRecords('/people/{id}/waivers', people, basket !== null && waiversOn);
  const rows: FormRow[] = [];
  const seen = new Set<string>();
  for (const r of requirements) {
    for (const id of r.policyVersionIds) {
      const key = `${r.participantPersonId}:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const ack = status.acknowledgment(r.participantPersonId, id);
      rows.push({
        key,
        title: policies[id]?.data?.title ?? 'Form',
        done: ack !== null,
        detail: ack
          ? `Signed for ${nameOf(r.participantPersonId)}`
          : `Needed before paying · for ${nameOf(r.participantPersonId)}`,
      });
    }
  }
  if (waiversOn) {
    for (const line of lines) {
      for (const required of offerings[line.offeringId]?.data?.waivers ?? []) {
        const key = `${line.participantPersonId}:${required.policyKey}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const waiver = waivers[line.participantPersonId]?.data?.waivers.find(
          (w) => w.policyKey === required.policyKey,
        );
        if (!waiver) continue;
        const done = waiver.status === 'current';
        rows.push({
          key,
          title: waiver.title,
          done,
          detail: done
            ? [
                `Signed for ${nameOf(line.participantPersonId)}`,
                waiver.validUntil
                  ? `valid until ${formatCalendarDate(waiver.validUntil.slice(0, 10))}`
                  : null,
              ]
                .filter(Boolean)
                .join(' · ')
            : `Needed before paying · for ${nameOf(line.participantPersonId)}`,
        });
      }
    }
  }
  return {
    rows,
    refetch: () => {
      status.refetch();
      Object.values(waivers).forEach((w) => w.refetch());
    },
  };
}

function Row({
  label,
  value,
  tone,
  children,
}: {
  label: string;
  value: string;
  tone?: 'accent';
  children?: ReactNode;
}) {
  const styles = useStyles();
  return (
    <View style={styles.priceRow} accessible accessibilityLabel={`${label}, ${value}`}>
      <View style={styles.priceLabel}>
        <Text variant="callout" tone={tone === 'accent' ? 'accent' : 'default'}>
          {label}
        </Text>
        {children}
      </View>
      <Text variant="callout" tone={tone === 'accent' ? 'accent' : 'default'} tabular>
        {value}
      </Text>
    </View>
  );
}

export function ReviewStep({
  prep,
  payment,
  offering,
  subtitle,
  heldFor,
  weekNameOf,
  nameOf,
  codes,
  onCodes,
  uniform,
  peopleIds,
  sizes,
  onSize,
  offerEndsAt,
  onBack,
  onEdit,
  onRetry,
  method,
  onMethod,
  onPay,
  notice,
}: {
  /** Shown first, above the hold line (a payment already started, the offer ended). */
  notice?: ReactNode;
  /** The payment method token chosen (development builds); null in release builds. */
  method: string | null;
  onMethod: (token: string) => void;
  /** Pays the current price with the chosen method (the controller's). */
  onPay: () => void;
  prep: ReturnType<typeof useRegisterBasket>;
  payment: ReturnType<typeof useRegistrationPayment>;
  offering: Offering | null;
  /** "For Maya · Sat from Mar 7 · 10 weeks". */
  subtitle: string;
  /** "Maya's place", "Maya and Leo's places". */
  heldFor: string;
  weekNameOf: (offeringId: string) => string | null;
  nameOf: (personId: string) => string;
  codes: readonly string[];
  onCodes: (codes: string[]) => void;
  /** The uniform asked on the line (null when the activity has none or the cart came from elsewhere). */
  uniform: OfferingUniform | null;
  /** Who is being registered (each is asked for a uniform size). */
  peopleIds: readonly string[];
  sizes: Readonly<Record<string, string>>;
  onSize: (personId: string, size: string) => void;
  /** A waitlist offer's end: the place is held until then. */
  offerEndsAt?: string | null;
  onBack: () => void;
  onEdit?: () => void;
  onRetry: () => void;
}) {
  const styles = useStyles();
  const theme = useTheme();
  const router = useRouter();
  const insets = useInsets();
  const now = useNow(1000);
  const offline = useConnectivity().reachable === false;
  const [choosing, setChoosing] = useState(false);
  const [codeOpen, setCodeOpen] = useState(false);
  const [codeDraft, setCodeDraft] = useState('');
  const [signing, setSigning] = useState(false);
  const [sizing, setSizing] = useState<string | null>(null);
  const { basket, quote, status } = prep;
  const forms = useFormRows(basket, nameOf);
  const cancellation = useApiRecords(
    '/policy-versions/{id}',
    offering?.cancellationPolicyVersionId ? [offering.cancellationPolicyVersionId] : [],
  );
  const terms = offering?.cancellationPolicyVersionId
    ? cancellation[offering.cancellationPolicyVersionId]?.data
    : undefined;
  const money = (v: number) => formatMoney(v, quote?.currency ?? 'USD');
  const held = basket?.status === 'held';
  const usable = quote !== null && quoteUsable(quote, now);
  const due = quote?.dueNowMinor ?? 0;
  const formsMissing = forms.rows.some((r) => !r.done);
  const payInApp = due === 0 || PAY_METHODS.length > 0;
  const missingSize =
    uniform?.requirement === 'required' && peopleIds.some((id) => !sizes[id]) && !quote;
  const canPay =
    status === 'ready' &&
    held &&
    usable &&
    !basket?.approvalPending &&
    !offline &&
    payment.unknownOutcome === null &&
    !payment.outcomeLost &&
    (due === 0 || method !== null);
  const pay = onPay;
  const holdLine = (() => {
    if (offerEndsAt) return `${heldFor} held until the offer ends · ${countdown(offerEndsAt, now)}`;
    if (held && basket?.holdExpiresAt)
      return `${heldFor} held for ${countdown(basket.holdExpiresAt, now)}`;
    if (status === 'needs_forms') return `Sign the form below to hold ${heldFor.toLowerCase()}`;
    if (status === 'working') return `Holding ${heldFor.toLowerCase()}…`;
    return null;
  })();
  const registrationLines = quote?.lines.filter((l) => l.lineKind === 'registration') ?? [];
  const appliedCodes = quote?.discounts.filter((d) => d.code !== null) ?? [];
  const autoDiscounts = quote?.discounts.filter((d) => d.code === null) ?? [];
  const sizeFor = (personId: string) =>
    sizes[personId] ??
    quote?.lines.find((l) => l.lineKind === 'uniform' && l.participantPersonId === personId)
      ?.uniform?.size ??
    null;

  return (
    <View style={styles.root} testID="register-review">
      <StepHeader title="Review" step="Review" onBack={onBack} />
      <ScrollView contentContainerStyle={styles.content}>
        {notice}
        {holdLine ? (
          <View style={styles.hold} accessible accessibilityLabel={holdLine} testID="review-hold">
            <Icon name="timer" size={20} color={theme.colors.info} />
            <Text style={styles.holdText} tabular>
              {holdLine}
            </Text>
          </View>
        ) : null}

        <Card style={styles.card} testID="review-line">
          <View style={styles.tile}>
            {offering ? (
              <Artwork
                source={artworkFor(offering, 'square').source}
                aspectRatio={1}
                style={styles.tileArt}
              />
            ) : null}
            <View style={styles.tileWords}>
              <Text variant="headline">{offering?.name ?? 'Your registration'}</Text>
              <Text variant="footnote" tone="muted">
                {subtitle}
              </Text>
            </View>
            {onEdit ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Edit your choices"
                onPress={onEdit}
                hitSlop={8}
                style={styles.edit}
              >
                <Text style={styles.editText}>Edit</Text>
              </Pressable>
            ) : null}
          </View>
          <View style={styles.lines}>
            {quote ? (
              <>
                {quote.lines.map((line) => {
                  const notes =
                    line.lineKind === 'uniform' && uniform ? [] : quoteLineBasisLines(line);
                  return (
                    <View key={line.id} style={styles.line}>
                      {line.lineKind === 'uniform' && uniform ? (
                        <Row
                          label={lineLabel(line, weekNameOf)}
                          value={
                            line.uniform?.charged === false
                              ? 'Not charged'
                              : money(line.totalMinor + line.discountMinor)
                          }
                        >
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={`Uniform size for ${nameOf(line.participantPersonId)}, ${line.uniform?.size ?? 'not chosen'}. Change`}
                            onPress={() => setSizing(line.participantPersonId)}
                            style={styles.sizeChip}
                            testID={`size-${line.participantPersonId}`}
                          >
                            <Text
                              style={styles.sizeText}
                            >{`${line.uniform?.size ?? 'Size'} ▾`}</Text>
                          </Pressable>
                        </Row>
                      ) : (
                        <Row
                          label={
                            registrationLines.length > 1 && line.lineKind === 'registration'
                              ? `${lineLabel(line, weekNameOf)} · ${nameOf(line.participantPersonId)}`
                              : lineLabel(line, weekNameOf)
                          }
                          value={money(line.totalMinor + line.discountMinor)}
                        />
                      )}
                      {notes.map((note) => (
                        <Text key={note} variant="footnote" tone="muted">
                          {note}
                        </Text>
                      ))}
                    </View>
                  );
                })}
                {[...autoDiscounts, ...appliedCodes].map((d) => (
                  <View key={d.discountDefinitionId} style={styles.discount}>
                    <Row
                      label={d.code ? `${d.name} · ${d.code}` : d.name}
                      value={`−${money(d.amountMinor)}`}
                      tone="accent"
                    />
                    {d.code ? (
                      <IconButton
                        icon="close"
                        label={`Remove code ${d.code}`}
                        onPress={() =>
                          onCodes(codes.filter((c) => c.toLowerCase() !== d.code?.toLowerCase()))
                        }
                        testID={`remove-code-${d.code}`}
                      />
                    ) : null}
                  </View>
                ))}
                <View
                  style={styles.total}
                  accessible
                  accessibilityLabel={`Total, ${money(quote.totalMinor)}`}
                  testID="review-total"
                >
                  <Text style={styles.totalText}>Total</Text>
                  <Text style={styles.totalText} tabular>
                    {money(quote.totalMinor)}
                  </Text>
                </View>
                {due !== quote.totalMinor ? <Row label="Due now" value={money(due)} /> : null}
              </>
            ) : missingSize && uniform ? (
              <View style={styles.sizes}>
                <Text variant="callout">{`${uniform.name}: choose a size for each player`}</Text>
              </View>
            ) : (
              <View style={styles.skeletons}>
                <Skeleton width="100%" />
                <Skeleton width="80%" />
                <Skeleton width="60%" />
              </View>
            )}
          </View>
        </Card>

        {uniform && (!quote || !quote.lines.some((l) => l.lineKind === 'uniform')) ? (
          <Card style={styles.card} testID="review-uniform">
            <Text variant="callout" style={styles.bold}>
              {uniform.name}
            </Text>
            {Object.keys(sizes).length === 0 ? (
              <Text variant="footnote" tone="muted">
                {uniform.requirement === 'required'
                  ? 'Choose a size to continue.'
                  : 'Optional. Choose a size to add one.'}
              </Text>
            ) : null}
            <SizeChoices
              uniform={uniform}
              people={peopleIds}
              sizeFor={sizeFor}
              nameOf={nameOf}
              onSize={onSize}
            />
          </Card>
        ) : null}

        <View style={styles.codeBox}>
          {codeOpen ? (
            <View style={styles.codeRow}>
              <View style={styles.codeField}>
                <TextField
                  label="Promo code"
                  value={codeDraft}
                  onChangeText={(text) => {
                    setCodeDraft(text);
                    prep.clearCodeError();
                  }}
                  autoCapitalize="characters"
                  error={prep.codeError}
                  returnKeyType="done"
                  testID="promo-code"
                />
              </View>
              <Button
                label="Apply"
                variant="tonal"
                disabled={codeDraft.trim().length < 2 || offline}
                busy={prep.repricing}
                onPress={() => {
                  const code = codeDraft.trim();
                  if (!codes.some((c) => c.toLowerCase() === code.toLowerCase()))
                    onCodes([...codes, code]);
                  setCodeDraft('');
                }}
                testID="promo-apply"
              />
            </View>
          ) : (
            <Button
              label="Have a promo code?"
              variant="text"
              onPress={() => setCodeOpen(true)}
              testID="promo-open"
            />
          )}
          {!codeOpen && prep.codeError ? (
            <Text variant="footnote" tone="danger">
              {prep.codeError}
            </Text>
          ) : null}
        </View>

        {forms.rows.length > 0 ? (
          <Card style={styles.formsCard} testID="review-forms">
            {forms.rows.map((row, i) => (
              <View key={row.key} style={[styles.formRow, i > 0 ? styles.divider : null]}>
                <Icon
                  name={row.done ? 'check_circle' : 'edit_document'}
                  size={22}
                  color={row.done ? theme.colors.success : theme.colors.warning}
                />
                <View style={styles.formWords}>
                  <Text variant="callout" style={styles.bold}>
                    {row.title}
                  </Text>
                  <Text variant="footnote" tone="muted">
                    {row.done ? row.detail : `▲ ${row.detail}`}
                  </Text>
                </View>
                {row.done ? null : (
                  <Button
                    label="Sign"
                    variant="tonal"
                    onPress={() => setSigning(true)}
                    disabled={offline}
                    accessibilityLabel={`Sign ${row.title}`}
                    testID={`sign-${row.key}`}
                  />
                )}
              </View>
            ))}
          </Card>
        ) : null}

        {due > 0 && PAY_METHODS.length > 0 ? (
          <Card style={styles.methodCard} testID="review-method">
            <View style={styles.methodRow}>
              <View style={styles.methodIcon}>
                <Icon name="credit_card" size={20} color={theme.colors.text} />
              </View>
              <View style={styles.formWords}>
                <Text variant="callout" style={styles.bold}>
                  {PAY_METHODS.find((m) => m.token === method)?.label ?? 'Choose how to pay'}
                </Text>
                <Text variant="footnote" tone="muted">
                  Or pay at the front desk
                </Text>
              </View>
              <Button
                label="Change"
                variant="text"
                onPress={() => setChoosing((v) => !v)}
                disabled={payment.processing}
              />
            </View>
            {choosing ? (
              <View
                accessibilityRole="radiogroup"
                accessibilityLabel="Payment method"
                style={styles.methods}
              >
                {PAY_METHODS.map((m) => (
                  <Pressable
                    key={m.token}
                    accessibilityRole="radio"
                    accessibilityLabel={m.label}
                    accessibilityState={{ checked: method === m.token }}
                    onPress={() => {
                      onMethod(m.token);
                      setChoosing(false);
                    }}
                    style={styles.methodChoice}
                    testID={`method-${m.token}`}
                  >
                    <View style={[styles.radio, method === m.token ? styles.radioOn : null]} />
                    <Text variant="callout">{m.label}</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
          </Card>
        ) : due > 0 && quote ? (
          <InfoCard
            tone="info"
            icon="storefront"
            message={PAY_AT_DESK_MESSAGE}
            testID="review-pay-at-desk"
          >
            <SupportDetails
              decisions={[...PAY_AT_DESK_SUPPORT.decisions]}
              owner={PAY_AT_DESK_SUPPORT.owner}
            />
          </InfoCard>
        ) : null}

        {terms ? (
          <Text variant="footnote" tone="muted" numberOfLines={4} testID="review-terms">
            {formWording(terms.content)[0] ?? terms.title}{' '}
            {offering ? (
              <Text
                variant="footnote"
                style={styles.link}
                accessibilityRole="link"
                onPress={() => router.push(`/registration/offering/${offering.id}`)}
              >
                All terms
              </Text>
            ) : null}
          </Text>
        ) : null}

        {basket?.approvalPending ? (
          <InfoCard
            tone="info"
            message="Staff must approve this registration before you can pay."
          />
        ) : null}

        {payment.unknownOutcome ? (
          <LiveRegion
            announcement={sentences(
              UNKNOWN_OUTCOME_LABEL,
              payment.unreadable ? UNREADABLE_OUTCOME_BODY : UNKNOWN_OUTCOME_BODY,
              'Check now',
            )}
            occurrence={payment.unanswered}
            style={styles.unknown}
            testID="review-outcome-unknown"
          >
            <StatusBadge tone="warning" label={UNKNOWN_OUTCOME_LABEL} />
            <Text variant="callout">
              {payment.unreadable ? UNREADABLE_OUTCOME_BODY : UNKNOWN_OUTCOME_BODY}
            </Text>
            <Button
              label="Check now"
              variant="secondary"
              onPress={() => payment.unknownOutcome && void payment.pay(payment.unknownOutcome)}
              busy={payment.processing}
              disabled={offline}
            />
            {payment.checkRefused && payment.failure ? (
              <RefusedBeforeRunning error={payment.failure.error} priorUnknown payment />
            ) : null}
          </LiveRegion>
        ) : null}

        <CommandError
          wording="registration"
          error={
            payment.checkRefused || payment.unknownOutcome
              ? null
              : ((payment.failure?.error ??
                  (status === 'failed' ? prep.failure : null)) as ApiError | null)
          }
          onRetry={payment.failure?.retry ?? onRetry}
          onReload={onRetry}
          onRequote={onRetry}
        />
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.md }]}>
        {payInApp ? (
          <Button
            label={
              payment.processing
                ? 'Paying…'
                : due === 0 && quote
                  ? 'Confirm registration'
                  : quote
                    ? `Pay ${money(due)}`
                    : 'Pay'
            }
            size="lg"
            block
            busy={payment.processing}
            disabled={!canPay || formsMissing}
            onPress={pay}
            testID="review-pay"
          />
        ) : null}
        {offline ? (
          <Text variant="footnote" tone="muted" style={styles.center}>
            Paying needs a connection.
          </Text>
        ) : formsMissing && quote ? (
          <Text variant="footnote" tone="muted" style={styles.center}>
            Sign the forms above to pay.
          </Text>
        ) : null}
        {due > 0 ? (
          <View style={styles.center}>
            <StatusBadge tone="pending" label="In-app payment proposed" />
          </View>
        ) : null}
      </View>

      <Sheet
        open={signing}
        onClose={() => {
          setSigning(false);
          forms.refetch();
          onRetry();
        }}
        title="Forms to sign"
        testID="review-sign-sheet"
      >
        {basket ? <FormsContent source={{ basketId: basket.id }} embedded /> : null}
      </Sheet>
      <Sheet
        open={sizing !== null}
        onClose={() => setSizing(null)}
        title={uniform ? `${uniform.name} size` : 'Size'}
        testID="review-size-sheet"
      >
        {uniform && sizing ? (
          <SizeChoices
            uniform={uniform}
            people={[sizing]}
            sizeFor={sizeFor}
            nameOf={nameOf}
            onSize={(personId, size) => {
              onSize(personId, size);
              setSizing(null);
            }}
          />
        ) : null}
      </Sheet>
    </View>
  );
}

/** The uniform's sizes as chips, per person. */
export function SizeChoices({
  uniform,
  people,
  sizeFor,
  nameOf,
  onSize,
}: {
  uniform: OfferingUniform;
  people: readonly string[];
  sizeFor: (personId: string) => string | null;
  nameOf: (personId: string) => string;
  onSize: (personId: string, size: string) => void;
}) {
  const styles = useStyles();
  return (
    <View style={styles.sizeGroups}>
      {people.map((personId) => (
        <View
          key={personId}
          accessibilityRole="radiogroup"
          accessibilityLabel={`${uniform.name} size for ${nameOf(personId)}`}
          style={styles.sizeGroup}
        >
          <Text variant="footnote" tone="muted">
            {`For ${nameOf(personId)}`}
          </Text>
          <View style={styles.sizeRow}>
            {uniform.sizes.map((size) => {
              const on = sizeFor(personId) === size;
              return (
                <Pressable
                  key={size}
                  accessibilityRole="radio"
                  accessibilityLabel={size}
                  accessibilityState={{ checked: on }}
                  onPress={() => onSize(personId, size)}
                  style={[styles.sizeOption, on ? styles.sizeOn : null]}
                  testID={`size-option-${personId}-${size}`}
                >
                  <Text style={[styles.sizeText, on ? styles.sizeTextOn : null]}>{size}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ))}
    </View>
  );
}

const useStyles = makeStyles(({ colors, toneBackgrounds }) => ({
  root: { flex: 1, backgroundColor: colors.page },
  content: {
    paddingHorizontal: layout.gutter,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xl,
    gap: spacing.md,
  },
  hold: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: radius.md,
    backgroundColor: toneBackgrounds.info,
  },
  holdText: { ...fonts.semibold, fontSize: 14, lineHeight: 19, color: colors.info, flexShrink: 1 },
  card: { gap: spacing.md },
  tile: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  tileArt: { width: 56, borderRadius: radius.sm },
  tileWords: { flex: 1 },
  edit: { minHeight: 44, justifyContent: 'center' },
  editText: { ...fonts.semibold, fontSize: 14, color: colors.primary },
  lines: { borderTopWidth: 1, borderTopColor: colors.divider, paddingTop: 10, gap: spacing.sm },
  line: { gap: 2 },
  priceRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.sm,
    flex: 1,
  },
  priceLabel: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexShrink: 1 },
  discount: { flexDirection: 'row', alignItems: 'center' },
  total: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    borderTopColor: colors.divider,
    paddingTop: 10,
  },
  totalText: { ...fonts.bold, ...tabularFigures, fontSize: 19, lineHeight: 24, color: colors.text },
  skeletons: { gap: spacing.sm },
  sizes: { gap: spacing.sm },
  sizeChip: {
    paddingHorizontal: 10,
    paddingVertical: 2,
    minHeight: 28,
    justifyContent: 'center',
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.control,
  },
  sizeText: { ...fonts.semibold, fontSize: 13, color: colors.text },
  sizeTextOn: { color: colors.onChipSelected },
  sizeGroups: { gap: spacing.md },
  sizeGroup: { gap: spacing.xs },
  sizeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  sizeOption: {
    minHeight: 44,
    paddingHorizontal: 14,
    justifyContent: 'center',
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.control,
    backgroundColor: colors.background,
  },
  sizeOn: { backgroundColor: colors.chipSelected, borderColor: colors.chipSelected },
  bold: { ...fonts.semibold },
  codeBox: { gap: spacing.xs },
  codeRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm },
  codeField: { flex: 1 },
  formsCard: { paddingVertical: spacing.xs },
  formRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
  },
  divider: { borderTopWidth: 1, borderTopColor: colors.divider },
  formWords: { flex: 1 },
  methodCard: { gap: spacing.sm },
  methodRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  methodIcon: {
    width: 38,
    height: 38,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  methods: { gap: spacing.xs },
  methodChoice: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 44 },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: colors.control },
  radioOn: { borderWidth: 7, borderColor: colors.primary },
  link: { ...fonts.semibold, color: colors.primary },
  unknown: { gap: spacing.sm },
  footer: {
    paddingTop: spacing.md,
    paddingHorizontal: layout.gutter,
    gap: 6,
    backgroundColor: colors.background,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  center: { alignSelf: 'center', textAlign: 'center' },
}));
