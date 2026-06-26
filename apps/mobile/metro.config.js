// Metro configuration.
//
// getSentryExpoConfig wraps Expo's default Metro config and installs Sentry's
// source-map serializer so production crash stack traces are symbolicated
// (readable function names + line numbers instead of minified bytecode offsets).
// It is a strict superset of `expo/metro-config`'s getDefaultConfig — when
// Sentry has no DSN the only effect is that source maps are emitted for upload.
const { getSentryExpoConfig } = require('@sentry/react-native/metro');

const config = getSentryExpoConfig(__dirname);

module.exports = config;
