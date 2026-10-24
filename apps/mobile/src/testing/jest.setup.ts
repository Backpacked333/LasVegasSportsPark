// React Native Testing Library 13 registers its Jest matchers on import. Nothing else is global:
// tests inject services (src/testing/test-app.tsx) instead of mocking device modules.
import '@testing-library/react-native';
// expo-router's testing library treats app/+native-intent.tsx as a route; see the file below.
import './expo-router-native-intent';
