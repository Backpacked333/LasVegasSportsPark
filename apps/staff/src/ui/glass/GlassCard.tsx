/**
 * Headline pieces of a screen as liquid glass bodies (SPK-UX-010): the hero card and the page
 * toolbar. They float above the application backdrop; lists, tables, forms and long text stay on
 * solid cards. Content on the glass is flat and nothing here holds another glass body.
 *
 * `tone="night"` is coloured glass: the dark slab a screen uses for its one most important
 * panel (the field board, the reconciliation summary, the scanner). It keeps the night tokens of
 * `.card-dark` in both themes, so everything written for a dark card reads the same on it.
 */
import { useLayoutEffect, useRef, type AriaAttributes, type AriaRole, type ReactNode } from 'react';
import { Glass } from './Glass';

export interface GlassCardProps extends AriaAttributes {
  tone?: 'plain' | 'night';
  /** Classes of the card body: the screen's own layout and spacing classes go here. */
  className?: string;
  /** Classes of the glass body itself, for placement in the parent layout. */
  hostClassName?: string;
  id?: string;
  as?: 'section' | 'div';
  children: ReactNode;
}

export function GlassCard({
  tone = 'plain',
  className,
  hostClassName,
  as = 'section',
  children,
  ...rest
}: GlassCardProps) {
  const night = tone === 'night';
  return (
    <Glass
      {...rest}
      as={as}
      radius={22}
      bezel={18}
      squircle
      material={night ? 'tint' : 'frost'}
      className={['glass-card', night ? 'glass-night' : null, hostClassName]
        .filter(Boolean)
        .join(' ')}
      contentClassName={['card', night ? 'card-dark' : null, className].filter(Boolean).join(' ')}
    >
      {children}
    </Glass>
  );
}

/**
 * A page toolbar: the filters and view switches of a list, on one glass bar. For a toolbar that
 * stands on the page; a toolbar inside a solid card stays a plain row. `className` replaces the
 * default row layout with the screen's own.
 */
export function Toolbar({
  className,
  fill = false,
  children,
  ...rest
}: AriaAttributes & {
  className?: string;
  role?: AriaRole;
  /** Span the column (a bar with controls at both ends); otherwise the bar hugs its controls. */
  fill?: boolean;
  children: ReactNode;
}) {
  return (
    <Glass
      {...rest}
      radius={18}
      bezel={14}
      squircle
      material="frost"
      className={fill ? 'glass-toolbar glass-toolbar--fill' : 'glass-toolbar'}
      contentClassName={className ?? 'toolbar'}
    >
      {children}
    </Glass>
  );
}

/**
 * The glass track behind the tabs of an area (its segmented navigation). The navigation element,
 * its label and its links are the caller's and unchanged; this is only the surface. On a phone the
 * tabs stay on one row and scroll sideways; the current tab is brought into view when the screen
 * opens (SPK-UX-007).
 */
export function TabTrack({ children }: { children: ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    const current = el?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!el || !current || el.scrollWidth <= el.clientWidth) return;
    const left = current.offsetLeft - el.offsetLeft;
    if (left < el.scrollLeft || left + current.offsetWidth > el.scrollLeft + el.clientWidth) {
      el.scrollLeft = Math.max(0, left - (el.clientWidth - current.offsetWidth) / 2);
    }
  }, []);
  return (
    <Glass radius={16} bezel={12} material="frost" className="glass-track">
      <div ref={scroller} className="glass-track-scroll">
        {children}
      </div>
    </Glass>
  );
}
