// Flat ESLint config for the apps/web Next.js 16 app.
//
// Next 16 removed the `next lint` subcommand and pushed apps onto the
// ESLint 9 flat-config flow. `eslint-config-next` v16 ships flat-config
// arrays out of the box for both the base preset and the
// Core-Web-Vitals add-on, so this file is a thin spreader plus a
// project-local ignores block and a couple of rule downgrades.
//
// We only override CORE ESLint rules + plugin-namespaced rules whose
// plugins are already registered by the Next preset (react, react-hooks,
// @next/next). TypeScript-aware rules are owned by the typescript-eslint
// plugin which the Next preset wires up inline.
//
// Rule choices below are post-triage (see commits leading up to the
// rule downgrades): the React 19 react-hooks plugin landed several
// extremely strict checks that flag valid patterns in this codebase.
// Three of them are pure-false-positive factories here and are
// disabled. The others stay as warn so they keep surfacing for
// triage as new code lands.
//
// The shared legacy preset in packages/config/eslint-preset.js is
// .eslintrc-style and NOT used here — migrating it to flat config is a
// separate effort. apps/web stands alone for now.

import nextConfig from 'eslint-config-next';
import coreWebVitals from 'eslint-config-next/core-web-vitals';

const ignores = {
  ignores: [
    '.next/**',
    '.turbo/**',
    'node_modules/**',
    'tests/playwright-report/**',
    'tests/test-results/**',
    'next-env.d.ts',
    'src/app/**/*.d.ts',
  ],
};

const projectOverrides = {
  rules: {
    // Core: console.warn/error/info are intentional telemetry on server
    // actions + API routes. Block only bare console.log.
    'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],

    // Cosmetic: 62 occurrences across JSX text. React renders raw
    // apostrophes / quotes correctly; the rule exists for older
    // browsers + screen-reader purity. We don't ship to those targets
    // and the rule's noise drowns real findings.
    'react/no-unescaped-entities': 'off',

    // The React 19 react-hooks plugin's strict purity rule flags
    // server components (async functions, Date.now() during a one-shot
    // server render) as impure. The rule can't tell client from server
    // and there's no per-file scoping that works reliably. Turning off
    // — server-component date math is by definition NOT a render
    // purity issue.
    'react-hooks/purity': 'off',

    // Flags every React Hook Form `watch(...)` use in JSX. RHF is the
    // form lib used throughout — this rule is fundamentally
    // incompatible with the library and produces zero true positives
    // in this codebase.
    'react-hooks/incompatible-library': 'off',

    // Remaining strict rules stay as warn so they surface for future
    // triage but don't fail the script today.
    'react-hooks/set-state-in-effect': 'warn',
    'react-hooks/refs': 'warn',
    'react-hooks/preserve-manual-memoization': 'warn',
    'react-hooks/error-boundaries': 'warn',
  },
};

export default [...nextConfig, ...coreWebVitals, ignores, projectOverrides];
