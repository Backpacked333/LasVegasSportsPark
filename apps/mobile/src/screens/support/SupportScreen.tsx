/**
 * SCR-C-38 Support request and case history (SPK-SUPPORT-001, SPK-SUPPORT-002, SPK-SUPPORT-003).
 *
 * The API's support cases are staff-only: `POST /v1/cases` and `GET /v1/cases` grant no customer
 * authority and answer a customer NOT_FOUND (apps/api/src/modules/support/support.actions.ts). So
 * the app cannot open a support request or show case history yet (reported as an API gap); the
 * screen sends no request to those routes and says so plainly.
 *
 * What it does show:
 * - How to reach the facility: the support contact from configuration
 *   (`SPORTSPARK_SUPPORT_PHONE`, `SPORTSPARK_SUPPORT_EMAIL`, `SPORTSPARK_SUPPORT_HOURS`). Contact
 *   details and coverage are facility facts (DEC-015, Technical lead/operator); unset, the screen
 *   shows that pending decision and never invents a number or hours.
 * - What to have ready: the error reference shown with any error, and which registration or
 *   balance it is about (from Enrollments and Payments).
 * - SPK-SUPPORT-003: talking to support never replaces the actual change. Cancellation and
 *   transfer (Enrollments) and payments are commands of their own; a note in a case is not a
 *   refund, permission change or transfer.
 *
 * States: unavailable (in-app requests and case history); pending decision (contact details when
 * not configured); signed out (sign in). Loading, empty, validation failure, offline draft,
 * processing and success apply once the API serves customer support requests.
 */
import { Stack, useRouter } from 'expo-router';
import { Linking, View } from 'react-native';
import type { SupportContact } from '../../config/app-config';
import { moneyRoutes } from '../../features/money/routes';
import { Body, ButtonRow, Caption, Field, Section } from '../../features/money/ui';
import { useApp } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';

function ContactDetails({ contact }: { contact: SupportContact }) {
  return (
    <>
      {contact.phone ? <Field label="Phone" value={contact.phone} /> : null}
      {contact.email ? <Field label="Email" value={contact.email} /> : null}
      {contact.hours ? <Field label="Hours" value={contact.hours} /> : null}
      <ButtonRow>
        {contact.phone ? (
          <Button
            label="Call the facility"
            variant="secondary"
            accessibilityHint={`Calls ${contact.phone}`}
            onPress={() => void Linking.openURL(`tel:${contact.phone?.replace(/[^\d+]/g, '')}`)}
          />
        ) : null}
        {contact.email ? (
          <Button
            label="Email the facility"
            variant="secondary"
            accessibilityHint={`Writes to ${contact.email}`}
            onPress={() => void Linking.openURL(`mailto:${contact.email}`)}
          />
        ) : null}
      </ButtonRow>
    </>
  );
}

function Support() {
  const router = useRouter();
  const { services } = useApp();
  const contact = services.config.supportContact ?? null;
  return (
    <View>
      <StateView
        variant="unavailable"
        title="Support requests in the app are not available yet"
        description="You cannot open a support request or see your support history in the app yet. Contact the facility instead; staff can see your registrations and payments and help without your password."
      />
      <Section title="Contact the facility" testID="support-contact">
        {contact ? (
          <ContactDetails contact={contact} />
        ) : (
          <>
            <Body>Ask at the front desk.</Body>
            <StateView
              variant="pending-decision"
              subject="The facility’s support phone, email and hours"
              decisions={['DEC-015']}
              owner="Technical lead/operator"
            />
          </>
        )}
      </Section>
      <Section title="What to have ready">
        <Body>
          The reference shown with any error message in the app, and which registration or balance
          your question is about.
        </Body>
        <ButtonRow>
          <Button
            label="Open enrollments"
            variant="secondary"
            onPress={() => router.push(moneyRoutes.enrollments())}
          />
          <Button
            label="Open payments"
            variant="secondary"
            onPress={() => router.push(moneyRoutes.payments())}
          />
        </ButtonRow>
      </Section>
      <Section title="Changes are made, not noted">
        <Body>
          A conversation with support never replaces the change itself. Cancel or transfer a
          registration from Enrollments, where you see the refund, credit or charge first; refunds
          and permission changes are made by the facility as their own actions.
        </Body>
        <Caption>Case history will appear here when the app can show it.</Caption>
      </Section>
    </View>
  );
}

export function SupportScreen() {
  return (
    <Screen>
      <RequireSession what="support">
        <Support />
      </RequireSession>
    </Screen>
  );
}

/** Route component for app/support.tsx. */
export function SupportRoute() {
  return (
    <>
      <Stack.Screen options={{ title: 'Support' }} />
      <SupportScreen />
    </>
  );
}
