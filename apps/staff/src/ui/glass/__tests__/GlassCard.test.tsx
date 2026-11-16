/**
 * Headline pieces on glass (SPK-UX-010, SPK-UX-009): the hero card, the page toolbar, the tab
 * track and the stat tile. Each is one glass body; what it holds stays flat on the content layer
 * and keeps the names and roles it had on a solid surface.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Kpi, KpiRow } from '../../Page';
import { GlassCard, TabTrack, Toolbar } from '../GlassCard';

describe('GlassCard (SPK-UX-010)', () => {
  it('is a labelled region whose card classes ride on the flat content layer', () => {
    render(
      <GlassCard tone="night" className="fin-recon" aria-labelledby="recon-title">
        <h3 id="recon-title">Reconciliation</h3>
        <a href="/finance/reconciliation">Open reconciliation</a>
      </GlassCard>,
    );
    const region = screen.getByRole('region', { name: 'Reconciliation' });
    expect(region.tagName).toBe('SECTION');
    // Coloured glass: the tint material and the night tokens, in both themes.
    expect(region).toHaveClass('glass', 'glass--tint', 'glass-night', 'glass-card');
    const content = region.querySelector(':scope > .glass__content');
    expect(content).toHaveClass('card', 'card-dark', 'fin-recon');
    expect(within(region).getByRole('link', { name: 'Open reconciliation' })).toBeInTheDocument();
  });

  it('plain tone is frosted glass that follows the theme', () => {
    const { container } = render(<GlassCard as="div">Body</GlassCard>);
    const body = container.firstElementChild as HTMLElement;
    expect(body.tagName).toBe('DIV');
    expect(body).toHaveClass('glass--frost');
    expect(body).not.toHaveClass('glass-night');
    expect(body.querySelector('.glass__content')).not.toHaveClass('card-dark');
  });

  it('never nests a glass body inside the optics of another (SPK-UX-009 contrast)', () => {
    const { container } = render(
      <GlassCard tone="night">
        <p>Text</p>
      </GlassCard>,
    );
    expect(container.querySelectorAll('.glass')).toHaveLength(1);
    expect(container.querySelector('.glass__optic')?.children).toHaveLength(0);
  });
});

describe('Toolbar (SPK-UX-010)', () => {
  it('keeps the group role and label of the row it replaces', () => {
    render(
      <Toolbar role="group" aria-label="Task filters">
        <label>
          Status
          <select>
            <option>All</option>
          </select>
        </label>
      </Toolbar>,
    );
    const group = screen.getByRole('group', { name: 'Task filters' });
    expect(group).toHaveClass('glass', 'glass-toolbar');
    expect(group).not.toHaveClass('glass-toolbar--fill');
    expect(group.querySelector(':scope > .glass__content')).toHaveClass('toolbar');
    expect(within(group).getByLabelText('Status')).toBeInTheDocument();
  });

  it("uses the screen's own row layout when one is given, and can span the column", () => {
    const { container } = render(
      <Toolbar fill className="cal-toolbar">
        <button type="button">Today</button>
      </Toolbar>,
    );
    const bar = container.firstElementChild as HTMLElement;
    expect(bar).toHaveClass('glass-toolbar--fill');
    const content = bar.querySelector(':scope > .glass__content');
    expect(content).toHaveClass('cal-toolbar');
    expect(content).not.toHaveClass('toolbar');
  });
});

describe('TabTrack (SPK-UX-005)', () => {
  it('is only a surface: the navigation, its label and its links are unchanged', () => {
    render(
      <nav aria-label="Finance screens">
        <TabTrack>
          <ul>
            <li>
              <a href="/finance" aria-current="page">
                Overview
              </a>
            </li>
            <li>
              <a href="/finance/payments">Payment attempts</a>
            </li>
          </ul>
        </TabTrack>
      </nav>,
    );
    const nav = screen.getByRole('navigation', { name: 'Finance screens' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Overview', 'Payment attempts']);
    expect(within(nav).getByRole('link', { name: 'Overview' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(nav.querySelector('.glass.glass-track')).not.toBeNull();
    // The track adds no role of its own between the navigation and its list.
    expect(within(nav).getByRole('list').closest('.glass-track')).not.toHaveAttribute('role');
    expect(within(nav).getByRole('list').parentElement).not.toHaveAttribute('role');
  });
});

describe('Kpi (SPK-UX-010)', () => {
  it('is a glass tile inside its labelled group, with the figure and label as text', () => {
    render(
      <KpiRow label="Today at a glance">
        <Kpi icon="edit_calendar" label="Activities today" value={4} sub="3 published" />
        <Kpi icon="warning" tone="danger" label="Open issues" value={0} />
      </KpiRow>,
    );
    const group = screen.getByRole('group', { name: 'Today at a glance' });
    const tiles = group.querySelectorAll(':scope > .glass.kpi-glass');
    expect(tiles).toHaveLength(2);
    expect(tiles[0]?.querySelector('.glass__content')).toHaveClass('kpi');
    expect(tiles[0]).toHaveTextContent('Activities today');
    expect(tiles[0]).toHaveTextContent('4');
    expect(tiles[0]).toHaveTextContent('3 published');
  });
});
