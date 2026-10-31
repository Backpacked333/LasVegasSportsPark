import {
  errors,
  importActorLabel,
  type ImportProvenance,
  type Principal,
} from '@sportspark/contracts';

/**
 * K-13, IF-40 (§5.3, §5.4, SPK-AT-024, §5.6): an owning module's import command runs only for the
 * migration module's system principal of that batch (`systemPrincipal(org, 'migration.import:<batchId>')`).
 * Any other principal (staff, customer, another batch's import) is refused with ACCESS_DENIED.
 *
 * The contract every import command follows (api-and-events.md): in-process only (no route); it
 * joins the caller's unit of work; it inserts with `id = provenance.recordId` and the module's
 * provenance column set to `import`, audited with the import actor; the same record with equal
 * content already present returns it with no audit, outbox or side effect; different content is
 * RESOURCE_CONFLICT `IMPORT_CONTENT_MISMATCH`. Import commands are the batch's sanctioned writer
 * and do not call RECORD_AUTHORITY_PORT.
 */
export function assertImportPrincipal(principal: Principal, provenance: ImportProvenance): void {
  if (
    principal.kind === 'system' &&
    principal.actorLabel === importActorLabel(provenance.batchId)
  ) {
    return;
  }
  throw errors.accessDenied('Only the migration import of this batch may write imported records.', {
    code: 'IMPORT_PRINCIPAL_REQUIRED',
    batchId: provenance.batchId,
  });
}

/** RESOURCE_CONFLICT for a re-import whose content differs from the record already imported. */
export function importContentMismatch(details: Record<string, unknown> = {}) {
  return errors.resourceConflict('An imported record with this id exists with different content.', {
    code: 'IMPORT_CONTENT_MISMATCH',
    ...details,
  });
}
