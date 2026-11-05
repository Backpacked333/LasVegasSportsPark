// Metro configuration (Expo default). Expo detects the pnpm workspace and watches
// packages/api-client, which the app imports as TypeScript source.
const { getDefaultConfig } = require('expo/metro-config');

module.exports = getDefaultConfig(__dirname);
