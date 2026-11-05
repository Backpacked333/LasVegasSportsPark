/**
 * Request fields the API fills with its own default when omitted (docs/api/openapi.json marks
 * them optional with a `default`), but which the generated `paths.ts` types as required because
 * openapi-typescript treats any schema with a default as non-nullable. Sending a value would make
 * the client choose a policy the API owns (an invitation's expiry, a duplicate's score), so the
 * screen omits the field and the API applies its default (§4.9; "never invent a policy").
 *
 *   body: withServerDefaults<Schema<'CreateInvitationRequest'>, 'expiresInHours'>({ ... })
 */
export function withServerDefaults<T, K extends keyof T>(body: Omit<T, K>): T {
  return body as T;
}
