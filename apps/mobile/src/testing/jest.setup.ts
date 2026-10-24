// React Native Testing Library 13 registers its Jest matchers on import. Nothing else is global:
// tests inject services (src/testing/test-app.tsx) instead of mocking device modules.
import '@testing-library/react-native';
