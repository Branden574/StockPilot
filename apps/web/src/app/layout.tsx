import type { Metadata, Viewport } from 'next';
import { Inter, Inter_Tight, Instrument_Serif, JetBrains_Mono } from 'next/font/google';
import type { ReactNode } from 'react';

import { PostHogProvider } from '@/components/analytics/posthog-provider';
import { Toaster } from '@/components/ui/sonner';
import { ThemeProvider } from '@/components/theme/theme-provider';

import { APP_DESCRIPTION, APP_NAME } from '@stockpilot/core';

import './globals.css';

// `preload: false` on Inter (body sans) and JetBrains_Mono (SKU/mono code):
// the marketing landing's LCP candidate is the H1 styled with --font-display
// (Inter_Tight) + the italic --font-serif (Instrument_Serif), so preloading
// the other two competes for connection slots without paying off. They still
// load lazily on first use (display: swap means the fallback shows briefly).
const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-sans',
  preload: false,
});

const interTight = Inter_Tight({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
  variable: '--font-display',
});

const instrumentSerif = Instrument_Serif({
  subsets: ['latin'],
  weight: ['400'],
  style: ['normal', 'italic'],
  display: 'swap',
  variable: '--font-serif',
});

const jetbrains = JetBrains_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-mono',
  preload: false,
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'),
  title: {
    default: `${APP_NAME} — Inventory you'll actually enjoy using`,
    template: `%s · ${APP_NAME}`,
  },
  description: APP_DESCRIPTION,
  keywords: [
    'inventory management',
    'inventory software',
    'barcode scanner',
    'small business inventory',
    'multi-location inventory',
    'purchase orders',
    'stock tracking',
  ],
  authors: [{ name: APP_NAME }],
  creator: APP_NAME,
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: '/',
    title: APP_NAME,
    description: APP_DESCRIPTION,
    siteName: APP_NAME,
  },
  twitter: {
    card: 'summary_large_image',
    title: APP_NAME,
    description: APP_DESCRIPTION,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-image-preview': 'large',
      'max-snippet': -1,
    },
  },
  // Favicons & touch icons are produced by Next.js's file-based icon
  // convention: see app/icon.svg (animated brand mark) and
  // app/apple-icon.tsx (static 180x180 PNG). No `icons` field is
  // needed here — declaring it would override the file convention.
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f6f4ef' },
    { media: '(prefers-color-scheme: dark)', color: '#0c0c0e' },
  ],
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${inter.variable} ${interTight.variable} ${instrumentSerif.variable} ${jetbrains.variable}`}
    >
      <body className="min-h-screen bg-background font-sans antialiased">
        <ThemeProvider>
          {/*
            PostHog product analytics. Wraps the whole app so pageviews +
            autocapture cover all routes. Completely inert (no init, no
            network) until NEXT_PUBLIC_POSTHOG_KEY is set — see
            posthog-provider.tsx.
          */}
          <PostHogProvider>{children}</PostHogProvider>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
