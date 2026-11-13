import type { Metadata, Viewport } from 'next';
import { Inter, Inter_Tight, Instrument_Serif, JetBrains_Mono } from 'next/font/google';
import type { ReactNode } from 'react';

import { PostHogProvider } from '@/components/analytics/posthog-provider';
import { InterruptedRunExpiry } from '@/components/auth/interrupted-run-expiry';
import { SessionFragmentScrub } from '@/components/auth/session-fragment-scrub';
import { WebVitalsReporter } from '@/components/perf/web-vitals-reporter';
import { Toaster } from '@/components/ui/sonner';
import { liquidGlassRollout } from '@/components/theme/appearance-flag';
import { AppearanceProvider } from '@/components/theme/appearance-provider';
import { appearanceScript } from '@/components/theme/appearance-script';
import { ThemeProvider } from '@/components/theme/theme-provider';

import { APP_DESCRIPTION, APP_NAME } from '@stockpilot/core';

import './globals.css';
// Liquid Glass rules that restyle the UNLAYERED rules of globals.css (a
// layered rule always loses to an unlayered one), so it comes right after it
// in source order. Every rule in it is scoped to
// :root[data-appearance="liquid-glass"] inside @media screen, so the classic
// appearances never match it (styles/liquid-glass/glass-scope.guard.test.ts).
import '../styles/liquid-glass/globals.glass.css';

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
  const glassScript = appearanceScript(liquidGlassRollout());
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${inter.variable} ${interTight.variable} ${instrumentSerif.variable} ${jetbrains.variable}`}
    >
      {/*
        The first-paint appearance script (components/theme/appearance-script.ts):
        sets data-appearance="liquid-glass" on <html> before the first paint
        when the Design cookie and the rollout say glass (under `default`:
        unless the cookie says classic; under `opt-in`: only when it says
        liquid-glass), and touches nothing otherwise. Not emitted under `off`
        (the kill switch, appearance-flag.ts). No route reads the cookie on
        the server, so every page's HTML is the same for everyone and caching
        is unchanged. It is the only thing glass adds to <head>: the scene
        illustration is named by the glass stylesheet alone
        (styles/liquid-glass/scene.css), never by an element or a preload.
      */}
      {glassScript ? (
        <head>
          <script dangerouslySetInnerHTML={{ __html: glassScript }} />
        </head>
      ) : null}
      <body className="bg-background min-h-screen font-sans antialiased">
        <ThemeProvider>
          {/*
            The appearance layer next to next-themes: owns only the
            data-appearance attribute on <html> and the appearance records,
            hands next-themes light, dark or system, and renders its children
            as given (no key, no second tree), so switching never remounts
            anything. See appearance-provider.tsx.
          */}
          <AppearanceProvider>
            {/*
            PostHog product analytics. Wraps the whole app so pageviews +
            autocapture cover all routes. Completely inert (no init, no
            network) until NEXT_PUBLIC_POSTHOG_KEY is set — see
            posthog-provider.tsx.
          */}
            {/*
            Real-user web vitals + the navigation-timing listener. Renders
            nothing and sends route TEMPLATES only. Placed BEFORE the provider
            so its listener is attached ahead of the page content's effects
            (a nicety, not a dependency: lib/perf/marks.ts holds a measurement
            taken before anyone was listening). See web-vitals-reporter.tsx.
          */}
            <WebVitalsReporter />
            {/*
            Removes what an interrupted run kept in this tab once it is over
            an hour old, whatever page the tab shows (the sign-in page a
            session that expired leaves it on above all). Renders nothing. See
            interrupted-run-expiry.tsx.
          */}
            <InterruptedRunExpiry />
            {/*
            Takes a session that a link Supabase verified itself left in the
            URL fragment out of the address bar, whatever page the link's
            redirect reached: /signin, /dashboard and the landing page among
            them. Here and on no single page, so no landing is missed
            (layout.session-fragment-scrub.guard.test.ts). Renders nothing. See
            session-fragment-scrub.tsx.
          */}
            <SessionFragmentScrub />
            <PostHogProvider>{children}</PostHogProvider>
            <Toaster />
          </AppearanceProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
