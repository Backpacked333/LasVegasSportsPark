// React Native Testing Library 13 registers its Jest matchers on import. Nothing else is global:
// tests inject services (src/testing/test-app.tsx) instead of mocking device modules.
import { configure } from '@testing-library/react-native';
// expo-router's testing library treats app/+native-intent.tsx as a route; see the file below.
import './expo-router-native-intent';

// findBy* and waitFor wait up to 5 s instead of 1 s: the suite runs on shared CI machines, where a
// slow worker must not turn a correct screen into a failed test. Still deterministic: every
// response comes from the fake API, never from real time or the network.
configure({ asyncUtilTimeout: 5_000 });
