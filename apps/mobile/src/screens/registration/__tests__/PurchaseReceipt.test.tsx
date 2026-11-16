/**
 * Proposed amendments PA-03 (SPK-PAY-014: add-ons) and PA-07 (SPK-REG-012: uniform) after
 * payment: the checkout outcome (SCR-C-15) names what was bought with each place, and the order
 * receipt (SCR-C-34) lists each add-on and the uniform as its own line. Add-ons, sizes and prices
 * are test data, not policy.
 */
import { fakeResponse, type FakeRequest } from '@sportspark/api-client/testing';
import { render, screen } from '@testing-library/react-native';
import {
  accountRoutes,
  IDS as MONEY,
  obligation,
  order,
} from '../../../features/money/testing/fixtures';
import { createMoneyTestApp, settleApps } from '../../../features/money/testing/money-test-app';
import {
  IDS,
  basket,
  checkout,
  enrollment,
  familyRoutes,
  line,
  offering,
  operation,
} from '../../../features/registration/testing/fixtures';
import { createRegistrationTestApp } from '../../../features/registration/testing/registration-test-app';
import { OrderScreen } from '../../payments/OrderScreen';
import { CheckoutOutcomeScreen } from '../CheckoutOutcomeScreen';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn() };
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => mockRouter,
}));

const LUNCH = '0192f1a0-0000-7000-8000-000000004101';
const KIT = '0192f1a0-0000-7000-8000-000000004201';
const MON = '0192f1a0-0000-7000-8000-000000004401';
const WED = '0192f1a0-0000-7000-8000-000000004403';

describe('Add-ons and uniform after payment (SPK-PAY-014, SPK-REG-012)', () => {
  afterEach(settleApps);

  it('SPK-PAY-014, SPK-REG-012: the checkout outcome names the add-ons and the uniform bought with each place', async () => {
    const bought = basket({
      status: 'fulfilled',
      lines: [
        line({
          outcome: 'confirmed',
          enrollmentId: IDS.enrollmentA,
          addons: [
            {
              addonId: LUNCH,
              code: 'lunch',
              name: 'Lunch',
              selection: 'per_session',
              sessionIds: [MON, WED],
              priceMinor: 900,
              currency: 'USD',
              quantity: 2,
            },
          ],
          uniform: {
            offeringUniformId: KIT,
            itemKey: 'club-kit-2026',
            name: 'Club kit',
            size: 'YM',
            priceMinor: 2500,
            currency: 'USD',
            returningHolderFree: false,
            heldUniformOrderId: null,
          },
        }),
        line({
          id: IDS.lineB,
          participantPersonId: IDS.childB,
          outcome: 'confirmed',
          enrollmentId: IDS.enrollmentB,
        }),
      ],
    });
    const app = createRegistrationTestApp({
      routes: {
        ...familyRoutes(),
        'GET /registration-checkouts/{id}': { status: 200, body: checkout() },
        'GET /operations/{id}': { status: 200, body: operation('succeeded') },
        'GET /baskets/{id}': { status: 200, body: bought },
        'GET /offerings/{id}': { status: 200, body: offering() },
        'GET /enrollments/{id}': (req: FakeRequest) =>
          fakeResponse(
            200,
            req.params.id === IDS.enrollmentA
              ? enrollment(IDS.enrollmentA, IDS.childA)
              : enrollment(IDS.enrollmentB, IDS.childB),
          ),
      },
    });
    render(<CheckoutOutcomeScreen checkoutId={IDS.checkout} />, { wrapper: app.wrapper });
    expect(await screen.findByLabelText('Registration complete')).toBeOnTheScreen();
    // The place with extras names them, read as one element with its status.
    expect(
      await screen.findByLabelText(/^Ada: Autumn Youth Program\. .*\. Lunch\. Club kit, size YM$/),
    ).toBeOnTheScreen();
    expect(screen.getByText('Lunch × 2 days')).toBeOnTheScreen();
    expect(screen.getByText('Club kit, size YM')).toBeOnTheScreen();
    // A place bought without extras reads as it always did.
    expect(
      await screen.findByLabelText(/^Ben: Autumn Youth Program\. [^.]*\.?$/),
    ).toBeOnTheScreen();
  });

  it('SPK-PAY-014, SPK-REG-012: the order receipt lists each add-on and the uniform as its own line with its amount', async () => {
    const [place] = order().lines as Array<Record<string, unknown>>;
    const receipt = order({
      totalMinor: 16300,
      lines: [
        { ...place, lineKind: 'registration', sourceId: null },
        {
          ...place,
          id: '0192f1a0-0000-7000-8000-000000004501',
          sequence: 2,
          description: 'Lunch',
          quantity: 2,
          unitPriceMinor: 900,
          baseAmountMinor: 1800,
          totalMinor: 1800,
          lineKind: 'addon',
          sourceId: LUNCH,
        },
        {
          ...place,
          id: '0192f1a0-0000-7000-8000-000000004502',
          sequence: 3,
          description: 'Club kit (YM)',
          unitPriceMinor: 2500,
          baseAmountMinor: 2500,
          totalMinor: 2500,
          lineKind: 'uniform',
          sourceId: KIT,
        },
      ],
    });
    const app = createMoneyTestApp({
      routes: {
        ...accountRoutes(),
        'GET /orders/{id}': { status: 200, body: receipt },
        'GET /obligations/{id}': { status: 200, body: obligation() },
      },
    });
    render(<OrderScreen orderId={MONEY.order} />, { wrapper: app.wrapper });
    expect(await screen.findByLabelText('Autumn U10 League, Sam. $120.00')).toBeOnTheScreen();
    expect(screen.getByLabelText('Add-on: Lunch × 2, Sam. $18.00')).toBeOnTheScreen();
    expect(screen.getByLabelText('Uniform: Club kit (YM), Sam. $25.00')).toBeOnTheScreen();
    expect(screen.getByLabelText('Order total: $163.00')).toBeOnTheScreen();
  });
});
