/** Dependency-injection tokens for kernel ports. Modules provide implementations for the `*_PORT` tokens. */
export const APP_CONFIG = Symbol('APP_CONFIG');
export const DATABASE = Symbol('DATABASE');
export const CLOCK = Symbol('CLOCK');
export const IDENTITY_PROVIDER = Symbol('IDENTITY_PROVIDER');
export const PRINCIPAL_RESOLVER_PORT = Symbol('PRINCIPAL_RESOLVER_PORT');
export const RELATIONSHIP_AUTHORITY_PORT = Symbol('RELATIONSHIP_AUTHORITY_PORT');
export const TEAM_AUTHORITY_PORT = Symbol('TEAM_AUTHORITY_PORT');
