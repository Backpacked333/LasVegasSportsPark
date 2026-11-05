/**
 * SCR-C-12 Quote review (SPK-PAY-001, SPK-PAY-002, SPK-PAY-003, SPK-PAY-009, POL-011, POL-012,
 * POL-013; journey A4). Reads `GET /v1/registration-quotes/{id}`: each participant and item, base
 * price, discounts with their explanation, approved taxes and fees, credits applied, due now,
 * future obligations, the server-owned expiry and the applicable policies. Every amount is the
 * API's integer minor units with its currency; the app never computes a price.
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
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandError } from '../../features/registration/CommandError';
import {
  fieldMessages,
  formatInstant,
  formatMoney,
  hasPassed,
} from '../../features/registration/format';
import { useMe, useParticipantNames } from '../../features/registration/participants';
import { useApiRecords } from '../../features/registration/queries';
import { param, registrationRoutes } from '../../features/registration/routes';
import { quoteStatus } from '../../features/registration/status';
import {
  Body,
  ButtonRow,
  ChoiceRow,
  Detail,
  Section,
  TextField,
} from '../../features/registration/ui';
import { useApp, useConnectivity, useNow } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { StatusBadge } from '../../ui/StatusBadge';
import { colors, spacing } from '../../ui/theme';

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

function LineDetail({ line, name }: { line: QuoteLine; name: string }) {
  const m = (v: number) => formatMoney(v, line.currency);
  return (
    <View style={styles.line} testID={`quote-line-${line.id}`}>
      <Body>{`${name}: ${line.description}`}</Body>
      <Detail
        label={line.quantity > 1 ? `${line.quantity} × ${m(line.unitPriceMinor)}` : 'Base price'}
        value={m(line.baseAmountMinor)}
      />
      {line.discounts.map((d) => (
        <View key={d.discountDefinitionId}>
          <Detail label={d.code ? `${d.name} (${d.code})` : d.name} value={m(-d.amountMinor)} />
          {d.explanation.map((text) => (
            <Body key={text} muted>
              {text}
            </Body>
          ))}
        </View>
      ))}
      {line.charges.map((c) => (
        <Detail
          key={c.code}
          label={c.inclusive ? `${c.label} (included)` : c.label}
          value={m(c.amountMinor)}
        />
      ))}
      <Detail label={`Total for ${name}`} value={m(line.totalMinor)} emphasis />
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
      {usable.map((c) => (
        <ChoiceRow
          key={c.id}
          label={`Credit: ${formatMoney(c.remainingMinor, c.currency)}`}
          detail={c.expiresAt ? `Expires ${formatInstant(c.expiresAt)}` : undefined}
          checked={chosen.includes(c.id)}
          onToggle={() =>
            onChange(chosen.includes(c.id) ? chosen.filter((id) => id !== c.id) : [...chosen, c.id])
          }
          testID={`credit-${c.id}`}
        />
      ))}
    </Section>
  );
}

function QuoteContent({ quote, refetch }: { quote: Quote; refetch: () => void }) {
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
      <Section title="Your price">
        <StatusBadge {...quoteStatus(quote, now)} testID="quote-status" />
        <Body muted>A price does not hold a place. Places are held when you check out.</Body>
      </Section>
      <View accessibilityRole="list">
        {quote.lines.map((line) => (
          <LineDetail key={line.id} line={line} name={names(line.participantPersonId)} />
        ))}
      </View>
      <Section title="Total">
        <Detail label="Subtotal" value={m(quote.subtotalMinor)} />
        {quote.discountMinor !== 0 ? (
          <Detail label="Discounts" value={m(-quote.discountMinor)} />
        ) : null}
        {quote.taxMinor !== 0 ? <Detail label="Taxes" value={m(quote.taxMinor)} /> : null}
        {quote.feeMinor !== 0 ? <Detail label="Fees" value={m(quote.feeMinor)} /> : null}
        {quote.includedTaxMinor !== 0 ? (
          <Detail label="Tax included in prices" value={m(quote.includedTaxMinor)} />
        ) : null}
        <Detail label="Total" value={m(quote.totalMinor)} />
        {quote.creditsAppliedMinor !== 0 ? (
          <Detail label="Credits applied" value={m(-quote.creditsAppliedMinor)} />
        ) : null}
        <Detail label="Due now" value={m(quote.dueNowMinor)} emphasis testID="quote-due-now" />
        {quote.futureObligations.map((f) => (
          <Detail
            key={f.sequence}
            label={`Payment ${f.sequence} due ${formatInstant(f.dueAt)}`}
            value={m(f.amountMinor)}
          />
        ))}
      </Section>
      <Section title="Policies">
        {cancellationIds.length === 0 ? <Body>No cancellation policy applies.</Body> : null}
        {cancellationIds.map((id) => (
          <Body
            key={id}
          >{`Cancellation: ${policyTitle(id) ?? 'policy attached to this activity'}`}</Body>
        ))}
        {policyTitle(quote.policies.refundPolicyVersionId) ? (
          <Body>{`Refunds: ${policyTitle(quote.policies.refundPolicyVersionId)}`}</Body>
        ) : null}
        {policyTitle(quote.policies.installmentPolicyVersionId) ? (
          <Body>{`Installments: ${policyTitle(quote.policies.installmentPolicyVersionId)}`}</Body>
        ) : null}
        {quote.policies.defaults.length > 0 ? (
          <>
            <Body muted>Where no policy is approved yet, the facility's system applies:</Body>
            {quote.policies.defaults.map((d) => (
              <Body key={d} muted>{`• ${d}`}</Body>
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
            <ButtonRow>
              <Button
                label="Update price with my credits"
                variant="secondary"
                onPress={() => void newQuote(appliedCodes, credits)}
                disabled={offline}
                busy={requote.isProcessing}
              />
            </ButtonRow>
          ) : null}
        </>
      ) : null}
      <CommandError
        error={failure?.error ?? null}
        onRetry={failure?.retry}
        onReload={refetch}
        onRequote={failure?.retry ?? (() => void newQuote(appliedCodes, credits))}
      />
      <ButtonRow>
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
          label="Back to your basket"
          variant="secondary"
          onPress={() => router.push(registrationRoutes.basket(quote.basketId))}
        />
        {offline ? <Body muted>Checking out needs a connection.</Body> : null}
      </ButtonRow>
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
      <RequireSession what="your price">
        <QueryBoundary
          query={quote}
          label="your price"
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
      <Stack.Screen options={{ title: 'Your price' }} />
      <QuoteReviewScreen quoteId={quoteId} />
    </>
  );
}

const styles = StyleSheet.create({
  line: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
});
