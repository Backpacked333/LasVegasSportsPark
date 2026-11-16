// Jest setup for every mobile test.
//
// React Native Testing Library 13 registers its Jest matchers on import. Device services are not
// mocked here: tests inject them (src/testing/test-app.tsx) instead. What is set up here is only
// what the UI libraries need to load in Node without their native halves:
//
// - react-native-gesture-handler: its own jest setup (the native module and the gesture
//   components as plain views).
// - react-native-worklets: its mock (no UI runtime in Node; worklets run on the JS thread).
// - react-native-reanimated: its test setup (`setUpTests`), so animated styles resolve to their
//   values and the timer helpers work with Jest's fake timers.
// - @gorhom/bottom-sheet: its mock (sheets render their content in place). Sheets in screen tests
//   render through React Native's `Modal` anyway, so their content can be queried.
//
// None of this makes anything move in a screen test: without a `MotionProvider`, motion counts as
// reduced (src/ui/motion.tsx), the same rule as `GlassProvider`.
import { configure } from '@testing-library/react-native';
import 'react-native-gesture-handler/jestSetup';
import { setUpTests } from 'react-native-reanimated';
// expo-router's testing library treats app/+native-intent.tsx as a route; see the file below.
import './expo-router-native-intent';

// Jest hoists these above the imports, so reanimated loads against the worklets mock.
jest.mock('react-native-worklets', () => jest.requireActual('react-native-worklets/src/mock'));
jest.mock('@gorhom/bottom-sheet', () => jest.requireActual('@gorhom/bottom-sheet/mock'));
setUpTests();

// findBy* and waitFor wait up to 5 s instead of 1 s: the suite runs on shared CI machines, where a
// slow worker must not turn a correct screen into a failed test. Still deterministic: every
// response comes from the fake API, never from real time or the network.
configure({ asyncUtilTimeout: 5_000 });
