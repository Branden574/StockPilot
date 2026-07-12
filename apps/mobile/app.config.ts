import type { ExpoConfig } from 'expo/config';

const config: ExpoConfig = {
  name: 'StockPilot',
  slug: 'stockpilot',
  scheme: 'stockpilot',
  // ⚠️ THIS BUMP IS LOAD-BEARING — do not lower it to "re-reach" old runtimes.
  // 1.1.0 adds react-native-document-scanner-plugin (a NATIVE TurboModule; its
  // JS entry calls TurboModuleRegistry.getEnforcing at import time) + expo-print
  // for the PO "Scan Document" flow. runtimeVersion.policy is 'appVersion', so
  // keeping the old version here would let `pnpm release:ota` push this JS onto
  // existing 1.0.x binaries that DON'T contain the native module — crashing them
  // on import. With 1.1.0, OTA updates from this tree only ever land on builds
  // that actually ship the scanner. OTA hotfixes for LIVE 1.0.x users must be
  // published from a commit before this bump.
  // History: 1.0.3 = first universal (iPhone+iPad+Mac) build, LIVE on the App
  // Store; 1.0.2 added expo-document-picker; 1.0.1 added @sentry/react-native.
  version: '1.1.0',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  newArchEnabled: true,
  icon: './assets/icon.png',
  updates: {
    url: 'https://u.expo.dev/68235e4f-fd32-4c8c-a2b5-9f9df663e6cc',
  },
  runtimeVersion: {
    policy: 'appVersion',
  },
  splash: {
    image: './assets/icon.png',
    resizeMode: 'contain',
    backgroundColor: '#0a0f1f',
  },
  ios: {
    // Universal app: runs natively on iPhone + iPad, and on Apple-Silicon Macs
    // as a "Designed for iPad" app (enabled via a checkbox in App Store Connect
    // — no separate Mac build). NOTE: enabling iPad makes the App Store listing
    // REQUIRE iPad screenshots (13" iPad Pro) before this build can be submitted.
    supportsTablet: true,
    bundleIdentifier: 'app.stockpilot.mobile',
    // Do NOT hand-edit this for releases. eas.json `production` sets
    // `autoIncrement: true` with `cli.appVersionSource: 'remote'`, so EAS owns
    // the real build number remotely (it bumps on every production build). This
    // literal '1' is only the local/dev fallback; bumping it by hand has no
    // effect on store builds and just creates confusing drift. See
    // docs/runbooks/mobile-ota.md.
    buildNumber: '1',
    infoPlist: {
      NSCameraUsageDescription: 'StockPilot uses the camera to scan barcodes, QR codes, and documents.',
      NSPhotoLibraryUsageDescription: 'StockPilot uses your photo library to attach images to inventory items.',
      // Shown by iOS when the app first invokes LocalAuthentication
      // (Face ID specifically). Required — the app will crash on first
      // Face ID prompt without this string. Touch ID + passcode do not
      // need it but having it doesn't hurt.
      NSFaceIDUsageDescription: 'StockPilot uses Face ID to sign you in securely without re-entering your password.',
      // Declares the app does not use non-exempt encryption. Required
      // by Apple's export-compliance prompt at submit time; setting it
      // here means TestFlight/App Store builds skip the question.
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    package: 'app.stockpilot.mobile',
    versionCode: 1,
    adaptiveIcon: {
      foregroundImage: './assets/icon.png',
      backgroundColor: '#0a0f1f',
    },
    permissions: [
      'CAMERA',
      'READ_MEDIA_IMAGES',
    ],
  },
  plugins: [
    // sitemap:false — never ship the route-map screen (/_sitemap, also
    // linked from Unmatched Route) in production; owner flagged it as
    // unnecessary internal exposure. Honored at bundle time (getRoutesCore
    // options.sitemap !== false), so OTA delivers it.
    ['expo-router', { sitemap: false }],
    [
      'expo-camera',
      {
        cameraPermission: 'Allow StockPilot to access your camera for scanning barcodes.',
        // The app only scans barcodes / captures photos — it never records
        // audio or video. Opt out of the microphone permission so Apple
        // doesn't see a usage string for a capability we don't exercise
        // (App Store Guideline 5.1.1 — unused-permission rejection).
        microphonePermission: false,
        recordAudioAndroid: false,
      },
    ],
    [
      'expo-image-picker',
      {
        photosPermission: 'Allow StockPilot to access your photos for attaching to inventory items.',
      },
    ],
    // Native document scanner (iOS VisionKit / Android ML Kit) used by the PO
    // "Scan Document" attachment flow. Its config plugin writes
    // NSCameraUsageDescription — keep this string identical to the
    // ios.infoPlist one above so neither side silently wins.
    [
      'react-native-document-scanner-plugin',
      {
        cameraPermission: 'StockPilot uses the camera to scan barcodes, QR codes, and documents.',
      },
    ],
    'expo-secure-store',
    'expo-sqlite',
    // Registers the native push module + adds the iOS `aps-environment`
    // entitlement. Without this plugin the build has no push entitlement,
    // so getExpoPushTokenAsync() fails on device and no token is ever
    // registered (the web then shows "No registered devices").
    'expo-notifications',
    [
      'expo-local-authentication',
      {
        // Matches the NSFaceIDUsageDescription above. The Expo plugin
        // injects this if missing; we set both explicitly so EAS/prebuild
        // doesn't surprise us if either side gets edited later.
        faceIDPermission: 'StockPilot uses Face ID to sign you in securely without re-entering your password.',
      },
    ],
    // Patches the generated Podfile so the `fmt` pod compiles under
    // Xcode 16+ (defines FMT_USE_CONSTEVAL=0). See the plugin file for
    // the full rationale. Required for `expo run:ios` to succeed until
    // we bump to RN 0.81+.
    './plugins/with-fmt-consteval-fix.js',
    // Sentry crash/error reporting. The plugin wires the native SDK and, at
    // build time, uploads source maps when SENTRY_ORG / SENTRY_PROJECT /
    // SENTRY_AUTH_TOKEN are present (set as EAS secrets). With those unset the
    // build still succeeds — it just skips the source-map upload. The runtime
    // DSN is separate (EXPO_PUBLIC_SENTRY_DSN); see src/lib/sentry.ts.
    [
      '@sentry/react-native',
      {
        organization: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        url: 'https://sentry.io/',
      },
    ],
  ],
  experiments: {
    typedRoutes: true,
  },
  extra: {
    supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL,
    supabaseAnonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
    apiUrl: process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000',
    eas: {
      projectId: '68235e4f-fd32-4c8c-a2b5-9f9df663e6cc',
    },
  },
  owner: 'branden615',
};

export default config;
