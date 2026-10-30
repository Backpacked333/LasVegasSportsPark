/**
 * SCR-S-01, SCR-S-02 (SPK-UX-006 "next permitted action"): a domain next action (`open` or `view`)
 * as a link to the staff screen of the owning module that carries it out, or its label as text
 * when no staff screen serves it. The API listed it because the viewer may take it now; the
 * owning screen still renders the API's own refusal if that changes.
 */
import type { Schema } from '@sportspark/api-client';
import { Link } from 'react-router';
import { staffScreenFor } from './exception-actions';

export function NextActionLink({ action }: { action: Schema<'NextAction'> }) {
  const to = staffScreenFor(action);
  if (!to) return <span>{action.label}</span>;
  return <Link to={to}>{action.label}</Link>;
}
