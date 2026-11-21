/**
 * Skeleton (redesign handoff "Loading": skeletons in the final layout, never a blank screen or a
 * full-screen spinner). Decorative blocks; the region that is loading says so once with
 * `SkeletonGroup` (`role="status"`, "Loading …") so screen readers hear it a single time.
 * Reduced motion: no shimmer.
 */
import type { CSSProperties, ReactNode } from 'react';
import './primitives.css';

export function Skeleton({
  width = '100%',
  height = 12,
  radius = 6,
  className,
}: {
  width?: number | string;
  height?: number | string;
  radius?: number;
  className?: string;
}) {
  const style: CSSProperties = { width, height, borderRadius: radius };
  return (
    <span
      className={['ui-skeleton', className].filter(Boolean).join(' ')}
      style={style}
      aria-hidden="true"
    />
  );
}

/** A loading region: the label is read once, the blocks inside are decorative. */
export function SkeletonGroup({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={className} role="status" aria-busy="true" aria-label={`Loading ${label}`}>
      {children}
    </div>
  );
}

/** A few lines of text, the last one shorter. */
export function SkeletonLines({ lines = 3 }: { lines?: number }) {
  return (
    <span className="ui-skeleton-lines" aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} width={i === lines - 1 ? '60%' : '100%'} />
      ))}
    </span>
  );
}
