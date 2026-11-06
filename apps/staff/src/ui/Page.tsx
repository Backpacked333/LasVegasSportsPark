/**
 * Shared page building blocks of the redesign (SPK-UX-010): the page header (eyebrow, condensed
 * title, intro, actions), KPI tiles and card headers. Purely presentational: screens keep their own
 * headings' text and ids so accessible names do not change.
 */
import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

export function PageHeader({
  eyebrow,
  title,
  titleId,
  intro,
  actions,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  titleId?: string;
  intro?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div className="page-head-text">
        {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
        <h2 id={titleId}>{title}</h2>
        {intro ? <p>{intro}</p> : null}
      </div>
      {actions ? <div className="actions-row">{actions}</div> : null}
    </div>
  );
}

export type KpiTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'pending';

export function Kpi({
  icon,
  tone = 'success',
  label,
  value,
  sub,
}: {
  icon: IconName;
  tone?: KpiTone;
  label: string;
  value: ReactNode;
  sub?: ReactNode;
}) {
  return (
    <div className="kpi">
      <span className="kpi-label">
        <span className={`tone-${tone}`}>
          <Icon name={icon} size={17} />
        </span>
        {label}
      </span>
      <span className="kpi-value-row">
        <span className="kpi-value">{value}</span>
        {sub ? <span className="kpi-sub">{sub}</span> : null}
      </span>
    </div>
  );
}

export function KpiRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="kpis" role="group" aria-label={label}>
      {children}
    </div>
  );
}

/** A card header row: heading on the left, meta or actions on the right. */
export function CardHead({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="card-head">
      <div className="card-head-title">{children}</div>
      {aside ? <div className="actions-row">{aside}</div> : null}
    </div>
  );
}
