/**
 * Booking flow placeholder (Package G; SPK-COND-003, DEC-016, DEC-076, DEC-077): blocked while
 * both switches are off, and a malformed offering id is "Link not available" with no request
 * (SCR-C-39). Replace with the screen's own tests when the flow is built.
 */
import { render, screen } from '@testing-library/react-native';
import { describeCustomerPackageGPlaceholder } from '../../../features/package-g/testing';
import { createTestApp } from '../../../testing/test-app';
import { BookingFlowScreen } from '../BookingFlowScreen';

const OFFERING = '0192f1a0-0000-7000-8000-00000000e001';

function OfferingBooking() {
  return <BookingFlowScreen offeringId={OFFERING} />;
}

describeCustomerPackageGPlaceholder({
  Screen: OfferingBooking,
  testID: 'screen-booking-flow',
  title: 'Book a rental or party',
  reference: 'Package G booking flow, SPK-COND-003',
  capability: 'parties',
  decisions: 'DEC-016, DEC-076, DEC-077',
  pending: 'POL-040, DEC-029, DEC-030, DEC-019',
});

describe('booking flow route (SCR-C-39)', () => {
  it('a malformed offering id is "Link not available", without a request', () => {
    const app = createTestApp();
    render(<BookingFlowScreen offeringId={null} />, { wrapper: app.wrapper });
    expect(screen.getByLabelText('Link not available')).toBeOnTheScreen();
    expect(app.fake.requests).toHaveLength(0);
  });
});
