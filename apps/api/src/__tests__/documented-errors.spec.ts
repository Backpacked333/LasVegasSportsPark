import { describe, expect, it } from 'vitest';
import { emitOpenApiDocument } from '../openapi-document';

type Operation = { responses: Record<string, unknown> };
const document = emitOpenApiDocument('0.1.0') as unknown as {
  paths: Record<string, Partial<Record<'get' | 'post', Operation>>>;
};

/**
 * R2-API-CONTRACT-04 (§4.8 publish exact schemas, §4.10): an operation documents every error status
 * it answers, so the typed client can name them. The service paths are covered by their module
 * tests: facilities restrictions.service.ts assertClosureLiftAllowed (422 restriction_release_required)
 * and catalog discounts.service.ts evaluate (protected NOT_FOUND for an unknown, hidden or
 * unpublished offering).
 */
describe('operation-specific error responses (R2-API-CONTRACT-04, §4.8)', () => {
  it('R2-API-CONTRACT-04: POST /closures/{id}/lift documents 422 (ELIGIBILITY_FAILED restriction_release_required)', () => {
    const responses = document.paths['/closures/{id}/lift']?.post?.responses ?? {};
    expect(Object.keys(responses)).toEqual(
      expect.arrayContaining(['200', '400', '403', '404', '409', '422']),
    );
  });

  it('R2-API-CONTRACT-04: POST /discounts/evaluate documents 404 for an unknown, hidden or unpublished offering', () => {
    const responses = document.paths['/discounts/evaluate']?.post?.responses ?? {};
    expect(Object.keys(responses)).toEqual(expect.arrayContaining(['200', '400', '403', '404']));
  });
});
