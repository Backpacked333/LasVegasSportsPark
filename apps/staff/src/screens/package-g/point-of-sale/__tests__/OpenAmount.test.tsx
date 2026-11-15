/**
 * SCR-S-55 open-amount lines at the register (SPK-PAY-016, proposed amendment PA-08; capability
 * `open_amount_lines`, DEC-102 pending): the "Other amount" entry, the approval step above the
 * ceiling (who must approve, and that the sale cannot finish before), the line on the sale and on
 * the receipt, the session's open-amount lines listed apart, and nothing of it while the switch is
 * off.
 */
import { fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_ID,
  NOW,
  OPEN_LINE_ID,
  OTHER_PERSON,
  SALE_ID,
  SESSION_ID,
  apiError,
  baseRoutes,
  line,
  ok,
  openAmountLine,
  openAmountRules,
  page,
  permissions,
  product,
  receipt,
  sale,
  saleWithLine,
  session,
} from '../../../../features/pos-access-accounting/__tests__/fixtures';
import { createTestApp } from '../../../../testing/test-app';

const SALE_PATH = `/finance/point-of-sale/sales/${SALE_ID}`;
const SESSION_PATH = `/finance/point-of-sale/sessions/${SESSION_ID}`;
const DESK = ['finance.operate_register', 'finance.enter_open_amount_line'];
const APPROVER = ['finance.read_pos', 'finance.approve_open_amount_line'];
const BOTH_ON = ['point_of_sale', 'open_amount_lines'] as const;

function saleRoutes(current: () => unknown, extra: Record<string, FakeHandler> = {}) {
  return {
    ...baseRoutes(),
    'GET /me/permissions': permissions(BOTH_ON, DESK),
    'GET /pos-sales/{id}': () => fakeResponse(200, current()),
    'GET /pos-products': page([product()]),
    'GET /pos-open-amount-rules': ok(openAmountRules()),
    ...extra,
  };
}

/** An open sale whose only line is an open amount above the ceiling, entered by `enteredBy`. */
function waitingSale(enteredByPersonId?: string) {
  return sale({
    subtotalMinor: 12000,
    totalMinor: 12000,
    remainingMinor: 12000,
    revision: 2,
    lines: [openAmountLine(enteredByPersonId ? { enteredByPersonId } : {})],
  });
}

describe('SCR-S-55 open-amount lines (SPK-PAY-016, proposed)', () => {
  it('SPK-PAY-016: "Other amount" sends a description, an amount and a reason category, and says the values are proposed', async () => {
    const user = userEvent.setup();
    let current = sale();
    const app = createTestApp({
      routes: saleRoutes(() => current, {
        'POST /pos-sales/{id}/lines': () => {
          current = sale({
            subtotalMinor: 1500,
            totalMinor: 1500,
            remainingMinor: 1500,
            revision: 2,
            lines: [
              openAmountLine(
                {
                  description: 'Locker key 14',
                  reasonCategory: 'lost_key',
                  approvalRequired: false,
                },
                { name: 'Lost key', unitPriceMinor: 1500, baseMinor: 1500, lineTotalMinor: 1500 },
              ),
            ],
          });
          return fakeResponse(201, current);
        },
      }),
    });
    render(app.at(SALE_PATH));
    const form = await screen.findByRole('form', { name: 'Other amount' });
    await within(form).findByRole('option', { name: 'Lost key' });
    expect(within(form).getByTestId('open-amount-proposed')).toHaveTextContent('DEC-102');
    // Nothing is sent before the three fields are filled.
    await user.click(within(form).getByRole('button', { name: 'Add the amount to the sale' }));
    expect(within(form).getByText('Describe what the amount is for.')).toBeInTheDocument();
    expect(within(form).getByText('Choose a reason category.')).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.route === '/pos-sales/{id}/lines')).toBe(false);
    await user.type(within(form).getByLabelText(/^What it is for/), 'Locker key 14');
    await user.selectOptions(within(form).getByLabelText(/^Reason category/), 'lost_key');
    await user.type(within(form).getByLabelText(/^Amount/), '15.00');
    expect(within(form).queryByTestId('open-amount-above')).toBeNull();
    await user.click(within(form).getByRole('button', { name: 'Add the amount to the sale' }));
    const table = await screen.findByRole('table', { name: 'Sale lines' });
    expect(within(table).getByText(/Locker key 14 · Other amount: Lost key/)).toBeInTheDocument();
    expect(within(table).getByText(/Books to facility_fees/)).toBeInTheDocument();
    const call = app.fake.requests.find((r) => r.route === '/pos-sales/{id}/lines');
    expect(call?.body).toEqual({
      description: 'Locker key 14',
      amountMinor: 1500,
      reasonCategory: 'lost_key',
      expectedRevision: 1,
    });
    expect(call?.headers['idempotency-key']).toMatch(/^key-/);
    // Within the ceiling: no approval step, and the tender is offered.
    expect(screen.queryByTestId('open-amount-approval')).toBeNull();
    expect(await screen.findByRole('form', { name: 'Take a tender' })).toBeInTheDocument();
    // On the ticket the line reads by its description and can only be removed.
    const ticket = screen.getByRole('complementary', { name: /Ticket of sale/ });
    expect(within(ticket).getByText('Locker key 14')).toBeInTheDocument();
    expect(within(ticket).getByRole('button', { name: 'Remove Locker key 14' })).toBeEnabled();
    expect(within(ticket).queryByRole('button', { name: /One more/ })).toBeNull();
  });

  it('SPK-PAY-016: an amount above the ceiling is announced before it is sent, then the sale shows who must approve and offers no tender', async () => {
    const user = userEvent.setup();
    let current = sale();
    const app = createTestApp({
      routes: saleRoutes(() => current, {
        'POST /pos-sales/{id}/lines': () => {
          current = waitingSale();
          return fakeResponse(201, current);
        },
      }),
    });
    render(app.at(SALE_PATH));
    const form = await screen.findByRole('form', { name: 'Other amount' });
    await within(form).findByRole('option', { name: 'Field damage fee' });
    await user.type(within(form).getByLabelText(/^What it is for/), 'Goal net torn on field 3');
    await user.selectOptions(within(form).getByLabelText(/^Reason category/), 'field_damage_fee');
    await user.type(within(form).getByLabelText(/^Amount/), '120.00');
    const warning = await within(form).findByTestId('open-amount-above');
    expect(warning).toHaveTextContent('above your ceiling of $50.00');
    expect(warning).toHaveTextContent(
      'the sale cannot take a tender or finish until a finance operator or a general manager other than you approves the line',
    );
    await user.click(within(form).getByRole('button', { name: 'Add the amount to the sale' }));
    const step = await screen.findByTestId('open-amount-approval');
    expect(step).toHaveAccessibleName('Second approval needed');
    expect(step).toHaveTextContent('The sale cannot take a tender yet');
    expect(step).toHaveTextContent(
      'The sale cannot take a tender or finish before a finance operator or a general manager approves each one.',
    );
    expect(step).toHaveTextContent('The person who entered a line never approves it.');
    expect(step).toHaveTextContent('Goal net torn on field 3 · Field damage fee · $120.00');
    expect(step).toHaveTextContent('Ceiling $50.00');
    // The person who entered it is told so and is offered no approval.
    expect(
      await within(step).findByText(/You entered this line: another person approves it/),
    ).toBeInTheDocument();
    expect(within(step).queryByRole('button', { name: /^Approve/ })).toBeNull();
    // No tender while it waits.
    expect(screen.getByTestId('tender-blocked')).toHaveTextContent('No tender can be taken yet');
    expect(screen.queryByRole('form', { name: 'Take a tender' })).toBeNull();
    expect(
      within(screen.getByRole('table', { name: 'Sale lines' })).getByText(
        /Waiting for a second approval/,
      ),
    ).toBeInTheDocument();
  });

  it('SPK-PAY-016: the ceiling counts every other amount the person entered on the sale: an amount within it is announced as above it once the total is, and a line that no longer waits blocks nothing', async () => {
    const user = userEvent.setup();
    // 30.00 already entered by the signed-in person, within the ceiling of 50.00.
    const first = openAmountLine(
      { description: 'Locker key 14', reasonCategory: 'lost_key', approvalRequired: false },
      { name: 'Lost key', unitPriceMinor: 3000, baseMinor: 3000, lineTotalMinor: 3000 },
    );
    const second = openAmountLine(
      { description: 'Locker key 15', reasonCategory: 'lost_key', enteredTotalMinor: 5500 },
      {
        id: '0192f1a0-0000-7000-8000-00000000a5f2',
        lineNumber: 3,
        name: 'Lost key',
        unitPriceMinor: 2500,
        baseMinor: 2500,
        lineTotalMinor: 2500,
      },
    );
    let current = sale({
      subtotalMinor: 3000,
      totalMinor: 3000,
      remainingMinor: 3000,
      revision: 2,
      lines: [first],
    });
    const app = createTestApp({
      routes: saleRoutes(() => current, {
        'POST /pos-sales/{id}/lines': () => {
          current = sale({
            subtotalMinor: 5500,
            totalMinor: 5500,
            remainingMinor: 5500,
            revision: 3,
            lines: [first, second],
          });
          return fakeResponse(201, current);
        },
      }),
    });
    const view = render(app.at(SALE_PATH));
    const form = await screen.findByRole('form', { name: 'Other amount' });
    await within(form).findByRole('option', { name: 'Lost key' });
    // What the person already has on the sale comes from a second read (who is signed in).
    expect(await within(form).findByText(/you have \$30\.00 on this one/)).toBeInTheDocument();
    await user.type(within(form).getByLabelText(/^What it is for/), 'Locker key 15');
    await user.selectOptions(within(form).getByLabelText(/^Reason category/), 'lost_key');
    // 20.00 more is exactly the ceiling: nothing to announce.
    await user.type(within(form).getByLabelText(/^Amount/), '20.00');
    expect(within(form).queryByTestId('open-amount-above')).toBeNull();
    // 25.00 is within the ceiling alone, and above it with the 30.00 already there.
    await user.clear(within(form).getByLabelText(/^Amount/));
    await user.type(within(form).getByLabelText(/^Amount/), '25.00');
    const warning = await within(form).findByTestId('open-amount-above');
    expect(warning).toHaveTextContent(
      'With this amount, the other amounts you entered on this sale total $55.00, above your ceiling of $50.00.',
    );
    await user.click(within(form).getByRole('button', { name: 'Add the amount to the sale' }));
    const step = await screen.findByTestId('open-amount-approval');
    expect(step).toHaveTextContent(
      'The ceiling counts every other amount one person enters on one sale.',
    );
    // Only the line that took the total above the ceiling waits; it says what the total was.
    const waiting = within(step).getByRole('list', { name: 'Lines waiting for a second approval' });
    expect(within(waiting).getAllByRole('listitem')).toHaveLength(1);
    expect(waiting).toHaveTextContent('Locker key 15 · Lost key · $25.00');
    expect(waiting).toHaveTextContent('whose other amounts on this sale then totalled $55.00');
    expect(screen.getByTestId('tender-blocked')).toBeInTheDocument();
    view.unmount();

    // The first line was removed: the second keeps how it was entered and no longer waits.
    const released = createTestApp({
      routes: saleRoutes(() =>
        sale({
          subtotalMinor: 2500,
          totalMinor: 2500,
          remainingMinor: 2500,
          revision: 4,
          lines: [
            openAmountLine(
              {
                description: 'Locker key 15',
                reasonCategory: 'lost_key',
                enteredTotalMinor: 5500,
                awaitingApproval: false,
              },
              { name: 'Lost key', unitPriceMinor: 2500, baseMinor: 2500, lineTotalMinor: 2500 },
            ),
          ],
        }),
      ),
    });
    render(released.at(SALE_PATH));
    expect(await screen.findByRole('form', { name: 'Take a tender' })).toBeInTheDocument();
    expect(screen.queryByTestId('open-amount-approval')).toBeNull();
    expect(screen.queryByTestId('tender-blocked')).toBeNull();
    expect(
      within(screen.getByRole('table', { name: 'Sale lines' })).queryByText(
        /Waiting for a second approval/,
      ),
    ).toBeNull();
  });

  it('SPK-PAY-016: a second person approves with a reason and the sale’s revision; the sale can then take a tender', async () => {
    const user = userEvent.setup();
    let current = waitingSale(OTHER_PERSON);
    const app = createTestApp({
      routes: saleRoutes(() => current, {
        'GET /me/permissions': permissions(BOTH_ON, [...APPROVER, 'finance.operate_register']),
        'POST /pos-sales/{id}/lines/{lineId}/approval': () => {
          current = sale({
            subtotalMinor: 12000,
            totalMinor: 12000,
            remainingMinor: 12000,
            revision: 3,
            lines: [
              openAmountLine({
                enteredByPersonId: OTHER_PERSON,
                approval: {
                  id: APPROVAL_ID,
                  approvedByPersonId: '0192f1a0-0000-7000-8000-0000000000dd',
                  approvedAt: NOW,
                  reason: 'Damage confirmed on site',
                },
              }),
            ],
          });
          return fakeResponse(200, current);
        },
      }),
    });
    render(app.at(SALE_PATH));
    const step = await screen.findByTestId('open-amount-approval');
    expect(await within(step).findByText('Pat Lee')).toBeInTheDocument();
    await user.click(
      await within(step).findByRole('button', { name: 'Approve: Goal net torn on field 3' }),
    );
    const form = within(step).getByRole('form', { name: 'Approve: Goal net torn on field 3' });
    expect(form).toHaveTextContent('recorded with your name, the time and this reason');
    // A reason is required.
    await user.click(within(form).getByRole('button', { name: 'Approve the line' }));
    expect(within(form).getByText('Enter a reason.')).toBeInTheDocument();
    await user.type(
      within(form).getByLabelText(/^Reason for approving/),
      'Damage confirmed on site',
    );
    await user.click(within(form).getByRole('button', { name: 'Approve the line' }));
    await waitFor(() => expect(screen.queryByTestId('open-amount-approval')).toBeNull());
    const call = app.fake.requests.find(
      (r) => r.route === '/pos-sales/{id}/lines/{lineId}/approval',
    );
    expect(call?.params).toMatchObject({ id: SALE_ID, lineId: OPEN_LINE_ID });
    expect(call?.body).toEqual({ reason: 'Damage confirmed on site', expectedRevision: 2 });
    expect(call?.headers['idempotency-key']).toMatch(/^key-/);
    const table = screen.getByRole('table', { name: 'Sale lines' });
    await waitFor(() => expect(table).toHaveTextContent('Approved by Dana Cole'));
    expect(table).toHaveTextContent('Damage confirmed on site');
    expect(await screen.findByRole('form', { name: 'Take a tender' })).toBeInTheDocument();
    expect(screen.queryByTestId('tender-blocked')).toBeNull();
  });

  it('SPK-PAY-016: a role that does not approve is told which permission is missing, and a refusal by the API is explained', async () => {
    const user = userEvent.setup();
    const deskOnly = createTestApp({ routes: saleRoutes(() => waitingSale(OTHER_PERSON)) });
    const first = render(deskOnly.at(SALE_PATH));
    const step = await screen.findByTestId('open-amount-approval');
    expect(
      await within(step).findByText(
        /Approving needs the permission finance.approve_open_amount_line/,
      ),
    ).toBeInTheDocument();
    expect(within(step).queryByRole('button', { name: /^Approve/ })).toBeNull();
    first.unmount();

    // The API has the last word: the same person entered the line under another session.
    const app = createTestApp({
      routes: saleRoutes(() => waitingSale(OTHER_PERSON), {
        'GET /me/permissions': permissions(BOTH_ON, APPROVER),
        'POST /pos-sales/{id}/lines/{lineId}/approval': apiError(403, 'ACCESS_DENIED', {
          message: 'The person who entered an open-amount line cannot approve it.',
          details: { code: 'SECOND_PERSON_REQUIRED', saleLineId: OPEN_LINE_ID },
        }),
      }),
    });
    render(app.at(SALE_PATH));
    const again = await screen.findByTestId('open-amount-approval');
    await user.click(
      await within(again).findByRole('button', { name: 'Approve: Goal net torn on field 3' }),
    );
    const form = within(again).getByRole('form', { name: 'Approve: Goal net torn on field 3' });
    await user.type(within(form).getByLabelText(/^Reason for approving/), 'Seen');
    await user.click(within(form).getByRole('button', { name: 'Approve the line' }));
    const refusal = await within(again).findByTestId('state-validation');
    expect(refusal).toHaveTextContent('Another person approves this line');
    expect(refusal).toHaveTextContent('Error code: ACCESS_DENIED (SECOND_PERSON_REQUIRED)');
    // The form keeps the reason.
    expect(within(form).getByLabelText(/^Reason for approving/)).toHaveValue('Seen');
  });

  it('SPK-PAY-016: removing the line from the ticket sends quantity 0 for it', async () => {
    const user = userEvent.setup();
    let current = waitingSale();
    const app = createTestApp({
      routes: saleRoutes(() => current, {
        'POST /pos-sales/{id}/lines/{lineId}/quantity': () => {
          current = sale({ revision: 3 });
          return fakeResponse(200, current);
        },
      }),
    });
    render(app.at(SALE_PATH));
    const ticket = await screen.findByRole('complementary', { name: /Ticket of sale/ });
    await user.click(
      await within(ticket).findByRole('button', { name: 'Remove Goal net torn on field 3' }),
    );
    await waitFor(() =>
      expect(
        app.fake.requests.find((r) => r.route === '/pos-sales/{id}/lines/{lineId}/quantity')?.body,
      ).toEqual({ quantity: 0, expectedRevision: 2 }),
    );
    await waitFor(() => expect(screen.queryByTestId('open-amount-approval')).toBeNull());
  });

  it('SPK-PAY-016, DEC-016: with open_amount_lines off nothing new is shown and product lines are as before', async () => {
    const app = createTestApp({
      routes: saleRoutes(() => saleWithLine(), {
        'GET /me/permissions': permissions(['point_of_sale'], DESK),
      }),
    });
    render(app.at(SALE_PATH));
    expect(await screen.findByRole('form', { name: 'Add a line' })).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: 'Sale lines' });
    expect(within(table).getByText('Water bottle (WATER) · Concession')).toBeInTheDocument();
    expect(await screen.findByRole('form', { name: 'Take a tender' })).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Other amount' })).toBeNull();
    expect(screen.queryByTestId('open-amount-approval')).toBeNull();
    expect(screen.queryByTestId('tender-blocked')).toBeNull();
    expect(app.fake.requests.some((r) => r.route === '/pos-open-amount-rules')).toBe(false);
  });

  it('SPK-PAY-016: a role that may not enter open amounts is not offered the entry while the switch is on', async () => {
    const app = createTestApp({
      routes: saleRoutes(() => saleWithLine(), {
        'GET /me/permissions': permissions(BOTH_ON, ['finance.operate_register']),
      }),
    });
    render(app.at(SALE_PATH));
    expect(await screen.findByRole('form', { name: 'Add a line' })).toBeInTheDocument();
    expect(await screen.findByRole('form', { name: 'Take a tender' })).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Other amount' })).toBeNull();
  });

  it('SPK-PAY-016, DEC-016: a line entered before the switch was turned off is still shown; it cannot be approved, can be removed, and blocks the tender', async () => {
    const app = createTestApp({
      routes: saleRoutes(() => waitingSale(OTHER_PERSON), {
        'GET /me/permissions': permissions(['point_of_sale'], [...DESK, ...APPROVER]),
      }),
    });
    render(app.at(SALE_PATH));
    const step = await screen.findByTestId('open-amount-approval');
    expect(step).toHaveTextContent(
      'Open-amount lines are turned off: this line cannot be approved now. Remove it from the ticket to finish the sale.',
    );
    expect(within(step).queryByRole('button', { name: /^Approve/ })).toBeNull();
    const ticket = screen.getByRole('complementary', { name: /Ticket of sale/ });
    expect(
      await within(ticket).findByRole('button', { name: 'Remove Goal net torn on field 3' }),
    ).toBeEnabled();
    expect(screen.getByTestId('tender-blocked')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Other amount' })).toBeNull();
  });

  it('SPK-PAY-016: the receipt shows an open-amount line by its description with its category', async () => {
    const app = createTestApp({
      routes: {
        ...baseRoutes(),
        'GET /me/permissions': permissions(BOTH_ON, DESK),
        'GET /pos-sales/{id}/receipt': ok(
          receipt({
            lines: [
              ...receipt().lines,
              {
                name: 'Field damage fee',
                kind: 'open_amount',
                description: 'Goal net torn on field 3',
                quantity: 1,
                unitPriceMinor: 12000,
                baseMinor: 12000,
                charges: [],
                lineTotalMinor: 12000,
              },
            ],
            subtotalMinor: 12500,
            totalMinor: 12542,
          }),
        ),
      },
    });
    render(app.at(`${SALE_PATH}/receipt`));
    const table = await screen.findByRole('table', { name: 'Receipt lines' });
    const rows = within(table).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('Water bottle');
    expect(rows[2]).toHaveTextContent('Goal net torn on field 3 Field damage fee');
    expect(rows[2]).toHaveTextContent('$120.00');
  });

  it('SPK-PAY-016: the register session lists its open-amount lines apart, with description, category, who entered and who approved', async () => {
    const item = (over: Record<string, unknown>) => ({
      saleId: SALE_ID,
      saleNumber: 'FD1-20261024-0001',
      saleStatus: 'paid',
      lineId: OPEN_LINE_ID,
      description: 'Goal net torn on field 3',
      reasonCategory: 'field_damage_fee',
      reasonLabel: 'Field damage fee',
      revenueCategory: 'facility_fees',
      currency: 'USD',
      amountMinor: 12000,
      chargesMinor: 0,
      lineTotalMinor: 12000,
      enteredByPersonId: OTHER_PERSON,
      enteredAt: NOW,
      ceilingMinor: 5000,
      enteredTotalMinor: 12000,
      approvalRequired: true,
      awaitingApproval: false,
      approval: {
        id: APPROVAL_ID,
        approvedByPersonId: '0192f1a0-0000-7000-8000-0000000000dd',
        approvedAt: NOW,
        reason: 'Damage confirmed on site',
      },
      returnedQuantity: 0,
      ...over,
    });
    const app = createTestApp({
      routes: {
        ...baseRoutes(),
        'GET /me/permissions': permissions(BOTH_ON, DESK),
        'GET /pos-register-sessions/{id}': ok(session()),
        'GET /pos-register-sessions/{id}/sales': page([saleWithLine({ lines: [line()] })]),
        'GET /pos-registers/{id}/sessions': page([session()]),
        'GET /pos-register-sessions/{id}/open-amount-lines': page([
          item({}),
          item({
            lineId: '0192f1a0-0000-7000-8000-00000000a503',
            description: 'Locker key 14',
            reasonLabel: 'Lost key',
            amountMinor: 1500,
            lineTotalMinor: 1500,
            enteredTotalMinor: 1500,
            approvalRequired: false,
            approval: null,
            returnedQuantity: 1,
          }),
          // Needed an approval when it was entered; lines were then removed until the person's
          // amounts on the sale were within the ceiling, so none was given.
          item({
            lineId: '0192f1a0-0000-7000-8000-00000000a504',
            description: 'Locker key 15',
            reasonLabel: 'Lost key',
            amountMinor: 2500,
            lineTotalMinor: 2500,
            enteredTotalMinor: 5500,
            approvalRequired: true,
            awaitingApproval: false,
            approval: null,
          }),
          item({
            lineId: '0192f1a0-0000-7000-8000-00000000a505',
            description: 'Locker key 16',
            reasonLabel: 'Lost key',
            amountMinor: 2600,
            lineTotalMinor: 2600,
            enteredTotalMinor: 5600,
            approvalRequired: true,
            awaitingApproval: true,
            approval: null,
          }),
        ]),
      },
    });
    render(app.at(SESSION_PATH));
    expect(
      await screen.findByRole('heading', { name: 'Other amounts in this session' }),
    ).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: 'Other amounts in this session' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(5);
    expect(rows[3]).toHaveTextContent(
      "Not given: lines were removed until this person's amounts on the sale were within the ceiling of $50.00",
    );
    expect(rows[4]).toHaveTextContent('waiting for a second approval');
    expect(rows[1]).toHaveTextContent('Sale FD1-20261024-0001');
    expect(rows[1]).toHaveTextContent('Goal net torn on field 3');
    expect(rows[1]).toHaveTextContent('Field damage fee Books to facility_fees.');
    expect(rows[1]).toHaveTextContent('$120.00');
    await waitFor(() => expect(rows[1]).toHaveTextContent('Pat Lee'));
    await waitFor(() => expect(rows[1]).toHaveTextContent('Dana Cole'));
    expect(rows[1]).toHaveTextContent('Damage confirmed on site');
    expect(rows[2]).toHaveTextContent('Locker key 14 Returned.');
    expect(rows[2]).toHaveTextContent('Not needed: within the ceiling of $50.00');
    // The sales list is still its own list beside it.
    expect(screen.getByRole('list', { name: 'Sales in this session' })).toBeInTheDocument();
  });

  it('SPK-PAY-016, DEC-016: with the switch off the session page lists no other amounts and does not ask for them', async () => {
    const app = createTestApp({
      routes: {
        ...baseRoutes(),
        'GET /me/permissions': permissions(['point_of_sale'], DESK),
        'GET /pos-register-sessions/{id}': ok(session()),
        'GET /pos-register-sessions/{id}/sales': page([saleWithLine()]),
        'GET /pos-registers/{id}/sessions': page([session()]),
      },
    });
    render(app.at(SESSION_PATH));
    expect(await screen.findByRole('list', { name: 'Sales in this session' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Other amounts in this session' })).toBeNull();
    expect(
      app.fake.requests.some((r) => r.route === '/pos-register-sessions/{id}/open-amount-lines'),
    ).toBe(false);
  });
});
