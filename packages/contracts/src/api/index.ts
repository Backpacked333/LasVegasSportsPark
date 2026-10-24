// Each module's API contract file registers its paths with the shared OpenAPI registry on import.
// Modules append their own export line here (one line per module keeps merges conflict-free).
export * from './facilities';
export * from './identity';
export * from './operations';
export * from './scheduling';
