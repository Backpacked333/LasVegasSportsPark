/**
 * Routes of "Programs and camps" (SCR-S-14, SCR-S-15), "Registrations and waitlists" (SCR-S-24 to
 * SCR-S-27) and "Finance" (SCR-S-35 to SCR-S-38) (SPK-UX-005), registered once in App.tsx. Route
 * parameters are opaque record ids only, never names or personal data (§4.14).
 */
import type { ReactElement } from 'react';
import { Route } from 'react-router';
import { CheckoutRecoveryScreen } from '../../screens/finance/CheckoutRecoveryScreen';
import { CreditsScreen } from '../../screens/finance/CreditsScreen';
import { FinanceScreen } from '../../screens/finance/FinanceScreen';
import { ObligationScreen } from '../../screens/finance/ObligationScreen';
import { ObligationsScreen } from '../../screens/finance/ObligationsScreen';
import { OrderScreen } from '../../screens/finance/OrderScreen';
import { PaymentAttemptScreen } from '../../screens/finance/PaymentAttemptScreen';
import { PaymentExceptionsScreen } from '../../screens/finance/PaymentExceptionsScreen';
import { ReconciliationScreen } from '../../screens/finance/ReconciliationScreen';
import { RefundScreen } from '../../screens/finance/RefundScreen';
import { RefundsScreen } from '../../screens/finance/RefundsScreen';
import { OfferingPublicationScreen } from '../../screens/programs/OfferingPublicationScreen';
import { OfferingSetupScreen } from '../../screens/programs/OfferingSetupScreen';
import { ProgramScreen } from '../../screens/programs/ProgramScreen';
import { ProgramsScreen } from '../../screens/programs/ProgramsScreen';
import { AssistedRegistrationScreen } from '../../screens/registrations/AssistedRegistrationScreen';
import { EnrollmentChangeScreen } from '../../screens/registrations/EnrollmentChangeScreen';
import { EnrollmentsScreen } from '../../screens/registrations/EnrollmentsScreen';
import { RegistrationQueueScreen } from '../../screens/registrations/RegistrationQueueScreen';
import { RegistrationsScreen } from '../../screens/registrations/RegistrationsScreen';
import { WaitlistScreen } from '../../screens/registrations/WaitlistScreen';
import './registration-finance.css';

const ROUTES: readonly [path: string, element: ReactElement][] = [
  ['/programs', <ProgramsScreen />],
  ['/programs/:programId', <ProgramScreen />],
  ['/programs/offerings/:offeringId', <OfferingSetupScreen />],
  ['/programs/offerings/:offeringId/publication', <OfferingPublicationScreen />],
  ['/registrations', <RegistrationsScreen />],
  ['/registrations/queue', <RegistrationQueueScreen />],
  ['/registrations/assisted', <AssistedRegistrationScreen />],
  ['/registrations/assisted/:basketId', <AssistedRegistrationScreen />],
  ['/registrations/waitlists', <WaitlistScreen />],
  ['/registrations/waitlists/:offeringId', <WaitlistScreen />],
  ['/registrations/enrollments', <EnrollmentsScreen />],
  ['/registrations/enrollments/:enrollmentId', <EnrollmentChangeScreen />],
  ['/finance', <FinanceScreen />],
  ['/finance/obligations', <ObligationsScreen />],
  ['/finance/obligations/:obligationId', <ObligationScreen />],
  ['/finance/orders/:orderId', <OrderScreen />],
  ['/finance/payments', <PaymentExceptionsScreen />],
  ['/finance/payments/:paymentId', <PaymentAttemptScreen />],
  ['/finance/payments/:paymentId/refunds', <RefundsScreen />],
  ['/finance/checkouts/:checkoutId', <CheckoutRecoveryScreen />],
  ['/finance/refunds/:refundId', <RefundScreen />],
  ['/finance/credits', <CreditsScreen />],
  ['/finance/credits/:creditId', <CreditsScreen />],
  ['/finance/reconciliation', <ReconciliationScreen />],
];

/** Route elements for `<Routes>` (React Router reads Route children through fragments). */
export function registrationFinanceRoutes() {
  return (
    <>
      {ROUTES.map(([path, element]) => (
        <Route key={path} path={path} element={element} />
      ))}
    </>
  );
}
