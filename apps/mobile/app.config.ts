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
  // `newArchEnabled` used to live here. Expo SDK 55 REMOVED it from the app
  // config schema (and from @expo/config-plugins and expo-build-properties)
  // because SDK 54 was the last release that could run the Legacy
  // Architecture at all — the New Architecture is now the only one, so the
  // flag has nothing left to switch. Do not re-add it; it is no longer a
  // valid ExpoConfig key and will fail typecheck.
  icon: './assets/icon.png',
  updates: {
    url: 'https://u.expo.dev/68235e4f-fd32-4c8c-a2b5-9f9df663e6cc',
  },
  runtimeVersion: {
    policy: 'appVersion',
  },
  // NOTE: the root-level `splash` key used to live here. Expo SDK 56 dropped it
  // from ExpoConfig AND from @expo/prebuild-config (grep the installed
  // @expo/prebuild-config@56 build output — it contains no splash handling at
  // all), so leaving it would silently produce a default white launch screen.
  // The identical configuration now lives in the 'expo-splash-screen' plugin
  // below.
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
    // Required from Expo SDK 56 on — expo-image gained a config plugin and
    // `expo install --fix` / expo-doctor now refuse the project without it. It
    // only writes one Podfile property (`expo-image.disable-libdav1d`, left at
    // its default `false` so the bundled AV1 decoder stays linked); there is no
    // behaviour change from adding it.
    'expo-image',
    // Required from Expo SDK 57 on — expo-status-bar's config plugin is now
    // part of expo-doctor's plugin-presence check. Listed with NO props on
    // purpose: the plugin's own implementation gates every write on
    // `hidden != null` / `style != null`, so a props-less entry is a verified
    // no-op for both the iOS Info.plist and the Android styles. The status bar
    // is still driven at runtime by <StatusBar style={...} /> in
    // app/_layout.tsx; giving the plugin a `style` here would bake a
    // launch-time value into the native project and fight that.
    'expo-status-bar',
    // Replaces the root-level `splash` key that SDK 56 removed (see the note
    // where it used to live). Values are carried over 1:1 from it. The
    // plugin's own defaults are NOT equivalent to the old key — it centres the
    // image at imageWidth 100 — so `enableFullScreenImage_legacy: true` is
    // load-bearing: it is Expo's documented compatibility switch that keeps
    // rendering the icon full-screen-contained exactly as the 1.1.0 build on
    // the App Store does today. Do not drop it without deciding you WANT the
    // new centred-logo look.
    [
      'expo-splash-screen',
      {
        image: './assets/icon.png',
        resizeMode: 'contain',
        backgroundColor: '#0a0f1f',
        enableFullScreenImage_legacy: true,
      },
    ],
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
    // NOTE: './plugins/with-fmt-consteval-fix.js' used to be listed here. It
    // patched the generated Podfile with FMT_USE_CONSTEVAL=0 because React
    // Native 0.79 pinned fmt 11.0.2, whose consteval format strings Xcode 16+
    // rejects. React Native fixed that upstream in 0.83.5 by bumping to fmt
    // 12.1.0 ("Build: Bump fmt to 12.1.0 to fix Xcode 26.4"), and SDK 55 ships
    // RN 0.83.10 — verified locally: node_modules/react-native/
    // third-party-podspecs/fmt.podspec declares spec.version = "12.1.0". The
    // plugin was therefore deleted along with the @expo/config-plugins
    // devDependency it needed. Do not resurrect it: it injects into the
    // Podfile's post_install block by string-matching `  end\nend\n`, so it is
    // a standing hazard every time the RN Podfile template changes shape.
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
