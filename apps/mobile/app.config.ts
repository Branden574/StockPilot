import type { ExpoConfig } from 'expo/config';

const config: ExpoConfig = {
  name: 'StockPilot',
  slug: 'stockpilot',
  scheme: 'stockpilot',
  version: '1.0.0',
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
    // iPhone-only: warehouse/stockroom users are on phones, and this keeps the
    // App Store listing to iPhone screenshots only (no iPad set required).
    // iPads still run the app in iPhone-compatibility mode.
    supportsTablet: false,
    bundleIdentifier: 'app.stockpilot.mobile',
    // Do NOT hand-edit this for releases. eas.json `production` sets
    // `autoIncrement: true` with `cli.appVersionSource: 'remote'`, so EAS owns
    // the real build number remotely (it bumps on every production build). This
    // literal '1' is only the local/dev fallback; bumping it by hand has no
    // effect on store builds and just creates confusing drift. See
    // docs/runbooks/mobile-ota.md.
    buildNumber: '1',
    infoPlist: {
      NSCameraUsageDescription: 'StockPilot uses the camera to scan barcodes and QR codes.',
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
    'expo-router',
    [
      'expo-camera',
      {
        cameraPermission: 'Allow StockPilot to access your camera for scanning barcodes.',
      },
    ],
    [
      'expo-image-picker',
      {
        photosPermission: 'Allow StockPilot to access your photos for attaching to inventory items.',
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
