/**
 * SupportDetails (PA-11, SPK-UX-011 **Proposed**; §4.10): decision identifiers, owners, error codes
 * and references live only in a collapsed "Details for support" fold, as plain label/value lines.
 */
import { screen } from '@testing-library/react-native';
import { openSupportDetails, renderSurface } from '../../testing/ui-surfaces';
import { MotionProvider } from '../motion';
import { SupportDetails, supportLines } from '../SupportDetails';
import { classicTheme, legendsTheme } from '../theme';

describe('SupportDetails (PA-11)', () => {
  it('SPK-UX-011: is closed until the customer opens it, so codes are never the first thing read', async () => {
    await renderSurface(
      <SupportDetails
        decisions={['DEC-019']}
        owner="Technical lead/account owners"
        errorCode="STALE_REVISION"
        reference="corr-123"
      />,
    );
    const fold = screen.getByRole('button', { name: 'Details for support' });
    expect(fold).toBeCollapsed();
    expect(screen.queryByText(/DEC-019|STALE_REVISION|corr-123/)).toBeNull();

    await openSupportDetails(screen);
    expect(screen.getByRole('button', { name: 'Details for support' })).toBeExpanded();
    expect(screen.getByText('Decision: DEC-019')).toBeOnTheScreen();
    expect(screen.getByText('Owner: Technical lead/account owners')).toBeOnTheScreen();
    expect(screen.getByText('Error code: STALE_REVISION')).toBeOnTheScreen();
    expect(screen.getByText('Reference: corr-123')).toBeOnTheScreen();
  });

  it('§4.10: the lines are selectable, so support can be given the exact code', async () => {
    await renderSurface(<SupportDetails errorCode="INTERNAL_ERROR" reference="corr-9" />);
    await openSupportDetails(screen);
    expect(screen.getByText('Error code: INTERNAL_ERROR')).toHaveProp('selectable', true);
  });

  it('orders the lines and names several decisions in the plural', () => {
    expect(
      supportLines({
        reference: 'c-1',
        decisions: ['DEC-016', 'DEC-072'],
        lines: [{ label: 'Policy', value: 'POL-046' }],
        owner: 'Product owner',
      }),
    ).toEqual([
      { label: 'Decisions', value: 'DEC-016, DEC-072' },
      { label: 'Owner', value: 'Product owner' },
      { label: 'Reference', value: 'c-1' },
      { label: 'Policy', value: 'POL-046' },
    ]);
  });

  it('draws nothing when there is nothing for support', async () => {
    await renderSurface(<SupportDetails decisions={[]} reference={null} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('SPK-UX-009: its button is at least 44 pt tall', async () => {
    await renderSurface(<SupportDetails errorCode="TIMEOUT" />);
    expect(screen.getByRole('button', { name: 'Details for support' })).toHaveStyle({
      minHeight: 44,
    });
  });

  it.each([
    ['classic', classicTheme],
    ['legends', legendsTheme],
  ] as const)('reads quietly in the muted text of the %s theme', async (name, theme) => {
    await renderSurface(<SupportDetails errorCode="TIMEOUT" />, { theme: name });
    expect(screen.getByText('Details for support')).toHaveStyle({ color: theme.colors.textMuted });
    await openSupportDetails(screen);
    expect(screen.getByText('Error code: TIMEOUT')).toHaveStyle({ color: theme.colors.textMuted });
  });

  it('SPK-UX-009 reduced motion: opens the same way with motion allowed', async () => {
    await renderSurface(
      <MotionProvider reduced={false}>
        <SupportDetails errorCode="TIMEOUT" />
      </MotionProvider>,
    );
    await openSupportDetails(screen);
    expect(screen.getByText('Error code: TIMEOUT')).toBeOnTheScreen();
  });
});
