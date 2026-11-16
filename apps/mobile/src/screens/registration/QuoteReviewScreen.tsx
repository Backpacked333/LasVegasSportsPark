/**
 * SCR-C-12 Quote review, the Review step of registering (PA-11: quote → review / price summary;
 * ADR-008: the lines grouped by person, each with its own total) (SPK-PAY-001, SPK-PAY-002, SPK-PAY-003, SPK-PAY-009, POL-011, POL-012,
 * POL-013; journey A4). Reads `GET /v1/registration-quotes/{id}`: each participant and item, base
 * price, discounts with their explanation, approved taxes and fees, credits applied, due now,
 * future obligations, the server-owned expiry and the applicable policies. Every amount is the
 * API's integer minor units with its currency; the app never computes a price. A line priced per
 * class or with a member price evaluated (SPK-PAY-013, SPK-PAY-015; proposed amendments PA-02 and
 * PA-04) shows the basis the quote stored: the per-class price, the count and the product, and
 * which price applied and why.
 *
 * A discount code or credits produce a new quote (`POST /v1/registration-quotes`, the body carries
 * no amounts). An expired quote reads "Price expired. Get a new price." (QUOTE_EXPIRED,
 * `request_new_quote`). A quote reserves nothing: places are held at checkout (SCR-C-14).
 *
 * Prices, taxes, discounts and rounding are Finance decisions (DEC-007, DEC-057): the app shows
 * what the API priced, and lists verbatim the engineering defaults the API says it applied where
 * no approved policy exists.
 *
 * States: loading; "no quote" reads not available; ready; validation failure (code or credit not
 * applicable); permission restriction (a credit of another person is not found); stale (expired:
 * get a new price); offline (shown with its expiry, checkout disabled); processing (requoting).
 */
import type { ApiError, Schema } from '@sportspark/api-client';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { RegistrationSteps } from '../../features/registration/steps';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandError } from '../../ui/CommandError';
import {
  fieldMessages,
  formatInstant,
  formatMoney,
  hasPassed,
} from '../../features/registration/format';
import { useMe, useParticipantNames } from '../../features/registration/participants';
import { lineKindLabel, quoteLineBasisLines } from '../../features/registration/price-basis';
import { useApiRecords } from '../../features/registration/queries';
import { param, registrationRoutes } from '../../features/registration/routes';
import { quoteStatus } from '../../features/registration/status';
import { useApp, useConnectivity, useNow } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { Avatar } from '../../ui/Avatar';
import { Button } from '../../ui/Button';
import { ChoiceCard } from '../../ui/ChoiceList';
import { FieldValue, TextField } from '../../ui/Field';
import { Section } from '../../ui/Section';
import { Text } from '../../ui/Text';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { StatusBadge } from '../../ui/StatusBadge';
import { layout, makeStyles, spacing } from '../../ui/theme';

type Quote = Schema<'Quote'>;
type QuoteLine = Schema<'QuoteLine'>;
type Credit = Schema<'Credit'>;

export function quoteIsUsable(quote: Quote, now: Date): boolean {
  return quote.status === 'active' && !hasPassed(quote.expiresAt, now);
}

/** Policy versions a quote relies on, for their titles. */
export function quotePolicyIds(quote: Quote): string[] {
  const ids = new Set<string>();
  for (const line of quote.lines) {
    if (line.policies.cancellationPolicyVersionId)
      ids.add(line.policies.cancellationPolicyVersionId);
  }
  const p = quote.policies;
  for (const id of [
    p.refundPolicyVersionId,
    p.installmentPolicyVersionId,
    p.overpaymentPolicyVersionId,
  ]) {
    if (id) ids.add(id);
  }
  return [...ids];
}

/** Field message for the discount code: unknown codes (service) or a malformed code (schema). */
export function discountCodeError(error: ApiError | null): string | undefined {
  if (error?.code !== 'VALIDATION_FAILED') return undefined;
  const details = error.details as { unknownCodes?: unknown } | undefined;
  if (Array.isArray(details?.unknownCodes) && details.unknownCodes.length > 0) {
    return 'This code is not recognized or is no longer active.';
  }
  const messages = fieldMessages(error.details);
  const key = Object.keys(messages).find((k) => k.startsWith('discountCodes'));
  return key ? messages[key] : undefined;
}

/** The quote's lines per participant, in the order the quote lists them (ADR-008 Review). */
export function byPerson(lines: readonly QuoteLine[]): [string, QuoteLine[]][] {
  const groups = new Map<string, QuoteLine[]>();
  for (const line of lines) {
    const group = groups.get(line.participantPersonId) ?? [];
    group.push(line);
    groups.set(line.participantPersonId, group);
  }
  return [...groups.entries()];
}

function LineDetail({ line, name }: { line: QuoteLine; name: string }) {
  const styles = useStyles();
  const m = (v: number) => formatMoney(v, line.currency);
  const kind = lineKindLabel(line);
  return (
    <View style={styles.line} testID={`quote-line-${line.id}`}>
      {/* SPK-PAY-014, SPK-REG-012: an add-on or uniform is its own line, named as such. */}
      <Text variant="headline">{`${kind ? `${kind}: ` : ''}${line.description}`}</Text>
      <FieldValue
        layout="inline"
        label={
          line.quantity > 1
            ? `${line.quantity} × ${m(line.unitPriceMinor)}`
            : kind
              ? 'Price'
              : 'Base price'
        }
        value={m(line.baseAmountMinor)}
      />
      {/* SPK-PAY-013 to SPK-PAY-015, SPK-REG-012: the basis the quote stored for the line. */}
      {quoteLineBasisLines(line).map((text) => (
        <Text key={text} variant="caption" tone="muted">
          {text}
        </Text>
      ))}
      {line.discounts.map((d) => (
        <View key={d.discountDefinitionId}>
          <FieldValue
            layout="inline"
            label={d.code ? `${d.name} (${d.code})` : d.name}
            value={m(-d.amountMinor)}
          />
          {d.explanation.map((text) => (
            <Text key={text} variant="caption" tone="muted">
              {text}
            </Text>
          ))}
        </View>
      ))}
      {line.charges.map((c) => (
        <FieldValue
          layout="inline"
          key={c.code}
          label={c.inclusive ? `${c.label} (included)` : c.label}
          value={m(c.amountMinor)}
        />
      ))}
      <FieldValue
        layout="inline"
        label={kind ? `Total for this ${kind.toLowerCase()}` : `Total for ${name}`}
        value={m(line.totalMinor)}
        emphasis
      />
    </View>
  );
}

function CreditsChooser({
  quote,
  chosen,
  onChange,
}: {
  quote: Quote;
  chosen: string[];
  onChange: (ids: string[]) => void;
}) {
  const me = useMe();
  const ownerPersonId = me.data?.person?.id ?? null;
  const credits = useApiQuery({
    path: '/credits',
    request: { query: { ownerPersonId: ownerPersonId ?? '', limit: 50 } },
    enabled: ownerPersonId !== null && ownerPersonId === quote.payerPersonId,
  });
  const usable = (credits.data?.items ?? []).filter(
    (c: Credit) =>
      c.status === 'active' &&
      c.remainingMinor > 0 &&
      c.currency === quote.currency &&
      c.permittedUses.includes('registration'),
  );
  if (usable.length === 0) return null;
  return (
    <Section title="Your credits">
      {usable.map((c) => {
        const label = `Credit: ${formatMoney(c.remainingMinor, c.currency)}`;
        const detail = c.expiresAt ? `Expires ${formatInstant(c.expiresAt)}` : undefined;
        return (
          <ChoiceCard
            key={c.id}
            option={{ value: c.id, label, description: detail }}
            mode="multiple"
            checked={chosen.includes(c.id)}
            onPress={() =>
              onChange(
                chosen.includes(c.id) ? chosen.filter((id) => id !== c.id) : [...chosen, c.id],
              )
            }
            accessibilityLabel={detail ? `${label}. ${detail}` : label}
            testID={`credit-${c.id}`}
          />
        );
      })}
    </Section>
  );
}

function QuoteContent({ quote, refetch }: { quote: Quote; refetch: () => void }) {
  const styles = useStyles();
  const router = useRouter();
  const now = useNow();
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const names = useParticipantNames(quote.lines.map((l) => l.participantPersonId));
  const policies = useApiRecords('/policy-versions/{id}', quotePolicyIds(quote));
  const policyTitle = (id: string | null) => (id ? (policies[id]?.data?.title ?? null) : null);
  const appliedCodes = quote.discounts.map((d) => d.code).filter((c): c is string => c !== null);
  const [code, setCode] = useState('');
  const [credits, setCredits] = useState<string[]>(quote.appliedCredits.map((c) => c.creditId));
  /** The failed attempt and its own arguments: "Try again" repeats exactly that request (§4.9). */
  const [failure, setFailure] = useState<{ error: ApiError; retry: () => void } | null>(null);
  const requote = useApiCommand('post', '/registration-quotes');
  const usable = quoteIsUsable(quote, now);
  const m = (v: number) => formatMoney(v, quote.currency);

  const newQuote = async (discountCodes: string[], creditIds: string[]) => {
    setFailure(null);
    try {
      const next = await requote.submit({
        body: { basketId: quote.basketId, discountCodes, creditIds },
      });
      setCode('');
      router.replace(registrationRoutes.quote(next.id));
    } catch (error) {
      setFailure({
        error: error as ApiError,
        retry: () => void newQuote(discountCodes, creditIds),
      });
    }
  };
  const codeError = discountCodeError(failure?.error ?? null);
  const creditsChanged =
    [...credits].sort().join() !==
    quote.appliedCredits
      .map((c) => c.creditId)
      .sort()
      .join();

  const cancellationIds = [
    ...new Set(quote.lines.map((l) => l.policies.cancellationPolicyVersionId).filter(Boolean)),
  ] as string[];

  return (
    <View>
      <RegistrationSteps step="Review" />
      <Section title="Price summary">
        <StatusBadge {...quoteStatus(quote, now)} testID="quote-status" />
        <Text variant="caption" tone="muted">
          This price does not save your spots. Your spots are saved when you check out.
        </Text>
      </Section>
      {byPerson(quote.lines).map(([personId, lines]) => {
        const name = names(personId);
        return (
          <Section
            key={personId}
            title={name === 'You' ? 'For you' : `For ${name}`}
            testID={`quote-person-${personId}`}
          >
            <View style={styles.person}>
              <Avatar name={name} id={personId} size="sm" decorative />
              <View accessibilityRole="list" style={styles.personLines}>
                {lines.map((line) => (
                  <LineDetail key={line.id} line={line} name={name} />
                ))}
              </View>
            </View>
          </Section>
        );
      })}
      <Section title="Total">
        <FieldValue layout="inline" label="Subtotal" value={m(quote.subtotalMinor)} />
        {quote.discountMinor !== 0 ? (
          <FieldValue layout="inline" label="Discounts" value={m(-quote.discountMinor)} />
        ) : null}
        {quote.taxMinor !== 0 ? (
          <FieldValue layout="inline" label="Taxes" value={m(quote.taxMinor)} />
        ) : null}
        {quote.feeMinor !== 0 ? (
          <FieldValue layout="inline" label="Fees" value={m(quote.feeMinor)} />
        ) : null}
        {quote.includedTaxMinor !== 0 ? (
          <FieldValue
            layout="inline"
            label="Tax included in prices"
            value={m(quote.includedTaxMinor)}
          />
        ) : null}
        <FieldValue layout="inline" label="Total" value={m(quote.totalMinor)} />
        {quote.creditsAppliedMinor !== 0 ? (
          <FieldValue
            layout="inline"
            label="Credits applied"
            value={m(-quote.creditsAppliedMinor)}
          />
        ) : null}
        <FieldValue
          layout="inline"
          label="Due now"
          value={m(quote.dueNowMinor)}
          emphasis
          testID="quote-due-now"
        />
        {quote.futureObligations.map((f) => (
          <FieldValue
            layout="inline"
            key={f.sequence}
            label={`Payment ${f.sequence} due ${formatInstant(f.dueAt)}`}
            value={m(f.amountMinor)}
          />
        ))}
      </Section>
      <Section title="Policies">
        {cancellationIds.length === 0 ? (
          <Text variant="body">No cancellation policy applies.</Text>
        ) : null}
        {cancellationIds.map((id) => (
          <Text
            key={id}
            variant="body"
          >{`Cancellation: ${policyTitle(id) ?? 'policy attached to this activity'}`}</Text>
        ))}
        {policyTitle(quote.policies.refundPolicyVersionId) ? (
          <Text variant="body">{`Refunds: ${policyTitle(quote.policies.refundPolicyVersionId)}`}</Text>
        ) : null}
        {policyTitle(quote.policies.installmentPolicyVersionId) ? (
          <Text variant="body">{`Installments: ${policyTitle(quote.policies.installmentPolicyVersionId)}`}</Text>
        ) : null}
        {quote.policies.defaults.length > 0 ? (
          <>
            <Text variant="caption" tone="muted">
              Where no policy is approved yet, the facility&apos;s system applies:
            </Text>
            {quote.policies.defaults.map((d) => (
              <Text key={d} variant="caption" tone="muted">{`• ${d}`}</Text>
            ))}
          </>
        ) : null}
      </Section>
      {usable ? (
        <Section title="Discount code">
          <TextField
            label="Discount code"
            value={code}
            onChangeText={setCode}
            error={codeError}
            testID="discount-code"
          />
          <Button
            label="Apply code"
            variant="secondary"
            onPress={() => void newQuote([...appliedCodes, code.trim()], credits)}
            disabled={code.trim().length === 0 || offline}
            busy={requote.isProcessing}
          />
        </Section>
      ) : null}
      {usable ? (
        <>
          <CreditsChooser quote={quote} chosen={credits} onChange={setCredits} />
          {creditsChanged ? (
            <View style={styles.actions}>
              <Button
                label="Update price with my credits"
                variant="secondary"
                onPress={() => void newQuote(appliedCodes, credits)}
                disabled={offline}
                busy={requote.isProcessing}
              />
            </View>
          ) : null}
        </>
      ) : null}
      <CommandError
        wording="registration"
        error={failure?.error ?? null}
        onRetry={failure?.retry}
        onReload={refetch}
        onRequote={failure?.retry ?? (() => void newQuote(appliedCodes, credits))}
      />
      <View style={styles.actions}>
        {usable ? (
          <Button
            label="Continue to checkout"
            onPress={() => router.push(registrationRoutes.checkout(quote.id))}
            disabled={offline}
          />
        ) : quote.status === 'consumed' ? (
          quote.consumedByCheckoutId ? (
            // The API names the checkout that used this price (SPK-UX-001: also after a reinstall).
            <Button
              label="See your payment"
              onPress={() =>
                router.push(registrationRoutes.outcome(quote.consumedByCheckoutId as string))
              }
            />
          ) : (
            // The checkout screen asks again for this price; the API returns the existing checkout.
            <Button
              label="Check your payment"
              onPress={() => router.push(registrationRoutes.checkout(quote.id))}
            />
          )
        ) : (
          <Button
            label="Get a new price"
            onPress={() =>
              void newQuote(
                appliedCodes,
                quote.appliedCredits.map((c) => c.creditId),
              )
            }
            busy={requote.isProcessing}
            disabled={offline}
          />
        )}
        <Button
          label="Back to your cart"
          variant="secondary"
          onPress={() => router.push(registrationRoutes.basket(quote.basketId))}
        />
        {offline ? (
          <Text variant="caption" tone="muted">
            Checking out needs a connection.
          </Text>
        ) : null}
      </View>
    </View>
  );
}

export function QuoteReviewScreen({ quoteId }: { quoteId: string }) {
  const { session } = useApp();
  const quote = useApiQuery({
    path: '/registration-quotes/{id}',
    request: { path: { id: quoteId } },
    enabled: session.status === 'signed_in',
  });
  return (
    <Screen>
      <RequireSession what="your price summary">
        <QueryBoundary
          query={quote}
          label="your price summary"
          empty={{ title: 'No price', description: '' }}
          unavailableOffline={['Checkout', 'Discount codes', 'Credits']}
        >
          {(q) => <QuoteContent key={q.id} quote={q} refetch={() => void quote.refetch()} />}
        </QueryBoundary>
      </RequireSession>
    </Screen>
  );
}

/** Route component for app/registration/quote/[quoteId].tsx. */
export function QuoteReviewRoute() {
  const quoteId = param(useLocalSearchParams<{ quoteId: string }>().quoteId) ?? '';
  return (
    <>
      <Stack.Screen options={{ title: 'Review' }} />
      <QuoteReviewScreen quoteId={quoteId} />
    </>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  line: {
    paddingVertical: spacing.sm,
    gap: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  person: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  personLines: { flex: 1 },
  actions: { gap: spacing.sm, paddingHorizontal: layout.gutter, paddingVertical: spacing.lg },
}));
