/**
 * ReasonList (ADR-008, moved from the teams kit): eligibility and readiness reasons with who
 * resolves them (SPK-READY-003, SPK-CAP-004), each with a status in words and a glyph (SPK-UX-009),
 * a league-approval rule shown as pending, never as a denial (SCR-C-26). The teams kit re-exports
 * the same component.
 */
import { screen, within } from '@testing-library/react-native';
import * as teamsKit from '../../features/teams/ui';
import { renderUi } from '../../testing/ui-actions';
import { ReasonList, reasonStatus } from '../ReasonList';

const REASONS = [
  {
    code: 'age_band',
    severity: 'blocking' as const,
    message: 'Sam is older than the age band.',
    responsibleRole: 'captain',
    requiredAction: 'Choose another division.',
  },
  {
    code: 'approval_required',
    severity: 'blocking' as const,
    message: 'This needs league approval.',
    responsibleRole: 'league_manager',
    requiredAction: 'Wait for the decision.',
  },
  {
    code: 'kit',
    severity: 'unknown' as const,
    message: 'Kit colours not yet known.',
    responsibleRole: 'kit_officer',
    requiredAction: '',
  },
];

describe('ReasonList (ADR-008)', () => {
  it('SPK-READY-003: each reason shows its status, message and who resolves it, as a list', async () => {
    await renderUi(<ReasonList reasons={REASONS} testID="reasons" />);
    const list = screen.getByTestId('reasons');
    expect(list).toHaveProp('accessibilityRole', 'list');
    expect(within(list).getByLabelText('Blocking')).toBeOnTheScreen();
    expect(within(list).getByText('Sam is older than the age band.')).toBeOnTheScreen();
    expect(within(list).getByText('Team captain: Choose another division.')).toBeOnTheScreen();
    // An unknown role id reads in words, its underscores as spaces.
    expect(within(list).getByText('kit officer:')).toBeOnTheScreen();
    expect(within(list).getByLabelText('Not known yet')).toBeOnTheScreen();
  });

  it('SCR-C-26: a rule that needs league approval is pending, never a denial', async () => {
    expect(reasonStatus(REASONS[1]!)).toEqual({
      tone: 'pending',
      label: 'League approval required',
    });
    await renderUi(<ReasonList reasons={[REASONS[1]!]} />);
    expect(screen.getByLabelText('League approval required')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Blocking')).toBeNull();
  });

  it('the teams kit re-exports it', () => {
    expect(teamsKit.ReasonList).toBe(ReasonList);
  });
});
