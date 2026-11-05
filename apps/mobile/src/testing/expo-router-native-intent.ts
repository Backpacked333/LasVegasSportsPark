/**
 * Test-harness workaround (SCR-C-39): expo-router 57.0.25's `renderRouter({ appDir, overrides })`
 * normalises every file key to a route name, so `app/+native-intent.tsx` becomes a route called
 * "+native-intent" and rendering throws ("Route nodes cannot start with the '+' character").
 * In the app, Metro's require.context keeps the `./+native-intent.tsx` key, which expo-router
 * ignores as a route and loads as the link handler. This keeps that key in tests too, so every
 * router test runs with the same safe deep-link handling as the app.
 */
type MockContext = ((id: string) => unknown) & {
  keys(): string[];
  resolve(key: string): string;
  id: string;
};
interface MockContextStubs {
  requireContextWithOverrides(dir: string, overrides: object): MockContext;
}

jest.mock('expo-router/build/testing-library/context-stubs', () => {
  const mockName = '+native-intent';
  const mockKey = './+native-intent.tsx';
  const actual = jest.requireActual(
    'expo-router/build/testing-library/context-stubs',
  ) as MockContextStubs;
  return {
    ...actual,
    requireContextWithOverrides(dir: string, overrides: object): MockContext {
      const context = actual.requireContextWithOverrides(dir, overrides);
      const keys = context.keys().map((key) => (key === mockName ? mockKey : key));
      return Object.assign((id: string) => context(id === mockKey ? mockName : id), {
        keys: () => [...keys],
        resolve: context.resolve,
        id: context.id,
      });
    },
  };
});

export {};
