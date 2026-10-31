import { errors } from '@sportspark/contracts';

/**
 * A port member declared ahead of its implementation (stage 3): the interface is fixed so module
 * builders implement and consume it in parallel, and until the named work item lands the member
 * answers INTERNAL_ERROR naming that item instead of guessing a behaviour. Members whose interface
 * specifies a default answer that default instead and never call this.
 */
export function declaredNotImplemented(member: string, workItem: string): never {
  throw errors.internal(`${member} is declared but not implemented yet (${workItem}).`);
}
