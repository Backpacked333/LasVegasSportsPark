/**
 * Glass bodies (SPK-UX-010, SPK-UX-009): content stays outside the optics, and where the bend
 * cannot render (here: jsdom, as in every engine but Chromium) no filter is mounted, so the
 * stylesheet's frost fallback applies.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Glass } from '../Glass';
import { glassFilterSvg, maxDisplacement, supportsSvgBackdrop } from '../liquidGlass';

describe('Glass (SPK-UX-010)', () => {
  it('renders its content above the optic, glow and rim layers, never inside them', () => {
    const { container } = render(
      <Glass radius={24} material="frost" className="panel-x">
        <button type="button">Open</button>
      </Glass>,
    );
    const body = container.firstElementChild as HTMLElement;
    expect(body).toHaveClass('glass', 'glass--frost', 'panel-x');
    expect(body.style.getPropertyValue('--radius')).toBe('24px');
    const layers = [...body.children].map((el) => el.className);
    expect(layers).toEqual(['glass__optic', 'glass__glow', 'glass__rim', 'glass__content']);
    const button = screen.getByRole('button', { name: 'Open' });
    expect(button.closest('.glass__content')).not.toBeNull();
    expect(button.closest('.glass__optic')).toBeNull();
  });

  it('without the bend (not Chromium) mounts no filter: the frost fallback applies', () => {
    expect(supportsSvgBackdrop()).toBe(false);
    const { container } = render(<Glass radius={20}>Label</Glass>);
    expect(container.querySelector('filter')).toBeNull();
    const optic = container.querySelector<HTMLElement>('.glass__optic');
    expect(optic?.style.getPropertyValue('--glass-filter')).toBe('');
  });

  it('keeps the displacement under the fold limit of the profile', () => {
    expect(maxDisplacement(20, 'bevel')).toBe(10);
    expect(maxDisplacement(30, 'convex')).toBe(20);
    expect(maxDisplacement(20, 'flat')).toBe(0);
  });

  it('returns no filter when no canvas is available', () => {
    // A browser that refuses a 2D context: the caller falls back to the frost.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    expect(
      glassFilterSvg('x', {
        w: 40,
        h: 40,
        radius: 20,
        bezel: 20,
        profile: 'bevel',
        displacement: 8,
        blur: 1,
      }),
    ).toBeNull();
  });
});
