import type { ExpoConfig } from 'expo/config';

const config: ExpoConfig = {
  name: 'StockPilot',
  slug: 'stockpilot',
  scheme: 'stockpilot',
  version: '0.1.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'automatic',
  newArchEnabled: true,
  splash: {
    image: './assets/splash.png',
    resizeMode: 'contain',
    backgroundColor: '#0a0f1f',
  },
  ios: {
    supportsTablet: true,
    bundleIdentifier: 'app.stockpilot.mobile',
    infoPlist: {
      NSCameraUsageDescription: 'StockPilot uses the camera to scan barcodes and QR codes.',
      NSPhotoLibraryUsageDescription: 'StockPilot uses your photo library to attach images to inventory items.',
    },
  },
  android: {
    package: 'app.stockpilot.mobile',
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      backgroundColor: '#0a0f1f',
    },
    permissions: ['CAMERA', 'READ_MEDIA_IMAGES'],
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
  ],
  experiments: {
    typedRoutes: true,
  },
  extra: {
    supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL,
    supabaseAnonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
    apiUrl: process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000',
  },
};

export default config;
