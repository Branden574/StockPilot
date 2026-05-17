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
// Downgrades below are pragmatic: ESLint is being introduced into a
// codebase that's never had it, so we surface issues as warnings
// instead of failing the script on day one. As surveys land, we'll
// crank specific rules back up to 'error'.
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
    // Core rule: console.warn/error/info are intentional telemetry on
    // server actions + API routes. Block only bare console.log.
    'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],

    // Cosmetic: 62 occurrences in JSX. React handles raw apostrophes
    // fine; the rule exists for very-old browsers + a11y purity.
    'react/no-unescaped-entities': 'warn',

    // The react-hooks v7 strictness landed alongside React 19. These
    // rules catch real bugs but also fire on entirely valid patterns
    // (data-fetch effects that setState on success, third-party libs
    // that haven't been audited yet). Demote to warn for now; survey
    // and re-tighten rule-by-rule as we triage.
    'react-hooks/set-state-in-effect': 'warn',
    'react-hooks/purity': 'warn',
    'react-hooks/incompatible-library': 'warn',
    'react-hooks/refs': 'warn',
    'react-hooks/preserve-manual-memoization': 'warn',
    'react-hooks/error-boundaries': 'warn',
  },
};

export default [...nextConfig, ...coreWebVitals, ignores, projectOverrides];
