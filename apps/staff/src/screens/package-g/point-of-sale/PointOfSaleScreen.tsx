/**
 * SCR-S-55 Point of sale (Package G, conditional; §3.16 POS row, SPK-PAY-002, SPK-PAY-012), in
 * the Finance area with the Finance section navigation. Route: `/finance/point-of-sale/*`.
 *
 * Behind `CapabilityGate` for the `point_of_sale` switch (DEC-016, DEC-079; off until a system
 * administrator turns it on). With the switch off the API keeps existing records readable and
 * never gates voids, returns, closing a register session or retiring a product or register, so the
 * gate shows its notice above the pages and only the commands that start a new commitment
 * (products, registers, opening a session, a sale and its lines) are not offered; a tender that
 * settles a sale already open stays offered, as the API never gates it (CAPABILITIES-01).
 *
 * Pages (nested routes, record ids only, §4.14):
 * - index: registers by facility, opening and closing their sessions (RegistersPage);
 * - `products`: products with prices and approved taxes and fees (ProductsPage);
 * - `sessions/:sessionId`: one register session, starting sales, closing with a counted amount;
 * - `sales/:saleId`: one sale with lines, tenders, returns and void (SalePage);
 * - `sales/:saleId/receipt`: the receipt of a paid sale (ReceiptPage).
 *
 * Registrations, memberships, packages and bookings are never sold here (SPK-PAY-012): products
 * are merchandise, concessions or services, priced by the API (SPK-PAY-001).
 */
import { Route, Routes } from 'react-router';
import { FINANCE_LINKS, SectionNav } from '../../../features/registration-finance/SectionNav';
import { CapabilityGate } from '../../../ui/CapabilityGate';
import { StateView } from '../../../ui/StateView';
import { POINT_OF_SALE } from './meta';
import { POS_PATHS } from './paths';
import { ProductsPage } from './ProductsPage';
import { ReceiptPage } from './ReceiptPage';
import { RegistersPage } from './RegistersPage';
import { SalePage } from './SalePage';
import { SessionPage } from './SessionPage';

const POS_LINKS = [
  { to: POS_PATHS.base, label: 'Registers and sales', end: true },
  { to: POS_PATHS.products, label: 'Products' },
] as const;

export function PointOfSaleScreen() {
  const headingId = `package-g-${POINT_OF_SALE.slug}`;
  return (
    <section aria-labelledby={headingId} data-testid={headingId}>
      <h2 id={headingId}>{POINT_OF_SALE.title}</h2>
      <SectionNav label="Finance" links={FINANCE_LINKS} />
      <CapabilityGate
        capability={POINT_OF_SALE.capability}
        subject={POINT_OF_SALE.title}
        whenOff="notice"
        stillAvailable="Existing products, registers, sessions and sales stay readable. Voids, returns, closing a register session and retiring a product or register stay available; nothing new can be sold."
      >
        <SectionNav label="Point of sale" links={POS_LINKS} />
        <Routes>
          <Route index element={<RegistersPage />} />
          <Route path="products" element={<ProductsPage />} />
          <Route path="sessions/:sessionId" element={<SessionPage />} />
          <Route path="sales/:saleId" element={<SalePage />} />
          <Route path="sales/:saleId/receipt" element={<ReceiptPage />} />
          <Route path="*" element={<StateView variant="unavailable" />} />
        </Routes>
        {POINT_OF_SALE.pending ? (
          <StateView
            variant="pending-decision"
            subject={POINT_OF_SALE.pending.subject}
            decisions={[...POINT_OF_SALE.pending.decisions]}
            owner={POINT_OF_SALE.pending.owner}
          />
        ) : null}
      </CapabilityGate>
    </section>
  );
}
